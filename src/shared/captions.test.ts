import { describe, expect, it } from 'vitest'
import { DEFAULT_SEGMENT_OPTIONS, captionLinesFor, captionSources, chunksToWords, packWordTimes, segmentWords, spreadPhraseWords, timelineTimeForSource, wordAlignmentFailed, wordsToTimeline, type AsrChunk, type CaptionWord } from './captions'
import { createEmptyProject, defaultTransform, type MediaAsset, type MediaClip, type Project } from './types'

function media(id: string, trackId: string, start: number, trimIn: number, trimOut: number, extra: Partial<MediaClip> = {}): MediaClip {
  return {
    id, kind: 'media', trackId, assetId: 'talk', start, duration: trimOut - trimIn, trimIn, trimOut, volume: 1, muted: false,
    speed: 1, reversed: false, frozen: false, transform: defaultTransform(), ...extra
  }
}

const w = (text: string, start: number, end: number): CaptionWord => ({ text, start, end })

function project(): Project {
  const p = createEmptyProject('t')
  const talk: MediaAsset = { id: 'talk', path: '/talk.mp4', kind: 'video', name: 'talk.mp4', duration: 60, hasAudio: true }
  const music: MediaAsset = { id: 'music', path: '/song.mp3', kind: 'audio', name: 'song.mp3', duration: 60, hasAudio: true }
  const broll: MediaAsset = { id: 'broll', path: '/broll.mp4', kind: 'video', name: 'broll.mp4', duration: 10, hasAudio: false }
  p.assets = [talk, music, broll]
  const v = p.tracks.find((t) => t.type === 'video')!
  const a = p.tracks.find((t) => t.type === 'audio')!
  v.clips = [media('c1', v.id, 0, 10, 20), media('c2', v.id, 10, 0, 5, { assetId: 'broll' }), media('c3', v.id, 15, 30, 34, { reversed: true })]
  a.clips = [media('m1', a.id, 0, 0, 20, { assetId: 'music' })]
  return p
}

describe('captionSources', () => {
  it('main track: clips with audio, skipping reversed ones', () => {
    const { sources, skipped } = captionSources(project(), 'main', null)
    expect(sources).toEqual([{ clipId: 'c1', path: '/talk.mp4', from: 10, to: 20 }])
    expect(skipped).toEqual([{ clipId: 'c3', reason: 'reversed' }])
  })

  it('all tracks includes audio tracks; selected picks one clip', () => {
    expect(captionSources(project(), 'all', null).sources.map((s) => s.clipId)).toEqual(['c1', 'm1'])
    expect(captionSources(project(), 'selected', 'm1').sources.map((s) => s.clipId)).toEqual(['m1'])
    expect(captionSources(project(), 'selected', 'c2').sources).toEqual([]) // no audio
  })
})

describe('source → timeline mapping', () => {
  it('offsets by trim and divides by speed', () => {
    const c = media('c', 'v', 5, 10, 20, { speed: 2 })
    expect(timelineTimeForSource(c, 10)).toBe(5)
    expect(timelineTimeForSource(c, 14)).toBe(7)
    expect(timelineTimeForSource(c, 99)).toBe(10) // clamped to trimOut
  })

  it('follows a speed curve', () => {
    // 1x over source 0..4, then 2x over 4..8 → timeline length 4 + 2 = 6
    const c = media('c', 'v', 0, 0, 8, { speedKeyframes: [{ time: 0, speed: 1 }, { time: 4, speed: 2 }] })
    expect(timelineTimeForSource(c, 2)).toBe(2)
    expect(timelineTimeForSource(c, 6)).toBe(5)
  })

  it('drops words outside the trimmed range', () => {
    const c = media('c', 'v', 0, 10, 20)
    expect(wordsToTimeline(c, [w('before', 8, 9), w('in', 12, 12.5), w('after', 21, 22)])).toEqual([w('in', 2, 2.5)])
  })
})

describe('packWordTimes (CapCut initCaptionInfo)', () => {
  it('shares short gaps between neighbours (0.5/0.5 meets in the middle)', () => {
    const p = packWordTimes([w('a', 0, 1), w('b', 1.4, 2)])
    expect(p[0].packEnd).toBeCloseTo(1.2)
    expect(p[1].packStart).toBeCloseTo(1.2)
  })

  it('splitPage(0, 1): the earlier word keeps the whole gap', () => {
    const p = packWordTimes([w('a', 0, 1), w('b', 1.4, 2)], 0, 1)
    expect(p[0].packEnd).toBeCloseTo(1.4)
    expect(p[1].packStart).toBeCloseTo(1.4)
  })

  it('only bridges a long pause towards its midpoint', () => {
    const p = packWordTimes([w('a', 0, 1), w('b', 4, 5)])
    // gap 3 s > 1 s: each side takes half of the half-gap
    expect(p[0].packEnd).toBeCloseTo(1.75)
    expect(p[1].packStart).toBeCloseTo(3.25)
  })

  it('pushes an overlapping word past the previous one', () => {
    const p = packWordTimes([w('a', 0, 1), w('b', 0.8, 1.5)])
    expect(p[1].packStart).toBe(1)
  })
})

describe('segmentWords', () => {
  it('breaks on sentence ends and pauses; lines meet across short pauses', () => {
    const lines = segmentWords([w('Hello', 0, 0.3), w('there.', 0.3, 0.6), w('How', 0.8, 1), w('are', 1, 1.2), w('you', 1.2, 1.4), w('later', 3, 3.4)])
    expect(lines.map((l) => l.text)).toEqual(['Hello there.', 'How are you', 'later'])
    expect(lines[0].end).toBeCloseTo(0.7)
    expect(lines[1].start).toBeCloseTo(0.7) // butts against the previous line
    expect(lines[1].end).toBeCloseTo(1.8) // long pause: bridged only towards its middle
    expect(lines[2].start).toBeCloseTo(2.6)
    expect(lines[2].words[0]).toEqual(w('later', 3, 3.4)) // raw word times are kept
  })

  it('keeps lines under maxChars and 3 s', () => {
    const words = 'one two three four five six seven eight nine ten eleven twelve'.split(' ').map((t, i) => w(t, i * 0.4, i * 0.4 + 0.4))
    for (const line of segmentWords(words)) {
      expect(line.text.length).toBeLessThanOrEqual(32)
      expect(line.end - line.start).toBeLessThanOrEqual(3.0001)
    }
  })

  it('never overlaps the next line', () => {
    const lines = segmentWords([w('a.', 0, 2), w('b', 1.5, 1.8)])
    expect(lines[0].end).toBeLessThanOrEqual(lines[1].start)
  })

  it('snaps boundaries to the frame grid', () => {
    const [line] = segmentWords([w('hi', 0.51, 0.93)], { ...DEFAULT_SEGMENT_OPTIONS, fps: 30 })
    expect(line.start * 30).toBeCloseTo(Math.round(line.start * 30))
    expect(line.end * 30).toBeCloseTo(Math.round(line.end * 30))
  })
})

it('captionLinesFor maps each clip and merges into lines', () => {
  const p = project()
  const lines = captionLinesFor(p, [{ clipId: 'c1', words: [w('Hi', 10.5, 10.8), w('all.', 10.8, 11)] }])
  expect(lines).toMatchObject([{ text: 'Hi all.', start: 0.5 }])
})

describe('Whisper word-time sanitising', () => {
  const c = (text: string, a: number, b: number | null): AsrChunk => ({ text, timestamp: [a, b] })
  // Measured on IMG_1328.MOV (16.6 s, speech at 10.9-15.7 s) before the num_frames fix.
  const collapsed = [c(" I'm", 29.98, 29.98), c(' a', 29.98, 29.98), c(' cooked', 29.98, 29.98), c(' CS', 29.98, 29.98), c(' major.', 29.98, 29.98)]

  it('detects alignment that piled every word past the end of the audio', () => {
    expect(wordAlignmentFailed(collapsed, 16.57)).toBe(true)
    expect(wordAlignmentFailed([c(' a', 3, 3), c(' b', 3, 3), c(' c', 3, 3)], 10)).toBe(true)
  })

  it('accepts normal word times, including a few zero-length words', () => {
    expect(wordAlignmentFailed([c(' Bulking', 0, 0.34), c(' is', 0.34, 0.52), c(' so', 0.52, 0.52)], 25)).toBe(false)
    expect(wordAlignmentFailed([], 25)).toBe(false)
  })

  it('the old failure mapped to the timeline drops every word, which is the "no speech" bug', () => {
    const p = project()
    const clip = media('c', p.tracks[0].id, 0, 0, 16.57)
    const raw = collapsed.map((x) => ({ text: x.text.trim(), start: x.timestamp[0], end: x.timestamp[1]! }))
    expect(wordsToTimeline(clip, raw)).toEqual([])
  })

  it('chunksToWords offsets, trims, drops blanks and clamps into the window', () => {
    const words = chunksToWords([c(' hi', 1, 1.5), c('  ', 2, 3), c(' late', 9, null), c(' over', 9.9, 12)], 30, 10)
    expect(words).toEqual([
      { text: 'hi', start: 31, end: 31.5 },
      { text: 'late', start: 39, end: 39.05 },
      { text: 'over', start: 39.9, end: 40 }
    ])
  })

  it('spreadPhraseWords shares a phrase out over its words by length, in order', () => {
    const words = spreadPhraseWords([c(" I'm a cooked CS major.", 10, 15.6)], 0, 16.57)
    expect(words.map((x) => x.text)).toEqual(["I'm", 'a', 'cooked', 'CS', 'major.'])
    expect(words[0].start).toBe(10)
    expect(words[words.length - 1].end).toBeCloseTo(15.6)
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeCloseTo(words[i - 1].end)
    expect(words[2].end - words[2].start).toBeGreaterThan(words[1].end - words[1].start)
  })

  it('spreadPhraseWords clamps an open-ended phrase to the window and applies the offset', () => {
    const words = spreadPhraseWords([c(' tail end', 8, null)], 56, 10)
    expect(words[0].start).toBe(64)
    expect(words[1].end).toBe(66)
  })
})
