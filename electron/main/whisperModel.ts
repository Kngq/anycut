/**
 * The Whisper caption model, downloaded and verified by anycut itself.
 *
 * transformers.js's own download cache keeps whatever bytes it got: a download cut short (app quit,
 * network drop) left a truncated encoder_model.onnx that then failed every run with "Protobuf
 * parsing failed", forever. So the files are fetched here instead: each one streams to a temp file,
 * must match the server's Content-Length, and is renamed into place only when complete. A manifest
 * of the verified sizes is written last; a missing or mismatched file is simply fetched again. The
 * worker then loads the model with remote loading switched off, from this folder only.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export const WHISPER_MODEL_ID = 'onnx-community/whisper-base_timestamped'
/** Everything the pipeline reads for this model (fp32 encoder + 8-bit merged decoder). */
export const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
]
const MANIFEST = '.anycut-manifest.json'

function modelDir(cacheDir: string): string {
  return path.join(cacheDir, WHISPER_MODEL_ID)
}

async function sizeOf(p: string): Promise<number | null> {
  return fs.stat(p).then(
    (s) => s.size,
    () => null
  )
}

/** True when every file is present at the size recorded when it was verified. */
export async function whisperModelReady(cacheDir: string): Promise<boolean> {
  const dir = modelDir(cacheDir)
  let manifest: Record<string, number>
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8'))
  } catch {
    return false
  }
  for (const f of WHISPER_FILES) {
    if (manifest[f] === undefined || (await sizeOf(path.join(dir, f))) !== manifest[f]) return false
  }
  return true
}

/** Downloads whatever is missing or incomplete. `onProgress` gets 0..1 over the whole download. */
export async function ensureWhisperModel(cacheDir: string, onProgress?: (ratio: number) => void): Promise<void> {
  if (await whisperModelReady(cacheDir)) return
  const dir = modelDir(cacheDir)
  await fs.mkdir(path.join(dir, 'onnx'), { recursive: true })
  let manifest: Record<string, number> = {}
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8'))
  } catch {
    manifest = {}
  }
  // Sizes first (HEAD), so progress covers the whole download and complete files are kept.
  const base = `https://huggingface.co/${WHISPER_MODEL_ID}/resolve/main/`
  const expected = new Map<string, number>()
  for (const f of WHISPER_FILES) {
    const res = await fetch(base + f, { method: 'HEAD', redirect: 'follow' })
    if (!res.ok) throw new Error(`model download failed: HTTP ${res.status} for ${f}`)
    expected.set(f, Number(res.headers.get('x-linked-size') ?? res.headers.get('content-length') ?? 0))
  }
  const todo: string[] = []
  for (const f of WHISPER_FILES) {
    const want = expected.get(f)!
    if (!want || (await sizeOf(path.join(dir, f))) !== want) todo.push(f)
    else manifest[f] = want
  }
  const total = todo.reduce((n, f) => n + (expected.get(f) || 0), 0) || 1
  let done = 0
  for (const f of todo) {
    const dest = path.join(dir, f)
    const tmp = `${dest}.download`
    const res = await fetch(base + f, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status} for ${f}`)
    const handle = await fs.open(tmp, 'w')
    let got = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        await handle.write(chunk)
        got += chunk.length
        done += chunk.length
        onProgress?.(Math.min(0.999, done / total))
      }
    } finally {
      await handle.close()
    }
    const want = expected.get(f) || got
    if (got !== want) {
      await fs.unlink(tmp).catch(() => {})
      throw new Error(`model download was incomplete (${f}: ${got} of ${want} bytes). Check your connection and try again.`)
    }
    await fs.rename(tmp, dest)
    manifest[f] = got
  }
  await fs.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2))
  onProgress?.(1)
}
