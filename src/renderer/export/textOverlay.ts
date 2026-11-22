import type { Project } from '@shared/types'
import { drawTextLayer, preloadCaptionFonts } from '../textRender'

/**
 * Bakes every text clip into a transparent PNG sequence for the export, using the exact renderer
 * the preview uses (textRender.ts). Frames without text and frames identical to the previous
 * one aren't encoded again; the main process links them to an existing file.
 *
 * Returns the overlay job id to pass to exportProject, or null when the project has no text.
 */
export async function bakeTextOverlay(project: Project, onProgress: (ratio: number) => void, isCancelled: () => boolean = () => false): Promise<string | null> {
  const textClips = project.tracks.filter((t) => t.type === 'text' && !t.hidden).flatMap((t) => t.clips)
  if (textClips.length === 0) return null
  const end = Math.max(...textClips.map((c) => c.start + c.duration))
  const { width, height, fps } = project.canvas
  const frames = Math.ceil(end * fps)
  if (frames <= 0) return null

  await preloadCaptionFonts()
  await document.fonts.ready

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas unavailable for the text overlay')
  const png = async () => new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())

  const id = await window.api.overlayBegin()
  try {
    ctx.clearRect(0, 0, width, height)
    await window.api.overlayBlank(id, await png())
    let lastHash: number | null = null
    for (let i = 0; i < frames; i++) {
      if (isCancelled()) throw new Error('cancelled')
      ctx.clearRect(0, 0, width, height)
      // Frame i shows time i/fps (the same sampling ffmpeg uses for the video).
      const drew = drawTextLayer(ctx as unknown as CanvasRenderingContext2D, project, i / fps, width, height)
      if (!drew) {
        await window.api.overlayFrame(id, i, 'blank')
        lastHash = null
      } else {
        const hash = frameHash(ctx.getImageData(0, 0, width, height).data)
        if (hash === lastHash) await window.api.overlayFrame(id, i, 'same')
        else await window.api.overlayFrame(id, i, await png())
        lastHash = hash
      }
      if (i % 5 === 0) onProgress(i / frames)
    }
    onProgress(1)
    return id
  } catch (err) {
    void window.api.overlayDiscard(id)
    throw err
  }
}

/** FNV-1a over the pixels as 32-bit words. Fast enough per frame, and a collision only
 *  repeats a frame that was visually identical anyway. */
function frameHash(px: Uint8ClampedArray): number {
  const words = new Uint32Array(px.buffer, px.byteOffset, px.byteLength >> 2)
  let h = 0x811c9dc5
  for (let i = 0; i < words.length; i++) {
    h ^= words[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
