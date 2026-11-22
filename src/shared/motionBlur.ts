import type { MotionBlurSettings, SourceOverride } from './types'

/**
 * Pure planning for the Motion blur bake (electron/main/motionBlur.ts): the sub-frame kernel and
 * the ffmpeg filter strings. Kept free of Node/Electron so it's unit-testable.
 *
 * Method (optical flow, like CapCut's "uses an optical flow to create an apparent streaking"):
 *  1. The source is retimed by frame index and downscaled to a work size (short side ≤ 540).
 *  2. `minterpolate` (motion-compensated) synthesises SUBFRAMES in-between frames per frame interval.
 *  3. `tmix` averages a window of sub-frames: the virtual shutter. Blur sets the window length,
 *     Times convolves the box with itself (= running the pass again), Direction places the window
 *     before / after / around each real frame.
 *  4. One sub-frame per source frame is kept, so the frame count and timing match the source exactly.
 *  5. Back at full resolution, the blurred low-res image replaces the original only where it differs
 *     from the (equally low-res) original, i.e. where something moved; static detail stays sharp.
 *     Blend lowers that mask so part of the sharp frame shows through the streaks.
 * Steps 1-4 run on time segments in parallel processes (minterpolate is single-threaded).
 */

export const MOTION_BLUR_DEFAULTS: MotionBlurSettings = { blur: 50, blend: 0, direction: 'both', times: 1 }
export const MOTION_BLUR_TIMES: MotionBlurSettings['times'][] = [1, 2, 4, 6]
/** Interpolated sub-frames per source frame interval. */
export const SUBFRAMES = 8
/** Optical flow + blur run at this short side (px); the full-res frame is only touched where it moved. */
export const WORK_SHORT_SIDE = 432

export interface Rational {
  num: number
  den: number
}

export function parseRational(s: string | undefined): Rational | null {
  if (!s) return null
  const [a, b] = s.split('/')
  const num = Number(a)
  const den = b === undefined ? 1 : Number(b)
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null
  return { num, den }
}

export const rationalStr = (r: Rational): string => (r.den === 1 ? String(r.num) : `${r.num}/${r.den}`)
export const rationalValue = (r: Rational): number => r.num / r.den

/** Retimes a stream to frame index / fps with a time base of exactly 1/fps, so the inputs of a
 *  multi-input filter (maskedmerge, blend) carry identical timestamps. (N/fps in a 1/1000 mkv time
 *  base rounds differently than in a 1/15360 mp4 one, and framesync then emits duplicate frames.) */
export const retimeFilter = (fps: Rational): string => `settb=${fps.den}/${fps.num},setpts=N`

/**
 * The rate the bake retimes frames to. `r_frame_rate` when it agrees with the average (CFR, keeps
 * exact rationals like 30000/1001); otherwise (variable-rate phone footage) the average, so
 * frames / rate still equals the clip's duration. Falls back to 30.
 */
export function pickFrameRate(rFrameRate?: string, avgFrameRate?: string): Rational {
  const r = parseRational(rFrameRate)
  const avg = parseRational(avgFrameRate)
  if (r && (!avg || Math.abs(rationalValue(r) - rationalValue(avg)) / rationalValue(r) < 0.005) && rationalValue(r) <= 240) return r
  if (avg) {
    const v = rationalValue(avg)
    const ntsc: [number, Rational][] = [
      [24000 / 1001, { num: 24000, den: 1001 }],
      [30000 / 1001, { num: 30000, den: 1001 }],
      [60000 / 1001, { num: 60000, den: 1001 }]
    ]
    for (const [val, rat] of ntsc) if (Math.abs(v - val) < 0.005) return rat
    if (Math.abs(v - Math.round(v)) < 0.005) return { num: Math.round(v), den: 1 }
    return { num: Math.round(v * 1000), den: 1000 }
  }
  return r ?? { num: 30, den: 1 }
}

/** Clamps/rounds user settings into the supported range. */
export function normalizeSettings(s: MotionBlurSettings): MotionBlurSettings {
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 0)))
  const times = MOTION_BLUR_TIMES.includes(s.times) ? s.times : 1
  const direction = s.direction === 'forward' || s.direction === 'backward' ? s.direction : 'both'
  return { blur: clamp(s.blur), blend: clamp(s.blend), direction, times }
}

/** Short stable string for cache keys. */
export function settingsKey(s: MotionBlurSettings): string {
  const n = normalizeSettings(s)
  return `b${n.blur}-m${n.blend}-${n.direction}-x${n.times}`
}

export interface BlurKernel {
  /** tmix weights over consecutive sub-frames (oldest first; the kernel is symmetric). */
  weights: number[]
  /** Which sub-frame of the window lands on the real frame: tmix's output at sub-frame n mixes
   *  n-L+1..n, so picking n = frame*SUBFRAMES + offset places the window. */
  offset: number
}

/**
 * Sub-frame kernel. Blur 100 = a box spanning one whole frame interval (a 360° shutter); Times
 * convolves that box with itself `times` times, exactly what repeating the pass would do, so the
 * streak gets longer (Times × Blur) and its ends fade smoothly.
 */
export function blurKernel(settings: MotionBlurSettings, subframes = SUBFRAMES): BlurKernel {
  const s = normalizeSettings(settings)
  const box = 1 + Math.round((s.blur / 100) * subframes)
  let weights = [1]
  for (let i = 0; i < s.times; i++) weights = convolve(weights, new Array(box).fill(1))
  const L = weights.length
  const offset = s.direction === 'backward' ? 0 : s.direction === 'forward' ? L - 1 : Math.floor((L - 1) / 2)
  return { weights, offset }
}

function convolve(a: number[], b: number[]): number[] {
  const out = new Array(a.length + b.length - 1).fill(0)
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j]
  return out
}

/** Source frames of clone padding each segment needs on both sides so every window is full. */
export function paddingFrames(kernel: BlurKernel, subframes = SUBFRAMES): number {
  const reach = Math.max(kernel.offset, kernel.weights.length - 1 - kernel.offset)
  return Math.ceil(reach / subframes) + 1
}

/** Splits frames [0, total) into up to `parts` contiguous segments of at least `minLen` frames. */
export function segmentRanges(total: number, parts: number, minLen = 24): [number, number][] {
  if (total <= 0) return []
  const n = Math.max(1, Math.min(parts, Math.floor(total / minLen) || 1))
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = Math.round((i * total) / n)
    const b = Math.round(((i + 1) * total) / n)
    if (b > a) out.push([a, b])
  }
  return out
}

/** Work size: even dims, short side ≤ WORK_SHORT_SIDE, never upscaled. */
export function workSize(width: number, height: number, shortSide = WORK_SHORT_SIDE): { w: number; h: number } {
  const scale = Math.min(1, shortSide / Math.max(1, Math.min(width, height)))
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2)
  return { w: even(width), h: even(height) }
}

/**
 * Filter for one segment worker. Input 0 is the low-res intermediate (already retimed to `fps`,
 * frames indexed 0..total-1). Emits exactly `end - start` blurred frames, retimed from 0, on [out].
 */
export function segmentFilter(opts: {
  fps: Rational
  kernel: BlurKernel
  start: number
  end: number
  total: number
  alpha: boolean
  subframes?: number
}): string {
  const { fps, kernel, start, end, total, alpha } = opts
  const n = opts.subframes ?? SUBFRAMES
  const P = paddingFrames(kernel, n)
  const a0 = Math.max(0, start - P)
  const b0 = Math.min(total, end + P)
  const padL = P - (start - a0)
  const padR = P - (b0 - end)
  const F = rationalStr(fps)
  const subRate = rationalStr({ num: fps.num * n, den: fps.den })
  const first = P * n + kernel.offset
  const last = (P + (end - start) - 1) * n + kernel.offset
  const retime = retimeFilter(fps)
  const pad = padL || padR ? `,tpad=start_mode=clone:start=${padL}:stop_mode=clone:stop=${padR}` : ''
  const blur =
    `minterpolate=fps=${subRate}:mi_mode=mci:mc_mode=obmc:me_mode=bilat:scd=none,` +
    `tmix=frames=${kernel.weights.length}:weights=${kernel.weights.join(' ')},` +
    `select=between(n\\,${first}\\,${last})*not(mod(n-${first}\\,${n})),${retime},fps=${F}`
  const head = `[0:v]trim=start_frame=${a0}:end_frame=${b0},${retime}${pad}`
  if (!alpha) return `${head},format=yuv420p,${blur}[out]`
  // minterpolate has no alpha formats: blur colour and alpha as separate streams, then re-merge.
  return `${head},split[c][a];[c]format=yuv420p,${blur}[cb];[a]alphaextract,${blur}[ab];[cb][ab]alphamerge[out]`
}

/** Mask gain: a low-res luma (or alpha) difference of ~16 levels between blurred and sharp = fully
 *  blurred; differences under 2 levels (noise, compression) don't touch the original. */
const MASK_FLOOR = 2
const MASK_GAIN = 16

/**
 * Final pass filter. Inputs: 0 = full-res source, 1 = low-res sharp intermediate, 2 = low-res
 * blurred frames (all `total` frames). `colorFilters` is ffmpegGraph's colorConversionFilters()
 * for the source (comma-terminated, or ''). Output on [out] in yuv444p (or yuva444p with alpha).
 */
export function compositeFilter(opts: { fps: Rational; width: number; height: number; blend: number; alpha: boolean; colorFilters: string }): string {
  const { fps, width, height, alpha, colorFilters } = opts
  const retime = retimeFilter(fps)
  const fmt = alpha ? 'yuva444p' : 'yuv444p'
  // Blend b mixes b parts sharp frame into 1 part blurred: out = (blurred*m + sharp*(1-m) + b*sharp)/(1+b)
  // which is the same masked merge with the mask scaled by 1/(1+b).
  const gain = MASK_GAIN / (1 + Math.max(0, Math.min(100, opts.blend)) / 100)
  const lut = `lut=c0=clip((val-${MASK_FLOOR})*${Number(gain.toFixed(3))}\\,0\\,255)`
  const full = alpha
    ? `[0:v:0]${retime},format=yuva444p,split[fc][fa];[fc]${colorFilters}format=yuv444p[fc2];[fa]alphaextract[fa2];[fc2][fa2]alphamerge,format=yuva444p[full]`
    : `[0:v:0]${retime},${colorFilters}format=yuv444p[full]`
  const diff = alpha
    ? `[lo][b1]blend=all_mode=difference,extractplanes=y+a[dy][da];[dy][da]blend=all_mode=lighten`
    : `[lo][b1]blend=all_mode=difference,extractplanes=y`
  return [
    full,
    `[1:v]${retime}[lo]`,
    `[2:v]${retime},split[b1][b2]`,
    `${diff},${lut},dilation,gblur=sigma=1.5,scale=${width}:${height}:flags=bicubic,mergeplanes=0x00000000:${fmt}[m]`,
    `[b2]scale=${width}:${height}:flags=bicubic,format=${fmt}[up]`,
    `[full][up][m]maskedmerge[out]`
  ].join(';')
}

/** Every file a clip's override keeps alive (including the bake a motion blur sits on), for cache
 *  protection. */
export function sourceOverrideFiles(o: SourceOverride | undefined): string[] {
  if (!o) return []
  const out = [o.path, o.previewPath ?? ''].filter(Boolean)
  return [...out, ...sourceOverrideFiles(o.motionBlur?.base)]
}

/** The file a new motion-blur bake should read: the override underneath an existing motion blur
 *  (so re-applying with new settings doesn't stack blurs), else the current override (e.g. the
 *  background-removed bake, keeping its alpha), else the asset itself. */
export function motionBlurInput(override: SourceOverride | undefined, assetPath: string): { path: string; base?: SourceOverride } {
  const base = override?.kind === 'motionBlur' ? override.motionBlur?.base : override
  return { path: base?.path ?? assetPath, base }
}

/** ffmpeg `-progress` key=value lines → output time in seconds (null if absent). */
export function parseProgressSeconds(chunk: string): number | null {
  let last: number | null = null
  for (const m of chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)) last = Number(m[1]) / 1e6
  return last
}
