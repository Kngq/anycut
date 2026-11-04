import { effectCatalogEntry, TRANSITION_CATALOG, type ClipEffectType, type Project, type TransitionType } from './types'

/**
 * Where an effect or transition dragged onto the timeline would land. Modeled on CapCut's timeline:
 * the dragged card carries no placement logic, and ONE function decides the outcome from the
 * pointer position, so the hover preview and the drop always agree (CapCut does this in its
 * canvas view-model's dragEnter/dragPositionChanged/dragDrop). Pure and unit-tested.
 *
 * Not modeled yet: CapCut also lets an effect dropped in EMPTY track space become its own effect
 * segment that applies to everything below it. freecut has no effect tracks, so that's a rejection
 * with an explanation for now.
 */

export type DragPayload = { kind: 'effect'; type: ClipEffectType } | { kind: 'transition'; type: TransitionType }

export type DropResolution =
  /** Effect lands on this clip (appended to its effect stack). */
  | { kind: 'attach'; clipId: string }
  /** Transition lands on the cut between left and right; stored on the right clip (transitionIn). */
  | { kind: 'transition'; leftClipId: string; rightClipId: string; cutTime: number; duration: number }
  | { kind: 'reject'; reason: string }

/** CapCut's default transition length. */
export const DEFAULT_TRANSITION_SECONDS = 0.5
/** How close (screen px) the pointer must be to a cut for a transition to snap to it. CapCut's
 *  radius lives in its C++ and is unknown; 12 px is a comfortable target. */
export const CUT_SNAP_PX = 12
/** Shorter than this and a transition can't fit (each clip needs real frames on both sides). */
export const MIN_TRANSITION_SECONDS = 0.1

export function resolveDrop(
  project: Project,
  payload: DragPayload,
  at: { trackId: string; time: number; pxPerSecond: number }
): DropResolution {
  const track = project.tracks.find((t) => t.id === at.trackId)
  if (!track) return { kind: 'reject', reason: 'Drop onto a timeline track.' }

  if (payload.kind === 'effect') {
    if (!effectCatalogEntry(payload.type)) return { kind: 'reject', reason: 'Unknown effect.' }
    if (track.type !== 'video') return { kind: 'reject', reason: 'Effects go on video or image clips, not audio or text.' }
    const clip = track.clips.find((c) => at.time >= c.start && at.time < c.start + c.duration)
    if (!clip) return { kind: 'reject', reason: 'Drag this effect onto the clip you want to apply it to.' }
    if (clip.kind !== 'media') return { kind: 'reject', reason: 'Effects go on video or image clips.' }
    return { kind: 'attach', clipId: clip.id }
  }

  // Transition
  if (!TRANSITION_CATALOG.some((t) => t.type === payload.type)) return { kind: 'reject', reason: 'Unknown transition.' }
  if (track.type !== 'video') return { kind: 'reject', reason: 'Transitions go between two video clips.' }
  const mainTrack = project.tracks.find((t) => t.type === 'video')
  if (track.id !== mainTrack?.id) return { kind: 'reject', reason: 'Transitions only work on the main video track for now.' }

  const clips = [...track.clips].sort((a, b) => a.start - b.start)
  if (clips.length < 2) return { kind: 'reject', reason: 'Transitions need two clips side by side.' }

  // Each cut is where clip i-1 hands over to clip i. With an existing transition the clips
  // overlap, so the cut sits in the middle of the overlap.
  const radius = CUT_SNAP_PX / Math.max(at.pxPerSecond, 1e-6)
  let best: { i: number; cutTime: number; dist: number } | null = null
  for (let i = 1; i < clips.length; i++) {
    const prevEnd = clips[i - 1].start + clips[i - 1].duration
    const cutTime = (clips[i].start + prevEnd) / 2
    const dist = Math.abs(at.time - cutTime)
    if (dist <= radius && (!best || dist < best.dist)) best = { i, cutTime, dist }
  }
  if (!best) return { kind: 'reject', reason: 'Drop the transition on a cut between two clips.' }

  const left = clips[best.i - 1]
  const right = clips[best.i]
  const fits = Math.min(left.duration, right.duration)
  if (fits < MIN_TRANSITION_SECONDS) return { kind: 'reject', reason: 'Clips are too short for a transition.' }
  // Replacing a transition keeps its length; a new one gets the default, clamped to what fits.
  const existing = right.transitionIn?.duration ?? 0
  const duration = Math.min(existing > 0 ? existing : DEFAULT_TRANSITION_SECONDS, fits)
  return { kind: 'transition', leftClipId: left.id, rightClipId: right.id, cutTime: best.cutTime, duration }
}

/** MIME types marking an effect/transition drag. The payload itself can't be read during
 *  `dragover` (browsers only expose the types until drop), so the card also records it in
 *  `activeDragPayload` (renderer) for live hover feedback; the drop reads the JSON data. */
export const EFFECT_DRAG_MIME = 'application/x-freecut-effect'
export const TRANSITION_DRAG_MIME = 'application/x-freecut-transition'

export function parseDragPayload(mime: string, json: string): DragPayload | null {
  try {
    const v = JSON.parse(json) as { type?: string }
    if (typeof v.type !== 'string') return null
    if (mime === EFFECT_DRAG_MIME) return { kind: 'effect', type: v.type as ClipEffectType }
    if (mime === TRANSITION_DRAG_MIME) return { kind: 'transition', type: v.type as TransitionType }
    return null
  } catch {
    return null
  }
}
