import { describe, expect, it } from 'vitest'
import { DEFAULT_TRANSITION_SECONDS, parseDragPayload, resolveDrop, EFFECT_DRAG_MIME, TRANSITION_DRAG_MIME } from './dropTargets'
import { createEmptyProject, defaultTransform, type Clip, type MediaClip, type Project } from './types'

function media(id: string, trackId: string, start: number, duration: number, extra: Partial<MediaClip> = {}): MediaClip {
  return {
    id,
    kind: 'media',
    trackId,
    assetId: 'a',
    start,
    duration,
    trimIn: 0,
    trimOut: duration,
    volume: 1,
    muted: false,
    speed: 1,
    reversed: false,
    frozen: false,
    transform: defaultTransform(),
    ...extra
  }
}

/** Main video track: clips c1 [0,4) c2 [4,8) c3 [8,8.05). Second video track: o1 [1,3).
 *  Text track: t1 [0,2). */
function project(): Project {
  const p = createEmptyProject('t')
  const v1 = p.tracks.find((t) => t.type === 'video')!
  const text = p.tracks.find((t) => t.type === 'text')!
  v1.clips = [media('c1', v1.id, 0, 4), media('c2', v1.id, 4, 4), media('c3', v1.id, 8, 0.05)]
  const v2 = { ...v1, id: 'v2', name: 'Video 2', clips: [media('o1', 'v2', 1, 2)] as Clip[] }
  text.clips = [{ id: 't1', kind: 'text', trackId: text.id, start: 0, duration: 2, text: 'hi', fontSize: 40, color: 'white', bold: false, transform: defaultTransform() }]
  p.tracks = [v1, v2, ...p.tracks.filter((t) => t.type !== 'video')]
  return p
}

const at = (p: Project, type: 'video' | 'video2' | 'audio' | 'text', time: number, pxPerSecond = 100) => ({
  trackId: type === 'video2' ? 'v2' : p.tracks.find((t) => t.type === type)!.id,
  time,
  pxPerSecond
})

describe('resolveDrop — effects', () => {
  it('attaches to the clip under the pointer, on any video track', () => {
    const p = project()
    expect(resolveDrop(p, { kind: 'effect', type: 'blur' }, at(p, 'video', 5))).toEqual({ kind: 'attach', clipId: 'c2' })
    expect(resolveDrop(p, { kind: 'effect', type: 'blur' }, at(p, 'video2', 2))).toEqual({ kind: 'attach', clipId: 'o1' })
  })

  it('rejects empty space, audio and text, with a reason', () => {
    const p = project()
    for (const r of [
      resolveDrop(p, { kind: 'effect', type: 'blur' }, at(p, 'video2', 5)),
      resolveDrop(p, { kind: 'effect', type: 'blur' }, at(p, 'audio', 1)),
      resolveDrop(p, { kind: 'effect', type: 'blur' }, at(p, 'text', 1))
    ]) {
      expect(r.kind).toBe('reject')
      expect(r.kind === 'reject' && r.reason.length).toBeGreaterThan(0)
    }
  })

  it('rejects an unknown effect type', () => {
    const p = project()
    expect(resolveDrop(p, { kind: 'effect', type: 'nope' as never }, at(p, 'video', 1)).kind).toBe('reject')
  })
})

describe('resolveDrop — transitions', () => {
  it('snaps to a cut within the pixel radius and defaults to 0.5 s', () => {
    const p = project()
    // 100 px/s, 12 px radius = 0.12 s. 4.1 s is 10 px from the c1|c2 cut at 4 s.
    expect(resolveDrop(p, { kind: 'transition', type: 'wipeLeft' }, at(p, 'video', 4.1))).toEqual({
      kind: 'transition',
      leftClipId: 'c1',
      rightClipId: 'c2',
      cutTime: 4,
      duration: DEFAULT_TRANSITION_SECONDS
    })
  })

  it('the snap radius is in screen pixels, so it widens in seconds when zoomed out', () => {
    const p = project()
    expect(resolveDrop(p, { kind: 'transition', type: 'crossfade' }, at(p, 'video', 4.5, 100)).kind).toBe('reject')
    expect(resolveDrop(p, { kind: 'transition', type: 'crossfade' }, at(p, 'video', 4.5, 20)).kind).toBe('transition')
  })

  it('rejects mid-clip, overlay tracks, and non-video tracks', () => {
    const p = project()
    expect(resolveDrop(p, { kind: 'transition', type: 'crossfade' }, at(p, 'video', 2)).kind).toBe('reject')
    expect(resolveDrop(p, { kind: 'transition', type: 'crossfade' }, at(p, 'video2', 3)).kind).toBe('reject')
    expect(resolveDrop(p, { kind: 'transition', type: 'crossfade' }, at(p, 'audio', 4)).kind).toBe('reject')
  })

  it('rejects when a neighbouring clip is too short', () => {
    const p = project()
    const r = resolveDrop(p, { kind: 'transition', type: 'crossfade' }, at(p, 'video', 8))
    expect(r).toEqual({ kind: 'reject', reason: 'Clips are too short for a transition.' })
  })

  it('clamps the default to the shorter neighbour', () => {
    const p = project()
    const v1 = p.tracks[0]
    v1.clips = [media('c1', v1.id, 0, 0.3), media('c2', v1.id, 0.3, 4)]
    const r = resolveDrop(p, { kind: 'transition', type: 'crossfade' }, at(p, 'video', 0.3))
    expect(r.kind === 'transition' && r.duration).toBeCloseTo(0.3)
  })

  it('replacing an existing transition keeps its duration; the cut is mid-overlap', () => {
    const p = project()
    const v1 = p.tracks[0]
    // c2 overlaps c1 by 1 s (transitionIn pulls its start back): c1 [0,4), c2 [3,7).
    v1.clips = [media('c1', v1.id, 0, 4), media('c2', v1.id, 3, 4, { transitionIn: { type: 'crossfade', duration: 1 } })]
    const r = resolveDrop(p, { kind: 'transition', type: 'circleOpen' }, at(p, 'video', 3.5))
    expect(r).toMatchObject({ kind: 'transition', rightClipId: 'c2', cutTime: 3.5, duration: 1 })
  })
})

describe('parseDragPayload', () => {
  it('round-trips both kinds and refuses junk', () => {
    expect(parseDragPayload(EFFECT_DRAG_MIME, '{"type":"blur"}')).toEqual({ kind: 'effect', type: 'blur' })
    expect(parseDragPayload(TRANSITION_DRAG_MIME, '{"type":"wipeLeft"}')).toEqual({ kind: 'transition', type: 'wipeLeft' })
    expect(parseDragPayload(EFFECT_DRAG_MIME, 'not json')).toBeNull()
    expect(parseDragPayload('text/plain', '{"type":"blur"}')).toBeNull()
  })
})
