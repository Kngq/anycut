import { describe, expect, it } from 'vitest'
import { clipDrawInsets, resizedTransitionDuration, transitionBlocks } from './transitionBlocks'
import { defaultTransform, type MediaClip, type Track } from './types'

function media(id: string, start: number, duration: number, transition?: number): MediaClip {
  return {
    id, kind: 'media', trackId: 'v', assetId: 'a', start, duration, trimIn: 0, trimOut: duration, volume: 1, muted: false,
    speed: 1, reversed: false, frozen: false, transform: defaultTransform(),
    ...(transition ? { transitionIn: { type: 'crossfade' as const, duration: transition } } : {})
  }
}

// a [0,4)  b [3,6) with a 1 s transition (overlap 3..4)  c [6,8) no transition
const track: Track = { id: 'v', type: 'video', name: 'V', muted: false, hidden: false, clips: [media('a', 0, 4), media('b', 3, 3, 1), media('c', 6, 2)] }

describe('transitionBlocks', () => {
  it('puts one block over each overlap, centred on the cut', () => {
    expect(transitionBlocks(track)).toEqual([
      { clipId: 'b', leftClipId: 'a', type: 'crossfade', start: 3, duration: 1, mid: 3.5, maxDuration: 3 }
    ])
  })

  it('ignores non-video tracks and the first clip', () => {
    expect(transitionBlocks({ ...track, type: 'audio' })).toEqual([])
    expect(transitionBlocks({ ...track, clips: [media('x', 0, 2, 1)] })).toEqual([])
  })

  it('draws clips trimmed by half the transition so they meet at the cut', () => {
    const insets = clipDrawInsets(track)
    expect(insets.get('a')).toEqual({ left: 0, right: 0.5 })
    expect(insets.get('b')).toEqual({ left: 0.5, right: 0 })
    expect(insets.has('c')).toBe(false)
  })

  it('a clip between two transitions is inset on both sides', () => {
    const t: Track = { ...track, clips: [media('a', 0, 4), media('b', 3, 3, 1), media('c', 5.6, 2, 0.4)] }
    expect(clipDrawInsets(t).get('b')).toEqual({ left: 0.5, right: 0.2 })
  })

  it('resizes symmetrically around the cut, clamped', () => {
    const b = { mid: 3.5, maxDuration: 3 }
    expect(resizedTransitionDuration(b, 4.25)).toBeCloseTo(1.5)
    expect(resizedTransitionDuration(b, 2.75)).toBeCloseTo(1.5)
    expect(resizedTransitionDuration(b, 3.5)).toBeCloseTo(0.1)
    expect(resizedTransitionDuration(b, 10)).toBe(3)
  })
})
