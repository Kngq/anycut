/**
 * Pure multi-clip operations behind the timeline's right-click menu (copy/cut/paste, copy/paste
 * attributes, delete, deactivate, group, separate audio, replace, export/compound ranges).
 * No store, no DOM: each takes a Project and returns a new one, so they're unit-tested directly
 * and the store just wraps them with undo + selection.
 *
 * Track model reminder: video tracks are packed rolls (array order = playback order, `start` is
 * derived by repack); audio and text tracks are free-form (clips sit at any `start`, overlaps
 * allowed). The caller passes its repack function so this module never re-implements it.
 */
import {
  defaultTransform,
  effectiveDuration,
  type Clip,
  type ClipCrop,
  type ClipEffect,
  type ClipTransform,
  type MediaAsset,
  type MediaClip,
  type Project,
  type TextClip,
  type Track,
  type TrackType
} from './types'

export type Repack = (track: Track) => Track
export type NewId = () => string

/** Everything a Copy/Cut put on the clipboard: deep-copied clips with where they came from. */
export interface ClipClipboard {
  items: { clip: Clip; trackId: string; trackType: TrackType }[]
  /** Earliest start among the items; paste places that point at the playhead. */
  anchor: number
}

/** Look attributes copied by "Copy attributes" (CapCut copies the look, not the content). */
export interface ClipAttributes {
  kind: Clip['kind']
  transform: ClipTransform
  effects?: ClipEffect[]
  media?: Pick<MediaClip, 'volume' | 'muted' | 'speed' | 'speedKeyframes' | 'reversed' | 'changeAudioPitch' | 'filter' | 'animations'> & { crop?: ClipCrop }
  text?: Pick<TextClip, 'fontSize' | 'color' | 'bold' | 'italic' | 'underline' | 'textCase' | 'fontFamily' | 'stroke' | 'look'>
}

export function findClipIn(project: Project, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index !== -1) return { track, clip: track.clips[index], index }
  }
  return null
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** The ids plus every clip that shares a group with one of them, in timeline order. */
export function expandGroups(project: Project, ids: readonly string[]): string[] {
  const groups = new Set<string>()
  for (const id of ids) {
    const g = findClipIn(project, id)?.clip.groupId
    if (g) groups.add(g)
  }
  const out = new Set(ids.filter((id) => findClipIn(project, id)))
  if (groups.size > 0) for (const t of project.tracks) for (const c of t.clips) if (c.groupId && groups.has(c.groupId)) out.add(c.id)
  return [...out]
}

/** Time span [start, end) covered by the clips (null when none exist). */
export function clipsRange(project: Project, ids: readonly string[]): { start: number; end: number } | null {
  let start = Infinity
  let end = -Infinity
  for (const id of ids) {
    const f = findClipIn(project, id)
    if (!f) continue
    start = Math.min(start, f.clip.start)
    end = Math.max(end, f.clip.start + f.clip.duration)
  }
  return start < end ? { start, end } : null
}

function mapTracks(project: Project, fn: (t: Track) => Track): Project {
  return { ...project, tracks: project.tracks.map(fn), updatedAt: Date.now() }
}

export function removeClips(project: Project, ids: readonly string[], repack: Repack): Project {
  const drop = new Set(ids)
  return mapTracks(project, (t) => (t.clips.some((c) => drop.has(c.id)) ? repack({ ...t, clips: t.clips.filter((c) => !drop.has(c.id)) }) : t))
}

function patchClips(project: Project, ids: readonly string[], patch: (c: Clip) => Clip): Project {
  const set = new Set(ids)
  return mapTracks(project, (t) => (t.clips.some((c) => set.has(c.id)) ? { ...t, clips: t.clips.map((c) => (set.has(c.id) ? patch(c) : c)) } : t))
}

export function setClipsDisabled(project: Project, ids: readonly string[], disabled: boolean): Project {
  return patchClips(project, ids, (c) => ({ ...c, disabled: disabled || undefined }))
}

export function groupClips(project: Project, ids: readonly string[], newId: NewId): Project {
  if (ids.length < 2) return project
  const groupId = newId()
  return patchClips(project, ids, (c) => ({ ...c, groupId }))
}

export function ungroupClips(project: Project, ids: readonly string[]): Project {
  return patchClips(project, expandGroups(project, ids), (c) => ({ ...c, groupId: undefined }))
}

export function copyClips(project: Project, ids: readonly string[]): ClipClipboard | null {
  const items: ClipClipboard['items'] = []
  for (const t of project.tracks) for (const c of t.clips) if (ids.includes(c.id)) items.push({ clip: clone(c), trackId: t.id, trackType: t.type })
  if (items.length === 0) return null
  return { items, anchor: Math.min(...items.map((i) => i.clip.start)) }
}

/**
 * Pastes the clipboard at `playhead`. Each clip goes back to its own track when that still
 * exists (else the first track of the same type). On a video roll the clips are inserted at the
 * cut nearest the playhead, in their original order; on free tracks they keep their spacing,
 * offset so the earliest one starts at the playhead. Groups are pasted as new groups.
 * Returns the project and the new clip ids (to select them).
 */
export function pasteClips(project: Project, board: ClipClipboard, playhead: number, newId: NewId, repack: Repack): { project: Project; ids: string[] } {
  const regroup = new Map<string, string>()
  const ids: string[] = []
  const byTrack = new Map<string, Clip[]>()
  for (const item of board.items) {
    const track = project.tracks.find((t) => t.id === item.trackId && t.type === item.trackType) ?? project.tracks.find((t) => t.type === item.trackType)
    if (!track) continue
    const clip = clone(item.clip)
    clip.id = newId()
    clip.trackId = track.id
    if (clip.groupId) {
      if (!regroup.has(clip.groupId)) regroup.set(clip.groupId, newId())
      clip.groupId = regroup.get(clip.groupId)
    }
    clip.start = Math.max(0, playhead + (item.clip.start - board.anchor))
    if (track.type === 'video') clip.transitionIn = undefined
    ids.push(clip.id)
    byTrack.set(track.id, [...(byTrack.get(track.id) ?? []), clip])
  }
  const next = mapTracks(project, (t) => {
    const add = byTrack.get(t.id)
    if (!add) return t
    if (t.type !== 'video') return { ...t, clips: [...t.clips, ...add] }
    // Insert at the clip boundary nearest the playhead.
    let index = t.clips.length
    for (let i = 0; i < t.clips.length; i++) {
      if (playhead < t.clips[i].start + t.clips[i].duration / 2) {
        index = i
        break
      }
    }
    return repack({ ...t, clips: [...t.clips.slice(0, index), ...add.sort((a, b) => a.start - b.start), ...t.clips.slice(index)] })
  })
  return { project: next, ids }
}

export function copyAttributes(clip: Clip): ClipAttributes {
  const base: ClipAttributes = { kind: clip.kind, transform: clone(clip.transform), effects: clip.effects ? clone(clip.effects) : undefined }
  if (clip.kind === 'media') {
    base.media = {
      volume: clip.volume,
      muted: clip.muted,
      speed: clip.speed,
      speedKeyframes: clip.speedKeyframes ? clone(clip.speedKeyframes) : undefined,
      reversed: clip.reversed,
      changeAudioPitch: clip.changeAudioPitch,
      crop: clip.crop ? { ...clip.crop } : undefined,
      filter: clip.filter ? { ...clip.filter } : undefined,
      animations: clip.animations ? clone(clip.animations) : undefined
    }
  } else {
    const { fontSize, color, bold, italic, underline, textCase, fontFamily, stroke, look } = clip
    base.text = clone({ fontSize, color, bold, italic, underline, textCase, fontFamily, stroke, look })
  }
  return base
}

/**
 * Applies copied attributes to clips. Transform and effects go onto any clip; media timing
 * (speed/reverse/volume/crop) only onto media clips and text style only onto text clips.
 * Media durations are re-derived (a speed change changes length) and video rolls repacked.
 */
export function pasteAttributes(project: Project, ids: readonly string[], attrs: ClipAttributes, repack: Repack): Project {
  const set = new Set(ids)
  return mapTracks(project, (t) => {
    if (!t.clips.some((c) => set.has(c.id))) return t
    const clips = t.clips.map((c): Clip => {
      if (!set.has(c.id)) return c
      const common = { transform: clone(attrs.transform), effects: attrs.effects ? clone(attrs.effects) : undefined }
      if (c.kind === 'media') {
        const m: MediaClip = { ...c, ...common, ...(attrs.media && !c.frozen ? clone(attrs.media) : {}) }
        // A speed curve is in SOURCE seconds of the clip it came from; it doesn't transfer.
        if (attrs.media && findClipSourceMismatch(c, m)) m.speedKeyframes = undefined
        return { ...m, duration: effectiveDuration(m) }
      }
      return { ...c, ...common, ...(attrs.text ? clone(attrs.text) : {}) }
    })
    return t.type === 'video' ? repack({ ...t, clips }) : { ...t, clips }
  })
}

function findClipSourceMismatch(original: MediaClip, patched: MediaClip): boolean {
  const kfs = patched.speedKeyframes
  if (!kfs || kfs.length < 2) return false
  return kfs.some((k) => k.time < original.trimIn - 1e-6 || k.time > original.trimOut + 1e-6)
}

/**
 * "Separate audio": the clip's sound moves to its own clip on an audio track (same source
 * range, speed and timing) and the video clip is muted. Uses the first audio track that is
 * free over the clip's span, else adds a new audio track. Returns null when not applicable.
 */
export function separateAudio(project: Project, clipId: string, newId: NewId): { project: Project; audioClipId: string } | null {
  const found = findClipIn(project, clipId)
  if (!found || found.clip.kind !== 'media' || found.track.type !== 'video') return null
  const clip = found.clip
  const asset = project.assets.find((a) => a.id === clip.assetId)
  if (!asset || !asset.hasAudio || asset.kind !== 'video' || clip.muted || clip.frozen) return null
  const start = clip.start
  const end = clip.start + clip.duration
  const free = (t: Track) => t.type === 'audio' && t.clips.every((c) => c.start >= end - 1e-6 || c.start + c.duration <= start + 1e-6)
  let tracks = project.tracks
  let target = tracks.find(free)
  if (!target) {
    const n = tracks.filter((t) => t.type === 'audio').length + 1
    target = { id: newId(), type: 'audio', name: `Audio ${n}`, clips: [], muted: false, hidden: false }
    tracks = [...tracks, target]
  }
  const audio: MediaClip = {
    ...clone(clip),
    id: newId(),
    trackId: target.id,
    start,
    transitionIn: undefined,
    effects: undefined,
    crop: undefined,
    sourceOverride: undefined,
    groupId: undefined,
    transform: defaultTransform()
  }
  const targetId = target.id
  tracks = tracks.map((t) => {
    if (t.id === targetId) return { ...t, clips: [...t.clips, audio] }
    if (t.id === found.track.id) return { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, muted: true } : c)) }
    return t
  })
  return { project: { ...project, tracks, updatedAt: Date.now() }, audioClipId: audio.id }
}

/**
 * "Replace clip": points the clip at another asset, keeping its place, length, transform and
 * effects. The new media plays from its start; when it's shorter than the slot the clip gets
 * shorter (a video roll closes up behind it). Images fill the whole slot.
 */
export function replaceClipMedia(project: Project, clipId: string, asset: MediaAsset, repack: Repack): Project | null {
  const found = findClipIn(project, clipId)
  if (!found || found.clip.kind !== 'media') return null
  const old = found.clip
  const isImage = asset.kind === 'image'
  const speed = old.speed > 0 ? old.speed : 1
  const span = isImage ? old.duration : Math.min(old.duration * speed, asset.duration)
  const replaced: MediaClip = {
    ...old,
    assetId: asset.id,
    trimIn: 0,
    trimOut: span,
    speedKeyframes: undefined,
    reversed: isImage ? false : old.reversed,
    frozen: false,
    sourceOverride: undefined,
    crop: undefined,
    speed: isImage ? 1 : speed
  }
  replaced.duration = effectiveDuration(replaced)
  return mapTracks(project, (t) => (t.id === found.track.id ? repack({ ...t, clips: t.clips.map((c) => (c.id === clipId ? replaced : c)) }) : t))
}

/**
 * The project as it should render for "Export selected clips" / "Create compound clip": every
 * clip outside `ids` is deactivated (so the selected clips keep their exact timing and
 * layering), then the caller trims the render to clipsRange(ids).
 */
export function isolateClips(project: Project, ids: readonly string[]): Project {
  const keep = new Set(ids)
  return mapTracks(project, (t) => ({ ...t, clips: t.clips.map((c) => (keep.has(c.id) ? c : { ...c, disabled: true })) }))
}

/**
 * "Create compound clip": the selected clips are replaced by one clip of the pre-rendered
 * `asset` covering their span. It goes on the video track holding the earliest selected video
 * clip (at that clip's position in the roll); with no video clips selected, on an audio track at
 * the span's start. Returns null when nothing usable is selected.
 */
export function replaceWithCompound(project: Project, ids: readonly string[], asset: MediaAsset, newId: NewId, repack: Repack): { project: Project; clipId: string } | null {
  const range = clipsRange(project, ids)
  if (!range) return null
  const sel = new Set(ids)
  const videoHit = project.tracks
    .filter((t) => t.type === 'video')
    .map((t) => ({ t, index: t.clips.findIndex((c) => sel.has(c.id)) }))
    .find((x) => x.index !== -1)
  const clip: MediaClip = {
    id: newId(),
    kind: 'media',
    trackId: '',
    start: range.start,
    duration: asset.duration,
    assetId: asset.id,
    trimIn: 0,
    trimOut: asset.duration,
    volume: 1,
    muted: false,
    speed: 1,
    reversed: false,
    frozen: false,
    transform: defaultTransform()
  }
  let tracks = project.tracks
  if (videoHit) {
    clip.trackId = videoHit.t.id
    // Count surviving clips before the insertion point (selected ones are being removed).
    const before = videoHit.t.clips.slice(0, videoHit.index).filter((c) => !sel.has(c.id)).length
    tracks = tracks.map((t) => {
      const kept = t.clips.filter((c) => !sel.has(c.id))
      if (t.id === videoHit.t.id) return repack({ ...t, clips: [...kept.slice(0, before), clip, ...kept.slice(before)] })
      return kept.length === t.clips.length ? t : repack({ ...t, clips: kept })
    })
  } else {
    if (asset.kind !== 'audio') return null
    let audioTrack = tracks.find((t) => t.type === 'audio')
    if (!audioTrack) {
      audioTrack = { id: newId(), type: 'audio', name: 'Audio 1', clips: [], muted: false, hidden: false }
      tracks = [...tracks, audioTrack]
    }
    clip.trackId = audioTrack.id
    const target = audioTrack.id
    tracks = tracks.map((t) => {
      const kept = t.clips.filter((c) => !sel.has(c.id))
      if (t.id === target) return { ...t, clips: [...kept, clip] }
      return kept.length === t.clips.length ? t : repack({ ...t, clips: kept })
    })
  }
  return { project: { ...project, tracks, updatedAt: Date.now() }, clipId: clip.id }
}
