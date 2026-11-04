import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import type { Waveform } from '@shared/ipc'
import { cacheKey, dedupe, entryPath, readJsonEntry, stampSource, writeFileAtomic, writeMeta } from './cache'

/**
 * Extracts an audio-waveform peak summary for a media file: decodes to mono 8 kHz PCM (s16le) and
 * reduces it to BUCKET_COUNT normalized peak magnitudes (0..1). The renderer draws these as a
 * symmetric bar graph under a clip's thumbnails. A fixed small bucket count keeps the JSON tiny
 * and is plenty of resolution once scaled across a clip — the renderer resamples to the clip's
 * pixel width.
 *
 * Cached in `<userData>/Cache/waveforms/<key>.json` (see cache.ts). CapCut keeps waveforms the
 * same way (`Cache/audioWave/<hash>.waveDataV2`) instead of recomputing them.
 */
const BUCKET_COUNT = 400
const SAMPLE_RATE = 8000

export async function ensureWaveform(filePath: string): Promise<Waveform | null> {
  if (!ffmpegPath) return null
  const src = await stampSource(filePath)
  if (!src) return null
  const key = cacheKey('waveforms', src)
  return dedupe(`waveforms:${key}`, async () => {
    const outPath = await entryPath('waveforms', key, '.json')
    const cached = await readJsonEntry<Waveform>(outPath)
    if (cached) return cached
    try {
      const pcm = await decodePcm(filePath)
      if (!pcm || pcm.length === 0) return null
      const waveform: Waveform = { peaks: reduceToPeaks(pcm, BUCKET_COUNT) }
      await writeFileAtomic(outPath, JSON.stringify(waveform))
      await writeMeta('waveforms', key, src)
      return waveform
    } catch (err) {
      console.error('[freecut] waveform generation failed for', filePath, err)
      return null
    }
  })
}

/** Runs ffmpeg to produce raw mono 16-bit little-endian PCM on stdout and collects it. */
function decodePcm(filePath: string): Promise<Int16Array | null> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-i', filePath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-']
    const proc = spawn(ffmpegPath as string, args)
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`))
      const buf = Buffer.concat(chunks)
      if (buf.length < 2) return resolve(null)
      // Copy into a fresh Int16Array: viewing buf.buffer directly throws when buf.byteOffset is
      // odd (Buffer.concat may return a slice of the shared pool at any offset).
      const n = Math.floor(buf.length / 2)
      const samples = new Int16Array(n)
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(i * 2)
      resolve(samples)
    })
  })
}

/** Reduces raw samples to `buckets` peak magnitudes in 0..1 (max |sample| per bucket / 32768). */
function reduceToPeaks(samples: Int16Array, buckets: number): number[] {
  const peaks = new Array<number>(buckets).fill(0)
  const per = samples.length / buckets
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * per)
    const end = Math.min(samples.length, Math.floor((i + 1) * per))
    let peak = 0
    for (let j = start; j < end; j++) {
      const v = Math.abs(samples[j])
      if (v > peak) peak = v
    }
    peaks[i] = peak / 32768
  }
  return peaks
}
