import { describe, expect, it } from 'vitest'
import { buildLut, FILTER_CATALOG, gradeColor, LUT_SIZE, lutToCube } from './filters'

describe('filters', () => {
  it('intensity 0 is the identity LUT', () => {
    const lut = buildLut(FILTER_CATALOG[0], 0)
    const n = LUT_SIZE - 1
    // cell (r=5, g=7, b=11)
    const i = ((11 * LUT_SIZE + 7) * LUT_SIZE + 5) * 3
    expect(lut[i]).toBeCloseTo(5 / n, 6)
    expect(lut[i + 1]).toBeCloseTo(7 / n, 6)
    expect(lut[i + 2]).toBeCloseTo(11 / n, 6)
  })
  it('every filter changes colour, stays in range and keeps black/white sane', () => {
    for (const f of FILTER_CATALOG) {
      const mid = gradeColor(f, [0.6, 0.45, 0.35], 1)
      expect(mid.some((v, i) => Math.abs(v - [0.6, 0.45, 0.35][i]) > 0.01)).toBe(true)
      for (const v of [...gradeColor(f, [0, 0, 0], 1), ...gradeColor(f, [1, 1, 1], 1)]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
      // Never inverts: white stays brighter than black.
      const w = gradeColor(f, [1, 1, 1], 1).reduce((a, b) => a + b)
      const k = gradeColor(f, [0, 0, 0], 1).reduce((a, b) => a + b)
      expect(w - k).toBeGreaterThan(1.2)
    }
  })
  it('writes a .cube with the right header and row count', () => {
    const cube = lutToCube(buildLut(FILTER_CATALOG[1], 0.5))
    const lines = cube.trim().split('\n')
    expect(lines[1]).toBe(`LUT_3D_SIZE ${LUT_SIZE}`)
    expect(lines.length).toBe(2 + LUT_SIZE ** 3)
  })
})
