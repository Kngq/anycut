/**
 * Speech-to-text worker for auto-captions. It runs as an Electron utilityProcess, forked by
 * captions.ts, so model loading and inference never block the main process (which also serves
 * preview media over anycut-media://).
 *
 * Engine: Whisper base (multilingual) via transformers.js on onnxruntime-node. That's prebuilt
 * native code with no compiler and no Homebrew, and it runs fully on this machine. The model
 * (~136 MB) is fetched from Hugging Face on first use into `cacheDir` and read from there after
 * that. The `_timestamped` export carries the cross-attention outputs needed for per-word times.
 *
 * Protocol (parentPort messages):
 *   in : { type: 'transcribe', id, samplesPath, language, cacheDir }  (samplesPath: raw f32le 16 kHz mono)
 *   out: { type: 'progress', id, phase: 'download' | 'transcribe', ratio }
 *        { type: 'result', id, words: { text, start, end }[] }      (seconds into the samples)
 *        { type: 'error', id, message }
 */
import fs from 'node:fs/promises'
import { chunksToWords, spreadPhraseWords, wordAlignmentFailed, type AsrChunk, type CaptionWord } from '@shared/captions'

const MODEL_ID = 'onnx-community/whisper-base_timestamped'
const SAMPLE_RATE = 16000
/** Whisper sees 30 s at a time. transformers.js's own chunking drops most words when asked for
 *  word timestamps (measured: 21 words out of ~280 in 111 s), so we window the audio ourselves,
 *  cutting at the quietest point in the last few seconds of each window so no word is split. */
const WINDOW_S = 28
const CUT_SEARCH_S = 4

type Port = { on(ev: 'message', cb: (e: { data: unknown }) => void): void; postMessage(msg: unknown): void }
const port = (process as unknown as { parentPort: Port }).parentPort

type Asr = ((audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: AsrChunk[] }>) & { model?: TimestampModel }
type TimestampModel = { _extract_token_timestamps?: (outputs: unknown, heads: unknown, numFrames?: number | null, precision?: number) => unknown }

/**
 * Works around a transformers.js 3.x bug that made word timestamps fail on real clips.
 * The pipeline passes `num_frames` as the input's MEL frame count (samples / 160, 100 per
 * second), and `_extract_token_timestamps` crops the cross-attention to that many ENCODER frames
 * (which run at 50 per second). For any input over 15 s that crop covers the whole padded 30 s,
 * so the DTW also aligns against the silent padding, and on some clips it pushes every word
 * to 29.98 s. Those times sit past the end of the clip, the words get dropped, and the panel
 * says "no speech". The Python reference halves the count (`weights[..., : num_frames // 2]`),
 * so do the same here.
 */
function fixWordTimestampCrop(asr: Asr) {
  const model = asr.model
  const original = model?._extract_token_timestamps
  if (!model || typeof original !== 'function') return
  model._extract_token_timestamps = (outputs, heads, numFrames, precision) =>
    original.call(model, outputs, heads, typeof numFrames === 'number' && numFrames > 0 ? Math.ceil(numFrames / 2) : numFrames, precision)
}
let asrPromise: Promise<Asr> | null = null

function loadAsr(cacheDir: string, onProgress: (ratio: number) => void): Promise<Asr> {
  if (!asrPromise) {
    asrPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.cacheDir = cacheDir
      env.allowLocalModels = false
      // Aggregate byte progress across the model's files.
      const files = new Map<string, { loaded: number; total: number }>()
      const asr = await pipeline('automatic-speech-recognition', MODEL_ID, {
        // fp32 encoder (quantising it costs accuracy), 8-bit decoder (most of the speed win).
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status !== 'progress' || !p.file || !p.total) return
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total })
          let loaded = 0
          let total = 0
          for (const f of files.values()) {
            loaded += f.loaded
            total += f.total
          }
          onProgress(total > 0 ? loaded / total : 0)
        }
      })
      fixWordTimestampCrop(asr as unknown as Asr)
      return asr as unknown as Asr
    })()
    asrPromise.catch(() => (asrPromise = null))
  }
  return asrPromise
}

/** [start, end) sample windows of at most WINDOW_S, each ending at a low-energy point. */
export function audioWindows(audio: Float32Array, windowS = WINDOW_S, searchS = CUT_SEARCH_S): [number, number][] {
  const out: [number, number][] = []
  const frame = Math.round(0.02 * SAMPLE_RATE)
  let s = 0
  while (s < audio.length) {
    let e = Math.min(audio.length, s + windowS * SAMPLE_RATE)
    if (e < audio.length) {
      let best = e
      let bestEnergy = Infinity
      for (let p = Math.max(s + frame, e - searchS * SAMPLE_RATE); p + frame <= e; p += frame / 2) {
        let energy = 0
        for (let k = p; k < p + frame; k++) energy += audio[k] * audio[k]
        if (energy < bestEnergy) {
          bestEnergy = energy
          best = p + frame / 2
        }
      }
      e = Math.floor(best)
    }
    out.push([s, e])
    s = e
  }
  return out
}

async function transcribe(msg: { id: string; samplesPath: string; language: string; cacheDir: string }) {
  const progress = (phase: 'download' | 'transcribe', ratio: number) => port.postMessage({ type: 'progress', id: msg.id, phase, ratio })
  const asr = await loadAsr(msg.cacheDir, (r) => progress('download', r))
  const buf = await fs.readFile(msg.samplesPath)
  // A Float32Array view needs a 4-byte-aligned offset; copy in the (rare) case it isn't.
  const n = Math.floor(buf.length / 4)
  const audio = buf.byteOffset % 4 === 0 ? new Float32Array(buf.buffer, buf.byteOffset, n) : new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4))
  const words: CaptionWord[] = []
  const windows = audioWindows(audio)
  for (let i = 0; i < windows.length; i++) {
    const [s, e] = windows[i]
    progress('transcribe', i / windows.length)
    // Skip near-silent windows: Whisper hallucinates text ("Thank you.") on silence.
    let peak = 0
    for (let k = s; k < e; k++) peak = Math.max(peak, Math.abs(audio[k]))
    if (peak < 0.01) continue
    const slice = audio.subarray(s, e)
    const opts = { task: 'transcribe', ...(msg.language && msg.language !== 'auto' ? { language: msg.language } : {}) }
    const offset = s / SAMPLE_RATE
    const duration = (e - s) / SAMPLE_RATE
    const out = await asr(slice, { ...opts, return_timestamps: 'word' })
    const chunks = out.chunks ?? []
    if (wordAlignmentFailed(chunks, duration)) {
      // Still failed: fall back to phrase times (Whisper's timestamp tokens) spread over words.
      const phrases = await asr(slice, { ...opts, return_timestamps: true })
      words.push(...spreadPhraseWords(phrases.chunks ?? [], offset, duration))
    } else {
      words.push(...chunksToWords(chunks, offset, duration))
    }
  }
  progress('transcribe', 1)
  return words
}

port.on('message', (e) => {
  const msg = e.data as { type: string; id: string; samplesPath: string; language: string; cacheDir: string }
  if (msg.type !== 'transcribe') return
  transcribe(msg).then(
    (words) => port.postMessage({ type: 'result', id: msg.id, words }),
    (err: unknown) => port.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
  )
})
