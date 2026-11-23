import type { ClipTransform } from './types'

/** Smallest / largest scale a preview corner drag can reach. */
export const MIN_DRAG_SCALE = 0.05
export const MAX_DRAG_SCALE = 10

/** Moves a clip by (dx, dy) canvas fractions. Keyframed transforms move every keyframe by the
 *  same amount, so the clip's motion path is kept and just shifted. */
export function offsetTransform(t: ClipTransform, dx: number, dy: number): ClipTransform {
  return {
    ...t,
    x: t.x + dx,
    y: t.y + dy,
    ...(t.keyframes ? { keyframes: t.keyframes.map((k) => ({ ...k, x: k.x + dx, y: k.y + dy })) } : {})
  }
}

/** Scales a clip by `factor` about its own centre. Keyframed scales are all multiplied, so a
 *  zoom animation keeps its shape. The factor is limited so the static scale stays in range. */
export function scaleTransform(t: ClipTransform, factor: number): ClipTransform {
  const f = Math.min(Math.max(factor, MIN_DRAG_SCALE / t.scale), MAX_DRAG_SCALE / t.scale)
  const clampScale = (s: number) => Math.min(Math.max(s * f, MIN_DRAG_SCALE), MAX_DRAG_SCALE)
  return {
    ...t,
    scale: clampScale(t.scale),
    ...(t.keyframes ? { keyframes: t.keyframes.map((k) => ({ ...k, scale: clampScale(k.scale) })) } : {})
  }
}

/** A clip's on-canvas rectangle: centre, size and clockwise rotation (degrees), in canvas px. */
export interface CanvasBox {
  cx: number
  cy: number
  w: number
  h: number
  rot: number
}

/** True when canvas point (px, py) falls inside the (possibly rotated) box, with `pad` px slack. */
export function pointInBox(box: CanvasBox, px: number, py: number, pad = 0): boolean {
  const r = (-box.rot * Math.PI) / 180
  const dx = px - box.cx
  const dy = py - box.cy
  const lx = dx * Math.cos(r) - dy * Math.sin(r)
  const ly = dx * Math.sin(r) + dy * Math.cos(r)
  return Math.abs(lx) <= Math.abs(box.w) / 2 + pad && Math.abs(ly) <= Math.abs(box.h) / 2 + pad
}

/** Snaps a dragged centre coordinate to `target` (the canvas centre line) when within `threshold`. */
export function snapAxis(value: number, target: number, threshold: number): { value: number; snapped: boolean } {
  return Math.abs(value - target) <= threshold ? { value: target, snapped: true } : { value, snapped: false }
}
