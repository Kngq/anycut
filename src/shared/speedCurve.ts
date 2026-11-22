import type { SpeedCurvePoint, SpeedKeyframe } from './types'

/** Speed range the model supports (projectStore clamps keyframe speeds to this). */
export const SPEED_CURVE_MIN = 0.1
export const SPEED_CURVE_MAX = 4

/** How many constant-speed segments a smooth curve is sampled into for playback/export. The
 *  speed model is piecewise-constant between keyframes, so a smooth curve is approximated by
 *  this many steps. */
export const SPEED_CURVE_SEGMENTS = 16

export type SpeedCurvePresetId = 'custom' | 'montage' | 'hero' | 'bullet' | 'jumpcut' | 'flashin' | 'flashout'

export interface SpeedCurvePreset {
  id: SpeedCurvePresetId
  label: string
  points: SpeedCurvePoint[]
}

/** CapCut's curve preset names (en.po), with point shapes approximating their feel. */
export const SPEED_CURVE_PRESETS: SpeedCurvePreset[] = [
  {
    id: 'custom',
    label: 'Custom',
    points: [
      { x: 0, speed: 1 },
      { x: 0.25, speed: 1 },
      { x: 0.5, speed: 1 },
      { x: 0.75, speed: 1 },
      { x: 1, speed: 1 }
    ]
  },
  {
    id: 'montage',
    label: 'Montage',
    points: [
      { x: 0, speed: 2.5 },
      { x: 0.25, speed: 0.6 },
      { x: 0.5, speed: 2.5 },
      { x: 0.75, speed: 0.6 },
      { x: 1, speed: 2 }
    ]
  },
  {
    id: 'hero',
    label: 'Hero',
    points: [
      { x: 0, speed: 1 },
      { x: 0.3, speed: 1 },
      { x: 0.45, speed: 0.25 },
      { x: 0.55, speed: 0.25 },
      { x: 0.7, speed: 1 },
      { x: 1, speed: 1 }
    ]
  },
  {
    id: 'bullet',
    label: 'Bullet',
    points: [
      { x: 0, speed: 3 },
      { x: 0.35, speed: 0.2 },
      { x: 0.65, speed: 0.2 },
      { x: 1, speed: 3 }
    ]
  },
  {
    id: 'jumpcut',
    label: 'Jump cut',
    points: [
      { x: 0, speed: 0.5 },
      { x: 0.38, speed: 0.5 },
      { x: 0.5, speed: 3.5 },
      { x: 0.62, speed: 0.5 },
      { x: 1, speed: 0.5 }
    ]
  },
  {
    id: 'flashin',
    label: 'Flash in',
    points: [
      { x: 0, speed: 4 },
      { x: 0.35, speed: 1.3 },
      { x: 1, speed: 1 }
    ]
  },
  {
    id: 'flashout',
    label: 'Flash out',
    points: [
      { x: 0, speed: 1 },
      { x: 0.65, speed: 1.3 },
      { x: 1, speed: 4 }
    ]
  }
]

export function speedCurvePreset(id: string | undefined): SpeedCurvePreset | undefined {
  return SPEED_CURVE_PRESETS.find((p) => p.id === id)
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const clampCurveSpeed = (s: number) => clamp(Number.isFinite(s) && s > 0 ? s : 1, SPEED_CURVE_MIN, SPEED_CURVE_MAX)

/** Speed → vertical graph position (0 = bottom, 1 = top). Log scale with 1x on the middle line,
 *  like CapCut: 0.1x..1x fills the bottom half, 1x..max the top half. */
export function speedToGraphY(speed: number): number {
  const s = clampCurveSpeed(speed)
  if (s <= 1) return 0.5 * (Math.log10(s) - Math.log10(SPEED_CURVE_MIN)) / -Math.log10(SPEED_CURVE_MIN)
  return 0.5 + (0.5 * Math.log(s)) / Math.log(SPEED_CURVE_MAX)
}

/** Inverse of speedToGraphY. */
export function graphYToSpeed(y: number): number {
  const v = clamp(y, 0, 1)
  if (v <= 0.5) return SPEED_CURVE_MIN * Math.pow(1 / SPEED_CURVE_MIN, v / 0.5)
  return Math.pow(SPEED_CURVE_MAX, (v - 0.5) / 0.5)
}

/** Sorts, clamps, and pins the first/last points to x=0/x=1 (endpoints are fixed in time). */
export function normalizeCurvePoints(points: SpeedCurvePoint[]): SpeedCurvePoint[] {
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.x))
    .map((p) => ({ x: clamp(p.x, 0, 1), speed: clampCurveSpeed(p.speed) }))
    .sort((a, b) => a.x - b.x)
  if (sorted.length === 0) return [{ x: 0, speed: 1 }, { x: 1, speed: 1 }]
  if (sorted.length === 1) return [{ x: 0, speed: sorted[0].speed }, { x: 1, speed: sorted[0].speed }]
  sorted[0] = { ...sorted[0], x: 0 }
  sorted[sorted.length - 1] = { ...sorted[sorted.length - 1], x: 1 }
  return sorted
}

/** Evaluates the smooth curve through `points` at x (0..1). Interpolation is monotone cubic
 *  (Fritsch–Carlson) in graph-y space, so it never overshoots between points and looks the same
 *  as the line drawn on the graph. */
export function evalSpeedCurve(points: SpeedCurvePoint[], x: number): number {
  const pts = normalizeCurvePoints(points)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => speedToGraphY(p.speed))
  const n = pts.length
  const t = clamp(x, 0, 1)
  let i = 0
  while (i < n - 2 && t > xs[i + 1]) i++
  const h = xs[i + 1] - xs[i]
  if (h <= 1e-9) return graphYToSpeed(ys[i + 1])
  // Secant slopes + Fritsch–Carlson tangents.
  const d: number[] = []
  for (let k = 0; k < n - 1; k++) {
    const dx = xs[k + 1] - xs[k]
    d.push(dx > 1e-9 ? (ys[k + 1] - ys[k]) / dx : 0)
  }
  const m: number[] = new Array(n)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) {
      m[k] = 0
      m[k + 1] = 0
      continue
    }
    const a = m[k] / d[k]
    const b = m[k + 1] / d[k]
    const s = a * a + b * b
    if (s > 9) {
      const tau = 3 / Math.sqrt(s)
      m[k] = tau * a * d[k]
      m[k + 1] = tau * b * d[k]
    }
  }
  const u = (t - xs[i]) / h
  const u2 = u * u
  const u3 = u2 * u
  const y =
    (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * m[i + 1]
  return graphYToSpeed(y)
}

/** Samples the smooth curve into `segments` equal-length constant-speed segments over the source
 *  range [trimIn, trimOut]. Each segment's speed is the harmonic mean of the curve over it, so the
 *  stepped playback has the same total duration as the smooth curve. Returns segments+1 keyframes
 *  (the last, at trimOut, only closes the range). */
export function sampleSpeedCurve(
  points: SpeedCurvePoint[],
  trimIn: number,
  trimOut: number,
  segments = SPEED_CURVE_SEGMENTS
): SpeedKeyframe[] {
  const len = Math.max(0, trimOut - trimIn)
  const n = Math.max(1, Math.round(segments))
  const SUB = 8
  const out: SpeedKeyframe[] = []
  for (let i = 0; i < n; i++) {
    let inv = 0
    for (let j = 0; j < SUB; j++) inv += 1 / evalSpeedCurve(points, (i + (j + 0.5) / SUB) / n)
    out.push({ time: trimIn + (len * i) / n, speed: clampCurveSpeed(SUB / inv) })
  }
  out.push({ time: trimOut, speed: out[out.length - 1].speed })
  return out
}

/** Recovers control points from a raw keyframe list (legacy curves with no stored points). */
export function curvePointsFromKeyframes(keyframes: SpeedKeyframe[], trimIn: number, trimOut: number): SpeedCurvePoint[] {
  const len = Math.max(1e-6, trimOut - trimIn)
  return normalizeCurvePoints(keyframes.map((k) => ({ x: (k.time - trimIn) / len, speed: k.speed })))
}

/** Timeline duration of a source range of `sourceLen` seconds played through the sampled curve. */
export function speedCurveDuration(points: SpeedCurvePoint[], sourceLen: number, segments = SPEED_CURVE_SEGMENTS): number {
  const kfs = sampleSpeedCurve(points, 0, sourceLen, segments)
  let total = 0
  for (let i = 0; i < kfs.length - 1; i++) total += (kfs[i + 1].time - kfs[i].time) / kfs[i].speed
  return total
}
