import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync, { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, net } from 'electron'
import { ffmpegPath } from './binaries'
import type { BackgroundStatus, BackgroundResult, MattingModelId } from '@shared/ipc'
import { cacheKey, entryPath, stampSource, writeMeta } from './cache'
import { matteToGray, parseDurationSec, parseFps, rgbToNchw, smoothMatte } from '@shared/matte'

/**
 * Local, fully-offline background removal (per-frame foreground matting) for video clips.
 *
 * Pipeline: ffmpeg decodes frames → ONNX matte per frame (MODNet for people, ISNet for anything) → matte scaled to the frame
 * and merged as alpha → reassembled at the SOURCE fps as ProRes 4444 (export) plus a
 * VP9+alpha WebM (preview, since Chromium can't decode ProRes). Output is content-keyed in
 * `<userData>/Cache/mattes/`. The renderer applies it to one clip via `sourceOverride` (CapCut swaps
 * a timeline material's path the same way); audio keeps coming from the original source.
 *
 * Verified on real files: a 3 s 1440x2560 30 fps phone clip bakes in ~10 s with the People model
 * (~87 s with Any subject), every source frame is kept, alpha is 0xff on the subject and 0x00 on the
 * background, fps/duration match the source, and an unchanged source re-bakes from cache
 * in ~10 ms. Every frame of the clip is matted, so the cutout follows the subject throughout.
 *
 * Needs the optional `onnxruntime-node` package (prebuilt darwin-arm64, no compile; not installed
 * by default to keep the base app light) plus a one-time model download (25 MB / 170 MB). When either is
 * missing this reports cleanly instead of failing.
 */

/** One matting network: where to get it and how to feed it. Both are Apache-2.0. */
interface MattingModel {
  id: MattingModelId
  label: string
  description: string
  file: string
  url: string
  sizeMB: number
  /** 'fixed': squash to size x size. 'aspect': keep the frame's aspect, long side = size, both
   *  sides rounded to a multiple of 32 (MODNet's stride). */
  resize: 'fixed' | 'aspect'
  size: number
  mean: [number, number, number]
  std: [number, number, number]
  /** 'alpha': output already is a 0..1 matte. 'minmax': saliency map, stretch to 0..1. */
  output: 'alpha' | 'minmax'
}

// Benchmarked on real CapCut talking-head and screen-recording frames (M-series CPU, onnxruntime-
// node): MODNet ~130 ms/frame with clean hair edges and no background leakage; ISNet ~870 ms/frame,
// works on non-human subjects but let some background through on people. (u2netp, the previous
// model, was as fast as MODNet but haloed badly; BiRefNet-lite was ~12 s/frame — too slow for video.)
export const MATTING_MODELS: Record<MattingModelId, MattingModel> = {
  person: {
    id: 'person',
    label: 'People',
    description: 'Best for people. Fast, clean hair and edges.',
    file: 'modnet.onnx',
    url: 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx',
    sizeMB: 25,
    resize: 'aspect',
    size: 512,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    output: 'alpha'
  },
  general: {
    id: 'general',
    label: 'Any subject',
    description: 'Objects, pets, products. About 7× slower.',
    file: 'isnet-general-use.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
    sizeMB: 170,
    resize: 'fixed',
    size: 1024,
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    output: 'minmax'
  }
}

/**
 * macOS: Apple's Vision framework does both cutouts on the Neural Engine via the bundled
 * `anycut-matte` helper (native/matte/main.swift): ~3× faster than MODNet for people and ~40×
 * faster than ISNet for any subject on Apple Silicon, with full-resolution masks and no model
 * download. Elsewhere, or if the helper is missing, the ONNX models below run instead.
 */
const VISION_MODE: Record<MattingModelId, 'person' | 'subject'> = { person: 'person', general: 'subject' }
/** Frame size fed to Vision (long side). Its masks come back at about this size and are scaled to
 *  the source by the encoder. */
const VISION_INPUT_SIZE = 1280

function visionHelperPath(): string | null {
  if (process.platform !== 'darwin') return null
  const p = app.isPackaged ? path.join(process.resourcesPath, 'anycut-matte') : path.join(app.getAppPath(), 'native-bin', 'anycut-matte')
  return fsSync.existsSync(p) ? p : null
}

/** "Any subject" needs macOS 14 (Sonoma); Darwin 23 = macOS 14. */
function visionSupports(id: MattingModelId): boolean {
  if (!visionHelperPath()) return false
  return id === 'person' || Number(os.release().split('.')[0]) >= 23
}

function modelsDir(): string {
  return path.join(app.getPath('userData'), 'models')
}
function modelPath(id: MattingModelId): string {
  return path.join(modelsDir(), MATTING_MODELS[id].file)
}

/** Network input dims for a frame. MODNet keeps the aspect ratio (a squashed portrait loses edge
 *  detail); ISNet is trained on a fixed square. */
function inputDims(m: MattingModel, frameW: number, frameH: number): { w: number; h: number } {
  if (m.resize === 'fixed' || !frameW || !frameH) return { w: m.size, h: m.size }
  const scale = m.size / Math.max(frameW, frameH)
  const r32 = (v: number) => Math.max(32, Math.round((v * scale) / 32) * 32)
  return { w: r32(frameW), h: r32(frameH) }
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

/** Minimal shape of the bits of onnxruntime-node we use (avoids a hard type dependency on the
 *  optional package, which may not be installed). */
interface OrtTensor {
  data: Float32Array
}
interface OrtModule {
  InferenceSession: {
    create(path: string): Promise<{
      inputNames: string[]
      outputNames: string[]
      run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>
    }>
  }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown
}

/** Lazily resolve the optional onnxruntime-node dependency. Returns null if it isn't installed. */
async function loadOnnx(): Promise<OrtModule | null> {
  try {
    // Dynamic import by a computed specifier so the bundler/type-checker doesn't require the
    // (heavy, optional) dependency to be present at build time.
    const specifier = 'onnxruntime-node'
    return (await import(/* @vite-ignore */ specifier)) as unknown as OrtModule
  } catch {
    return null
  }
}

/** Reports whether background removal can run: the ONNX runtime dep + which models are downloaded. */
export async function backgroundStatus(): Promise<BackgroundStatus> {
  const onnx = await loadOnnx()
  const models = await Promise.all(
    Object.values(MATTING_MODELS).map(async (m) =>
      visionSupports(m.id)
        ? {
            id: m.id,
            label: m.label,
            description: m.id === 'person' ? 'Best for people. Runs on your Mac\'s Neural Engine.' : 'Objects, pets, products. Runs on your Mac\'s Neural Engine.',
            sizeMB: 0,
            downloaded: true
          }
        : { id: m.id, label: m.label, description: m.description, sizeMB: m.sizeMB, downloaded: await fileExists(modelPath(m.id)) }
    )
  )
  const anyVision = models.some((m) => visionSupports(m.id))
  return {
    runtimeAvailable: onnx !== null || anyVision,
    models,
    installHint: onnx === null ? 'Install the local ML runtime to enable background removal: `npm i onnxruntime-node`.' : undefined
  }
}

/** Downloads a matting model once into the app data dir (idempotent, atomic). */
export async function downloadBackgroundModel(
  id: MattingModelId,
  onProgress?: (ratio: number) => void
): Promise<{ ok: boolean; error?: string }> {
  const model = MATTING_MODELS[id]
  if (!model) return { ok: false, error: `unknown model "${id}"` }
  const dest = modelPath(id)
  if (await fileExists(dest)) return { ok: true }
  await fs.mkdir(modelsDir(), { recursive: true })
  const tmp = `${dest}.download`
  try {
    await new Promise<void>((resolve, reject) => {
      const request = net.request(model.url)
      request.on('response', (response) => {
        const status = (response as unknown as { statusCode: number }).statusCode
        if (status >= 400) return reject(new Error(`model download failed: HTTP ${status}`))
        const lenHeader = response.headers['content-length']
        const total = Number(Array.isArray(lenHeader) ? lenHeader[0] : lenHeader) || model.sizeMB * 1024 * 1024
        let received = 0
        const out = createWriteStream(tmp)
        response.on('data', (c) => {
          out.write(c)
          received += c.length
          onProgress?.(Math.min(1, received / total))
        })
        response.on('end', () => {
          out.end()
          out.on('finish', () => resolve())
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end()
    })
    await fs.rename(tmp, dest)
    // The old u2netp model is no longer used.
    await fs.unlink(path.join(modelsDir(), 'u2netp.onnx')).catch(() => {})
    return { ok: true }
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Spawned ffmpeg with its stderr tail kept for error messages; `done` settles on exit. */
function startFfmpeg(args: string[], stdin: 'pipe' | 'ignore' = 'ignore') {
  if (!ffmpegPath) throw new Error('ffmpeg not available')
  const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: [stdin, 'pipe', 'pipe'] })
  let stderr = ''
  proc.stderr!.on('data', (c) => (stderr = (stderr + c).slice(-2000)))
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code ?? signal}: ${stderr.trim().slice(-300)}`))
    )
  })
  done.catch(() => {}) // observed by the caller; avoid an unhandled rejection if it never awaits
  return { proc, done }
}

/** Writes to a child's stdin honoring backpressure (so a long clip never buffers in memory). */
function writeChunk(stream: NodeJS.WritableStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    stream.once('error', onError)
    const flushed = stream.write(chunk, (err) => {
      if (err) reject(err)
    })
    const finish = () => {
      stream.removeListener('error', onError)
      resolve()
    }
    if (flushed) finish()
    else stream.once('drain', finish)
  })
}

/**
 * Removes the background from a video: an alpha ProRes 4444 .mov (export) plus a VP9+alpha WebM
 * (preview), both content-keyed in the cache.
 *
 * Streamed, three processes running concurrently with nothing per-frame on disk:
 *   decoder ffmpeg  → raw RGB frames already scaled to the network's input size (stdout)
 *   this process    → ONNX matte per frame, edge-flicker smoothing → raw gray mattes
 *   encoder ffmpeg  ← mattes on stdin + the source decoded at full res; scales each matte up,
 *                     alphamerges, and writes BOTH outputs in one pass (split filter).
 * Both sides re-time frames to index / fps, so the matte for frame N always merges with source
 * frame N even on variable-frame-rate phone footage. (The old pipeline wrote two PNGs and spawned
 * two ffmpegs per frame; that overhead was ~70% of the run time with the fast People model.)
 *
 * Returns ok:false with a reason when the runtime/model aren't available (graceful).
 */
export async function removeBackground(
  inputPath: string,
  modelId: MattingModelId,
  onProgress?: (ratio: number) => void
): Promise<BackgroundResult> {
  const model = MATTING_MODELS[modelId]
  if (!model) return { ok: false, error: `unknown model "${modelId}"` }
  const vision = visionSupports(modelId) ? visionHelperPath() : null
  const onnx = vision ? null : await loadOnnx()
  if (!vision) {
    if (!onnx) return { ok: false, error: 'Local ML runtime (onnxruntime-node) is not installed.' }
    if (!(await fileExists(modelPath(modelId)))) return { ok: false, error: `The ${model.label} model isn't downloaded yet.` }
  }

  // The bake is content-keyed like every other derived artifact: re-running on an unchanged source
  // returns the cached file instantly, and the output survives restarts (it's referenced by the
  // clip's sourceOverride, so it must not live in a temp dir that gets wiped).
  const src = await stampSource(inputPath)
  if (!src) return { ok: false, error: 'source file is missing' }
  // Model is part of the key: the same clip can be baked with either model.
  const key = `${cacheKey('mattes', src)}-${modelId}${vision ? '-vision' : ''}`
  const outPath = await entryPath('mattes', key, '.mov')
  const previewOut = await entryPath('mattes', key, '.webm')
  if ((await fileExists(outPath)) && (await fileExists(previewOut))) return { ok: true, outputPath: outPath, previewPath: previewOut }

  const { fps, width, height, durationSec } = await sourceInfo(inputPath)
  const dims = vision ? visionDims(width, height) : inputDims(model, width, height)
  const pixels = dims.w * dims.h
  // Vision takes BGRA frames, the ONNX path planar-ready RGB.
  const frameBytes = pixels * (vision ? 4 : 3)
  const expectedFrames = Math.max(1, Math.round(durationSec * (parseFps(fps) || 30)))
  // Frame index → seconds at the source rate, applied to both the source and the matte stream.
  const retime = `setpts=N/(${fps})/TB`
  // Matte → full frame size. An explicit scale, not scale2ref: scale2ref (deprecated) emitted a
  // duplicate final frame when the mattes arrive slowly over the pipe. Display size is known from
  // the probe; scale2ref is only the fallback for a source we couldn't size.
  const merge =
    width && height
      ? `[0:v:0]${retime}[rgb];[1:v]${retime},scale=${width}:${height}:flags=bicubic[a]`
      : `[0:v:0]${retime}[rgb0];[1:v]${retime}[a0];[a0][rgb0]scale2ref=flags=bicubic[a][rgb]`
  const tmpMov = `${outPath}.tmp.mov`
  const tmpWebm = `${previewOut}.tmp.webm`

  let decoder: ReturnType<typeof startFfmpeg> | null = null
  let encoder: ReturnType<typeof startFfmpeg> | null = null
  let helper = null as ChildProcessWithoutNullStreams | null
  try {
    const session = onnx ? await onnx.InferenceSession.create(modelPath(modelId)) : null

    decoder = startFfmpeg(['-i', inputPath, '-map', '0:v:0', '-vf', `scale=${dims.w}:${dims.h}`, '-fps_mode', 'passthrough', '-pix_fmt', vision ? 'bgra' : 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    encoder = startFfmpeg(
      [
        '-y',
        '-i',
        inputPath,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-s',
        `${dims.w}x${dims.h}`,
        '-framerate',
        fps,
        '-i',
        'pipe:0',
        '-filter_complex',
        // No -shortest: phone audio often ends a frame or two before the video, and trimming to it
        // would drop the clip's last frames (the timeline's audio comes from the original anyway).
        `${merge};[rgb][a]alphamerge=shortest=1,split[mov][web]`,
        // Export master: ProRes 4444 with alpha, PCM audio (always valid in MOV).
        '-map',
        '[mov]',
        '-map',
        '0:a?',
        '-fps_mode',
        'passthrough',
        '-c:v',
        'prores_ks',
        '-profile:v',
        '4444',
        '-pix_fmt',
        'yuva444p10le',
        '-c:a',
        'pcm_s16le',
        tmpMov,
        // Preview: Chromium can't decode ProRes 4444, but it plays VP9 with alpha in WebM.
        '-map',
        '[web]',
        '-map',
        '0:a?',
        '-fps_mode',
        'passthrough',
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuva420p',
        '-b:v',
        '0',
        '-crf',
        '34',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-row-mt',
        '1',
        '-c:a',
        'libopus',
        tmpWebm
      ],
      'pipe'
    )
    const encIn = encoder.proc.stdin!
    // A failed encoder surfaces as an EPIPE on write; prefer its real stderr in that case.
    const encoderFailed = encoder.done.then(
      () => null,
      (err: Error) => err
    )

    const input = new Float32Array(3 * pixels)
    let prevGray: Uint8Array | null = null
    let pending: Buffer = Buffer.alloc(0)
    let frames = 0

    const emitMatte = async (raw: Uint8Array) => {
      const gray = smoothMatte(raw, prevGray)
      prevGray = gray
      await writeChunk(encIn, gray)
      frames++
      onProgress?.(Math.min(0.99, frames / expectedFrames))
    }
    const processFrame = async (rgb: Uint8Array) => {
      rgbToNchw(rgb, pixels, model.mean, model.std, input)
      const tensor = new onnx!.Tensor('float32', input, [1, 3, dims.h, dims.w])
      const results = await session!.run({ [session!.inputNames[0]]: tensor })
      await emitMatte(matteToGray(results[session!.outputNames[0]].data, model.output))
    }

    try {
      if (vision) {
        // decoder → helper (Vision) → here (temporal smoothing, progress) → encoder.
        const h = spawn(vision, [VISION_MODE[modelId], String(dims.w), String(dims.h)])
        helper = h
        let helperErr = ''
        h.stderr.on('data', (c) => (helperErr = (helperErr + c).slice(-500)))
        const helperDone = new Promise<void>((resolve, reject) => {
          h.on('error', reject)
          h.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`background removal helper exited ${code}: ${helperErr.trim()}`))))
        })
        helperDone.catch(() => {})
        decoder.proc.stdout!.pipe(h.stdin)
        h.stdin.on('error', () => {}) // surfaces through helperDone
        for await (const chunk of h.stdout as AsyncIterable<Buffer>) {
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
          let off = 0
          while (pending.length - off >= pixels) {
            await emitMatte(new Uint8Array(pending.subarray(off, off + pixels)))
            off += pixels
          }
          pending = off ? pending.subarray(off) : pending
        }
        await helperDone
      } else {
        for await (const chunk of decoder.proc.stdout! as AsyncIterable<Buffer>) {
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
          let off = 0
          while (pending.length - off >= frameBytes) {
            await processFrame(pending.subarray(off, off + frameBytes))
            off += frameBytes
          }
          pending = off ? pending.subarray(off) : pending
        }
      }
      await decoder.done
      if (frames === 0) throw new Error('no frames decoded')
      encIn.end()
      await encoder.done
    } catch (err) {
      const encErr = await Promise.race([encoderFailed, new Promise<null>((r) => setTimeout(() => r(null), 200))])
      throw encErr ?? err
    }

    await fs.rename(tmpMov, outPath)
    await fs.rename(tmpWebm, previewOut)
    await writeMeta('mattes', key, src)
    onProgress?.(1)
    return { ok: true, outputPath: outPath, previewPath: previewOut }
  } catch (err) {
    decoder?.proc.kill('SIGKILL')
    encoder?.proc.kill('SIGKILL')
    helper?.kill('SIGKILL')
    await fs.unlink(tmpMov).catch(() => {})
    await fs.unlink(tmpWebm).catch(() => {})
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Vision input size: the frame's aspect, long side VISION_INPUT_SIZE (never upscaled), even sides. */
function visionDims(frameW: number, frameH: number): { w: number; h: number } {
  if (!frameW || !frameH) return { w: VISION_INPUT_SIZE, h: VISION_INPUT_SIZE }
  const k = Math.min(1, VISION_INPUT_SIZE / Math.max(frameW, frameH))
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2)
  return { w: even(frameW), h: even(frameH) }
}

/** Source frame rate as an ffmpeg rational (e.g. "30000/1001"), so the bake keeps exactly the
 *  source's timing (falls back to 30), plus the display size (0 when unknown) and duration. */
function sourceInfo(inputPath: string): Promise<{ fps: string; width: number; height: number; durationSec: number }> {
  return new Promise((resolveInfo) => {
    let width = 0
    let height = 0
    let durationSec = 0
    const resolve = (fps: string) => resolveInfo({ fps, width, height, durationSec })
    if (!ffmpegPath) return resolve('30')
    const proc = spawn(ffmpegPath, ['-i', inputPath])
    let stderr = ''
    proc.stderr.on('data', (c) => (stderr += c))
    proc.on('error', () => resolve('30'))
    proc.on('close', () => {
      durationSec = parseDurationSec(stderr)
      const size = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(stderr)
      if (size) {
        width = Number(size[1])
        height = Number(size[2])
        // Phone footage is often stored landscape with a 90°/270° rotation; size the matte input
        // for how it actually displays.
        if (/rotation of -?90|rotation of -?270|rotate\s*:\s*-?(90|270)/.test(stderr)) [width, height] = [height, width]
      }
      // ffmpeg prints e.g. "29.97 fps" / "30 fps" / "23.98 fps" on the video stream line.
      const m = /, (\d+(?:\.\d+)?) fps/.exec(stderr)
      if (!m) return resolve('30')
      const v = Number(m[1])
      // Map the common NTSC rates back to their exact rationals.
      const ntsc: Record<string, string> = { '29.97': '30000/1001', '23.98': '24000/1001', '59.94': '60000/1001' }
      resolve(ntsc[m[1]] ?? String(v))
    })
  })
}
