import { describe, expect, it } from 'vitest'
import { ANIMATION_CATALOG, animatedTransform, animationPoseAt, animationWindows, cubicBezier, easeOut } from './animations'
import { defaultTransform, interpolateTransform } from './types'

const clip = (duration: number, animations: Parameters<typeof animatedTransform>[0]['animations'], transform = defaultTransform()) => ({ duration, animations, transform })

describe('easing', () => {
  it('cubic-bezier hits its endpoints and is monotonic for CapCut curves', () => {
    for (const f of [easeOut, cubicBezier(1, 0, 0, 1), cubicBezier(1 / 6, 1 / 6, 5 / 6, 5 / 6)]) {
      expect(f(0)).toBe(0)
      expect(f(1)).toBe(1)
      let prev = 0
      for (let i = 1; i <= 50; i++) {
        const v = f(i / 50)
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = v
      }
    }
    // (0.33, 0, 0, 1) is front-loaded: well past halfway at a quarter of the time.
    expect(easeOut(0.25)).toBeGreaterThan(0.5)
  })
})

describe('catalog', () => {
  it('In animations end at rest and Out animations start at rest', () => {
    for (const a of ANIMATION_CATALOG) {
      if (a.kind === 'combo') continue
      const rest = a.pose(a.kind === 'in' ? 1 : 0)
      expect(rest.scale).toBeCloseTo(1, 5)
      expect(rest.dx).toBeCloseTo(0, 5)
      expect(rest.dy).toBeCloseTo(0, 5)
      expect(rest.opacity).toBeCloseTo(1, 5)
    }
  })
})

describe('windows', () => {
  it('clamps In + Out to the clip and lets Combo replace both', () => {
    const w = animationWindows({ in: { id: 'zoom_in', duration: 2 }, out: { id: 'fade_out', duration: 2 } }, 3)
    expect(w.map((x) => [x.def.id, x.start, x.end])).toEqual([['zoom_in', 0, 2], ['fade_out', 2, 3]])
    const c = animationWindows({ in: { id: 'zoom_in', duration: 0.5 }, combo: { id: 'pulse', duration: 0 } }, 4)
    expect(c.map((x) => [x.def.id, x.start, x.end])).toEqual([['pulse', 0, 4]])
  })
})

describe('animatedTransform', () => {
  it('is the identity without animations', () => {
    const t = defaultTransform()
    expect(animatedTransform(clip(5, undefined, t))).toBe(t)
  })
  it('bakes a zoom-in that starts small, settles at the static transform and holds it', () => {
    const base = { ...defaultTransform(), scale: 1.2, x: 0.4 }
    const tf = animatedTransform(clip(4, { in: { id: 'zoom_in', duration: 0.5 } }, base))
    expect(tf.keyframes!.length).toBeGreaterThan(8)
    const at = (t: number) => interpolateTransform(tf, t)
    expect(at(0).scale).toBeCloseTo(1.2 * 0.6, 3)
    expect(at(0).opacity).toBe(0)
    expect(at(0.5).scale).toBeCloseTo(1.2, 3)
    expect(at(2).scale).toBeCloseTo(1.2, 5)
    expect(at(2).x).toBeCloseTo(0.4, 5)
    // Sampled curve tracks the eased pose closely between samples.
    const mid = animationPoseAt({ in: { id: 'zoom_in', duration: 0.5 } }, 4, 0.13)
    expect(at(0.13).scale).toBeCloseTo(1.2 * mid.scale, 2)
  })
  it('slides out to the left past the frame edge', () => {
    const tf = animatedTransform(clip(2, { out: { id: 'slide_left_out', duration: 0.5 } }))
    const at = (t: number) => interpolateTransform(tf, t)
    expect(at(1).x).toBeCloseTo(0.5, 5)
    expect(at(2).x).toBeCloseTo(-0.5, 3)
  })
})
