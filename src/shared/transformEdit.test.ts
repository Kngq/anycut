import { describe, expect, it } from 'vitest'
import { offsetTransform, pointInBox, scaleTransform, snapAxis } from './transformEdit'
import { defaultTransform, interpolateTransform, type ClipTransform } from './types'

const keyed: ClipTransform = {
  ...defaultTransform(),
  keyframes: [
    { time: 0, x: 0.2, y: 0.3, scale: 1, opacity: 1 },
    { time: 2, x: 0.8, y: 0.6, scale: 2, opacity: 0.5 }
  ]
}

describe('offsetTransform', () => {
  it('moves a static transform', () => {
    const t = offsetTransform(defaultTransform(), 0.1, -0.2)
    expect(t.x).toBeCloseTo(0.6)
    expect(t.y).toBeCloseTo(0.3)
    expect(t.keyframes).toBeUndefined()
  })

  it('shifts every keyframe so the motion path is preserved', () => {
    const t = offsetTransform(keyed, 0.1, 0.05)
    for (const time of [0, 0.5, 1, 2]) {
      const a = interpolateTransform(keyed, time)
      const b = interpolateTransform(t, time)
      expect(b.x - a.x).toBeCloseTo(0.1)
      expect(b.y - a.y).toBeCloseTo(0.05)
      expect(b.scale).toBeCloseTo(a.scale)
      expect(b.opacity).toBeCloseTo(a.opacity)
    }
  })
})

describe('scaleTransform', () => {
  it('multiplies static and keyframed scale', () => {
    const t = scaleTransform(keyed, 1.5)
    expect(t.scale).toBeCloseTo(1.5)
    expect(t.keyframes!.map((k) => k.scale)).toEqual([1.5, 3])
    expect(interpolateTransform(t, 1).scale).toBeCloseTo(interpolateTransform(keyed, 1).scale * 1.5)
  })

  it('clamps to a sane range', () => {
    expect(scaleTransform(defaultTransform(), 0).scale).toBeCloseTo(0.05)
    expect(scaleTransform(defaultTransform(), 1000).scale).toBeCloseTo(10)
  })
})

describe('pointInBox / snapAxis', () => {
  it('hit-tests a rotated box', () => {
    const box = { cx: 100, cy: 100, w: 200, h: 20, rot: 90 }
    expect(pointInBox(box, 100, 190)).toBe(true) // the long side now runs vertically
    expect(pointInBox(box, 190, 100)).toBe(false)
  })

  it('snaps within the threshold only', () => {
    expect(snapAxis(537, 540, 5)).toEqual({ value: 540, snapped: true })
    expect(snapAxis(530, 540, 5)).toEqual({ value: 530, snapped: false })
  })
})
