import { describe, expect, it } from 'vitest'
import { animationScale, clipWords, pageAt } from './textRender'
import { defaultTransform, type TextClip } from '@shared/types'

function clip(text: string, words?: [string, number, number][]): TextClip {
  return {
    id: 'c', kind: 'text', trackId: 't', start: 10, duration: 3, text, fontSize: 60, color: 'white', bold: true, transform: defaultTransform(),
    ...(words ? { caption: { words: words.map(([t, s, e]) => ({ text: t, start: s, end: e })) } } : {})
  }
}

describe('clipWords', () => {
  it('uses recognised timing, packed so a word stays lit until the next (splitPage(0, 1))', () => {
    const ws = clipWords(clip('one two', [['one', 0, 0.4], ['two', 0.9, 1.2]]))
    expect(ws[0].packEnd).toBeCloseTo(0.9)
    expect(ws[1].packStart).toBeCloseTo(0.9)
  })

  it('keeps timing when a word is respelled, spreads evenly when the word count changes', () => {
    expect(clipWords(clip('One Too', [['one', 0, 0.4], ['two', 0.9, 1.2]])).map((w) => [w.text, w.start])).toEqual([['One', 0], ['Too', 0.9]])
    const even = clipWords(clip('a b c', [['ab', 0, 1]]))
    expect(even.map((w) => w.start)).toEqual([0, 1, 2])
  })
})

describe('pageAt', () => {
  const ws = clipWords(clip('a b c d e', [['a', 0, 0.2], ['b', 0.3, 0.5], ['c', 0.6, 0.8], ['d', 1, 1.2], ['e', 1.4, 1.6]]))
  it('shows N words at a time, switching when the next page is spoken', () => {
    expect(pageAt(ws, 2, 0).words.map((w) => w.text)).toEqual(['a', 'b'])
    expect(pageAt(ws, 2, 0.65).words.map((w) => w.text)).toEqual(['c', 'd'])
    expect(pageAt(ws, 2, 1.5)).toMatchObject({ index: 2, start: 1.4 })
  })
  it('0 = the whole caption', () => {
    expect(pageAt(ws, 0, 1).words).toHaveLength(5)
  })
})

describe('animationScale', () => {
  it('pop is CapCut’s damped spring: 0 at the start, overshoots, settles at 1', () => {
    expect(animationScale('pop', 0)[0]).toBeCloseTo(0)
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => animationScale('pop', i * 0.01)[0]))
    expect(peak).toBeGreaterThan(1.2)
    expect(animationScale('pop', 0.5)).toEqual([1, 1])
  })
  it('overshoot hits 120% at frame 6.45 and settles at frame 12.1', () => {
    expect(animationScale('overshoot', 6.451172 / 30)[0]).toBeCloseTo(1.2)
    expect(animationScale('overshoot', 0.41)).toEqual([1, 1])
  })
  it('squash scales x only', () => {
    expect(animationScale('squash', 0)).toEqual([0.8, 1])
    expect(animationScale('squash', 0.2)).toEqual([1, 1])
  })
})
