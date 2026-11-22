import { MIN_TRANSITION_SECONDS } from './dropTargets'
import type { Track, TransitionType } from './types'

/**
 * Timeline geometry for transitions, drawn the way CapCut draws them: as their own block over
 * the cut (CapCut's MainTimeLineSegmentTransition), not as one clip stretched over another.
 *
 * anycut stores a transition as an overlap. The right clip starts `d` seconds before the left
 * one ends, and preview and export cross the two over that span. That model doesn't change.
 * Only the drawing does:
 *  - each clip is drawn trimmed by d/2 on the transition side, so the two clips butt together
 *    at the overlap's midpoint (the cut, as CapCut shows it);
 *  - the transition block covers the overlap [right.start, right.start + d], centred on that cut.
 * Pure and unit-tested.
 */

export interface TransitionBlock {
  /** The clip that owns the transition (`transitionIn`), i.e. the right-hand clip. */
  clipId: string
  leftClipId: string
  type: TransitionType
  start: number
  duration: number
  /** The cut the block is centred on. Resizing keeps it fixed. */
  mid: number
  /** Longest the transition may be: both clips need real frames under it. */
  maxDuration: number
}

function sortedClips(track: Track) {
  return [...track.clips].sort((a, b) => a.start - b.start)
}

export function transitionBlocks(track: Track): TransitionBlock[] {
  if (track.type !== 'video') return []
  const clips = sortedClips(track)
  const out: TransitionBlock[] = []
  for (let i = 1; i < clips.length; i++) {
    const c = clips[i]
    const d = c.transitionIn?.duration ?? 0
    if (!c.transitionIn || d <= 0) continue
    const left = clips[i - 1]
    // The actual overlap (repack may have clamped the stored duration).
    const overlap = Math.min(d, left.start + left.duration - c.start)
    if (overlap <= 0) continue
    out.push({
      clipId: c.id,
      leftClipId: left.id,
      type: c.transitionIn.type,
      start: c.start,
      duration: overlap,
      mid: c.start + overlap / 2,
      maxDuration: Math.min(left.duration, c.duration)
    })
  }
  return out
}

/** Seconds to shave off each side of each clip when drawing, so clips meet at the cut. */
export function clipDrawInsets(track: Track): Map<string, { left: number; right: number }> {
  const insets = new Map<string, { left: number; right: number }>()
  for (const b of transitionBlocks(track)) {
    const half = b.duration / 2
    insets.set(b.clipId, { left: half, right: insets.get(b.clipId)?.right ?? 0 })
    insets.set(b.leftClipId, { left: insets.get(b.leftClipId)?.left ?? 0, right: half })
  }
  return insets
}

/** New duration while an edge handle is dragged: the block grows or shrinks symmetrically
 *  around its cut, so the pointer always sits on the dragged edge. */
export function resizedTransitionDuration(block: Pick<TransitionBlock, 'mid' | 'maxDuration'>, pointerTime: number): number {
  const d = 2 * Math.abs(pointerTime - block.mid)
  return Math.min(block.maxDuration, Math.max(MIN_TRANSITION_SECONDS, d))
}
