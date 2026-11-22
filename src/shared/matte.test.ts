import { describe, expect, it } from 'vitest'
import { matteToGray, parseDurationSec, parseFps, rgbToNchw, smoothMatte } from './matte'

describe('rgbToNchw', () => {
  it('splits packed RGB into planes and normalizes with mean/std', () => {
    const rgb = Uint8Array.from([255, 0, 128, 0, 255, 255])
    const out = rgbToNchw(rgb, 2, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5])
    // (v/255 - 0.5) / 0.5 → 255 → 1, 0 → -1
    expect(Array.from(out.slice(0, 2))).toEqual([1, -1]) // R plane
    expect(Array.from(out.slice(2, 4))).toEqual([-1, 1]) // G plane
    expect(out[4]).toBeCloseTo(128 / 255 / 0.5 - 1, 6) // B plane
    expect(out[5]).toBeCloseTo(1, 6)
  })
})

describe('matteToGray', () => {
  it('maps an alpha matte straight to 0..255 without stretching', () => {
    expect(Array.from(matteToGray([0, 0.1, 0.5, 1, 1.2, -0.1], 'alpha'))).toEqual([0, 26, 128, 255, 255, 0])
  })
  it('does not amplify a faint matte (no subject in frame)', () => {
    expect(Math.max(...matteToGray([0, 0.02, 0.01], 'alpha'))).toBeLessThan(10)
  })
  it('stretches a saliency map to the full range', () => {
    expect(Array.from(matteToGray([2, 3, 4], 'minmax'))).toEqual([0, 128, 255])
  })
})

describe('smoothMatte', () => {
  it('returns the frame unchanged when there is no previous one', () => {
    const cur = Uint8Array.from([10, 200])
    expect(Array.from(smoothMatte(cur, null))).toEqual([10, 200])
  })
  it('damps small edge jitter but lets real motion through', () => {
    const prev = Uint8Array.from([100, 100, 0])
    const cur = Uint8Array.from([110, 90, 255])
    expect(Array.from(smoothMatte(cur, prev))).toEqual([105, 95, 255])
  })
})

describe('parsers', () => {
  it('parses rational and decimal fps', () => {
    expect(parseFps('30000/1001')).toBeCloseTo(29.97, 2)
    expect(parseFps('25')).toBe(25)
  })
  it('parses the ffmpeg Duration banner', () => {
    expect(parseDurationSec('  Duration: 00:01:02.50, start: 0.000000')).toBeCloseTo(62.5)
    expect(parseDurationSec('nope')).toBe(0)
  })
})
