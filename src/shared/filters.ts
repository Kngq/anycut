/**
 * Filters (left panel → Filters, Inspector → Video → Filter): CapCut-style looks, as original
 * colour grades. CapCut ships its filters as server-downloaded LUT images that aren't in the app
 * or its data folder, so these are anycut's own grades written to match each look's
 * description (warm soft sunset, flash-camera Umber, subtle Blue Grey, …).
 *
 * A filter is a per-pixel colour function plus optional spatial finishing (sharpen, soften,
 * grain, vignette). The colour part is baked into a 3D LUT (`buildLut`) that BOTH sides use:
 * the preview samples it as a WebGL 3D texture (hardware trilinear), export writes it as a .cube
 * file for ffmpeg's `lut3d` (trilinear). Intensity is folded into the LUT (a mix with identity),
 * so 0 = untouched and 1 = the full look.
 */

export type Rgb = [number, number, number]

export interface FilterDef {
  id: string
  label: string
  category: 'Featured' | 'Life' | 'Movies' | 'Retro'
  /** 0..1 — the strength a newly applied filter starts at. */
  defaultIntensity: number
  /** Colour transform on gamma-encoded RGB in 0..1. */
  grade: (c: Rgb) => Rgb
  /** Spatial finishing, each 0..1 at full intensity (scaled by intensity). */
  sharpen?: number
  soften?: number
  grain?: number
  vignette?: number
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const luma = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/* ── grading building blocks (all on 0..1 gamma-encoded RGB) ── */
const map = (c: Rgb, f: (v: number, i: number) => number): Rgb => [f(c[0], 0), f(c[1], 1), f(c[2], 2)]
/** Exposure in stops-ish (multiplicative gain). */
const exposure = (c: Rgb, ev: number): Rgb => map(c, (v) => v * 2 ** ev)
/** S-curve contrast around mid-grey; k > 0 adds contrast, k < 0 flattens. */
const contrast = (c: Rgb, k: number, pivot = 0.5): Rgb => map(c, (v) => pivot + (v - pivot) * (1 + k))
const saturation = (c: Rgb, s: number): Rgb => {
  const y = luma(c)
  return map(c, (v) => y + (v - y) * s)
}
/** Saturation boost that spares already-saturated colours. */
const vibrance = (c: Rgb, amt: number): Rgb => {
  const mx = Math.max(...c)
  const mn = Math.min(...c)
  const sat = mx - mn
  return saturation(c, 1 + amt * (1 - sat))
}
/** Warm (+) / cool (−) white balance, and green (−) / magenta (+) tint. */
const balance = (c: Rgb, temp: number, tint = 0): Rgb => [c[0] * (1 + temp * 0.12 + tint * 0.04), c[1] * (1 - tint * 0.08), c[2] * (1 - temp * 0.14 + tint * 0.04)]
/** Lift blacks toward `to` (faded film). */
const fade = (c: Rgb, amt: number, to: Rgb = [1, 1, 1]): Rgb => map(c, (v, i) => v + (to[i] * 0.25 - v * 0.25) * amt * (1 - v))
/** Tint shadows and highlights separately (split toning), strength 0..1. */
const splitTone = (c: Rgb, shadow: Rgb, highlight: Rgb, amt: number): Rgb => {
  const y = luma(c)
  const ws = (1 - smooth(0, 0.55, y)) * amt
  const wh = smooth(0.45, 1, y) * amt
  return map(c, (v, i) => v + (shadow[i] - 0.5) * 0.35 * ws + (highlight[i] - 0.5) * 0.35 * wh)
}
/** Brightness that protects highlights (gamma). */
const brighten = (c: Rgb, amt: number): Rgb => map(c, (v) => clamp01(v) ** (1 / (1 + amt)))
/** Soft highlight roll-off (less harsh whites). */
const rolloff = (c: Rgb, amt: number): Rgb => map(c, (v) => (v > 0.7 ? 0.7 + (v - 0.7) * (1 - amt * 0.6) : v))
/** Shift one hue family: push channel weights where `select` is strong. */
const hueBoost = (c: Rgb, select: (c: Rgb) => number, gain: Rgb): Rgb => {
  const w = clamp01(select(c))
  return map(c, (v, i) => v * (1 + (gain[i] - 1) * w))
}
const greens = ([r, g, b]: Rgb) => (g - Math.max(r, b)) * 3
const skinOrange = ([r, g, b]: Rgb) => (r - b) * 1.6 * (g > b ? 1 : 0.3)
const blues = ([r, g, b]: Rgb) => (b - Math.max(r, g)) * 3

const pipe = (c: Rgb, ...fs: ((c: Rgb) => Rgb)[]) => fs.reduce((acc, f) => f(acc), c)

export const FILTER_CATALOG: FilterDef[] = [
  /* Featured */
  {
    id: 'clear_ii',
    label: 'Clear II',
    category: 'Featured',
    defaultIntensity: 0.8,
    // Clean, high-clarity: a touch brighter, crisper midtone contrast, colours that pop
    // without clipping skin.
    grade: (c) => pipe(c, (x) => brighten(x, 0.06), (x) => contrast(x, 0.12), (x) => vibrance(x, 0.35), (x) => balance(x, 0.03)),
    sharpen: 0.5
  },
  {
    id: 'shadow',
    label: 'Shadow',
    category: 'Featured',
    defaultIntensity: 0.8,
    // Softened, slightly darker and flatter, so text on top reads clearly.
    grade: (c) => pipe(c, (x) => exposure(x, -0.25), (x) => contrast(x, -0.12), (x) => saturation(x, 0.85), (x) => rolloff(x, 0.5)),
    soften: 0.45
  },
  {
    id: 'umber',
    label: 'Umber',
    category: 'Featured',
    defaultIntensity: 0.4,
    // Digital point-and-shoot flash: hot, slightly blown centre, hard contrast, cool-green
    // shadows against warm skin, dark corners and a little sensor noise.
    grade: (c) =>
      pipe(
        c,
        (x) => exposure(x, 0.25),
        (x) => contrast(x, 0.3, 0.45),
        (x) => splitTone(x, [0.42, 0.52, 0.56], [0.6, 0.52, 0.44], 0.7),
        (x) => saturation(x, 0.9)
      ),
    vignette: 0.55,
    grain: 0.25
  },
  {
    id: 'september_sunset',
    label: 'September sunset',
    category: 'Featured',
    defaultIntensity: 0.8,
    // Warm and soft: slightly lower brightness, contrast and brilliance, golden highlights,
    // small sharpen to keep it from going mushy.
    grade: (c) =>
      pipe(
        c,
        (x) => balance(x, 0.55, 0.12),
        (x) => exposure(x, -0.1),
        (x) => contrast(x, -0.1),
        (x) => rolloff(x, 0.45),
        (x) => splitTone(x, [0.5, 0.46, 0.5], [0.66, 0.52, 0.36], 0.55),
        (x) => fade(x, 0.25, [1, 0.85, 0.75])
      ),
    sharpen: 0.2
  },
  /* Life */
  {
    id: 'taro',
    label: 'Taro',
    category: 'Life',
    defaultIntensity: 0.8,
    // Pastel lavender: airy, low contrast, lifted lilac blacks, gentle magenta tint.
    grade: (c) => pipe(c, (x) => brighten(x, 0.12), (x) => contrast(x, -0.18), (x) => saturation(x, 0.75), (x) => balance(x, -0.15, 0.55), (x) => fade(x, 0.5, [0.85, 0.75, 1])),
  },
  {
    id: 'light_green',
    label: 'Light Green',
    category: 'Life',
    defaultIntensity: 0.8,
    // Bright, fresh greenery: lifted exposure, greens pushed lighter and yellower.
    grade: (c) => pipe(c, (x) => brighten(x, 0.15), (x) => hueBoost(x, greens, [1.05, 1.22, 0.9]), (x) => contrast(x, -0.05), (x) => vibrance(x, 0.2), (x) => balance(x, -0.05, -0.2))
  },
  {
    id: 'grey_orange',
    label: 'Grey Orange',
    category: 'Life',
    defaultIntensity: 0.8,
    // Muted grey world with orange kept alive (skin, signage), slate-blue shadows.
    grade: (c) => {
      const keep = clamp01(skinOrange(c))
      const desat = saturation(c, mix(0.35, 1.05, keep))
      return pipe(desat, (x) => splitTone(x, [0.44, 0.49, 0.56], [0.56, 0.5, 0.45], 0.5), (x) => contrast(x, 0.08), (x) => fade(x, 0.2, [0.8, 0.82, 0.86]))
    }
  },
  {
    id: 'gold_ivory',
    label: 'Gold Ivory',
    category: 'Life',
    defaultIntensity: 0.8,
    // Warm vintage: cream highlights, golden mids, softened contrast and faded blacks.
    grade: (c) =>
      pipe(c, (x) => balance(x, 0.4, 0.05), (x) => saturation(x, 0.85), (x) => contrast(x, -0.08), (x) => splitTone(x, [0.52, 0.48, 0.44], [0.6, 0.56, 0.44], 0.6), (x) => fade(x, 0.4, [0.95, 0.88, 0.75])),
    grain: 0.1
  },
  {
    id: 'fresh_lime',
    label: 'Fresh Lime',
    category: 'Life',
    defaultIntensity: 0.8,
    // Zesty everyday vlog look: bright, saturated, a citrus yellow-green cast in the highlights.
    grade: (c) => pipe(c, (x) => brighten(x, 0.1), (x) => vibrance(x, 0.4), (x) => splitTone(x, [0.48, 0.5, 0.52], [0.56, 0.6, 0.4], 0.5), (x) => contrast(x, 0.06))
  },
  /* Retro */
  {
    id: 'vhs',
    label: 'VHS',
    category: 'Retro',
    defaultIntensity: 0.8,
    // Tape: washed-out colour, lifted blue-grey blacks, crushed highlights, soft and noisy.
    grade: (c) => pipe(c, (x) => saturation(x, 0.7), (x) => balance(x, -0.1, 0.15), (x) => fade(x, 0.55, [0.7, 0.72, 0.85]), (x) => rolloff(x, 0.7), (x) => contrast(x, 0.05)),
    soften: 0.35,
    grain: 0.6,
    vignette: 0.25
  },
  /* Movies */
  {
    id: 'blue_grey',
    label: 'Blue Grey',
    category: 'Movies',
    defaultIntensity: 0.25,
    // Cool, desaturated, polished: steel shadows, neutral-cool highlights.
    grade: (c) => pipe(c, (x) => saturation(x, 0.55), (x) => balance(x, -0.45), (x) => splitTone(x, [0.42, 0.48, 0.6], [0.48, 0.5, 0.54], 0.7), (x) => contrast(x, 0.1))
  },
  {
    id: 'sicily',
    label: 'Sicily',
    category: 'Movies',
    defaultIntensity: 0.8,
    // Mediterranean golden hour: rich warm mids, teal shadows, saturated but soft whites.
    grade: (c) => pipe(c, (x) => balance(x, 0.35), (x) => splitTone(x, [0.4, 0.52, 0.56], [0.62, 0.54, 0.4], 0.7), (x) => vibrance(x, 0.25), (x) => contrast(x, 0.12), (x) => rolloff(x, 0.4))
  },
  {
    id: 'dune_1',
    label: 'Dune 1',
    category: 'Movies',
    defaultIntensity: 0.8,
    // Desert epic: everything pulled toward sand and rust, blues killed, heavy contrast.
    grade: (c) =>
      pipe(
        c,
        (x) => hueBoost(x, blues, [1.2, 1.05, 0.6]),
        (x) => saturation(x, 0.7),
        (x) => balance(x, 0.6, 0.05),
        (x) => contrast(x, 0.25, 0.42),
        (x) => splitTone(x, [0.5, 0.45, 0.4], [0.64, 0.54, 0.38], 0.6)
      ),
    vignette: 0.3
  },
  {
    id: 'love_city',
    label: 'Love City',
    category: 'Movies',
    defaultIntensity: 0.8,
    // Neon romance: magenta-pink highlights, violet shadows, punchy contrast.
    grade: (c) => pipe(c, (x) => balance(x, -0.05, 0.6), (x) => splitTone(x, [0.5, 0.42, 0.62], [0.64, 0.46, 0.56], 0.65), (x) => contrast(x, 0.18), (x) => vibrance(x, 0.3))
  },
  {
    id: 'bright_summer',
    label: 'Bright Summer',
    category: 'Movies',
    defaultIntensity: 0.8,
    // High-key summer: bright, warm, saturated sky and skin, soft highlights.
    grade: (c) => pipe(c, (x) => brighten(x, 0.22), (x) => balance(x, 0.25), (x) => vibrance(x, 0.45), (x) => rolloff(x, 0.5), (x) => contrast(x, 0.04))
  }
]

export const FILTER_CATEGORIES = ['Featured', 'Life', 'Movies', 'Retro'] as const

export function filterDef(id: string | undefined): FilterDef | undefined {
  return id ? FILTER_CATALOG.find((f) => f.id === id) : undefined
}

/** Applies a filter's colour grade at `intensity` to one colour (what a LUT cell stores). */
export function gradeColor(def: FilterDef, c: Rgb, intensity: number): Rgb {
  const g = def.grade(c)
  return [clamp01(mix(c[0], g[0], intensity)), clamp01(mix(c[1], g[1], intensity)), clamp01(mix(c[2], g[2], intensity))]
}

export const LUT_SIZE = 33

/** The filter's colour grade at `intensity` as an RGB 3D LUT: index ((b·N + g)·N + r)·3, the
 *  .cube order (red fastest). */
export function buildLut(def: FilterDef, intensity: number, size = LUT_SIZE): Float32Array {
  const lut = new Float32Array(size * size * size * 3)
  const n = size - 1
  let i = 0
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const o = gradeColor(def, [r / n, g / n, b / n], intensity)
        lut[i++] = o[0]
        lut[i++] = o[1]
        lut[i++] = o[2]
      }
  return lut
}

/** A LUT as Adobe/Resolve .cube text (what ffmpeg's lut3d reads). */
export function lutToCube(lut: Float32Array, size = LUT_SIZE, title = 'anycut'): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]
  for (let i = 0; i < lut.length; i += 3) lines.push(`${lut[i].toFixed(5)} ${lut[i + 1].toFixed(5)} ${lut[i + 2].toFixed(5)}`)
  return lines.join('\n') + '\n'
}

/** Stable name for a filter+intensity LUT file (export writes each one once). */
export function lutFileName(id: string, intensity: number): string {
  return `${id}-${Math.round(intensity * 100)}.cube`
}

/** Spatial finishing amounts at an intensity. */
export function filterFinish(def: FilterDef, intensity: number) {
  return {
    sharpen: (def.sharpen ?? 0) * intensity,
    soften: (def.soften ?? 0) * intensity,
    grain: (def.grain ?? 0) * intensity,
    vignette: (def.vignette ?? 0) * intensity
  }
}

/** ffmpeg `vignette` angle for an amount (the preview shader uses the same cos⁴ falloff). */
export const vignetteAngle = (amount: number) => amount * (Math.PI / 3)
