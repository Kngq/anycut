import type { MediaAsset, Project, Track } from './types'

/**
 * Where a media-bin asset dragged over the timeline would land: the "follow segment" ghost.
 * Modeled on CapCut's MainTimeLineFollowSegments: while hovering, the timeline asks its
 * view-model for a snapped x (`adsorbX = dragPositionChanged(...)`) and draws a translucent
 * segment there, sized to the clip at the current zoom. The drop then commits at the same
 * place. This function serves both hover and drop, so they always agree. Pure and unit-tested.
 */

export interface MediaDropGhost {
  trackId: string
  /** Where the clip will start (seconds), after insertion/snapping. */
  start: number
  duration: number
  /** Time of the edge the ghost snapped to, or null if it isn't snapped. */
  snapTime: number | null
  /** What it snapped to. 'playhead' also lights up the playhead, as CapCut does. */
  snapKind: 'playhead' | 'edge' | null
}

/** How close (screen px) a ghost edge must be to a snap target. CapCut's radius is a C++
 *  constant we couldn't read. 10 px matches the feel of the existing cut-snap. */
export const MEDIA_SNAP_PX = 10

/** The clip duration a dropped asset gets (stills default to 5 s, as in addMediaClipToTrack). */
export function dropDurationFor(asset: MediaAsset): number {
  return asset.kind === 'image' ? 5 : asset.duration
}

/** The track a dropped asset lands on: the hovered one if its type fits, else the first that does. */
export function trackForAsset(project: Project, asset: MediaAsset, hoveredTrackId: string): Track | undefined {
  const wanted = asset.kind === 'audio' ? 'audio' : 'video'
  const hovered = project.tracks.find((t) => t.id === hoveredTrackId)
  return hovered?.type === wanted ? hovered : project.tracks.find((t) => t.type === wanted)
}

export function resolveMediaDrop(
  project: Project,
  asset: MediaAsset,
  at: { trackId: string; time: number; pxPerSecond: number; playhead: number; snap: boolean }
): MediaDropGhost | null {
  const track = trackForAsset(project, asset, at.trackId)
  if (!track) return null
  const duration = dropDurationFor(asset)

  if (track.type === 'video' && project.tracks.find((t) => t.type === 'video')?.id === track.id) {
    // The main video track stays gap-free (CapCut's main-track magnet). The drop inserts before the first
    // clip whose midpoint is past the pointer, which is the same rule addMediaClipToTrack uses.
    // So the ghost sits exactly at that cut.
    const clips = [...track.clips].sort((a, b) => a.start - b.start)
    const before = clips.find((c) => at.time < c.start + c.duration / 2)
    const end = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0)
    const start = before ? before.start : end
    return { trackId: track.id, start, duration, snapTime: clips.length > 0 ? start : null, snapKind: clips.length > 0 ? 'edge' : null }
  }

  // Free tracks (overlay video, audio, text): the clip goes where the pointer is, with its start
  // OR end edge snapped to the nearest target (clip edges on any track, the playhead, 0).
  if (!at.snap) return { trackId: track.id, start: Math.max(0, at.time), duration, snapTime: null, snapKind: null }
  return { trackId: track.id, duration, ...snapFreeStart(project, at.time, duration, at.pxPerSecond, at.playhead) }
}

/** Snaps a free-track clip spanning [start, start+duration) so its start or end edge lands on the
 *  nearest clip edge (any track, except `ignoreClipId`), the playhead or 0, within MEDIA_SNAP_PX.
 *  Shared by bin drops and dragging an existing clip along a free track. */
export function snapFreeStart(
  project: Project,
  time: number,
  duration: number,
  pxPerSecond: number,
  playhead: number,
  ignoreClipId?: string
): { start: number; snapTime: number | null; snapKind: 'playhead' | 'edge' | null } {
  let start = Math.max(0, time)
  const targets: { t: number; kind: 'playhead' | 'edge' }[] = [{ t: 0, kind: 'edge' }, { t: playhead, kind: 'playhead' }]
  for (const t of project.tracks) for (const c of t.clips) if (c.id !== ignoreClipId) targets.push({ t: c.start, kind: 'edge' }, { t: c.start + c.duration, kind: 'edge' })
  const at = { pxPerSecond }

  const radius = MEDIA_SNAP_PX / Math.max(at.pxPerSecond, 1e-6)
  let best: { delta: number; t: number; kind: 'playhead' | 'edge' } | null = null
  for (const target of targets) {
    for (const edge of [start, start + duration]) {
      const delta = target.t - edge
      if (Math.abs(delta) <= radius && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, t: target.t, kind: target.kind }
    }
  }
  if (best && start + best.delta >= 0) {
    start += best.delta
    return { start, snapTime: best.t, snapKind: best.kind }
  }
  return { start, snapTime: null, snapKind: null }
}
