/**
 * Clip animations (Inspector → Animation tab): CapCut's In / Out / Combo motion presets.
 *
 * An animation is a pose over its own progress p ∈ [0, 1] (scale multiplier, position offset in
 * canvas fractions, opacity multiplier) layered on top of the clip's static transform. Rather than
 * teach the preview and the exporter a second animation system, `animatedTransform()` samples the
 * presets into ordinary transform keyframes, which both already play back (interpolateTransform in
 * the preview, piecewise-linear expressions in ffmpegGraph). Sampling is dense enough (~24/s) that
 * the eased motion survives the linear interpolation between samples.
 *
 * Easing follows CapCut's own animation resources (Cache/effect/<id>/…/LumiExportData.lua): their
 * AE-exported keyframes use cubic-bezier influence curves — (0.33, 0, 0, 1) on the zoom/scale
 * tracks of In animations (fast start, long settle), (1, 0, 0, 1) on opacity, and the AE default
 * (1/6, 1/6, 5/6, 5/6) for steady drifts. Out animations are In animations played backwards, which
 * turns each ease-out into the matching ease-in (the clip accelerates away).
 */
import type { ClipAnimations, ClipTransform, MediaClip, TransformKeyframe } from './types'
import { interpolateTransform } from './types'

export type AnimationKind = 'in' | 'out' | 'combo'

/** Offset from the static transform at one instant. */
export interface Pose {
  scale: number // multiplier
  dx: number // canvas widths
  dy: number // canvas heights
  opacity: number // multiplier
}

export interface AnimationDef {
  id: string
  label: string
  kind: AnimationKind
  /** Seconds; CapCut's defaults are 0.5 s for In/Out and the whole clip for Combo. */
  defaultDuration: number
  pose: (p: number) => Pose
  /** Repeating motion (needs denser sampling). */
  periodic?: boolean
}

const IDENTITY: Pose = { scale: 1, dx: 0, dy: 0, opacity: 1 }

/** CSS-style cubic-bezier(x1, y1, x2, y2) easing, solved for x by Newton + bisection. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t ** 2 * (1 - t) + t ** 3
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t ** 2 * (1 - t) + t ** 3
  const dbx = (t: number) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t ** 2
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = bx(t) - x
      if (Math.abs(err) < 1e-6) return by(t)
      const d = dbx(t)
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    let lo = 0
    let hi = 1
    t = x
    for (let i = 0; i < 40; i++) {
      const v = bx(t)
      if (Math.abs(v - x) < 1e-6) break
      if (v < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return by(t)
  }
}

/** CapCut's In-animation scale curve (fast start, long settle). */
export const easeOut = cubicBezier(0.33, 0, 0, 1)
/** CapCut's opacity curve. */
export const easeOpacity = cubicBezier(1, 0, 0, 1)
/** AE's default "easy ease" — gentle at both ends. */
export const easeInOut = cubicBezier(1 / 6, 1 / 6, 5 / 6, 5 / 6)

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
/** Opacity reaching 1 over the first `frac` of the animation (CapCut's fades are short). */
const fadeUp = (p: number, frac = 0.35) => clamp01(p / frac)
/** Overshoot ("back") ease for pops. */
function easeOutBack(p: number, s = 1.9): number {
  const t = p - 1
  return 1 + (s + 1) * t ** 3 + s * t ** 2
}
/** Deterministic pseudo-random wobble in [-1, 1] (sum of incommensurate sines). */
const wobble = (t: number, seed: number) => (Math.sin(t * 37.1 + seed) * 0.6 + Math.sin(t * 61.7 + seed * 2.3) * 0.4)

function pose(partial: Partial<Pose>): Pose {
  return { ...IDENTITY, ...partial }
}

/** In animations: pose(0) is the starting state, pose(1) must be the identity. */
const IN_ANIMS: AnimationDef[] = [
  { id: 'fade_in', label: 'Fade in', kind: 'in', defaultDuration: 0.5, pose: (p) => pose({ opacity: easeInOut(p) }) },
  { id: 'zoom_in', label: 'Zoom in', kind: 'in', defaultDuration: 0.5, pose: (p) => pose({ scale: 0.6 + 0.4 * easeOut(p), opacity: fadeUp(p) }) },
  { id: 'zoom_out', label: 'Zoom out', kind: 'in', defaultDuration: 0.5, pose: (p) => pose({ scale: 1.5 - 0.5 * easeOut(p), opacity: fadeUp(p) }) },
  { id: 'pop_in', label: 'Pop', kind: 'in', defaultDuration: 0.5, pose: (p) => pose({ scale: 0.3 + 0.7 * easeOutBack(p), opacity: fadeUp(p, 0.2) }) },
  { id: 'mini_zoom_in', label: 'Mini zoom', kind: 'in', defaultDuration: 0.6, pose: (p) => pose({ scale: 1.12 - 0.12 * easeOut(p) }) },
  { id: 'pull_in', label: 'Pull in', kind: 'in', defaultDuration: 0.4, pose: (p) => pose({ scale: 2.2 - 1.2 * easeOut(p), opacity: fadeUp(p, 0.25) }) },
  { id: 'slide_left_in', label: 'Slide left', kind: 'in', defaultDuration: 0.5, pose: (p) => pose({ dx: 1 - easeOut(p) }) },
  { id: 'slide_right_in', label: 'Slide right', kind: 'in', defaultDuration: 0.5, pose: (p) => pose({ dx: -(1 - easeOut(p)) }) },
  { id: 'slide_up_in', label: 'Slide up', kind: 'in', defaultDuration: 0.5, pose: (p) => pose({ dy: 1 - easeOut(p) }) },
  { id: 'slide_down_in', label: 'Slide down', kind: 'in', defaultDuration: 0.5, pose: (p) => pose({ dy: -(1 - easeOut(p)) }) },
  { id: 'rise_in', label: 'Rise', kind: 'in', defaultDuration: 0.5, pose: (p) => pose({ dy: 0.12 * (1 - easeOut(p)), opacity: easeInOut(p) }) },
  {
    // Modeled on CapCut's cached "shake" In animation: decaying 2-D shake while it zooms from
    // 1.15x and fades up over the first quarter.
    id: 'shake_in',
    label: 'Shake',
    kind: 'in',
    defaultDuration: 0.6,
    pose: (p) => {
      const amp = 0.035 * (1 - p) ** 2
      return pose({ scale: 1.15 - 0.15 * easeOut(p), dx: amp * wobble(p, 1), dy: amp * wobble(p, 4), opacity: fadeUp(p, 0.25) })
    }
  }
]

/** Out animations reuse In motions in reverse: pose(0) is the identity, pose(1) the end state. */
function reversed(id: string, label: string, of: string): AnimationDef {
  const src = IN_ANIMS.find((a) => a.id === of)!
  return { id, label, kind: 'out', defaultDuration: src.defaultDuration, pose: (p) => src.pose(1 - p) }
}
const OUT_ANIMS: AnimationDef[] = [
  reversed('fade_out', 'Fade out', 'fade_in'),
  reversed('zoom_in_out', 'Zoom in', 'zoom_out'),
  reversed('zoom_out_out', 'Zoom out', 'zoom_in'),
  reversed('pop_out', 'Pop', 'pop_in'),
  reversed('mini_zoom_out', 'Mini zoom', 'mini_zoom_in'),
  reversed('push_out', 'Push out', 'pull_in'),
  reversed('slide_left_out', 'Slide left', 'slide_right_in'),
  reversed('slide_right_out', 'Slide right', 'slide_left_in'),
  reversed('slide_up_out', 'Slide up', 'slide_down_in'),
  reversed('slide_down_out', 'Slide down', 'slide_up_in'),
  reversed('sink_out', 'Sink', 'rise_in'),
  reversed('shake_out', 'Shake', 'shake_in')
]

/** Number of whole cycles of a periodic combo that fit `duration` at ~`period` seconds each.
 *  Combo poses get p over the whole window, so cycles are counted against the clip's length. */
let comboCycles = 1
const cycles = (period: number) => (duration: number) => Math.max(1, Math.round(duration / period))

const COMBO_ANIMS: (AnimationDef & { cyclesFor?: (d: number) => number })[] = [
  { id: 'slow_zoom_in', label: 'Slow zoom in', kind: 'combo', defaultDuration: 0, pose: (p) => pose({ scale: 1 + 0.18 * easeInOut(p) }) },
  { id: 'slow_zoom_out', label: 'Slow zoom out', kind: 'combo', defaultDuration: 0, pose: (p) => pose({ scale: 1.18 - 0.18 * easeInOut(p) }) },
  {
    id: 'pulse',
    label: 'Zoom in & out',
    kind: 'combo',
    defaultDuration: 0,
    periodic: true,
    cyclesFor: cycles(1),
    pose: (p) => pose({ scale: 1 + 0.1 * Math.sin(Math.PI * p * comboCycles) ** 2 })
  },
  {
    id: 'heartbeat',
    label: 'Heartbeat',
    kind: 'combo',
    defaultDuration: 0,
    periodic: true,
    cyclesFor: cycles(0.9),
    pose: (p) => {
      // Two quick beats then a rest, per cycle.
      const c = (p * comboCycles) % 1
      const beat = (center: number) => Math.exp(-(((c - center) / 0.06) ** 2))
      return pose({ scale: 1 + 0.08 * beat(0.15) + 0.06 * beat(0.38) })
    }
  },
  {
    id: 'shake',
    label: 'Shake',
    kind: 'combo',
    defaultDuration: 0,
    periodic: true,
    pose: (p) => pose({ scale: 1.08, dx: 0.018 * wobble(p * 6, 2), dy: 0.018 * wobble(p * 6, 7) })
  },
  {
    id: 'sway',
    label: 'Sway',
    kind: 'combo',
    defaultDuration: 0,
    periodic: true,
    cyclesFor: cycles(1.6),
    pose: (p) => pose({ scale: 1.1, dx: 0.035 * Math.sin(2 * Math.PI * p * comboCycles) })
  },
  {
    id: 'bounce',
    label: 'Bounce',
    kind: 'combo',
    defaultDuration: 0,
    periodic: true,
    cyclesFor: cycles(0.7),
    pose: (p) => pose({ scale: 1.08, dy: -0.035 * Math.abs(Math.sin(Math.PI * p * comboCycles)) })
  },
  {
    id: 'drift',
    label: 'Drift',
    kind: 'combo',
    defaultDuration: 0,
    pose: (p) => pose({ scale: 1.15, dx: 0.05 - 0.1 * easeInOut(p) })
  }
]

export const ANIMATION_CATALOG: AnimationDef[] = [...IN_ANIMS, ...OUT_ANIMS, ...COMBO_ANIMS]

export function animationDef(id: string | undefined): AnimationDef | undefined {
  return id ? ANIMATION_CATALOG.find((a) => a.id === id) : undefined
}

export function animationsOfKind(kind: AnimationKind): AnimationDef[] {
  return ANIMATION_CATALOG.filter((a) => a.kind === kind)
}

/** Pose of one animation at progress p, with a combo's cycle count fixed for its window length. */
export function poseAt(def: AnimationDef, p: number, windowDuration: number): Pose {
  const withCycles = def as AnimationDef & { cyclesFor?: (d: number) => number }
  comboCycles = withCycles.cyclesFor ? withCycles.cyclesFor(windowDuration) : 1
  return def.pose(clamp01(p))
}

/** The [start, end] windows (clip-local seconds) each applied animation occupies, clamped the
 *  way CapCut clamps them: In + Out never exceed the clip, a Combo fills at most the clip. */
export function animationWindows(anims: ClipAnimations | undefined, clipDuration: number) {
  const D = Math.max(0, clipDuration)
  const out: { def: AnimationDef; start: number; end: number }[] = []
  if (!anims) return out
  const combo = animationDef(anims.combo?.id)
  if (combo) {
    const d = anims.combo!.duration > 0 ? Math.min(anims.combo!.duration, D) : D
    if (d > 0) out.push({ def: combo, start: 0, end: d })
    return out
  }
  const inDef = animationDef(anims.in?.id)
  const outDef = animationDef(anims.out?.id)
  const inDur = inDef ? Math.min(Math.max(0, anims.in!.duration), D) : 0
  const outDur = outDef ? Math.min(Math.max(0, anims.out!.duration), D - inDur) : 0
  if (inDef && inDur > 0) out.push({ def: inDef, start: 0, end: inDur })
  if (outDef && outDur > 0) out.push({ def: outDef, start: D - outDur, end: D })
  return out
}

/** The combined animation pose at clip-local time t. */
export function animationPoseAt(anims: ClipAnimations | undefined, clipDuration: number, t: number): Pose {
  let acc = IDENTITY
  for (const w of animationWindows(anims, clipDuration)) {
    if (t < w.start || t > w.end) continue
    const span = w.end - w.start
    const p = span > 0 ? (t - w.start) / span : 1
    const q = poseAt(w.def, p, span)
    acc = { scale: acc.scale * q.scale, dx: acc.dx + q.dx, dy: acc.dy + q.dy, opacity: acc.opacity * q.opacity }
  }
  return acc
}

export function hasAnimations(clip: Pick<MediaClip, 'animations' | 'duration'>): boolean {
  return animationWindows(clip.animations, clip.duration).length > 0
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6

/**
 * The clip's transform with its animations baked in as keyframes (clip-local seconds). Returns
 * the transform itself when nothing is animated, so callers can use identity to skip work.
 */
export function animatedTransform(clip: Pick<MediaClip, 'animations' | 'duration' | 'transform'>): ClipTransform {
  const windows = animationWindows(clip.animations, clip.duration)
  if (windows.length === 0) return clip.transform
  const D = clip.duration
  const times = new Set<number>([0, D])
  for (const w of windows) {
    const span = w.end - w.start
    const rate = w.def.periodic ? 30 : 24
    const n = Math.max(8, Math.min(240, Math.ceil(span * rate)))
    for (let i = 0; i <= n; i++) times.add(r6(w.start + (span * i) / n))
    // Hold the identity just outside each window so the linear interpolation doesn't smear the
    // animation into the static part of the clip.
    if (w.start > 0) times.add(r6(Math.max(0, w.start - 1e-3)))
    if (w.end < D) times.add(r6(Math.min(D, w.end + 1e-3)))
  }
  for (const k of clip.transform.keyframes ?? []) if (k.time >= 0 && k.time <= D) times.add(r6(k.time))
  const keyframes: TransformKeyframe[] = [...times]
    .sort((a, b) => a - b)
    .map((time) => {
      const base = interpolateTransform(clip.transform, time)
      const a = animationPoseAt(clip.animations, D, time)
      return {
        time,
        x: r6(base.x + a.dx),
        y: r6(base.y + a.dy),
        scale: r6(Math.max(0.02, base.scale * a.scale)),
        opacity: r6(clamp01(base.opacity * a.opacity))
      }
    })
  return { ...clip.transform, keyframes }
}

/** Preview helper: memoizes animatedTransform per clip object (clips are immutable in the store). */
const cache = new WeakMap<object, ClipTransform>()
export function animatedTransformCached(clip: Pick<MediaClip, 'animations' | 'duration' | 'transform'>): ClipTransform {
  if (!clip.animations) return clip.transform
  let t = cache.get(clip)
  if (!t) {
    t = animatedTransform(clip)
    cache.set(clip, t)
  }
  return t
}
