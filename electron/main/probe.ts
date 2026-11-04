import { spawn } from 'node:child_process'
import path from 'node:path'
// @ts-expect-error - no types published
import ffprobePkg from 'ffprobe-static'
import type { ProbeResult } from '@shared/ipc'
import { SUPPORTED_EXTENSIONS } from '@shared/types'
import { cacheKey, entryPath, readJsonEntry, stampSource, writeFileAtomic, writeMeta } from './cache'

const ffprobePath: string = (ffprobePkg as { path: string }).path

const VIDEO_EXT = new Set<string>(SUPPORTED_EXTENSIONS.video)
const AUDIO_EXT = new Set<string>(SUPPORTED_EXTENSIONS.audio)
const IMAGE_EXT = new Set<string>(SUPPORTED_EXTENSIONS.image)

/**
 * Probes a media file's metadata. Results are cached in `<userData>/Cache/mediainfo/<key>.json`,
 * keyed on path + size + mtime (CapCut's `importcache3/mediainfo` does the same), so re-importing
 * a file or reopening a project skips ffprobe entirely.
 */
export async function probeMedia(filePath: string): Promise<ProbeResult | null> {
  const src = await stampSource(filePath)
  if (!src) return null
  const key = cacheKey('mediainfo', src)
  const file = await entryPath('mediainfo', key, '.json')
  const cached = await readJsonEntry<ProbeResult>(file)
  if (cached) return cached
  const result = await probeUncached(filePath)
  if (result) {
    await writeFileAtomic(file, JSON.stringify(result))
    await writeMeta('mediainfo', key, src)
  }
  return result
}

function probeUncached(filePath: string): Promise<ProbeResult | null> {
  const ext = path.extname(filePath).toLowerCase()
  const isImage = IMAGE_EXT.has(ext)
  if (!isImage && !VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext)) {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath]
    const proc = spawn(ffprobePath, args)
    let stdout = ''
    proc.stdout.on('data', (chunk) => (stdout += chunk))
    // An image ffprobe can't read is still importable (Chromium may draw it); only fail AV media.
    proc.on('error', () => resolve(isImage ? { kind: 'image', duration: 0, hasAudio: false } : null))
    proc.on('close', (code) => {
      if (code !== 0) return resolve(isImage ? { kind: 'image', duration: 0, hasAudio: false } : null)
      try {
        const data = JSON.parse(stdout)
        const streams: Array<Record<string, unknown>> = data.streams ?? []
        const videoStream = streams.find((s) => s.codec_type === 'video')
        const audioStream = streams.find((s) => s.codec_type === 'audio')
        if (IMAGE_EXT.has(ext)) {
          resolve({
            kind: 'image',
            duration: 0,
            width: videoStream ? Number(videoStream.width) : undefined,
            height: videoStream ? Number(videoStream.height) : undefined,
            hasAudio: false
          })
          return
        }
        const duration = Number(data.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? 0)
        const kind: ProbeResult['kind'] = videoStream ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : 'video'
        resolve({
          kind,
          duration: Number.isFinite(duration) ? duration : 0,
          width: videoStream ? Number(videoStream.width) : undefined,
          height: videoStream ? Number(videoStream.height) : undefined,
          hasAudio: Boolean(audioStream),
          videoCodec: videoStream ? String(videoStream.codec_name ?? '') : undefined,
          audioCodec: audioStream ? String(audioStream.codec_name ?? '') : undefined
        })
      } catch {
        resolve(null)
      }
    })
  })
}
