import { describe, expect, it } from 'vitest'
import {
  SPEED_CURVE_MAX,
  SPEED_CURVE_MIN,
  SPEED_CURVE_PRESETS,
  curvePointsFromKeyframes,
  evalSpeedCurve,
  graphYToSpeed,
  normalizeCurvePoints,
  sampleSpeedCurve,
  speedCurveDuration,
  speedToGraphY
} from './speedCurve'
import { effectiveDuration, sourceTimeFor, type MediaClip } from './types'

function clipWith(trimIn: number, trimOut: number, points: { x: number; speed: number }[]): MediaClip {
  return {
    id: 'c',
    kind: 'media',
    assetId: 'a',
    start: 0,
    duration: trimOut - trimIn,
    trimIn,
    trimOut,
    volume: 1,
    muted: false,
    speed: 1,
    speedKeyframes: sampleSpeedCurve(points, trimIn, trimOut),
    reversed: false,
    frozen: false
  } as unknown as MediaClip
}

describe('speed graph scale', () => {
  it('puts 0.1x at the bottom, 1x in the middle and the max at the top', () => {
    expect(speedToGraphY(SPEED_CURVE_MIN)).toBeCloseTo(0)
    expect(speedToGraphY(1)).toBeCloseTo(0.5)
    expect(speedToGraphY(SPEED_CURVE_MAX)).toBeCloseTo(1)
  })
  it('round-trips through graphYToSpeed', () => {
    for (const s of [0.1, 0.25, 0.5, 1, 1.7, 3, 4]) expect(graphYToSpeed(speedToGraphY(s))).toBeCloseTo(s, 6)
  })
  it('clamps out-of-range speeds', () => {
    expect(speedToGraphY(100)).toBeCloseTo(1)
    expect(speedToGraphY(0)).toBeCloseTo(speedToGraphY(1))
  })
})

describe('normalizeCurvePoints', () => {
  it('sorts and pins the endpoints to x=0 and x=1', () => {
    const n = normalizeCurvePoints([{ x: 0.9, speed: 2 }, { x: 0.1, speed: 0.5 }, { x: 0.5, speed: 9 }])
    expect(n.map((p) => p.x)).toEqual([0, 0.5, 1])
    expect(n[1].speed).toBe(SPEED_CURVE_MAX)
  })
})

describe('evalSpeedCurve', () => {
  it('passes through the control points', () => {
    const pts = SPEED_CURVE_PRESETS.find((p) => p.id === 'bullet')!.points
    for (const p of pts) expect(evalSpeedCurve(pts, p.x)).toBeCloseTo(p.speed, 6)
  })
  it('does not overshoot between points (monotone)', () => {
    const pts = [{ x: 0, speed: 1 }, { x: 0.5, speed: 4 }, { x: 1, speed: 4 }]
    for (let i = 0; i <= 100; i++) {
      const s = evalSpeedCurve(pts, i / 100)
      expect(s).toBeLessThanOrEqual(4 + 1e-9)
      expect(s).toBeGreaterThanOrEqual(1 - 1e-9)
    }
  })
})

describe('sampleSpeedCurve', () => {
  it('produces segments+1 keyframes spanning trimIn..trimOut', () => {
    const kfs = sampleSpeedCurve(SPEED_CURVE_PRESETS[1].points, 2, 6, 16)
    expect(kfs).toHaveLength(17)
    expect(kfs[0].time).toBe(2)
    expect(kfs[16].time).toBe(6)
    for (const k of kfs) {
      expect(k.speed).toBeGreaterThanOrEqual(SPEED_CURVE_MIN)
      expect(k.speed).toBeLessThanOrEqual(SPEED_CURVE_MAX)
    }
  })
  it('a flat curve keeps the clip duration', () => {
    const clip = clipWith(1, 5, [{ x: 0, speed: 1 }, { x: 1, speed: 1 }])
    expect(effectiveDuration(clip)).toBeCloseTo(4)
  })
  it('preset durations go the right way and match the playback model', () => {
    const preset = (id: string) => SPEED_CURVE_PRESETS.find((p) => p.id === id)!.points
    // Bullet is mostly very slow → longer; Flash in/out are mostly >=1x → shorter.
    expect(effectiveDuration(clipWith(0, 4, preset('bullet')))).toBeGreaterThan(4)
    expect(effectiveDuration(clipWith(0, 4, preset('flashin')))).toBeLessThan(4)
    expect(effectiveDuration(clipWith(0, 4, preset('flashout')))).toBeLessThan(4)
    for (const p of SPEED_CURVE_PRESETS) {
      expect(speedCurveDuration(p.points, 4)).toBeCloseTo(effectiveDuration(clipWith(0, 4, p.points)), 6)
    }
  })
  it('sourceTimeFor walks the whole source range', () => {
    const clip = clipWith(0, 4, SPEED_CURVE_PRESETS.find((p) => p.id === 'hero')!.points)
    const dur = effectiveDuration(clip)
    expect(sourceTimeFor(clip, 0)).toBeCloseTo(0)
    expect(sourceTimeFor(clip, dur)).toBeCloseTo(4)
  })
})

describe('curvePointsFromKeyframes', () => {
  it('maps source times back to 0..1', () => {
    const pts = curvePointsFromKeyframes([{ time: 2, speed: 2 }, { time: 3, speed: 0.5 }, { time: 4, speed: 1 }], 2, 4)
    expect(pts).toEqual([{ x: 0, speed: 2 }, { x: 0.5, speed: 0.5 }, { x: 1, speed: 1 }])
  })
})
