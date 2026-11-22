import { describe, expect, it } from 'vitest'
import {
  clipsRange,
  copyAttributes,
  copyClips,
  expandGroups,
  groupClips,
  isolateClips,
  pasteAttributes,
  pasteClips,
  removeClips,
  replaceClipMedia,
  replaceWithCompound,
  separateAudio,
  setClipsDisabled,
  ungroupClips
} from './clipOps'
import { createEmptyProject, defaultTransform, type Clip, type MediaAsset, type MediaClip, type Project, type TextClip, type Track } from './types'

let n = 0
const newId = () => `id${++n}`
const repack = (t: Track): Track => {
  if (t.type !== 'video') return t
  let cursor = 0
  return { ...t, clips: t.clips.map((c) => { const out = { ...c, start: cursor } as Clip; cursor += c.duration; return out }) }
}

const asset = (id: string, duration: number, extra: Partial<MediaAsset> = {}): MediaAsset => ({ id, path: `/m/${id}.mp4`, kind: 'video', name: id, duration, hasAudio: true, ...extra })
const media = (id: string, trackId: string, start: number, duration: number, extra: Partial<MediaClip> = {}): MediaClip => ({
  id, kind: 'media', trackId, start, duration, assetId: 'a', trimIn: 0, trimOut: duration, volume: 1, muted: false, speed: 1, reversed: false, frozen: false, transform: defaultTransform(), ...extra
})
const text = (id: string, trackId: string, start: number, duration: number): TextClip => ({
  id, kind: 'text', trackId, start, duration, text: 'hi', fontSize: 64, color: 'white', bold: false, transform: defaultTransform()
})

function fixture(): Project {
  const p = createEmptyProject('t')
  const [v, a, tx] = p.tracks
  p.assets = [asset('a', 20), asset('b', 3), asset('img', 0, { kind: 'image', hasAudio: false })]
  v.clips = repack({ ...v, clips: [media('v1', v.id, 0, 4), media('v2', v.id, 0, 5), media('v3', v.id, 0, 2)] }).clips
  a.clips = [media('au1', a.id, 1, 2)]
  tx.clips = [text('t1', tx.id, 3, 2)]
  return p
}
const clipsOf = (p: Project, i: number) => p.tracks[i].clips

describe('selection helpers', () => {
  it('expands groups and measures ranges', () => {
    let p = fixture()
    p = groupClips(p, ['v2', 't1'], newId)
    expect(expandGroups(p, ['t1']).sort()).toEqual(['t1', 'v2'])
    expect(clipsRange(p, ['v2', 't1'])).toEqual({ start: 3, end: 9 })
    p = ungroupClips(p, ['v2'])
    expect(expandGroups(p, ['t1'])).toEqual(['t1'])
  })
})

describe('remove / deactivate', () => {
  it('closes the gap on a video roll and leaves free tracks alone', () => {
    const p = removeClips(fixture(), ['v1', 'au1'], repack)
    expect(clipsOf(p, 0).map((c) => [c.id, c.start])).toEqual([['v2', 0], ['v3', 5]])
    expect(clipsOf(p, 1)).toEqual([])
  })
  it('toggles disabled', () => {
    let p = setClipsDisabled(fixture(), ['v2'], true)
    expect(clipsOf(p, 0)[1].disabled).toBe(true)
    p = setClipsDisabled(p, ['v2'], false)
    expect(clipsOf(p, 0)[1].disabled).toBeUndefined()
  })
})

describe('copy / paste', () => {
  it('pastes onto the roll at the nearest cut and onto free tracks at the playhead', () => {
    const p0 = fixture()
    const board = copyClips(p0, ['v1', 't1'])!
    expect(board.anchor).toBe(0)
    const { project: p, ids } = pasteClips(p0, board, 4.2, newId, repack)
    expect(ids).toHaveLength(2)
    // Playhead 4.2 is in the first half of v2 (4..9) → inserted before v2.
    expect(clipsOf(p, 0).map((c) => c.id)).toEqual(['v1', ids[0], 'v2', 'v3'])
    expect(clipsOf(p, 0)[1].start).toBe(4)
    const pastedText = clipsOf(p, 2).find((c) => c.id === ids[1])!
    expect(pastedText.start).toBeCloseTo(7.2) // keeps its 3 s offset from the anchor
  })
  it('pasted groups become a new group', () => {
    let p = groupClips(fixture(), ['v1', 't1'], newId)
    const board = copyClips(p, ['v1', 't1'])!
    const res = pasteClips(p, board, 0, newId, repack)
    p = res.project
    const g = (id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!.groupId
    expect(g(res.ids[0])).toBe(g(res.ids[1]))
    expect(g(res.ids[0])).not.toBe(g('v1'))
  })
})

describe('attributes', () => {
  it('copies look onto compatible clips and re-derives media length', () => {
    let p = fixture()
    const src = { ...(clipsOf(p, 0)[0] as MediaClip), speed: 2, volume: 0.3, transform: { ...defaultTransform(), scale: 1.5 } }
    p = pasteAttributes(p, ['v3', 't1'], copyAttributes(src), repack)
    const v3 = clipsOf(p, 0)[2] as MediaClip
    expect(v3.speed).toBe(2)
    expect(v3.volume).toBe(0.3)
    expect(v3.duration).toBeCloseTo(1) // 2 s of source at 2x
    expect(clipsOf(p, 2)[0].transform.scale).toBe(1.5)
    expect((clipsOf(p, 2)[0] as TextClip).text).toBe('hi')
  })
})

describe('separate audio', () => {
  it('moves sound to a free audio track and mutes the video clip', () => {
    const res = separateAudio(fixture(), 'v2', newId)!
    const v2 = clipsOf(res.project, 0)[1] as MediaClip
    expect(v2.muted).toBe(true)
    // Audio 1 has au1 at 1..3; v2 spans 4..9 so it fits there.
    const audio = clipsOf(res.project, 1).find((c) => c.id === res.audioClipId) as MediaClip
    expect([audio.start, audio.duration, audio.trimIn, audio.trimOut, audio.muted]).toEqual([4, 5, 0, 5, false])
  })
  it('adds an audio track when the existing ones are busy', () => {
    const res = separateAudio(fixture(), 'v1', newId)! // 0..4 overlaps au1
    expect(res.project.tracks.filter((t) => t.type === 'audio')).toHaveLength(2)
  })
  it('refuses clips without audio', () => {
    const p = fixture()
    p.assets[0].hasAudio = false
    expect(separateAudio(p, 'v1', newId)).toBeNull()
  })
})

describe('replace', () => {
  it('keeps the slot but shortens to shorter media', () => {
    const p = fixture()
    const r = replaceClipMedia(p, 'v2', p.assets[1], repack)!
    expect(clipsOf(r, 0).map((c) => [c.id, c.start, c.duration])).toEqual([['v1', 0, 4], ['v2', 4, 3], ['v3', 7, 2]])
    expect((clipsOf(r, 0)[1] as MediaClip).assetId).toBe('b')
  })
  it('images fill the slot', () => {
    const p = fixture()
    const r = replaceClipMedia(p, 'v2', p.assets[2], repack)!
    expect(clipsOf(r, 0)[1].duration).toBe(5)
  })
})

describe('isolate / compound', () => {
  it('deactivates everything else', () => {
    const p = isolateClips(fixture(), ['v2'])
    expect(p.tracks.flatMap((t) => t.clips).filter((c) => !c.disabled).map((c) => c.id)).toEqual(['v2'])
  })
  it('swaps the selection for one clip at the first selected roll position', () => {
    const p = fixture()
    const baked = asset('cmp', 7)
    const res = replaceWithCompound({ ...p, assets: [...p.assets, baked] }, ['v2', 'v3', 't1'], baked, newId, repack)!
    expect(clipsOf(res.project, 0).map((c) => c.id)).toEqual(['v1', res.clipId])
    expect(clipsOf(res.project, 0)[1].start).toBe(4)
    expect(clipsOf(res.project, 2)).toEqual([])
  })
})
