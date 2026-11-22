/**
 * Pure per-frame helpers for the background-removal (matting) pipeline in
 * electron/main/background.ts. Kept free of Node/Electron imports so they're unit-testable.
 */

/** Packed RGB24 bytes (HWC) → planar NCHW float32 normalized as (v/255 - mean) / std. Reuses
 *  `out` when given so a long clip doesn't allocate a tensor per frame. */
export function rgbToNchw(
  rgb: Uint8Array,
  pixels: number,
  mean: readonly [number, number, number],
  std: readonly [number, number, number],
  out: Float32Array = new Float32Array(3 * pixels)
): Float32Array {
  const s0 = 1 / (255 * std[0])
  const s1 = 1 / (255 * std[1])
  const s2 = 1 / (255 * std[2])
  const o0 = mean[0] / std[0]
  const o1 = mean[1] / std[1]
  const o2 = mean[2] / std[2]
  for (let p = 0, q = 0; p < pixels; p++, q += 3) {
    out[p] = rgb[q] * s0 - o0
    out[pixels + p] = rgb[q + 1] * s1 - o1
    out[2 * pixels + p] = rgb[q + 2] * s2 - o2
  }
  return out
}

/** Network output → 0..255 matte. 'alpha' outputs are already 0..1 (stretching them would turn a
 *  frame with no subject into amplified noise); 'minmax' saliency maps are stretched to 0..1. */
export function matteToGray(matte: ArrayLike<number>, mode: 'alpha' | 'minmax', out: Uint8Array = new Uint8Array(matte.length)): Uint8Array {
  let min = 0
  let scale = 255
  if (mode === 'minmax') {
    let max = -Infinity
    min = Infinity
    for (let i = 0; i < matte.length; i++) {
      const v = matte[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    scale = 255 / (max - min || 1)
  }
  for (let i = 0; i < matte.length; i++) {
    const v = Math.round((matte[i] - min) * scale)
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  return out
}

/**
 * Edge-flicker suppression between consecutive mattes, in place on `cur`.
 *
 * Per-frame models jitter a few levels at soft edges (hair, motion blur) even when nothing moves,
 * which reads as shimmer. Where a pixel changed by less than `threshold` it's blended with the
 * previous frame's value; larger changes are real motion and pass through untouched, so moving
 * subjects don't leave a ghost trail. `prev` is the previous frame's *smoothed* output.
 */
export function smoothMatte(cur: Uint8Array, prev: Uint8Array | null, threshold = 24, weight = 0.5): Uint8Array {
  if (!prev || prev.length !== cur.length) return cur
  for (let i = 0; i < cur.length; i++) {
    const d = cur[i] - prev[i]
    if (d > -threshold && d < threshold) cur[i] = Math.round(prev[i] + d * weight)
  }
  return cur
}

/** "30000/1001" | "29.97" | "30" → frames per second (NaN when unparseable). */
export function parseFps(fps: string): number {
  const [n, d] = fps.split('/')
  return d === undefined ? Number(n) : Number(n) / Number(d)
}

/** Parses ffmpeg's "Duration: 00:01:02.50" banner line into seconds (0 when absent). */
export function parseDurationSec(ffmpegBanner: string): number {
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(ffmpegBanner)
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
}
