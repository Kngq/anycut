import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import ffmpegPath from 'ffmpeg-static'
import type { ThumbnailCover } from '@shared/ipc'
import { cacheKey, dedupe, entryPath, fileExists, readJsonEntry, stampSource, touchEntry, writeFileAtomic, writeMeta } from './cache'

/**
 * Filmstrip sprite for a video: FRAME_COUNT frames sampled evenly across the source, scaled to
 * FRAME_HEIGHT, laid out left-to-right in one PNG. The renderer slices it across a timeline clip.
 *
 * Speed: the old version used ffmpeg's `thumbnail` filter, which decodes EVERY frame of the source,
 * so a long or 4K clip took about as long as a full transcode. Now each frame is grabbed with an
 * input-side seek (`-ss` before `-i`), which jumps to the nearest keyframe and decodes one frame.
 * That's FRAME_COUNT cheap seeks run a few at a time, then a single tile pass. CapCut does the same
 * thing (its frameThumbnail cache stores individual frames named by timestamp).
 *
 * Cached in `<userData>/Cache/thumbnails/<key>.png` + `<key>.json` (see cache.ts).
 */
const FRAME_COUNT = 40
const FRAME_HEIGHT = 120
const PARALLEL_SEEKS = 4

/** Thumbnail sprite for a VIDEO file. `duration` (seconds, from the probe) spaces the samples. */
export async function ensureVideoCover(filePath: string, duration?: number): Promise<ThumbnailCover | null> {
  if (!ffmpegPath) return null
  const src = await stampSource(filePath)
  if (!src) return null
  const key = cacheKey('thumbnails', src)
  return dedupe(`thumbnails:${key}`, async () => {
    const outPath = await entryPath('thumbnails', key, '.png')
    const metaPath = await entryPath('thumbnails', key, '.json')
    const cached = await readJsonEntry<ThumbnailCover>(metaPath)
    if (cached && (await fileExists(outPath))) {
      void touchEntry(outPath)
      return { ...cached, path: outPath }
    }
    try {
      const cover = await buildSprite(filePath, outPath, duration ?? (await probeDuration(filePath)))
      await writeFileAtomic(metaPath, JSON.stringify(cover))
      await writeMeta('thumbnails', key, src)
      return cover
    } catch (err) {
      console.error('[freecut] thumbnail sprite generation failed for', filePath, err)
      return null
    }
  })
}

async function buildSprite(filePath: string, outPath: string, duration: number): Promise<ThumbnailCover> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'freecut-thumb-'))
  try {
    const span = Math.max(duration, 0.1)
    // Sample at the centre of each of FRAME_COUNT equal slices; never seek past the end.
    const times = Array.from({ length: FRAME_COUNT }, (_, i) => Math.min(((i + 0.5) / FRAME_COUNT) * span, Math.max(span - 0.05, 0)))
    const framePaths = times.map((_, i) => path.join(work, `f${String(i).padStart(3, '0')}.jpg`))

    // Grab frames a few at a time. Each grab seeks before the input, so it's a near-instant
    // keyframe jump + one decoded frame.
    for (let i = 0; i < times.length; i += PARALLEL_SEEKS) {
      await Promise.all(
        times.slice(i, i + PARALLEL_SEEKS).map((t, j) =>
          runFfmpeg(['-y', '-ss', t.toFixed(3), '-i', filePath, '-frames:v', '1', '-vf', `scale=-2:${FRAME_HEIGHT}`, '-q:v', '4', framePaths[i + j]]).catch(
            () => undefined // a seek past a short file's last keyframe can fail; filled below
          )
        )
      )
    }

    // Any frame that failed (e.g. tail of a very short clip) reuses the nearest earlier one so the
    // sprite always has exactly FRAME_COUNT cells.
    let lastGood: string | null = null
    for (let i = 0; i < framePaths.length; i++) {
      if (await fileExists(framePaths[i])) lastGood = framePaths[i]
      else if (lastGood) await fs.copyFile(lastGood, framePaths[i])
    }
    if (!lastGood) throw new Error('no frames could be extracted')
    for (let i = framePaths.length - 1; i >= 0; i--) {
      // Leading gaps (first frames failed): back-fill from the first good one.
      if (!(await fileExists(framePaths[i]))) await fs.copyFile(lastGood, framePaths[i])
    }

    // One cheap pass: tile the JPEG sequence into the sprite. Frames are forced to a common size
    // (the first frame's) so odd-sized/rotated stragglers can't break `tile`.
    const tmp = `${outPath}.tmp.png`
    await runFfmpeg([
      '-y',
      '-framerate',
      '1',
      '-i',
      path.join(work, 'f%03d.jpg'),
      '-vf',
      `scale=-2:${FRAME_HEIGHT},tile=${FRAME_COUNT}x1`,
      '-frames:v',
      '1',
      tmp
    ])
    await fs.rename(tmp, outPath)

    const { width: totalWidth, height } = await pngSize(outPath)
    const frameWidth = Math.max(1, Math.round(totalWidth / FRAME_COUNT))
    return { path: outPath, frames: FRAME_COUNT, frameWidth, frameHeight: height }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/** Fallback duration read (the renderer normally passes the probed duration). */
async function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath as string, ['-i', filePath])
    let stderr = ''
    proc.stderr.on('data', (c: Buffer) => (stderr += c))
    proc.on('error', () => resolve(1))
    proc.on('close', () => {
      const m = /Duration: (\d+):(\d+):(\d+\.?\d*)/.exec(stderr)
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 1)
    })
  })
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args)
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`))))
  })
}

/** Reads a PNG's pixel width/height from its IHDR header (bytes 16-23, big-endian). */
async function pngSize(pngPath: string): Promise<{ width: number; height: number }> {
  const fh = await fs.open(pngPath, 'r')
  try {
    const buf = Buffer.alloc(24)
    await fh.read(buf, 0, 24, 0)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  } finally {
    await fh.close()
  }
}
