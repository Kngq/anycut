import { describe, expect, it } from 'vitest'
import { atempoFactors, buildFfmpegPlan, piecewiseLinearExpr } from './ffmpegGraph'
import { createEffect, defaultTransform, type ClipTransform, type MediaClip, type Project, type TransitionType } from './types'

/** Minimal single-video-track project with two clips, so transitions (which need a preceding
 *  clip) and effects can both be exercised through the real plan builder. */
function twoClipProject(opts: { transition?: TransitionType; effectsOnSecond?: MediaClip['effects']; transformOnSecond?: ClipTransform } = {}): Project {
  const base: Omit<MediaClip, 'id' | 'start'> = {
    kind: 'media',
    trackId: 'v1',
    duration: 4,
    assetId: 'a1',
    trimIn: 0,
    trimOut: 4,
    volume: 1,
    muted: false,
    speed: 1,
    reversed: false,
    frozen: false,
    transform: defaultTransform()
  }
  const clip1: MediaClip = { ...base, id: 'c1', start: 0 }
  const clip2: MediaClip = {
    ...base,
    id: 'c2',
    start: 4,
    transitionIn: opts.transition ? { type: opts.transition, duration: 1 } : undefined,
    effects: opts.effectsOnSecond,
    transform: opts.transformOnSecond ?? defaultTransform()
  }
  return {
    id: 'p',
    name: 'test',
    canvas: { width: 1080, height: 1920, fps: 30 },
    tracks: [{ id: 'v1', type: 'video', name: 'Video 1', clips: [clip1, clip2], muted: false, hidden: false }],
    assets: [{ id: 'a1', path: '/tmp/a.mp4', kind: 'video', name: 'a.mp4', duration: 10, hasAudio: false }],
    createdAt: 0,
    updatedAt: 0
  }
}

describe('buildFfmpegPlan — transitions', () => {
  it('emits the mapped xfade transition name for a new transition type', () => {
    const plan = buildFfmpegPlan(twoClipProject({ transition: 'slideLeft' }))
    expect(plan.filterComplex).toContain('xfade=transition=slideleft')
  })

  it('still emits plain concat when there is no transition', () => {
    const plan = buildFfmpegPlan(twoClipProject())
    expect(plan.filterComplex).toContain('concat=n=2:v=1:a=0')
    expect(plan.filterComplex).not.toContain('xfade')
  })
})

describe('buildFfmpegPlan — effects', () => {
  it('splices an inline effect filter into the clip chain', () => {
    const vignette = createEffect('vignette', 'fx-vig')
    const plan = buildFfmpegPlan(twoClipProject({ effectsOnSecond: [vignette] }))
    expect(plan.filterComplex).toContain('vignette=angle=')
  })

  it('emits a mirror subgraph (split/hflip/hstack) for the mirror effect', () => {
    const mirror = createEffect('mirror', 'fx-mir')
    const plan = buildFfmpegPlan(twoClipProject({ effectsOnSecond: [mirror] }))
    expect(plan.filterComplex).toContain('hflip')
    expect(plan.filterComplex).toContain('hstack')
  })

  it('produces no effect filters when a clip has no effects', () => {
    const plan = buildFfmpegPlan(twoClipProject())
    expect(plan.filterComplex).not.toContain('vignette')
    expect(plan.filterComplex).not.toContain('gblur')
  })
})

describe('buildFfmpegPlan — rotate/flip (mirror)', () => {
  it('emits hflip for a horizontally-flipped clip', () => {
    const plan = buildFfmpegPlan(twoClipProject({ transformOnSecond: { ...defaultTransform(), flipH: true } }))
    expect(plan.filterComplex).toContain('hflip')
  })

  it('rotates a clip into its full bounding box and places it back on the canvas', () => {
    const plan = buildFfmpegPlan(twoClipProject({ transformOnSecond: { ...defaultTransform(), rotation: 90 } }))
    // The 1080x1920 canvas frame turned 90° is 1920x1080 (nothing cropped, like the preview)…
    expect(plan.filterComplex).toMatch(/rotate=[\d.]+:ow=1920:oh=1080/)
    // …composited centered back onto the 1080x1920 black canvas.
    expect(plan.filterComplex).toMatch(/color=c=black:s=1080x1920/)
    expect(plan.filterComplex).toMatch(/overlay=x='1080\*\(0\.5\)-w\/2'/)
  })

  it('emits both hflip and rotate when a clip is mirrored and rotated', () => {
    const plan = buildFfmpegPlan(twoClipProject({ transformOnSecond: { ...defaultTransform(), rotation: 180, flipH: true } }))
    expect(plan.filterComplex).toContain('hflip')
    expect(plan.filterComplex).toContain('rotate=')
  })

  it('emits neither at the default transform (rotation 0, no flip)', () => {
    const plan = buildFfmpegPlan(twoClipProject())
    expect(plan.filterComplex).not.toContain('hflip')
    expect(plan.filterComplex).not.toContain('rotate=')
  })
})

/** Evaluates the tiny subset of ffmpeg expression syntax `piecewiseLinearExpr` emits
 *  (if/lt + arithmetic) so the generated string can be checked against the same math
 *  `interpolateTransform` does, without needing a real ffmpeg binary. */
function evalExpr(expr: string, t: number): number {
  const scoped = expr.replace(/\bT\b/g, String(t))
  // `if(cond,a,b)` -> `(cond ? a : b)`; everything else is plain JS-safe arithmetic.
  // eslint-disable-next-line no-new-func
  const js = scoped.replace(/if\(/g, '__if(')
  // eslint-disable-next-line no-new-func
  const fn = new Function('lt', '__if', `return ${js}`)
  return fn((a: number, b: number) => a < b, (cond: boolean, a: number, b: number) => (cond ? a : b)) as number
}

describe('piecewiseLinearExpr', () => {
  it('is constant with a single keyframe', () => {
    expect(piecewiseLinearExpr([{ time: 0, value: 5 }], 'T')).toBe('5')
  })

  it('clamps before the first and after the last keyframe', () => {
    const expr = piecewiseLinearExpr(
      [
        { time: 1, value: 0 },
        { time: 3, value: 10 }
      ],
      'T'
    )
    expect(evalExpr(expr, 0)).toBe(0)
    expect(evalExpr(expr, 10)).toBe(10)
  })

  it('linearly interpolates between keyframes, matching interpolateTransform math', () => {
    const expr = piecewiseLinearExpr(
      [
        { time: 0, value: 0 },
        { time: 2, value: 10 }
      ],
      'T'
    )
    expect(evalExpr(expr, 1)).toBeCloseTo(5)
  })

  it('handles more than two keyframes, picking the right segment', () => {
    const expr = piecewiseLinearExpr(
      [
        { time: 0, value: 0 },
        { time: 2, value: 10 },
        { time: 4, value: 0 }
      ],
      'T'
    )
    expect(evalExpr(expr, 1)).toBeCloseTo(5)
    expect(evalExpr(expr, 3)).toBeCloseTo(5)
    expect(evalExpr(expr, 2)).toBeCloseTo(10)
  })
})

describe('atempoFactors', () => {
  function product(factors: number[]): number {
    return factors.reduce((a, b) => a * b, 1)
  }

  it('is a single in-range factor when speed is already in [0.5,2]', () => {
    expect(atempoFactors(1)).toEqual([1])
    expect(atempoFactors(1.5)).toEqual([1.5])
    expect(atempoFactors(0.5)).toEqual([0.5])
    expect(atempoFactors(2)).toEqual([2])
  })

  it('chains factors (each within [0.5,2]) whose product reproduces an out-of-range speed', () => {
    for (const speed of [3, 4, 0.25, 0.1, 8]) {
      const factors = atempoFactors(speed)
      expect(factors.length).toBeGreaterThan(0)
      for (const f of factors) {
        expect(f).toBeGreaterThanOrEqual(0.5)
        expect(f).toBeLessThanOrEqual(2)
      }
      expect(product(factors)).toBeCloseTo(speed, 10)
    }
  })
})

describe('text outline', () => {
  it('maps a text stroke to drawtext borderw/bordercolor, and omits it otherwise', () => {
    const p = twoClipProject()
    const text = { id: 't1', kind: 'text' as const, trackId: 'tx', start: 0, duration: 2, text: 'Hi', fontSize: 60, color: 'white', bold: true, transform: defaultTransform() }
    const withText = (stroke?: { color: string; width: number }): Project => ({
      ...p,
      tracks: [...p.tracks, { id: 'tx', type: 'text', name: 'Captions', clips: [{ ...text, ...(stroke ? { stroke } : {}) }], muted: false, hidden: false }]
    })
    expect(buildFfmpegPlan(withText({ color: 'black', width: 5 })).filterComplex).toContain(':borderw=5:bordercolor=black')
    expect(buildFfmpegPlan(withText()).filterComplex).not.toContain('borderw')
  })
})

describe('baked text overlay', () => {
  it('overlays the PNG sequence instead of drawtext', () => {
    const p = twoClipProject()
    const text = { id: 't1', kind: 'text' as const, trackId: 'tx', start: 0, duration: 2, text: 'Hi', fontSize: 60, color: 'white', bold: true, transform: defaultTransform() }
    const withText: Project = { ...p, tracks: [...p.tracks, { id: 'tx', type: 'text', name: 'Captions', clips: [text], muted: false, hidden: false }] }
    const plan = buildFfmpegPlan(withText, { textOverlay: { pattern: '/tmp/x/%06d.png', fps: 30 } })
    expect(plan.inputs.join(' ')).toContain('-framerate 30 -i /tmp/x/%06d.png')
    expect(plan.filterComplex).toMatch(/overlay=0:0:format=auto:eof_action=pass/)
    expect(plan.filterComplex).not.toContain('drawtext')
  })
})

describe('buildFfmpegPlan — transition audio crossfade', () => {
  function withAudio(p: Project): Project {
    return { ...p, assets: p.assets.map((a) => ({ ...a, hasAudio: true })) }
  }

  it('fades the outgoing clip out and the incoming clip in over the transition (equal power)', () => {
    const plan = buildFfmpegPlan(withAudio(twoClipProject({ transition: 'crossfade' })))
    // Clip 1 (4 s) fades out over its last second; clip 2 fades in over its first second.
    expect(plan.filterComplex).toContain('afade=t=out:st=3:d=1:curve=qsin,volume=1,adelay=0|0')
    expect(plan.filterComplex).toContain('afade=t=in:st=0:d=1:curve=qsin,volume=1,adelay=4000|4000')
    // Both stay in the mix (no concat/gap): the overlap is what makes the crossfade.
    expect(plan.filterComplex).toContain('amix=inputs=2:normalize=0')
  })

  it('adds no audio fades without a transition', () => {
    const plan = buildFfmpegPlan(withAudio(twoClipProject()))
    expect(plan.filterComplex).not.toContain('afade')
  })

  it('adds no fades when the neighbouring clip is deactivated', () => {
    const p = withAudio(twoClipProject({ transition: 'crossfade' }))
    p.tracks[0].clips[0] = { ...p.tracks[0].clips[0], disabled: true }
    const plan = buildFfmpegPlan(p)
    expect(plan.filterComplex).not.toContain('afade')
  })
})

describe('buildFfmpegPlan — image inputs', () => {
  function imageProject(path: string): Project {
    const p = twoClipProject()
    return { ...p, assets: [{ id: 'a1', path, kind: 'image', name: path, duration: 10, hasAudio: false }] }
  }

  it('loops still images with the image2 -loop option', () => {
    const plan = buildFfmpegPlan(imageProject('/tmp/a.png'))
    expect(plan.inputs).toEqual(['-loop', '1', '-framerate', '30', '-i', '/tmp/a.png'])
  })

  it('uses -stream_loop for GIFs (the gif demuxer has no -loop option)', () => {
    const plan = buildFfmpegPlan(imageProject('/tmp/a.GIF'))
    expect(plan.inputs).toEqual(['-stream_loop', '-1', '-i', '/tmp/a.GIF'])
  })
})
