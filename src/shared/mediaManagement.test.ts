import { describe, expect, it } from 'vitest'
import { buildFfmpegPlan } from './ffmpegGraph'
import { createEmptyProject, defaultTransform, resolveSourceOverrides, type MediaAsset, type MediaClip, type Project } from './types'

function asset(id: string, path: string): MediaAsset {
  return { id, path, kind: 'video', name: id, duration: 10, width: 1920, height: 1080, hasAudio: true }
}

function clip(id: string, assetId: string, trackId: string, start: number, override?: MediaClip['sourceOverride']): MediaClip {
  return {
    id,
    kind: 'media',
    trackId,
    assetId,
    start,
    duration: 5,
    trimIn: 0,
    trimOut: 5,
    volume: 1,
    muted: false,
    speed: 1,
    reversed: false,
    frozen: false,
    transform: defaultTransform(),
    sourceOverride: override
  }
}

/** Two video tracks: base clip on track 1, overlay on track 2; both from the same asset. */
function twoTrackProject(override?: MediaClip['sourceOverride']): Project {
  const p = createEmptyProject('t')
  const v1 = p.tracks.find((t) => t.type === 'video')!
  const v2 = { ...v1, id: 'v2', name: 'Video 2', clips: [] as MediaClip[] }
  p.assets = [asset('a', '/media/a.mp4')]
  v1.clips = [clip('c1', 'a', v1.id, 0)]
  v2.clips = [clip('c2', 'a', 'v2', 0, override)]
  p.tracks = [v1, v2, ...p.tracks.filter((t) => t.type !== 'video')]
  return p
}

describe('resolveSourceOverrides', () => {
  it('is a no-op when no clip has an override', () => {
    const p = twoTrackProject()
    expect(resolveSourceOverrides(p)).toBe(p)
  })

  it('points the overridden clip at a synthetic asset with the baked path; others keep the original', () => {
    const r = resolveSourceOverrides(twoTrackProject({ path: '/cache/mattes/x.mov', kind: 'backgroundRemoved', hasAlpha: true }))
    const c1 = r.tracks[0].clips[0] as MediaClip
    const c2 = r.tracks[1].clips[0] as MediaClip
    expect(c1.assetId).toBe('a')
    expect(c2.assetId).not.toBe('a')
    const synth = r.assets.find((a) => a.id === c2.assetId)!
    expect(synth.path).toBe('/cache/mattes/x.mov')
    // The original bin asset is untouched.
    expect(r.assets.find((a) => a.id === 'a')!.path).toBe('/media/a.mp4')
  })

  it('dedupes: two clips with the same override share one synthetic asset', () => {
    const p = twoTrackProject({ path: '/cache/mattes/x.mov', kind: 'backgroundRemoved', hasAlpha: true })
    p.tracks[1].clips.push(clip('c3', 'a', 'v2', 5, { path: '/cache/mattes/x.mov', kind: 'backgroundRemoved', hasAlpha: true }))
    const r = resolveSourceOverrides(p)
    const ids = r.tracks[1].clips.map((c) => (c as MediaClip).assetId)
    expect(ids[0]).toBe(ids[1])
    expect(r.assets).toHaveLength(2)
  })
})

describe('buildFfmpegPlan with a source override', () => {
  it('feeds the baked file to ffmpeg as its own input, alongside the original', () => {
    const plan = buildFfmpegPlan(twoTrackProject({ path: '/cache/mattes/x.mov', kind: 'backgroundRemoved', hasAlpha: true }))
    const inputs = plan.inputs.filter((_, i, arr) => arr[i - 1] === '-i')
    expect(inputs).toContain('/media/a.mp4')
    expect(inputs).toContain('/cache/mattes/x.mov')
  })

  it('without an override, one asset used twice is a single ffmpeg input', () => {
    const plan = buildFfmpegPlan(twoTrackProject())
    const inputs = plan.inputs.filter((_, i, arr) => arr[i - 1] === '-i')
    expect(inputs).toEqual(['/media/a.mp4'])
  })

  it("an overridden clip's AUDIO comes from the original file (bakes may have no audio stream)", () => {
    const plan = buildFfmpegPlan(twoTrackProject({ path: '/cache/mattes/x.mov', kind: 'backgroundRemoved', hasAlpha: true }))
    const inputs = plan.inputs.filter((_, i, arr) => arr[i - 1] === '-i')
    const original = inputs.indexOf('/media/a.mp4')
    const baked = inputs.indexOf('/cache/mattes/x.mov')
    // Audio is only ever read from the original input; the baked file feeds video only.
    expect(plan.filterComplex).toContain(`[${original}:a]`)
    expect(plan.filterComplex).not.toContain(`[${baked}:a]`)
    expect(plan.filterComplex).toContain(`[${baked}:v]`)
  })
})
