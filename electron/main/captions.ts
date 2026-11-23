import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { ffmpegPath } from './binaries'
import { whisperModelReady } from './whisperModel'
import type { CaptionProgress, CaptionResult, CaptionStatus } from '@shared/ipc'
import type { CaptionSource, CaptionWord } from '@shared/captions'

/**
 * Local auto-captions, main-process side. For each clip to caption: ffmpeg extracts its trimmed
 * source range as 16 kHz mono float PCM, and the caption worker (captionWorker.ts, a
 * utilityProcess) transcribes it with Whisper and returns per-word times. Nothing leaves the
 * machine except the one-time model download (~136 MB from Hugging Face, cached under
 * <userData>/models/transformers and reused offline after that).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'models', 'transformers')
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

export async function captionStatus(): Promise<CaptionStatus> {
  return { modelDownloaded: await whisperModelReady(cacheDir()), modelName: 'Whisper base (multilingual)', modelSizeMB: 136 }
}

// ---- Worker lifecycle: one long-lived worker keeps the model in memory between runs. ----

let worker: UtilityProcess | null = null
const pending = new Map<string, { resolve: (w: CaptionWord[]) => void; reject: (e: Error) => void; onProgress: (phase: 'download' | 'transcribe', r: number) => void }>()

function getWorker(): UtilityProcess {
  if (worker) return worker
  const w = utilityProcess.fork(path.join(__dirname, 'captionWorker.js'), [], { serviceName: 'anycut-captions' })
  w.on('message', (msg: { type: string; id: string; phase?: 'download' | 'transcribe'; ratio?: number; words?: CaptionWord[]; message?: string }) => {
    const job = pending.get(msg.id)
    if (!job) return
    if (msg.type === 'progress') job.onProgress(msg.phase!, msg.ratio ?? 0)
    else if (msg.type === 'result') {
      pending.delete(msg.id)
      job.resolve(msg.words ?? [])
    } else if (msg.type === 'error') {
      pending.delete(msg.id)
      job.reject(new Error(msg.message))
    }
  })
  w.on('exit', (code) => {
    if (worker === w) worker = null
    for (const [id, job] of pending) {
      pending.delete(id)
      job.reject(new Error(cancelled ? 'cancelled' : `caption engine exited (code ${code})`))
    }
  })
  worker = w
  return w
}

export function stopCaptionWorker() {
  worker?.kill()
  worker = null
}

/** Extracts [from, to] of a file's audio as raw float32 little-endian, 16 kHz mono. */
function extractSamples(input: string, from: number, to: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg not available'))
    const args = ['-y', '-v', 'error', '-ss', String(from), '-t', String(Math.max(0.01, to - from)), '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', out]
    const proc = spawn(ffmpegPath, args)
    currentFfmpeg = proc
    let stderr = ''
    proc.stderr.on('data', (c) => (stderr += c))
    proc.on('error', reject)
    proc.on('close', (code) => {
      currentFfmpeg = null
      if (code === 0) resolve()
      else reject(new Error(cancelled ? 'cancelled' : `couldn't read audio from ${path.basename(input)}: ${stderr.slice(-200)}`))
    })
  })
}

let running = false
let cancelled = false
let currentFfmpeg: ReturnType<typeof spawn> | null = null
let jobCounter = 0

/** Stops a running transcription. The worker is killed (the model reloads from disk next time). */
export function cancelCaptions() {
  if (!running) return
  cancelled = true
  currentFfmpeg?.kill()
  stopCaptionWorker()
}

/** Transcribes each source's range. Words come back in SOURCE time (seconds into the file). */
export async function transcribeSources(sources: CaptionSource[], language: string, onProgress: (p: CaptionProgress) => void): Promise<CaptionResult> {
  if (running) return { ok: false, error: 'Captions are already being generated.' }
  running = true
  cancelled = false
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'anycut-captions-'))
  try {
    await fs.mkdir(cacheDir(), { recursive: true })
    const results: { clipId: string; words: CaptionWord[] }[] = []
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i]
      const base = { clipIndex: i, clipCount: sources.length }
      onProgress({ ...base, phase: 'extract', ratio: 0 })
      const samplesPath = path.join(work, `${i}.f32`)
      await extractSamples(src.path, src.from, src.to, samplesPath)
      if (cancelled) throw new Error('cancelled')
      const id = `job-${++jobCounter}`
      const words = await new Promise<CaptionWord[]>((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress: (phase, ratio) => onProgress({ ...base, phase, ratio }) })
        getWorker().postMessage({ type: 'transcribe', id, samplesPath, language, cacheDir: cacheDir() })
      })
      results.push({ clipId: src.clipId, words: words.map((w) => ({ text: w.text, start: w.start + src.from, end: w.end + src.from })) })
      await fs.rm(samplesPath, { force: true })
    }
    return { ok: true, results }
  } catch (err) {
    if (cancelled) return { ok: false, cancelled: true }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    running = false
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
