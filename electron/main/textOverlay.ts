import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/**
 * Storage for the text overlay the renderer bakes before an export. The renderer draws every
 * text clip with the same canvas code as the live preview (src/renderer/textRender.ts) and sends
 * the frames here as PNGs. ffmpeg then reads them as an image sequence and overlays it, so
 * exported captions match the preview exactly (fonts, outlines, shadows, per-word highlight,
 * animation), which drawtext can't do.
 *
 * Frames with no text, or identical to the previous frame, are hard links to an existing PNG, so
 * a long video with occasional captions costs little disk or encode time.
 */

interface Job {
  dir: string
  blank: string | null
  last: string | null
  frames: number
}

const jobs = new Map<string, Job>()
let counter = 0

export async function overlayBegin(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anycut-text-'))
  const id = `overlay-${++counter}`
  jobs.set(id, { dir, blank: null, last: null, frames: 0 })
  return id
}

const frameName = (dir: string, index: number) => path.join(dir, `${String(index).padStart(6, '0')}.png`)

/** Writes frame `index`: PNG bytes, 'blank' (no text) or 'same' (repeat the previous frame). */
export async function overlayFrame(id: string, index: number, data: Uint8Array | 'blank' | 'same'): Promise<void> {
  const job = jobs.get(id)
  if (!job) throw new Error('unknown overlay job')
  const out = frameName(job.dir, index)
  if (data === 'blank' || data === 'same') {
    const src = data === 'blank' ? job.blank : job.last
    if (!src) throw new Error(`overlay frame ${index}: nothing to repeat`)
    await fs.link(src, out).catch(() => fs.copyFile(src, out))
  } else {
    await fs.writeFile(out, data)
  }
  job.last = out
  job.frames = Math.max(job.frames, index + 1)
}

/** Stores the transparent frame used for every frame without text. */
export async function overlayBlank(id: string, data: Uint8Array): Promise<void> {
  const job = jobs.get(id)
  if (!job) throw new Error('unknown overlay job')
  job.blank = path.join(job.dir, 'blank.png')
  await fs.writeFile(job.blank, data)
}

/** The ffmpeg image-sequence pattern for a finished job, or null if it has no frames. */
export function overlayPattern(id: string): string | null {
  const job = jobs.get(id)
  return job && job.frames > 0 ? path.join(job.dir, '%06d.png') : null
}

export async function overlayDiscard(id: string): Promise<void> {
  const job = jobs.get(id)
  if (!job) return
  jobs.delete(id)
  await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {})
}
