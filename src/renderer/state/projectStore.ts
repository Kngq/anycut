import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { captionStyleOf, defaultCaptionStyle, type CaptionLine } from '@shared/captions'
import { captionTemplate, templateStyle } from '@shared/captionTemplates'
import * as ops from '@shared/clipOps'
import { normalizeCurvePoints, sampleSpeedCurve } from '@shared/speedCurve'
import type { ClipAttributes, ClipClipboard } from '@shared/clipOps'
import {
  createEffect,
  isFullCrop,
  createEmptyProject,
  defaultTransform,
  effectiveDuration,
  projectDuration,
  sourceTimeFor,
  type Clip,
  type ClipEffect,
  type ClipEffectType,
  type ClipCrop,
  type ClipTransform,
  type ColorSpaceId,
  type MediaAsset,
  type MediaClip,
  type Project,
  type SpeedKeyframe,
  type SpeedCurvePoint,
  type TextClip,
  type Track,
  type TrackType,
  type Transition,
  type TransitionType
} from '@shared/types'

interface ProjectState {
  project: Project
  filePath: string | null
  dirty: boolean
  selectedClipId: string | null
  /** Transient: a media asset being previewed on its own in the Preview panel (from clicking a
   *  card in the MediaBin), independent of the timeline. Null = show the timeline as normal.
   *  Session-only, never serialized. */
  previewAssetId: string | null
  /** Transient: ids of assets whose source file is missing on disk (moved/renamed/unplugged).
   *  Set by the post-open media check; cleared per asset when it's relinked. Never serialized. */
  missingAssetIds: string[]
  /** Transient: an effect the Inspector should reveal (set by clicking a clip's effect badge).
   *  `nonce` makes repeat clicks on the same effect re-trigger the scroll. */
  effectFocus: { clipId: string; effectId: string; nonce: number } | null
  /** Multi-selection (Cmd/Shift-click, groups). Read it through selectionOf(): it's only valid
   *  while it contains `selectedClipId`, which stays the primary (Inspector) clip. */
  selectedClipIds: string[]
  /** Copy/Cut clipboard and the "Copy attributes" clipboard. Session-only. */
  clipboard: ClipClipboard | null
  attributeClipboard: ClipAttributes | null
  playhead: number
  isPlaying: boolean
  pxPerSecond: number
  /** Undo/redo history: `past` holds prior project snapshots (most recent last), `future`
   *  holds snapshots undone off the top of `past` (for redo). Both are cleared on
   *  setProject/newProject. Capped to HISTORY_LIMIT to bound memory. */
  past: Project[]
  future: Project[]

  setProject: (project: Project, filePath?: string | null) => void
  newProject: () => void

  /** Reverts to the previous project snapshot (no-op when `past` is empty). */
  undo: () => void
  /** Re-applies the most recently undone snapshot (no-op when `future` is empty). */
  redo: () => void

  addAsset: (asset: MediaAsset) => void
  /** Merges partial fields into an existing asset (used to attach proxy/cover/waveform as the
   *  background jobs for them finish, so an imported asset can appear instantly and fill in). */
  patchAsset: (assetId: string, patch: Partial<MediaAsset>) => void
  /** Removes an asset from the media pool and any clips on the timeline that reference it. */
  removeAsset: (assetId: string) => void
  /** Records which assets are offline (source file missing). */
  setMissingAssets: (assetIds: string[]) => void
  /** Points assets at new source paths (oldPath → newPath). Derived artifacts built from the old
   *  file (proxy, filmstrip, waveform) are dropped so they're regenerated from the new one; clips
   *  keep referencing the same asset id, so the timeline is untouched. Undoable. */
  relinkAssets: (pathMap: Record<string, string>) => void
  /** On video tracks the clip is appended unless `insertAtStart` is set, in which case it's placed at `start`. */
  addMediaClipToTrack: (trackId: string, asset: MediaAsset, start: number, options?: { insertAtStart?: boolean }) => void
  addTextClipToTrack: (trackId: string, start: number) => void
  /** Replaces every auto-caption with `lines`, on the captions text track (the one already
   *  holding captions, else a new "Captions" track). New captions keep the existing captions'
   *  style if there are any, else the default. One undo step. */
  setAutoCaptions: (lines: CaptionLine[], templateId?: string) => void
  /** Restyles every caption with a template ('basic' = the plain default). One undo step. */
  applyCaptionTemplate: (templateId: string) => void
  /** Copies one caption's look (font, size, colour, bold, outline, height) to every caption. */
  applyCaptionStyleToAll: (fromClipId: string) => void
  addTrack: (type: TrackType) => void

  /** Free positioning: only valid for audio/text tracks. */
  moveFreeClip: (clipId: string, newStart: number, newTrackId?: string) => void
  /** Reorder within (or into) a contiguous video track by array index. */
  reorderVideoClip: (clipId: string, toTrackId: string, toIndex: number) => void

  trimClip: (clipId: string, edge: 'start' | 'end', newTime: number) => void
  splitClipAtPlayhead: () => void
  /** Splits the clip at the playhead and inserts a 1s frozen hold at the cut — a no-op
   *  unless canInsertFreezeFrame() agrees. */
  insertFreezeFrame: (clipId: string) => void
  setClipSpeed: (clipId: string, speed: number) => void
  /** Replaces the whole speed-curve keyframe list; undefined disables the curve (falls back
   *  to the clip's flat `speed`). Points are sorted, and clamped to [trimIn,trimOut]/[0.1,4]. */
  setClipSpeedKeyframes: (clipId: string, keyframes: SpeedKeyframe[] | undefined) => void
  /** Speed > Curve graph: stores the control points + preset id and writes `speedKeyframes`
   *  sampled from the smooth curve through them (so playback/export match the graph).
   *  undefined clears the curve. `live` skips the undo step (pointer drags call
   *  recordUndoPoint once on release instead). */
  setClipSpeedCurve: (clipId: string, points: SpeedCurvePoint[] | undefined, preset?: string, opts?: { live?: boolean }) => void
  /** Records `before` as one undo step if the project has changed since (used after a live drag). */
  recordUndoPoint: (before: Project) => void
  setClipReversed: (clipId: string, reversed: boolean) => void
  /** Replaces a clip's transform (position/scale/opacity, optionally keyframed). Works for
   *  both media and text clips since `transform` lives on ClipBase. */
  setClipTransform: (clipId: string, transform: ClipTransform) => void
  /** Rotates a clip by `deltaDegrees` (the toolbar uses +90). Normalized to [0,360). */
  rotateClip: (clipId: string, deltaDegrees: number) => void
  /** Toggles a clip's horizontal mirror (the toolbar's Mirror button). */
  toggleClipFlipH: (clipId: string) => void
  /** Rejoins a clip with its immediate next sibling on the same video track — the inverse of
   *  Split. Only valid when canMergeWithNext() agrees; a no-op otherwise. */
  mergeWithNext: (clipId: string) => void
  removeClip: (clipId: string) => void
  setTransition: (clipId: string, duration: number) => void
  /** Changes the transition type (crossfade/slide/wipe/…) without touching its duration; a
   *  no-op when the clip has no transitionIn yet (set a duration first). */
  /** Sets type AND duration in one undo step (drag-drop and the Transitions tab); undefined removes it.
   *  Same guard as setTransition: main video track, not the first clip. */
  setClipTransition: (clipId: string, transition: Transition | undefined) => void
  setTransitionType: (clipId: string, type: TransitionType) => void
  /** Appends a default-param effect of `type` to a clip's effect stack. */
  addClipEffect: (clipId: string, type: ClipEffectType) => void
  /** Removes one effect instance by its id. */
  removeClipEffect: (clipId: string, effectId: string) => void
  /** Patches one numeric param of one effect instance. */
  updateClipEffectParam: (clipId: string, effectId: string, key: string, value: number) => void
  updateTextClip: (clipId: string, patch: Record<string, unknown>) => void
  updateMediaClipProps: (clipId: string, patch: Partial<Pick<MediaClip, 'volume' | 'muted' | 'changeAudioPitch'>>) => void
  /** Animation tab: replaces the clip's In/Out/Combo presets. `record` = add an undo step
   *  (off while a duration slider is being dragged). */
  setClipAnimations: (clipId: string, animations: MediaClip['animations'], record?: boolean) => void
  /** Filters: sets or clears (undefined) the clip's filter. `record` = add an undo step (off
   *  while the intensity slider is dragged). */
  setClipFilter: (clipId: string, filter: MediaClip['filter'], record?: boolean) => void
  /** Points one clip at a baked stand-in (e.g. background removed), or clears it (undefined).
   *  The bin asset is untouched. Undoable. */
  setClipSourceOverride: (clipId: string, override: MediaClip['sourceOverride']) => void

  selectClip: (clipId: string | null) => void
  /** Cmd/Shift-click: adds or removes a clip (and its group) from the selection. */
  toggleClipSelection: (clipId: string) => void
  copySelection: () => void
  cutSelection: () => void
  paste: () => void
  copyAttributes: (clipId: string) => void
  pasteAttributesToSelection: () => void
  deleteSelection: () => void
  setSelectionDisabled: (disabled: boolean) => void
  groupSelection: () => void
  ungroupSelection: () => void
  separateAudio: (clipId: string) => void
  replaceClipMedia: (clipId: string, asset: MediaAsset) => void
  /** CapCut's Trim start / Trim end: cut the clip's head or tail off at the playhead. */
  trimClipToPlayhead: (clipId: string, edge: 'start' | 'end') => void
  setClipCrop: (clipId: string, crop: ClipCrop | undefined) => void
  /** Swaps `clipIds` for one clip of the already-rendered compound `asset` (added to the bin). */
  applyCompound: (clipIds: string[], asset: MediaAsset) => void
  setColorSpace: (id: ColorSpaceId) => void
  /** Selects the clip and asks the Inspector to reveal one of its effects. */
  focusEffect: (clipId: string, effectId: string) => void
  /** Sets (or clears, with null) the asset previewed standalone in the Preview panel. */
  setPreviewAsset: (assetId: string | null) => void
  /** Changes the output canvas resolution (aspect ratio). Keeps fps. */
  setCanvasSize: (width: number, height: number) => void
  setPlayhead: (t: number) => void
  setIsPlaying: (v: boolean) => void
  setZoom: (pxPerSecond: number) => void
}

function findClip(project: Project, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index !== -1) return { track, clip: track.clips[index], index }
  }
  return null
}

/** Whether `clipId` can be rejoined with its immediate next sibling on the same video track:
 *  both must be plain (non-frozen, non-curve-speed) media clips from the same asset, sharing
 *  speed/reversed, and trim-contiguous (the next clip's trimIn picks up exactly where this
 *  clip's trimOut leaves off — true right after a Split, and whenever neither side has been
 *  retrimmed since). Exported for the Inspector to decide whether to show the merge button. */
export function canMergeWithNext(project: Project, clipId: string): boolean {
  const found = findClip(project, clipId)
  if (!found || found.track.type !== 'video') return false
  const { track, clip, index } = found
  if (clip.kind !== 'media' || clip.frozen || (clip.speedKeyframes?.length ?? 0) >= 2) return false
  const next = track.clips[index + 1]
  if (!next || next.kind !== 'media' || next.frozen || (next.speedKeyframes?.length ?? 0) >= 2) return false
  if (next.assetId !== clip.assetId || next.speed !== clip.speed || next.reversed !== clip.reversed) return false
  return Math.abs(next.trimIn - clip.trimOut) <= 1e-6
}

/** Whether `clipId` can carry a transitionIn: it must be a media/text clip on the FIRST video
 *  track and not the first clip in that track (a transition blends it with the clip before it).
 *  Mirrors the guard in setTransition, and the Inspector's inline `canHaveTransition`. Exported
 *  so the Transitions tab can decide whether applying a transition will take effect. */
export function canHaveTransition(project: Project, clipId: string | null): boolean {
  if (!clipId) return false
  const found = findClip(project, clipId)
  if (!found || found.track.type !== 'video') return false
  const firstVideoTrack = project.tracks.find((t) => t.type === 'video')
  return found.track.id === firstVideoTrack?.id && found.index > 0
}

/** Whether a freeze frame can be inserted at `playhead` into `clipId`: it must be a plain
 *  (non-frozen) media clip on a video track, and the playhead must sit strictly inside its
 *  span (same tolerance splitClipAtPlayhead uses). Exported for the Toolbar to decide the
 *  freeze-frame button's enabled state without duplicating this logic. */
export function canInsertFreezeFrame(project: Project, playhead: number, clipId: string | null): boolean {
  if (!clipId) return false
  const found = findClip(project, clipId)
  if (!found || found.track.type !== 'video') return false
  const { clip } = found
  if (clip.kind !== 'media' || clip.frozen) return false
  return playhead > clip.start + 0.05 && playhead < clip.start + clip.duration - 0.05
}

/** The effective selection: the multi-select list when it still includes the primary clip,
 *  else just the primary (many actions set only selectedClipId). Ids that no longer exist are
 *  dropped. */
export function selectionOf(s: Pick<ProjectState, 'project' | 'selectedClipId' | 'selectedClipIds'>): string[] {
  if (!s.selectedClipId) return []
  const ids = s.selectedClipIds.includes(s.selectedClipId) ? s.selectedClipIds : [s.selectedClipId]
  return ids.filter((id) => findClip(s.project, id))
}

function touch(project: Project): Project {
  return { ...project, updatedAt: Date.now() }
}

/** A clip's length on the timeline: speed/curve/frozen-aware for media clips, the plain
 *  field for text clips (which have no speed concept). */
function clipTimelineDuration(c: Clip): number {
  return c.kind === 'media' ? effectiveDuration(c) : c.duration
}

/**
 * Video tracks are a contiguous roll: array order === playback order, and `start` is a
 * derived value, not something a drag can set freely. A transitionIn pulls a clip's start
 * back by its (clamped) duration, exactly mirroring the xfade offset math in ffmpegGraph.ts
 * so the canvas preview and the exported file always agree. `duration` is also re-derived
 * here for media clips (speed/curve/frozen can change it) and cached onto the clip so other
 * code (Timeline width, projectDuration) can keep reading `clip.duration` directly.
 */
function repackVideoTrack(track: Track): Track {
  if (track.type !== 'video') return track
  const clips = track.clips
  let cursor = 0
  const repacked = clips.map((c, i) => {
    const dur = clipTimelineDuration(c)
    if (i === 0) {
      cursor = dur
      return { ...c, start: 0, duration: dur, transitionIn: undefined } as Clip
    }
    const d = Math.min(c.transitionIn?.duration ?? 0, cursor, dur)
    const start = cursor - d
    cursor = start + dur
    return { ...c, start, duration: dur } as Clip
  })
  return { ...track, clips: repacked }
}

function updateTrack(project: Project, trackId: string, fn: (t: Track) => Track): Project {
  const tracks = project.tracks.map((t) => (t.id === trackId ? fn(t) : t))
  return touch({ ...project, tracks })
}

/** Splits a non-frozen media clip at `firstDuration` (clip-local timeline seconds) into two
 *  new halves whose trimIn/trimOut/speed correctly continue playback across the cut.
 *  sourceTimeFor already accounts for speed curves and `reversed` — it's exactly the source
 *  position the playhead is sitting on. A speed curve can't be precisely partitioned across a
 *  cut in v1, so both halves fall back to a flat 1x rather than carry a curve that no longer
 *  matches their range. Shared by splitClipAtPlayhead and insertFreezeFrame. */
function splitMediaClipHalves(clip: MediaClip, firstDuration: number): { first: MediaClip; second: MediaClip } {
  const secondDuration = clip.duration - firstDuration
  const splitSource = sourceTimeFor(clip, firstDuration)
  const hasCurve = (clip.speedKeyframes?.length ?? 0) >= 2
  const speed = hasCurve ? 1 : clip.speed
  const secondBase = {
    ...clip,
    id: uuid(),
    start: clip.start + firstDuration,
    duration: secondDuration,
    speed,
    speedKeyframes: undefined,
    speedCurvePoints: undefined,
    speedCurvePreset: undefined,
    transitionIn: undefined
  }
  if (clip.reversed) {
    return {
      first: { ...clip, duration: firstDuration, trimIn: splitSource, trimOut: clip.trimOut, speed, speedKeyframes: undefined, speedCurvePoints: undefined, speedCurvePreset: undefined },
      second: { ...secondBase, trimIn: clip.trimIn, trimOut: splitSource }
    }
  }
  return {
    first: { ...clip, duration: firstDuration, trimOut: splitSource, speed, speedKeyframes: undefined, speedCurvePoints: undefined, speedCurvePreset: undefined },
    second: { ...secondBase, trimIn: splitSource, trimOut: clip.trimOut }
  }
}

/** Max number of undo snapshots kept, to bound memory for long sessions. */
const HISTORY_LIMIT = 100

/** Returns the `past`/`future` update that records the current project as an undo point before
 *  a committing mutation: appends `current` to `past` (capped) and clears `future` (a new edit
 *  invalidates the redo stack). Spread into a mutation's returned state alongside the new
 *  `project`. Example: `return { project: next, dirty: true, ...recordPast(s) }`. */
function recordPast(s: { project: Project; past: Project[] }): { past: Project[]; future: Project[] } {
  return { past: [...s.past, s.project].slice(-HISTORY_LIMIT), future: [] }
}

/** A timeline at or beyond this length (seconds) is treated as "long": adding a clip that pushes
 *  the project past it snaps the timeline to minimum zoom (and thus the minute-scale ruler). */
const LONG_TIMELINE_SECONDS = 60

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: createEmptyProject('Untitled'),
  filePath: null,
  dirty: false,
  selectedClipId: null,
  previewAssetId: null,
  missingAssetIds: [],
  effectFocus: null,
  selectedClipIds: [],
  clipboard: null,
  attributeClipboard: null,
  playhead: 0,
  isPlaying: false,
  pxPerSecond: 60,
  past: [],
  future: [],

  setProject: (project, filePath = null) => set({ project, filePath, dirty: false, selectedClipId: null, previewAssetId: null, missingAssetIds: [], playhead: 0, past: [], future: [] }),

  newProject: () => set({ project: createEmptyProject('Untitled'), filePath: null, dirty: false, selectedClipId: null, previewAssetId: null, missingAssetIds: [], playhead: 0, past: [], future: [] }),

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return {}
      const previous = s.past[s.past.length - 1]
      return {
        project: previous,
        past: s.past.slice(0, -1),
        future: [s.project, ...s.future].slice(0, HISTORY_LIMIT),
        dirty: true,
        // Keep the selection only if it still exists in the restored project.
        selectedClipId: s.selectedClipId && findClip(previous, s.selectedClipId) ? s.selectedClipId : null
      }
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return {}
      const next = s.future[0]
      return {
        project: next,
        past: [...s.past, s.project].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        dirty: true,
        selectedClipId: s.selectedClipId && findClip(next, s.selectedClipId) ? s.selectedClipId : null
      }
    }),

  addAsset: (asset) =>
    set((s) => ({ project: touch({ ...s.project, assets: [...s.project.assets, asset] }), dirty: true })),

  patchAsset: (assetId, patch) =>
    set((s) => {
      // No-op if the asset is gone (e.g. removed before a background job finished). Don't mark
      // dirty or record undo — attaching a derived artifact (proxy/cover/waveform) isn't a
      // document edit the user needs to undo/save-prompt over.
      if (!s.project.assets.some((a) => a.id === assetId)) return {}
      const assets = s.project.assets.map((a) => (a.id === assetId ? { ...a, ...patch } : a))
      return { project: { ...s.project, assets } }
    }),

  removeAsset: (assetId) =>
    set((s) => {
      const tracks = s.project.tracks.map((t) => {
        const clips = t.clips.filter((c) => !(c.kind === 'media' && c.assetId === assetId))
        return t.type === 'video' ? repackVideoTrack({ ...t, clips }) : { ...t, clips }
      })
      const assets = s.project.assets.filter((a) => a.id !== assetId)
      const project = touch({ ...s.project, tracks, assets })
      const selectionStillExists = s.selectedClipId !== null && findClip(project, s.selectedClipId) !== null
      const previewStillExists = s.previewAssetId !== null && assets.some((a) => a.id === s.previewAssetId)
      return {
        project,
        dirty: true,
        selectedClipId: selectionStillExists ? s.selectedClipId : null,
        previewAssetId: previewStillExists ? s.previewAssetId : null,
        ...recordPast(s)
      }
    }),

  setMissingAssets: (assetIds) => set({ missingAssetIds: assetIds }),

  relinkAssets: (pathMap) =>
    set((s) => {
      const relinkedIds: string[] = []
      const assets = s.project.assets.map((a) => {
        const next = pathMap[a.path]
        if (!next || next === a.path) return a
        relinkedIds.push(a.id)
        const name = next.split(/[/\\]/).pop() ?? a.name
        // Drop artifacts derived from the OLD file; the caller re-enriches from the new path.
        // Images are their own cover, so theirs just follows the new path.
        const cover = a.kind === 'image' && a.cover ? { ...a.cover, path: next } : undefined
        return { ...a, path: next, name, previewPath: undefined, cover, waveform: undefined }
      })
      if (relinkedIds.length === 0) return {}
      return {
        project: touch({ ...s.project, assets }),
        missingAssetIds: s.missingAssetIds.filter((id) => !relinkedIds.includes(id)),
        dirty: true,
        ...recordPast(s)
      }
    }),

  addMediaClipToTrack: (trackId, asset, start, options) =>
    set((s) => {
      const track = s.project.tracks.find((t) => t.id === trackId)
      if (!track) return {}
      const duration = asset.kind === 'image' ? 5 : asset.duration
      const clip: MediaClip = {
        id: uuid(),
        kind: 'media',
        trackId,
        start: track.type === 'video' ? 0 : start,
        duration,
        trimIn: 0,
        trimOut: asset.kind === 'image' ? duration : asset.duration,
        assetId: asset.id,
        volume: 1,
        muted: false,
        speed: 1,
        reversed: false,
        frozen: false,
        transform: defaultTransform()
      }
      const project = updateTrack(s.project, trackId, (t) => {
        let clips = [...t.clips, clip]
        if (t.type === 'video' && options?.insertAtStart) {
          // Insert before the first clip whose midpoint is after the drop point, like a drag-reorder.
          const index = t.clips.findIndex((c) => start < c.start + c.duration / 2)
          if (index !== -1) clips = [...t.clips.slice(0, index), clip, ...t.clips.slice(index)]
        }
        return repackVideoTrack({ ...t, clips })
      })
      // When the timeline becomes "long" (>= LONG_TIMELINE_SECONDS), snap to minimum zoom so the
      // whole thing fits. Setting pxPerSecond to 1 lands below the Timeline's dynamic floor; the
      // Timeline's clamp effect then pulls it up to exactly the "half the timeline" minimum, and
      // the adaptive ruler switches to a minute scale at that zoom. We only ever drop zoom here
      // (never raise it), so a user who's zoomed in on a short project isn't disturbed.
      const zoomPatch = projectDuration(project) >= LONG_TIMELINE_SECONDS ? { pxPerSecond: 1 } : {}
      return { project, dirty: true, selectedClipId: clip.id, ...zoomPatch, ...recordPast(s) }
    }),

  addTextClipToTrack: (trackId, start) =>
    set((s) => {
      const clip: Clip = {
        id: uuid(),
        kind: 'text',
        trackId,
        start,
        duration: 3,
        text: 'New text',
        fontSize: 64,
        color: 'white',
        bold: true,
        fontFamily: 'sans',
        transform: defaultTransform()
      }
      const project = updateTrack(s.project, trackId, (t) => ({ ...t, clips: [...t.clips, clip] }))
      return { project, dirty: true, selectedClipId: clip.id, ...recordPast(s) }
    }),

  setAutoCaptions: (lines, templateId) =>
    set((s) => {
      const isCaption = (c: Clip) => c.kind === 'text' && !!c.caption
      const existing = s.project.tracks.flatMap((t) => t.clips).find(isCaption) as TextClip | undefined
      const tpl = captionTemplate(templateId)
      const style = existing
        ? captionStyleOf(existing)
        : tpl
          ? { ...templateStyle(tpl, s.project.canvas), y: defaultCaptionStyle(s.project.canvas).y }
          : defaultCaptionStyle(s.project.canvas)
      let tracks = s.project.tracks
      let captionTrack = tracks.find((t) => t.type === 'text' && t.clips.some(isCaption))
      if (!captionTrack) {
        captionTrack = { id: uuid(), type: 'text', name: 'Captions', clips: [], muted: false, hidden: false }
        tracks = [...tracks, captionTrack]
      }
      const trackId = captionTrack.id
      const newClips: TextClip[] = lines.map((line) => ({
        id: uuid(),
        kind: 'text',
        trackId,
        start: Math.max(0, line.start),
        duration: Math.max(0.2, line.end - line.start),
        text: line.text,
        fontSize: style.fontSize,
        color: style.color,
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        textCase: style.textCase,
        fontFamily: style.fontFamily,
        ...(style.stroke ? { stroke: { ...style.stroke } } : {}),
        ...(style.look ? { look: structuredClone(style.look) } : {}),
        transform: { ...defaultTransform(), y: style.y },
        caption: { words: line.words.map((w) => ({ text: w.text, start: w.start - line.start, end: w.end - line.start })) }
      }))
      tracks = tracks.map((t) => {
        const kept = t.clips.filter((c) => !isCaption(c))
        return t.id === trackId ? { ...t, clips: [...kept, ...newClips] } : kept.length === t.clips.length ? t : { ...t, clips: kept }
      })
      const selectedGone = s.selectedClipId && !tracks.some((t) => t.clips.some((c) => c.id === s.selectedClipId))
      return { project: touch({ ...s.project, tracks }), dirty: true, ...(selectedGone ? { selectedClipId: null } : {}), ...recordPast(s) }
    }),

  applyCaptionStyleToAll: (fromClipId) =>
    set((s) => {
      const from = findClip(s.project, fromClipId)?.clip
      if (!from || from.kind !== 'text' || !from.caption) return {}
      const style = captionStyleOf(from)
      const tracks = s.project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c): Clip => {
          if (c.kind !== 'text' || !c.caption || c.id === fromClipId) return c
          const { stroke: _drop, look: _dropLook, ...rest } = c
          return {
            ...rest,
            fontSize: style.fontSize,
            color: style.color,
            bold: style.bold,
            italic: style.italic,
            underline: style.underline,
            textCase: style.textCase,
            fontFamily: style.fontFamily,
            ...(style.stroke ? { stroke: { ...style.stroke } } : {}),
            ...(style.look ? { look: structuredClone(style.look) } : {}),
            transform: { ...c.transform, y: style.y }
          }
        })
      }))
      return { project: touch({ ...s.project, tracks }), dirty: true, ...recordPast(s) }
    }),

  applyCaptionTemplate: (templateId) =>
    set((s) => {
      const tpl = captionTemplate(templateId)
      const base = defaultCaptionStyle(s.project.canvas)
      const style = tpl ? templateStyle(tpl, s.project.canvas) : { fontSize: base.fontSize, color: base.color, bold: base.bold, fontFamily: base.fontFamily ?? 'sans', stroke: base.stroke, look: undefined }
      let changed = false
      const tracks = s.project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c): Clip => {
          if (c.kind !== 'text' || !c.caption) return c
          changed = true
          const { stroke: _s, look: _l, ...rest } = c
          return {
            ...rest,
            fontSize: style.fontSize,
            color: style.color,
            bold: style.bold,
            fontFamily: style.fontFamily,
            ...(style.stroke ? { stroke: { ...style.stroke } } : {}),
            ...(style.look ? { look: structuredClone(style.look) } : {})
          }
        })
      }))
      if (!changed) return {}
      return { project: touch({ ...s.project, tracks }), dirty: true, ...recordPast(s) }
    }),

  addTrack: (type) =>
    set((s) => {
      const count = s.project.tracks.filter((t) => t.type === type).length + 1
      const track: Track = {
        id: uuid(),
        type,
        name: `${type[0].toUpperCase()}${type.slice(1)} ${count}`,
        clips: [],
        muted: false,
        hidden: false
      }
      return { project: touch({ ...s.project, tracks: [...s.project.tracks, track] }), dirty: true, ...recordPast(s) }
    }),

  moveFreeClip: (clipId, newStart, newTrackId) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.track.type === 'video') return {}
      const targetTrackId = newTrackId ?? found.track.id
      const targetTrack = s.project.tracks.find((t) => t.id === targetTrackId)
      if (!targetTrack || targetTrack.type === 'video') return {}
      const clampedStart = Math.max(0, newStart)
      const tracks = s.project.tracks.map((t) => {
        if (t.id === found.track.id && t.id !== targetTrackId) {
          return { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
        }
        if (t.id === targetTrackId) {
          const withoutClip = t.clips.filter((c) => c.id !== clipId)
          const moved = { ...found.clip, start: clampedStart, trackId: targetTrackId }
          return { ...t, clips: [...withoutClip, moved] }
        }
        return t
      })
      return { project: touch({ ...s.project, tracks }), dirty: true, ...recordPast(s) }
    }),

  reorderVideoClip: (clipId, toTrackId, toIndex) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const targetTrack = s.project.tracks.find((t) => t.id === toTrackId)
      if (!targetTrack || targetTrack.type !== 'video') return {}

      const tracks = s.project.tracks.map((t) => {
        if (t.id === found.track.id && t.id !== toTrackId) {
          return repackVideoTrack({ ...t, clips: t.clips.filter((c) => c.id !== clipId) })
        }
        if (t.id === toTrackId) {
          const without = t.clips.filter((c) => c.id !== clipId)
          const clampedIndex = Math.max(0, Math.min(toIndex, without.length))
          const moved = { ...found.clip, trackId: toTrackId }
          const next = [...without.slice(0, clampedIndex), moved, ...without.slice(clampedIndex)]
          return repackVideoTrack({ ...t, clips: next })
        }
        return t
      })
      return { project: touch({ ...s.project, tracks }), dirty: true, ...recordPast(s) }
    }),

  trimClip: (clipId, edge, newTime) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const clip = found.clip

      // Frozen clips hold a single source frame; trimming just changes how long it's held,
      // not which source frame (trimIn/trimOut stay pinned together).
      if (clip.kind === 'media' && clip.frozen) {
        const newDuration = edge === 'start' ? clip.start + clip.duration - newTime : newTime - clip.start
        if (newDuration < 0.1) return {}
        const patch: Partial<Clip> = { duration: newDuration }
        if (edge === 'start' && found.track.type !== 'video') patch.start = newTime
        const project = updateTrack(s.project, found.track.id, (t) => {
          const withPatch = { ...t, clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, ...patch } as Clip) : c)) }
          return repackVideoTrack(withPatch)
        })
        return { project, dirty: true }
      }

      // Curve-speed clips: dragging a timeline edge isn't curve-aware in v1 — edit the
      // underlying trimIn/trimOut via the keyframe time fields in the Inspector instead.
      if (clip.kind === 'media' && (clip.speedKeyframes?.length ?? 0) >= 2) return {}

      // Video and audio clips can't be trimmed outside their source file. Images and text are unbounded.
      const asset = clip.kind === 'media' ? s.project.assets.find((a) => a.id === clip.assetId) : undefined
      const sourceLimited = clip.kind === 'media' && asset !== undefined && asset.kind !== 'image'
      // trimIn/trimOut are SOURCE seconds; a dragged timeline-seconds delta covers `speed`x
      // as much source material.
      const speed = clip.kind === 'media' ? clip.speed || 1 : 1
      let patch: Partial<Clip> = {}
      if (edge === 'start') {
        let delta = Math.max(newTime, 0) - clip.start
        if (sourceLimited && clip.kind === 'media') delta = Math.max(delta, -clip.trimIn / speed)
        const newDuration = clip.duration - delta
        if (newDuration < 0.1) return {}
        patch = { duration: newDuration }
        if (found.track.type !== 'video') patch.start = clip.start + delta
        if (clip.kind === 'media') patch = { ...patch, trimIn: clip.trimIn + delta * speed } as Partial<MediaClip>
      } else {
        let newDuration = newTime - clip.start
        if (sourceLimited && clip.kind === 'media' && asset) {
          newDuration = Math.min(newDuration, (asset.duration - clip.trimIn) / speed)
        }
        if (newDuration < 0.1) return {}
        patch = { duration: newDuration }
        if (clip.kind === 'media') patch = { ...patch, trimOut: clip.trimIn + newDuration * speed } as Partial<MediaClip>
      }
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = { ...t, clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, ...patch } as Clip) : c)) }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true }
    }),

  splitClipAtPlayhead: () =>
    set((s) => {
      const clipId = s.selectedClipId
      if (!clipId) return {}
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const { track, clip, index } = found
      const t = s.playhead
      if (t <= clip.start + 0.05 || t >= clip.start + clip.duration - 0.05) return {}

      const firstDuration = t - clip.start
      const secondDuration = clip.duration - firstDuration

      let first: Clip
      let second: Clip
      if (clip.kind === 'media' && clip.frozen) {
        // Both halves keep holding the same source frame, just for less time each.
        first = { ...clip, duration: firstDuration }
        second = { ...clip, id: uuid(), start: t, duration: secondDuration, transitionIn: undefined }
      } else if (clip.kind === 'media') {
        const halves = splitMediaClipHalves(clip, firstDuration)
        first = halves.first
        second = halves.second
      } else {
        first = { ...clip, duration: firstDuration }
        second = { ...clip, id: uuid(), start: t, duration: secondDuration, transitionIn: undefined }
      }

      const project = updateTrack(s.project, track.id, (tr) => {
        const clips = [...tr.clips]
        clips[index] = first
        clips.splice(index + 1, 0, second)
        return repackVideoTrack({ ...tr, clips })
      })
      return { project, dirty: true, selectedClipId: second.id, ...recordPast(s) }
    }),

  insertFreezeFrame: (clipId) =>
    set((s) => {
      if (!canInsertFreezeFrame(s.project, s.playhead, clipId)) return {}
      const found = findClip(s.project, clipId)!
      const { track, index } = found
      const clip = found.clip as MediaClip
      const t = s.playhead
      const firstDuration = t - clip.start

      const { first, second } = splitMediaClipHalves(clip, firstDuration)
      const freezeSource = sourceTimeFor(clip, firstDuration)
      const freeze: MediaClip = {
        id: uuid(),
        kind: 'media',
        trackId: track.id,
        start: t,
        duration: 1,
        assetId: clip.assetId,
        trimIn: freezeSource,
        trimOut: freezeSource,
        volume: clip.volume,
        muted: true,
        speed: 1,
        reversed: false,
        frozen: true,
        transform: defaultTransform()
      }

      const project = updateTrack(s.project, track.id, (tr) => {
        const clips = [...tr.clips]
        clips[index] = first
        clips.splice(index + 1, 0, freeze, second)
        return repackVideoTrack({ ...tr, clips })
      })
      return { project, dirty: true, selectedClipId: freeze.id, ...recordPast(s) }
    }),

  mergeWithNext: (clipId) =>
    set((s) => {
      if (!canMergeWithNext(s.project, clipId)) return {}
      const found = findClip(s.project, clipId)!
      const { track, clip, index } = found
      const next = track.clips[index + 1] as MediaClip
      const merged: MediaClip = { ...(clip as MediaClip), trimOut: next.trimOut }
      const project = updateTrack(s.project, track.id, (t) => {
        const clips = [...t.clips]
        clips.splice(index, 2, merged)
        return repackVideoTrack({ ...t, clips })
      })
      return { project, dirty: true, selectedClipId: merged.id, ...recordPast(s) }
    }),

  removeClip: (clipId) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const project = updateTrack(s.project, found.track.id, (t) => repackVideoTrack({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }))
      return { project, dirty: true, selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId, ...recordPast(s) }
    }),

  setTransition: (clipId, duration) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      const firstVideoTrack = s.project.tracks.find((t) => t.type === 'video')
      if (!found || found.track.type !== 'video' || found.track.id !== firstVideoTrack?.id || found.index === 0) return {}
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = {
          ...t,
          // Keep the clip's current transition type: the Inspector's duration slider calls this on
          // every move, and resetting to crossfade threw away a dropped wipe/slide/etc.
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, transitionIn: duration > 0 ? { type: c.transitionIn?.type ?? ('crossfade' as const), duration } : undefined } : c
          )
        }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true, ...recordPast(s) }
    }),

  setClipTransition: (clipId, transition) =>
    set((s) => {
      if (!canHaveTransition(s.project, clipId)) return {}
      const found = findClip(s.project, clipId)!
      const project = updateTrack(s.project, found.track.id, (t) =>
        repackVideoTrack({
          ...t,
          clips: t.clips.map((c) => (c.id === clipId ? { ...c, transitionIn: transition && transition.duration > 0 ? transition : undefined } : c))
        })
      )
      return { project, dirty: true, ...recordPast(s) }
    }),

  setTransitionType: (clipId, type) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.track.type !== 'video') return {}
      const clip = found.clip
      if (!clip.transitionIn) return {}
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = {
          ...t,
          clips: t.clips.map((c) => (c.id === clipId && c.transitionIn ? { ...c, transitionIn: { ...c.transitionIn, type } } : c))
        }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true, ...recordPast(s) }
    }),

  addClipEffect: (clipId, type) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const effect = createEffect(type, uuid())
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, effects: [...(c.effects ?? []), effect] } as Clip) : c))
      }))
      return { project, dirty: true, ...recordPast(s) }
    }),

  removeClipEffect: (clipId, effectId) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== clipId) return c
          const effects = (c.effects ?? []).filter((e) => e.id !== effectId)
          // Drop the array entirely when empty so serialized projects stay minimal.
          return { ...c, effects: effects.length > 0 ? effects : undefined } as Clip
        })
      }))
      return { project, dirty: true, ...recordPast(s) }
    }),

  updateClipEffectParam: (clipId, effectId, key, value) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== clipId) return c
          const effects = (c.effects ?? []).map((e: ClipEffect) =>
            e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e
          )
          return { ...c, effects } as Clip
        })
      }))
      return { project, dirty: true }
    }),

  setClipSpeed: (clipId, speed) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.clip.kind !== 'media') return {}
      const clamped = Math.min(Math.max(speed, 0.1), 4)
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, speed: clamped } : c)) }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true }
    }),

  setClipSpeedCurve: (clipId, points, preset, opts) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.clip.kind !== 'media') return {}
      const clip = found.clip as MediaClip
      const normalized = points ? normalizeCurvePoints(points) : undefined
      const patch: Partial<MediaClip> = normalized
        ? {
            speedCurvePoints: normalized,
            speedCurvePreset: preset ?? 'custom',
            speedKeyframes: sampleSpeedCurve(normalized, clip.trimIn, clip.trimOut)
          }
        : { speedCurvePoints: undefined, speedCurvePreset: undefined, speedKeyframes: undefined }
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = { ...t, clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, ...patch } as Clip) : c)) }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true, ...(opts?.live ? {} : recordPast(s)) }
    }),

  recordUndoPoint: (before) =>
    set((s) => (s.project === before ? {} : { past: [...s.past, before].slice(-HISTORY_LIMIT), future: [] })),

  setClipSpeedKeyframes: (clipId, keyframes) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.clip.kind !== 'media') return {}
      const clip = found.clip as MediaClip
      const sanitized = keyframes
        ? [...keyframes]
            .sort((a, b) => a.time - b.time)
            .map((k) => ({
              time: Math.min(Math.max(k.time, clip.trimIn), clip.trimOut),
              speed: Math.min(Math.max(k.speed, 0.1), 4)
            }))
        : undefined
      const project = updateTrack(s.project, found.track.id, (t) => {
        // A raw keyframe list replaces any graph control points (they'd no longer match).
        const withPatch = {
          ...t,
          clips: t.clips.map((c) => (c.id === clipId ? { ...c, speedKeyframes: sanitized, speedCurvePoints: undefined, speedCurvePreset: undefined } : c))
        }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true }
    }),

  setClipReversed: (clipId, reversed) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.clip.kind !== 'media') return {}
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, reversed } : c)) }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true }
    }),

  setClipTransform: (clipId, transform) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      // Keep the keyframe list sorted by time, same as setClipSpeedKeyframes — otherwise an
      // "Add point" (which appends) leaves the Inspector's row order out of sync with playback
      // order, even though interpolateTransform/piecewiseLinearExpr both sort internally and
      // are unaffected either way.
      const sortedTransform = transform.keyframes
        ? { ...transform, keyframes: [...transform.keyframes].sort((a, b) => a.time - b.time) }
        : transform
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, transform: sortedTransform } : c)) }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true }
    }),

  rotateClip: (clipId, deltaDegrees) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = {
          ...t,
          clips: t.clips.map((c) => {
            if (c.id !== clipId) return c
            const current = c.transform.rotation ?? 0
            const rotation = (((current + deltaDegrees) % 360) + 360) % 360
            return { ...c, transform: { ...c.transform, rotation } }
          })
        }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true, ...recordPast(s) }
    }),

  toggleClipFlipH: (clipId) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = {
          ...t,
          clips: t.clips.map((c) => (c.id === clipId ? { ...c, transform: { ...c.transform, flipH: !c.transform.flipH } } : c))
        }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true, ...recordPast(s) }
    }),

  updateTextClip: (clipId, patch) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, ...patch } as Clip) : c))
      }))
      return { project, dirty: true }
    }),

  updateMediaClipProps: (clipId, patch) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, ...patch } as Clip) : c))
      }))
      return { project, dirty: true }
    }),

  setClipFilter: (clipId, filter, record = true) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.clip.kind !== 'media') return {}
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId && c.kind === 'media' ? { ...c, filter } : c))
      }))
      return { project, dirty: true, ...(record ? recordPast(s) : {}) }
    }),

  setClipAnimations: (clipId, animations, record = true) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.clip.kind !== 'media') return {}
      const empty = !animations || (!animations.in && !animations.out && !animations.combo)
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId && c.kind === 'media' ? { ...c, animations: empty ? undefined : animations } : c))
      }))
      return { project, dirty: true, ...(record ? recordPast(s) : {}) }
    }),

  setClipSourceOverride: (clipId, override) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.clip.kind !== 'media') return {}
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId && c.kind === 'media' ? { ...c, sourceOverride: override } : c))
      }))
      return { project, dirty: true, ...recordPast(s) }
    }),

  focusEffect: (clipId, effectId) =>
    set({ selectedClipId: clipId, previewAssetId: null, effectFocus: { clipId, effectId, nonce: Date.now() } }),
  selectClip: (clipId) =>
    set((s) => ({
      selectedClipId: clipId,
      selectedClipIds: clipId ? ops.expandGroups(s.project, [clipId]) : [],
      previewAssetId: clipId ? null : s.previewAssetId
    })),

  toggleClipSelection: (clipId) =>
    set((s) => {
      const current = selectionOf(s)
      const unit = ops.expandGroups(s.project, [clipId])
      if (current.includes(clipId)) {
        const rest = current.filter((id) => !unit.includes(id))
        return { selectedClipIds: rest, selectedClipId: rest.length ? (rest.includes(s.selectedClipId ?? '') ? s.selectedClipId : rest[rest.length - 1]) : null }
      }
      return { selectedClipIds: [...new Set([...current, ...unit])], selectedClipId: clipId, previewAssetId: null }
    }),

  copySelection: () => set((s) => ({ clipboard: ops.copyClips(s.project, selectionOf(s)) ?? s.clipboard })),

  cutSelection: () => {
    get().copySelection()
    get().deleteSelection()
  },

  paste: () =>
    set((s) => {
      if (!s.clipboard) return {}
      const { project, ids } = ops.pasteClips(s.project, s.clipboard, s.playhead, uuid, repackVideoTrack)
      if (ids.length === 0) return {}
      return { project, dirty: true, selectedClipId: ids[0], selectedClipIds: ids, ...recordPast(s) }
    }),

  copyAttributes: (clipId) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      return found ? { attributeClipboard: ops.copyAttributes(found.clip) } : {}
    }),

  pasteAttributesToSelection: () =>
    set((s) => {
      const ids = selectionOf(s)
      if (!s.attributeClipboard || ids.length === 0) return {}
      return { project: ops.pasteAttributes(s.project, ids, s.attributeClipboard, repackVideoTrack), dirty: true, ...recordPast(s) }
    }),

  deleteSelection: () =>
    set((s) => {
      const ids = selectionOf(s)
      if (ids.length === 0) return {}
      return { project: ops.removeClips(s.project, ids, repackVideoTrack), dirty: true, selectedClipId: null, selectedClipIds: [], ...recordPast(s) }
    }),

  setSelectionDisabled: (disabled) =>
    set((s) => {
      const ids = selectionOf(s)
      if (ids.length === 0) return {}
      return { project: ops.setClipsDisabled(s.project, ids, disabled), dirty: true, ...recordPast(s) }
    }),

  groupSelection: () =>
    set((s) => {
      const ids = selectionOf(s)
      if (ids.length < 2) return {}
      return { project: ops.groupClips(s.project, ids, uuid), dirty: true, ...recordPast(s) }
    }),

  ungroupSelection: () =>
    set((s) => {
      const ids = selectionOf(s)
      if (ids.length === 0) return {}
      return { project: ops.ungroupClips(s.project, ids), dirty: true, ...recordPast(s) }
    }),

  separateAudio: (clipId) =>
    set((s) => {
      const res = ops.separateAudio(s.project, clipId, uuid)
      if (!res) return {}
      return { project: res.project, dirty: true, ...recordPast(s) }
    }),

  replaceClipMedia: (clipId, asset) =>
    set((s) => {
      const withAsset = s.project.assets.some((a) => a.id === asset.id) ? s.project : { ...s.project, assets: [...s.project.assets, asset] }
      const project = ops.replaceClipMedia(withAsset, clipId, asset, repackVideoTrack)
      return project ? { project: touch(project), dirty: true, ...recordPast(s) } : {}
    }),

  trimClipToPlayhead: (clipId, edge) => {
    const s = get()
    const found = findClip(s.project, clipId)
    if (!found) return
    const t = s.playhead
    if (t <= found.clip.start + 0.05 || t >= found.clip.start + found.clip.duration - 0.05) return
    const before = s.project
    get().trimClip(clipId, edge, t)
    // trimClip is the live drag action (no undo step per mouse move); record one here.
    if (get().project !== before) set((cur) => ({ past: [...cur.past, before].slice(-HISTORY_LIMIT), future: [] }))
  },

  setClipCrop: (clipId, crop) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.clip.kind !== 'media') return {}
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, crop: crop && !isFullCrop(crop) ? crop : undefined } as Clip) : c))
      }))
      return { project, dirty: true, ...recordPast(s) }
    }),

  applyCompound: (clipIds, asset) =>
    set((s) => {
      const withAsset = { ...s.project, assets: [...s.project.assets, asset] }
      const res = ops.replaceWithCompound(withAsset, clipIds, asset, uuid, repackVideoTrack)
      if (!res) return {}
      return { project: touch(res.project), dirty: true, selectedClipId: res.clipId, selectedClipIds: [res.clipId], ...recordPast(s) }
    }),

  setColorSpace: (id) =>
    set((s) => (s.project.canvas.colorSpace === id ? {} : { project: touch({ ...s.project, canvas: { ...s.project.canvas, colorSpace: id } }), dirty: true, ...recordPast(s) })),
  setPreviewAsset: (assetId) => set({ previewAssetId: assetId, isPlaying: false }),
  setCanvasSize: (width, height) =>
    set((s) => ({
      project: touch({ ...s.project, canvas: { ...s.project.canvas, width, height } }),
      dirty: true,
      ...recordPast(s)
    })),
  setPlayhead: (t) => set({ playhead: Math.max(0, t), previewAssetId: null }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setZoom: (pxPerSecond) => set({ pxPerSecond: Math.min(Math.max(pxPerSecond, 1), 400) })
}))

export function getProjectDuration(project: Project): number {
  return projectDuration(project)
}
