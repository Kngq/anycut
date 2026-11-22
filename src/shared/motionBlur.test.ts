import { describe, expect, it } from 'vitest'
import {
  blurKernel,
  compositeFilter,
  motionBlurInput,
  normalizeSettings,
  paddingFrames,
  parseProgressSeconds,
  pickFrameRate,
  segmentFilter,
  segmentRanges,
  settingsKey,
  sourceOverrideFiles,
  workSize
} from './motionBlur'
import type { SourceOverride } from './types'

const base = { blur: 100, blend: 0, direction: 'both' as const, times: 1 as const }

describe('blurKernel', () => {
  it('blur 0 is a single tap (identity)', () => {
    expect(blurKernel({ ...base, blur: 0 })).toEqual({ weights: [1], offset: 0 })
  })
  it('blur 100 spans one frame interval of sub-frames', () => {
    const k = blurKernel(base, 8)
    expect(k.weights).toEqual(new Array(9).fill(1))
    expect(k.offset).toBe(4)
  })
  it('direction places the window behind / ahead of / around the frame', () => {
    expect(blurKernel({ ...base, direction: 'backward' }, 8).offset).toBe(0)
    expect(blurKernel({ ...base, direction: 'forward' }, 8).offset).toBe(8)
  })
  it('times convolves the box with itself: longer, smoother streak', () => {
    const k2 = blurKernel({ ...base, blur: 25, times: 2 }, 8) // box of 3
    expect(k2.weights).toEqual([1, 2, 3, 2, 1])
    const k6 = blurKernel({ ...base, times: 6 }, 8)
    expect(k6.weights.length).toBe(6 * 8 + 1)
    expect(k6.weights).toEqual([...k6.weights].reverse())
  })
  it('padding covers the window reach', () => {
    const k = blurKernel({ ...base, times: 6, direction: 'forward' }, 8)
    expect(paddingFrames(k, 8) * 8).toBeGreaterThanOrEqual(k.weights.length - 1)
  })
})

describe('settings', () => {
  it('clamps and keys', () => {
    expect(normalizeSettings({ blur: 140, blend: -3, direction: 'x' as never, times: 3 as never })).toEqual({ blur: 100, blend: 0, direction: 'both', times: 1 })
    expect(settingsKey(base)).not.toBe(settingsKey({ ...base, direction: 'backward' }))
  })
})

describe('pickFrameRate', () => {
  it('keeps exact CFR rationals', () => {
    expect(pickFrameRate('30000/1001', '30000/1001')).toEqual({ num: 30000, den: 1001 })
    expect(pickFrameRate('30/1', '30/1')).toEqual({ num: 30, den: 1 })
  })
  it('uses the average for variable-rate footage', () => {
    expect(pickFrameRate('600/1', '2997/100')).toEqual({ num: 30000, den: 1001 })
    expect(pickFrameRate('120/1', '28/1')).toEqual({ num: 28, den: 1 })
  })
  it('falls back to 30', () => expect(pickFrameRate(undefined, '0/0')).toEqual({ num: 30, den: 1 }))
})

describe('segmentRanges / workSize', () => {
  it('covers every frame once', () => {
    const r = segmentRanges(540, 8)
    expect(r[0][0]).toBe(0)
    expect(r[r.length - 1][1]).toBe(540)
    for (let i = 1; i < r.length; i++) expect(r[i][0]).toBe(r[i - 1][1])
    expect(segmentRanges(30, 8)).toEqual([[0, 30]])
  })
  it('downscales to the work short side, even, never up', () => {
    expect(workSize(3840, 2160, 432)).toEqual({ w: 768, h: 432 })
    expect(workSize(1080, 1920, 432)).toEqual({ w: 432, h: 768 })
    expect(workSize(320, 240, 432)).toEqual({ w: 320, h: 240 })
  })
})

describe('filters', () => {
  it('segment selects one sub-frame per source frame at the kernel offset', () => {
    const f = segmentFilter({ fps: { num: 30, den: 1 }, kernel: blurKernel(base, 8), start: 30, end: 60, total: 90, alpha: false, subframes: 8 })
    expect(f).toContain('trim=start_frame=28:end_frame=62')
    expect(f).toContain('minterpolate=fps=240:')
    expect(f).toContain('tmix=frames=9:')
    // frame `start` sits at padded index P=2 → sub-frame 16, + offset 4
    expect(f).toContain('select=between(n\\,20\\,252)*not(mod(n-20\\,8))')
    expect(f).not.toContain('tpad')
  })
  it('segment pads with clones at the clip ends and splits alpha', () => {
    const f = segmentFilter({ fps: { num: 30000, den: 1001 }, kernel: blurKernel(base, 8), start: 0, end: 10, total: 10, alpha: true, subframes: 8 })
    expect(f).toContain('tpad=start_mode=clone:start=2:stop_mode=clone:stop=2')
    expect(f).toContain('minterpolate=fps=240000/1001')
    expect(f).toContain('alphaextract')
    expect(f).toContain('alphamerge[out]')
  })
  it('composite scales the motion mask by blend and keeps colour conversion', () => {
    const a = compositeFilter({ fps: { num: 30, den: 1 }, width: 1920, height: 1080, blend: 0, alpha: false, colorFilters: 'zscale=x,' })
    const b = compositeFilter({ fps: { num: 30, den: 1 }, width: 1920, height: 1080, blend: 100, alpha: false, colorFilters: '' })
    expect(a).toContain('zscale=x,format=yuv444p[full]')
    expect(a).toContain('*16\\,0\\,255')
    expect(b).toContain('*8\\,0\\,255')
    expect(a).toContain('[full][up][m]maskedmerge[out]')
  })
})

describe('override helpers', () => {
  const bg: SourceOverride = { path: '/c/m.mov', previewPath: '/c/m.webm', kind: 'backgroundRemoved', hasAlpha: true }
  const mb: SourceOverride = { path: '/c/b.mov', previewPath: '/c/b.webm', kind: 'motionBlur', hasAlpha: true, motionBlur: { ...base, base: bg } }
  it('lists every referenced file including the base bake', () => {
    expect(sourceOverrideFiles(mb)).toEqual(['/c/b.mov', '/c/b.webm', '/c/m.mov', '/c/m.webm'])
    expect(sourceOverrideFiles(undefined)).toEqual([])
  })
  it('bakes on the layer under an existing motion blur, else the current override, else the asset', () => {
    expect(motionBlurInput(undefined, '/a.mp4')).toEqual({ path: '/a.mp4', base: undefined })
    expect(motionBlurInput(bg, '/a.mp4')).toEqual({ path: '/c/m.mov', base: bg })
    expect(motionBlurInput(mb, '/a.mp4')).toEqual({ path: '/c/m.mov', base: bg })
    expect(motionBlurInput({ ...mb, motionBlur: base }, '/a.mp4').path).toBe('/a.mp4')
  })
  it('parses ffmpeg -progress output time', () => {
    expect(parseProgressSeconds('frame=10\nout_time_us=1500000\nout_time_ms=2000000\n')).toBe(2)
    expect(parseProgressSeconds('frame=1\n')).toBeNull()
  })
})
