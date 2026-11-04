import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from './projectStore'
import { createEmptyProject, defaultTransform, type MediaAsset } from '@shared/types'

/** Seeds a clean project with one media clip on the video track and selects it. Returns the
 *  clip id. Each test starts from here so history is empty and deterministic. */
function seedOneClip(): string {
  const project = createEmptyProject('test')
  useProjectStore.getState().setProject(project)
  const asset: MediaAsset = { id: 'a', path: '/tmp/a.mp4', kind: 'video', name: 'a.mp4', duration: 10, width: 1920, height: 1080, hasAudio: false }
  const vt = useProjectStore.getState().project.tracks.find((t) => t.type === 'video')!
  useProjectStore.getState().addAsset(asset)
  useProjectStore.getState().addMediaClipToTrack(vt.id, asset, 0)
  const clipId = useProjectStore.getState().selectedClipId!
  return clipId
}

function selectedClipTransform() {
  const st = useProjectStore.getState()
  const clip = st.project.tracks.flatMap((t) => t.clips).find((c) => c.id === st.selectedClipId)
  return clip?.transform
}

describe('projectStore — rotate / mirror', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject()
  })

  it('rotateClip adds to rotation and wraps at 360', () => {
    const id = seedOneClip()
    useProjectStore.getState().rotateClip(id, 90)
    expect(selectedClipTransform()?.rotation).toBe(90)
    useProjectStore.getState().rotateClip(id, 90)
    useProjectStore.getState().rotateClip(id, 90)
    useProjectStore.getState().rotateClip(id, 90)
    expect(selectedClipTransform()?.rotation).toBe(0) // 360 wraps to 0
  })

  it('toggleClipFlipH flips the horizontal mirror on and off', () => {
    const id = seedOneClip()
    expect(selectedClipTransform()?.flipH).toBe(false)
    useProjectStore.getState().toggleClipFlipH(id)
    expect(selectedClipTransform()?.flipH).toBe(true)
    useProjectStore.getState().toggleClipFlipH(id)
    expect(selectedClipTransform()?.flipH).toBe(false)
  })
})

describe('projectStore — undo / redo', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject()
  })

  it('undo reverts the last mutation and redo re-applies it', () => {
    const id = seedOneClip()
    useProjectStore.getState().rotateClip(id, 90)
    expect(selectedClipTransform()?.rotation).toBe(90)

    useProjectStore.getState().undo()
    expect(selectedClipTransform()?.rotation).toBe(0)

    useProjectStore.getState().redo()
    expect(selectedClipTransform()?.rotation).toBe(90)
  })

  it('undo is a no-op once history is exhausted', () => {
    seedOneClip()
    // Drain the history accumulated by seeding, then an extra undo must not change anything.
    while (useProjectStore.getState().past.length > 0) useProjectStore.getState().undo()
    const drained = JSON.stringify(useProjectStore.getState().project)
    useProjectStore.getState().undo()
    expect(JSON.stringify(useProjectStore.getState().project)).toBe(drained)
  })

  it('a new mutation after undo clears the redo stack', () => {
    const id = seedOneClip()
    useProjectStore.getState().rotateClip(id, 90) // rotation 90
    useProjectStore.getState().undo() // back to 0, future has the 90 state
    expect(useProjectStore.getState().future.length).toBeGreaterThan(0)
    useProjectStore.getState().toggleClipFlipH(id) // a new edit
    expect(useProjectStore.getState().future.length).toBe(0) // redo stack invalidated
  })

  it('removeClip is undoable', () => {
    const id = seedOneClip()
    const countBefore = useProjectStore.getState().project.tracks.flatMap((t) => t.clips).length
    useProjectStore.getState().removeClip(id)
    expect(useProjectStore.getState().project.tracks.flatMap((t) => t.clips).length).toBe(countBefore - 1)
    useProjectStore.getState().undo()
    expect(useProjectStore.getState().project.tracks.flatMap((t) => t.clips).length).toBe(countBefore)
  })
})

describe('projectStore — media management', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject()
  })

  it('relinkAssets repoints the asset, drops derived artifacts, clears offline, keeps clips', () => {
    const id = seedOneClip()
    useProjectStore.getState().patchAsset('a', { previewPath: '/cache/p.mp4', waveform: { peaks: [0.5] } })
    useProjectStore.getState().setMissingAssets(['a'])
    useProjectStore.getState().relinkAssets({ '/tmp/a.mp4': '/new/place/a.mp4' })
    const st = useProjectStore.getState()
    const asset = st.project.assets.find((x) => x.id === 'a')!
    expect(asset.path).toBe('/new/place/a.mp4')
    expect(asset.previewPath).toBeUndefined()
    expect(asset.waveform).toBeUndefined()
    expect(st.missingAssetIds).toEqual([])
    // The timeline clip still references the same asset id.
    const clip = st.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
    expect(clip.kind === 'media' && clip.assetId).toBe('a')
  })

  it('relinkAssets is undoable', () => {
    seedOneClip()
    useProjectStore.getState().relinkAssets({ '/tmp/a.mp4': '/new/a.mp4' })
    useProjectStore.getState().undo()
    expect(useProjectStore.getState().project.assets[0].path).toBe('/tmp/a.mp4')
  })

  it('patchAsset attaches artifacts without dirtying or adding undo history', () => {
    seedOneClip()
    useProjectStore.setState({ dirty: false })
    const pastLen = useProjectStore.getState().past.length
    useProjectStore.getState().patchAsset('a', { previewPath: '/cache/p.mp4' })
    expect(useProjectStore.getState().project.assets[0].previewPath).toBe('/cache/p.mp4')
    expect(useProjectStore.getState().dirty).toBe(false)
    expect(useProjectStore.getState().past.length).toBe(pastLen)
  })

  it('setClipSourceOverride applies to one clip only and is undoable', () => {
    const id = seedOneClip()
    useProjectStore.getState().setClipSourceOverride(id, { path: '/cache/m.mov', kind: 'backgroundRemoved', hasAlpha: true })
    const override = () => {
      const c = useProjectStore.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === id)!
      return c.kind === 'media' ? c.sourceOverride : 'not-media'
    }
    expect(override()).toMatchObject({ path: '/cache/m.mov' })
    expect(useProjectStore.getState().project.assets[0].path).toBe('/tmp/a.mp4')
    useProjectStore.getState().undo()
    expect(override()).toBeUndefined()
  })
})

describe('projectStore — transitions', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject()
  })

  /** Two back-to-back clips on the main video track; returns the second (transition-eligible) clip id. */
  function seedTwoClips(): string {
    seedOneClip()
    const st = useProjectStore.getState()
    const vt = st.project.tracks.find((t) => t.type === 'video')!
    st.addMediaClipToTrack(vt.id, st.project.assets[0], 10)
    return useProjectStore.getState().selectedClipId!
  }

  function transitionOf(clipId: string) {
    return useProjectStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)?.transitionIn
  }

  it('setClipTransition sets type and duration as ONE undo step', () => {
    const id = seedTwoClips()
    const pastBefore = useProjectStore.getState().past.length
    useProjectStore.getState().setClipTransition(id, { type: 'wipeLeft', duration: 0.5 })
    expect(transitionOf(id)).toEqual({ type: 'wipeLeft', duration: 0.5 })
    expect(useProjectStore.getState().past.length).toBe(pastBefore + 1)
    useProjectStore.getState().undo()
    expect(transitionOf(id)).toBeUndefined()
  })

  it('setClipTransition is a no-op on the first clip', () => {
    const first = seedOneClip()
    useProjectStore.getState().setClipTransition(first, { type: 'crossfade', duration: 0.5 })
    expect(transitionOf(first)).toBeUndefined()
  })

  it('setTransition changes the duration but keeps the type', () => {
    const id = seedTwoClips()
    useProjectStore.getState().setClipTransition(id, { type: 'dipToBlack', duration: 0.5 })
    useProjectStore.getState().setTransition(id, 1.2)
    expect(transitionOf(id)).toEqual({ type: 'dipToBlack', duration: 1.2 })
  })
})
