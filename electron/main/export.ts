import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { ffmpegPath } from './binaries'
import { buildFfmpegPlan, planToFfmpegArgs } from '@shared/ffmpegGraph'
import { projectDuration, type Project } from '@shared/types'
import type { ExportProgress, ExportResult } from '@shared/ipc'
import type { TextOverlayInput } from '@shared/ffmpegGraph'

export function exportProject(
  project: Project,
  outputPath: string,
  onProgress: (p: ExportProgress) => void,
  textOverlay?: TextOverlayInput,
  range?: { start: number; end: number }
): Promise<ExportResult> {
  const totalDuration = Math.max(range ? range.end - range.start : projectDuration(project), 0.1)

  let plan
  try {
    plan = buildFfmpegPlan(project, { textOverlay, lutDir: path.join(app.getPath('userData'), 'Cache', 'luts') })
    for (const f of plan.files ?? []) {
      mkdirSync(path.dirname(f.path), { recursive: true })
      writeFileSync(f.path, f.content)
    }
  } catch (err) {
    return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }

  if (!ffmpegPath) {
    return Promise.resolve({ ok: false, error: 'ffmpeg binary not found (ffmpeg-static did not resolve a path)' })
  }
  const resolvedFfmpegPath: string = ffmpegPath

  const args = planToFfmpegArgs(plan, outputPath, range)

  return new Promise((resolve) => {
    onProgress({ ratio: 0, message: 'Starting ffmpeg…' })
    const proc = spawn(resolvedFfmpegPath, args)
    let stderr = ''

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/)
      if (match) {
        const [, h, m, s] = match
        const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s)
        const ratio = Math.min(seconds / totalDuration, 0.99)
        onProgress({ ratio, message: `Encoding… ${Math.round(ratio * 100)}%` })
      }
    })

    proc.on('error', (err) => {
      resolve({ ok: false, error: err.message })
    })

    proc.on('close', (code) => {
      if (code === 0) {
        onProgress({ ratio: 1, message: 'Done' })
        resolve({ ok: true, outputPath })
      } else {
        const tail = stderr.split('\n').slice(-20).join('\n')
        resolve({ ok: false, error: `ffmpeg exited with code ${code}\n${tail}` })
      }
    })
  })
}

/**
 * "Extract audio": copies a file's audio into `<userData>/Extracted audio/<name> (audio).m4a`
 * (AAC; stream-copied when it already is AAC, so it's instant and lossless). Returns the path.
 */
export async function extractAudio(inputPath: string): Promise<{ ok: boolean; outputPath?: string; error?: string }> {
  if (!ffmpegPath) return { ok: false, error: 'ffmpeg not available' }
  const dir = path.join(app.getPath('userData'), 'Extracted audio')
  await fs.mkdir(dir, { recursive: true })
  const base = path.basename(inputPath, path.extname(inputPath))
  let out = path.join(dir, `${base} (audio).m4a`)
  for (let i = 2; await fs.access(out).then(() => true, () => false); i++) out = path.join(dir, `${base} (audio ${i}).m4a`)
  const run = (codecArgs: string[]) =>
    new Promise<boolean>((resolve) => {
      const proc = spawn(ffmpegPath as string, ['-y', '-v', 'error', '-i', inputPath, '-vn', '-map', '0:a:0', ...codecArgs, out])
      proc.on('error', () => resolve(false))
      proc.on('close', (code) => resolve(code === 0))
    })
  if ((await run(['-c:a', 'copy'])) || (await run(['-c:a', 'aac', '-b:a', '256k']))) return { ok: true, outputPath: out }
  await fs.unlink(out).catch(() => {})
  return { ok: false, error: "the file has no audio track ffmpeg can read" }
}
