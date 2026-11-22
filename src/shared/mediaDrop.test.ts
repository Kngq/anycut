import { describe, expect, it } from 'vitest'
import { resolveMediaDrop, MEDIA_SNAP_PX } from './mediaDrop'
import { createEmptyProject, defaultTransform, type MediaAsset, type MediaClip, type Project } from './types'

function media(id: string, trackId: string, start: number, duration: number): MediaClip {
  return { id, kind: 'media', trackId, assetId: 'a', start, duration, trimIn: 0, trimOut: duration, volume: 1, muted: false, speed: 1, reversed: false, frozen: false, transform: defaultTransform() }
}

const video: MediaAsset = { id: 'v', path: '/v.mp4', kind: 'video', name: 'v.mp4', duration: 3, hasAudio: true }
const audio: MediaAsset = { id: 'au', path: '/a.mp3', kind: 'audio', name: 'a.mp3', duration: 2, hasAudio: true }
const image: MediaAsset = { id: 'i', path: '/i.png', kind: 'image', name: 'i.png', duration: 0, hasAudio: false }

/** Video: c1 [0,4) c2 [4,8). Audio: m1 [10,12). */
function project(): Project {
  const p = createEmptyProject('t')
  const v = p.tracks.find((t) => t.type === 'video')!
  const a = p.tracks.find((t) => t.type === 'audio')!
  v.clips = [media('c1', v.id, 0, 4), media('c2', v.id, 4, 4)]
  a.clips = [media('m1', a.id, 10, 2)]
  return p
}

const id = (p: Project, type: 'video' | 'audio' | 'text') => p.tracks.find((t) => t.type === type)!.id
const opts = (p: Project, type: 'video' | 'audio' | 'text', time: number, extra: Partial<{ playhead: number; snap: boolean; pxPerSecond: number }> = {}) => ({
  trackId: id(p, type),
  time,
  pxPerSecond: 100,
  playhead: 50,
  snap: true,
  ...extra
})

describe('resolveMediaDrop', () => {
  it('video on a contiguous track lands at the insertion cut', () => {
    const p = project()
    expect(resolveMediaDrop(p, video, opts(p, 'video', 1))).toMatchObject({ start: 0, duration: 3, snapKind: 'edge', snapTime: 0 })
    expect(resolveMediaDrop(p, video, opts(p, 'video', 3))).toMatchObject({ start: 4 })
    expect(resolveMediaDrop(p, video, opts(p, 'video', 7))).toMatchObject({ start: 8 })
  })

  it('an empty video track gives an unsnapped ghost at 0', () => {
    const p = createEmptyProject('t')
    expect(resolveMediaDrop(p, video, opts(p, 'video', 5))).toMatchObject({ start: 0, snapKind: null })
  })

  it('stills get the 5 s default', () => {
    const p = project()
    expect(resolveMediaDrop(p, image, opts(p, 'video', 9))?.duration).toBe(5)
  })

  it('reroutes to a track of the right type', () => {
    const p = project()
    expect(resolveMediaDrop(p, audio, opts(p, 'video', 20))?.trackId).toBe(id(p, 'audio'))
    expect(resolveMediaDrop(p, video, opts(p, 'text', 1))?.trackId).toBe(id(p, 'video'))
  })

  it('free tracks snap the start edge to a nearby clip edge', () => {
    const p = project()
    const g = resolveMediaDrop(p, audio, opts(p, 'audio', 8.05))!
    expect(g.start).toBeCloseTo(8)
    expect(g.snapKind).toBe('edge')
  })

  it('free tracks snap the END edge too', () => {
    const p = project()
    // 2 s clip at 17.96 → its end (19.96) is 4 px from the playhead at 20; its start is far from everything.
    const g = resolveMediaDrop(p, audio, opts(p, 'audio', 17.96, { playhead: 20 }))!
    expect(g.start).toBeCloseTo(18)
    expect(g).toMatchObject({ snapKind: 'playhead', snapTime: 20 })
    const h = resolveMediaDrop(p, audio, opts(p, 'audio', 7.5))!
    expect(h.start).toBeCloseTo(7.5) // 50 px from everything: no snap
    expect(h.snapKind).toBeNull()
    const k = resolveMediaDrop(p, audio, opts(p, 'audio', 12.06))!
    expect(k.start).toBeCloseTo(12) // start edge to m1's end
  })

  it('snaps to the playhead and reports it', () => {
    const p = project()
    const g = resolveMediaDrop(p, audio, opts(p, 'audio', 30.04, { playhead: 30 }))!
    expect(g).toMatchObject({ snapKind: 'playhead', snapTime: 30 })
    expect(g.start).toBeCloseTo(30)
  })

  it('respects the snap radius in screen px and the modifier override', () => {
    const p = project()
    const r = MEDIA_SNAP_PX / 100
    expect(resolveMediaDrop(p, audio, opts(p, 'audio', 30 + r * 1.5, { playhead: 30 }))!.snapKind).toBeNull()
    expect(resolveMediaDrop(p, audio, opts(p, 'audio', 30.02, { playhead: 30, snap: false }))!.start).toBeCloseTo(30.02)
  })
})
