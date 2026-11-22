import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ffmpegPath, ffprobePath } from './binaries'
import type { MotionBlurResult } from '@shared/ipc'
import type { MediaAsset, MotionBlurSettings } from '@shared/types'
import { colorConversionFilters, REC709_OUTPUT_ARGS } from '@shared/ffmpegGraph'
import {
  blurKernel,
  compositeFilter,
  normalizeSettings,
  parseProgressSeconds,
  pickFrameRate,
  rationalStr,
  rationalValue,
  retimeFilter,
  segmentFilter,
  segmentRanges,
  settingsKey,
  workSize,
  type Rational
} from '@shared/motionBlur'
import { cacheKey, dedupe, entryPath, fileExists, stampSource, touchEntry, writeMeta } from './cache'


/**
 * Video > Motion blur, baked offline (CapCut bakes it the same way, into `Cache/MotionBlurCache/`).
 * The plan (sub-frame kernel, filter strings) lives in src/shared/motionBlur.ts; this file runs it:
 *
 *   1. prep      source → retimed, colour-converted, downscaled lossless FFV1 intermediate (1 decode)
 *   2. segments  K parallel ffmpegs, each: minterpolate (optical flow) → tmix window → 1 frame per
 *                source frame, for its slice of the clip. minterpolate is single-threaded and the
 *                cost, so slicing the clip across cores is what makes this usable.
 *   3. composite full-res source + concat'd blurred frames + motion mask → H.264 (or, when the
 *                input has alpha, e.g. a background-removed bake: ProRes 4444 + VP9-alpha WebM).
 *
 * Output keeps every source frame at the source rate (frame N in = frame N out) so the clip's
 * trimIn/trimOut stay valid when it replaces the source via `sourceOverride`. Audio is copied.
 * The bake is always Rec. 709 SDR (HDR sources are tone-mapped like export/proxies do).
 */

interface SourceInfo {
  width: number
  height: number
  fps: Rational
  durationSec: number
  alpha: boolean
  audioCodec?: string
  color?: MediaAsset['color']
}

/** Running bakes, so cancel can kill their processes. */
const running = new Set<{ cancelled: boolean; procs: Set<ChildProcess> }>()

export function cancelMotionBlur(): void {
  for (const job of running) {
    job.cancelled = true
    for (const p of job.procs) p.kill('SIGKILL')
  }
}

const CANCELLED = 'cancelled'

export async function motionBlur(inputPath: string, settings: MotionBlurSettings, onProgress?: (ratio: number) => void): Promise<MotionBlurResult> {
  if (!ffmpegPath) return { ok: false, error: 'ffmpeg not available' }
  const s = normalizeSettings(settings)
  const src = await stampSource(inputPath)
  if (!src) return { ok: false, error: 'source file is missing' }
  const key = `${cacheKey('motionblur', src)}-${settingsKey(s)}`
  return dedupe(`motionblur:${key}`, () => bake(inputPath, s, key, src, onProgress))
}

async function bake(
  inputPath: string,
  s: MotionBlurSettings,
  key: string,
  src: NonNullable<Awaited<ReturnType<typeof stampSource>>>,
  onProgress?: (ratio: number) => void
): Promise<MotionBlurResult> {
  const info = await sourceInfo(inputPath)
  if (!info) return { ok: false, error: 'no video stream' }
  const ext = info.alpha ? '.mov' : '.mp4'
  const outPath = await entryPath('motionblur', key, ext)
  const previewOut = info.alpha ? await entryPath('motionblur', key, '.webm') : undefined
  if ((await fileExists(outPath)) && (!previewOut || (await fileExists(previewOut)))) {
    void touchEntry(outPath)
    onProgress?.(1)
    return { ok: true, outputPath: outPath, previewPath: previewOut, hasAlpha: info.alpha }
  }

  const job = { cancelled: false, procs: new Set<ChildProcess>() }
  running.add(job)
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'anycut-motionblur-'))
  const tmpOut = `${outPath}.tmp${ext}`
  const tmpPreview = previewOut ? `${previewOut}.tmp.webm` : undefined
  const run = (args: string[], onTime?: (sec: number) => void, onFrame?: (n: number) => void) => runFfmpeg(job, args, onTime, onFrame)
  try {
    const F = rationalStr(info.fps)
    const fpsValue = rationalValue(info.fps)
    const { w, h } = workSize(info.width, info.height)
    const color = colorConversionFilters(info.color)
    const loFmt = info.alpha ? 'yuva420p' : 'yuv420p'
    const total = Math.max(1, info.durationSec)
    // Stage weights for one 0..1 progress bar (measured: segments dominate).
    const W_PREP = 0.08
    const W_SEG = 0.67
    const W_COMP = 0.25

    // 1. prep. Colour conversion happens here too, so optical flow sees the same SDR pixels as the output.
    const lo = path.join(work, 'lo.mkv')
    let frames = 0
    const prepColor = info.alpha
      ? `split[c][a];[c]${color}format=yuv420p[c2];[a]alphaextract[a2];[c2][a2]alphamerge,`
      : color
    await run(
      ['-y', '-i', inputPath, '-filter_complex', `[0:v:0]${retimeFilter(info.fps)},${prepColor}scale=${w}:${h}:flags=area,format=${loFmt}[v]`, '-map', '[v]', '-fps_mode', 'passthrough', '-c:v', 'ffv1', '-level', '3', '-threads', '0', lo],
      (t) => onProgress?.(W_PREP * Math.min(1, t / total)),
      (n) => (frames = n)
    )
    if (frames < 1) throw new Error('no frames decoded')

    // 2. segments in parallel.
    const kernel = blurKernel(s)
    const parts = Math.max(1, Math.min(8, os.cpus().length - 1))
    const ranges = segmentRanges(frames, parts)
    const segDone = new Array(ranges.length).fill(0)
    const reportSeg = () => onProgress?.(W_PREP + (W_SEG * segDone.reduce((a, b) => a + b, 0)) / frames)
    const segFiles = ranges.map((_, i) => path.join(work, `seg${i}.mkv`))
    await Promise.all(
      ranges.map(([a, b], i) =>
        run(
          ['-y', '-i', lo, '-filter_complex', segmentFilter({ fps: info.fps, kernel, start: a, end: b, total: frames, alpha: info.alpha }), '-map', '[out]', '-fps_mode', 'passthrough', '-c:v', 'ffv1', '-level', '3', segFiles[i]],
          (t) => {
            segDone[i] = Math.min(b - a, Math.round(t * fpsValue))
            reportSeg()
          }
        )
      )
    )
    const list = path.join(work, 'segments.txt')
    await fs.writeFile(list, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'))

    // 3. composite at full res + encode.
    const filter = compositeFilter({ fps: info.fps, width: info.width, height: info.height, blend: s.blend, alpha: info.alpha, colorFilters: color })
    const inputs = ['-i', inputPath, '-i', lo, '-f', 'concat', '-safe', '0', '-i', list]
    const common = ['-map', '0:a:0?', '-fps_mode', 'passthrough', '-frames:v', String(frames)]
    const audioCopyOk = !info.audioCodec || ['aac', 'mp3', 'alac'].includes(info.audioCodec)
    const outputs = info.alpha
      ? [
          '-filter_complex',
          `${filter};[out]split[mov][web]`,
          '-map', '[mov]', ...common, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', ...REC709_OUTPUT_ARGS, '-c:a', 'pcm_s16le', tmpOut,
          '-map', '[web]', ...common, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', ...REC709_OUTPUT_ARGS, '-c:a', 'libopus', tmpPreview!
        ]
      : [
          '-filter_complex',
          `${filter};[out]format=yuv420p[v]`,
          '-map', '[v]', ...common, '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', ...REC709_OUTPUT_ARGS,
          ...(audioCopyOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
          '-movflags', '+faststart', tmpOut
        ]
    await run(['-y', ...inputs, ...outputs], (t) => onProgress?.(W_PREP + W_SEG + W_COMP * Math.min(1, t / total)))

    await fs.rename(tmpOut, outPath)
    if (tmpPreview && previewOut) await fs.rename(tmpPreview, previewOut)
    await writeMeta('motionblur', key, src)
    onProgress?.(1)
    return { ok: true, outputPath: outPath, previewPath: previewOut, hasAlpha: info.alpha }
  } catch (err) {
    await fs.unlink(tmpOut).catch(() => {})
    if (tmpPreview) await fs.unlink(tmpPreview).catch(() => {})
    if (job.cancelled) return { ok: false, cancelled: true, error: CANCELLED }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    running.delete(job)
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/** Runs ffmpeg with `-progress pipe:1`, reporting output time (s) and frame count; tracked for cancel. */
function runFfmpeg(
  job: { cancelled: boolean; procs: Set<ChildProcess> },
  args: string[],
  onTime?: (sec: number) => void,
  onFrame?: (n: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error(CANCELLED))
    const proc = spawn(ffmpegPath as string, ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    job.procs.add(proc)
    let stderr = ''
    proc.stderr!.on('data', (c) => (stderr = (stderr + c).slice(-2000)))
    proc.stdout!.on('data', (c: Buffer) => {
      const text = c.toString()
      const t = parseProgressSeconds(text)
      if (t !== null) onTime?.(t)
      const f = /frame=(\d+)/g
      let m: RegExpExecArray | null
      let last: number | null = null
      while ((m = f.exec(text))) last = Number(m[1])
      if (last !== null) onFrame?.(last)
    })
    proc.on('error', reject)
    proc.on('close', (code, signal) => {
      job.procs.delete(proc)
      if (code === 0) resolve()
      else reject(new Error(job.cancelled ? CANCELLED : `ffmpeg exited ${code ?? signal}: ${stderr.trim().slice(-400)}`))
    })
  })
}

/** Display size (rotation applied, as ffmpeg autorotates), frame rate, alpha, audio codec, colour tags. */
function sourceInfo(filePath: string): Promise<SourceInfo | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath])
    let out = ''
    proc.stdout.on('data', (c) => (out += c))
    proc.on('error', () => resolve(null))
    proc.on('close', () => {
      try {
        const json = JSON.parse(out) as {
          streams?: Record<string, unknown>[]
          format?: { duration?: string }
        }
        const streams = json.streams ?? []
        const v = streams.find((st) => st.codec_type === 'video' && !(st.disposition as { attached_pic?: number } | undefined)?.attached_pic)
        if (!v) return resolve(null)
        const a = streams.find((st) => st.codec_type === 'audio')
        let width = Number(v.width) || 0
        let height = Number(v.height) || 0
        const sideRot = ((v.side_data_list as { rotation?: number }[] | undefined) ?? []).find((d) => d.rotation !== undefined)?.rotation
        const rot = Math.abs(Number(sideRot ?? (v.tags as { rotate?: string } | undefined)?.rotate ?? 0)) % 180
        if (rot === 90) [width, height] = [height, width]
        const pixFmt = String(v.pix_fmt ?? '')
        const tag = (k: string) => {
          const val = v[k]
          return typeof val === 'string' && val !== 'unknown' && val !== 'reserved' ? val : undefined
        }
        const color = { primaries: tag('color_primaries'), transfer: tag('color_transfer'), matrix: tag('color_space'), range: tag('color_range') }
        resolve({
          width,
          height,
          fps: pickFrameRate(v.r_frame_rate as string, v.avg_frame_rate as string),
          durationSec: Number(v.duration) || Number(json.format?.duration) || 0,
          alpha: /^(yuva|gbrap|ya[0-9])|rgba|argb|bgra|abgr/.test(pixFmt),
          audioCodec: a ? String(a.codec_name) : undefined,
          color: Object.values(color).some(Boolean) ? color : undefined
        })
      } catch {
        resolve(null)
      }
    })
  })
}
