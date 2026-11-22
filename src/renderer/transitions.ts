import type { TransitionType } from '@shared/types'

/**
 * Canvas-2D renderers for each transition type, so the live preview matches what the exporter
 * produces with ffmpeg `xfade` (see transitionToXfade in shared/effects.ts). The outgoing clip
 * (A) and incoming clip (B) are each drawn to their own offscreen layer first; this module then
 * composites the two layers onto the main canvas for a linear progress `p` in 0..1.
 */

const layers: HTMLCanvasElement[] = []

/** Returns a reusable offscreen layer (index 0 = outgoing, 1 = incoming) sized w x h, cleared
 *  to transparent. */
export function getTransitionLayer(index: 0 | 1, w: number, h: number): CanvasRenderingContext2D | null {
  let c = layers[index]
  if (!c) {
    c = document.createElement('canvas')
    layers[index] = c
  }
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  } else {
    c.getContext('2d')?.clearRect(0, 0, w, h)
  }
  return c.getContext('2d')
}

export function transitionLayerCanvas(index: 0 | 1): HTMLCanvasElement {
  return layers[index]
}

/** Deterministic per-cell hash in [0,1) for the grainy dissolve. */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** Composites outgoing layer `a` and incoming layer `b` onto `ctx` for progress `p`. */
export function compositeTransition(
  ctx: CanvasRenderingContext2D,
  a: HTMLCanvasElement,
  b: HTMLCanvasElement,
  type: TransitionType,
  p: number,
  w: number,
  h: number
): void {
  p = Math.min(Math.max(p, 0), 1)
  switch (type) {
    case 'dipToBlack':
    case 'dipToWhite': {
      // Fade A out to the colour over the first half, then fade B in from it.
      ctx.save()
      ctx.fillStyle = type === 'dipToWhite' ? '#fff' : '#000'
      ctx.fillRect(0, 0, w, h)
      ctx.globalAlpha = p < 0.5 ? 1 - p * 2 : (p - 0.5) * 2
      ctx.drawImage(p < 0.5 ? a : b, 0, 0)
      ctx.restore()
      return
    }
    case 'dissolve': {
      // Grainy dissolve: B appears in randomly-ordered blocks as p grows.
      ctx.drawImage(a, 0, 0)
      const cell = Math.max(Math.round(Math.max(w, h) / 48), 4)
      const path = new Path2D()
      for (let cy = 0; cy * cell < h; cy++) {
        for (let cx = 0; cx * cell < w; cx++) {
          if (hash2(cx, cy) < p) path.rect(cx * cell, cy * cell, cell, cell)
        }
      }
      ctx.save()
      ctx.clip(path)
      ctx.drawImage(b, 0, 0)
      ctx.restore()
      return
    }
    case 'slideLeft':
      ctx.drawImage(a, -p * w, 0)
      ctx.drawImage(b, (1 - p) * w, 0)
      return
    case 'slideRight':
      ctx.drawImage(a, p * w, 0)
      ctx.drawImage(b, -(1 - p) * w, 0)
      return
    case 'slideUp':
      ctx.drawImage(a, 0, -p * h)
      ctx.drawImage(b, 0, (1 - p) * h)
      return
    case 'slideDown':
      ctx.drawImage(a, 0, p * h)
      ctx.drawImage(b, 0, -(1 - p) * h)
      return
    case 'wipeLeft':
    case 'wipeRight':
    case 'wipeUp':
    case 'wipeDown': {
      // A stays put; B is revealed by a hard-edged rectangle sweeping across.
      ctx.drawImage(a, 0, 0)
      ctx.save()
      ctx.beginPath()
      if (type === 'wipeLeft') ctx.rect(w * (1 - p), 0, w * p, h)
      else if (type === 'wipeRight') ctx.rect(0, 0, w * p, h)
      else if (type === 'wipeUp') ctx.rect(0, h * (1 - p), w, h * p)
      else ctx.rect(0, 0, w, h * p)
      ctx.clip()
      ctx.drawImage(b, 0, 0)
      ctx.restore()
      return
    }
    case 'zoomIn': {
      // A zooms in toward the camera while fading out; B settles in from slightly zoomed.
      const sa = 1 + p * 0.6
      const sb = 1.3 - p * 0.3
      ctx.save()
      ctx.translate(w / 2, h / 2)
      ctx.scale(sb, sb)
      ctx.drawImage(b, -w / 2, -h / 2)
      ctx.restore()
      ctx.save()
      ctx.globalAlpha = 1 - p
      ctx.translate(w / 2, h / 2)
      ctx.scale(sa, sa)
      ctx.drawImage(a, -w / 2, -h / 2)
      ctx.restore()
      return
    }
    case 'circleOpen':
    case 'circleClose': {
      const maxR = Math.hypot(w, h) / 2
      ctx.save()
      if (type === 'circleOpen') {
        // B grows from the centre over A.
        ctx.drawImage(a, 0, 0)
        ctx.beginPath()
        ctx.arc(w / 2, h / 2, maxR * p, 0, Math.PI * 2)
        ctx.clip()
        ctx.drawImage(b, 0, 0)
      } else {
        // A shrinks to the centre, revealing B around it.
        ctx.drawImage(b, 0, 0)
        ctx.beginPath()
        ctx.arc(w / 2, h / 2, maxR * (1 - p), 0, Math.PI * 2)
        ctx.clip()
        ctx.drawImage(a, 0, 0)
      }
      ctx.restore()
      return
    }
    case 'crossfade':
    default:
      ctx.drawImage(a, 0, 0)
      ctx.save()
      ctx.globalAlpha = p
      ctx.drawImage(b, 0, 0)
      ctx.restore()
  }
}
