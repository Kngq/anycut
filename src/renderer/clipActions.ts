/**
 * The timeline clip menu's actions that need more than a store update: rendering (export
 * selected / compound clip), file dialogs (replace), the main process (extract audio, reveal in
 * Finder) or other panels (transcript). Synchronous edits live in projectStore.
 */
import { clipsRange, isolateClips } from '@shared/clipOps'
import type { MediaAsset, MediaClip } from '@shared/types'
import { runExport } from './export/runExport'
import { importAssets } from './media'
import { selectionOf, useProjectStore } from './state/projectStore'
import { useBinRequest } from './state/layoutStore'
import { useToastStore } from './state/toastStore'

const toast = (kind: 'info' | 'error', msg: string) => useToastStore.getState().push(kind, msg)

function assetOf(clipId: string): { clip: MediaClip; asset: MediaAsset } | null {
  const { project } = useProjectStore.getState()
  for (const t of project.tracks) {
    const clip = t.clips.find((c) => c.id === clipId)
    if (clip?.kind === 'media') {
      const asset = project.assets.find((a) => a.id === clip.assetId)
      return asset ? { clip, asset } : null
    }
  }
  return null
}

/** Renders only the selected clips (others deactivated, so timing and layering are exact),
 *  trimmed to the span they cover. */
async function renderSelection(outputPath: string, label: string): Promise<{ ok: boolean; outputPath?: string; error?: string; range?: { start: number; end: number } }> {
  const s = useProjectStore.getState()
  const ids = selectionOf(s)
  const range = clipsRange(s.project, ids)
  if (!range) return { ok: false, error: 'nothing selected' }
  const result = await runExport(isolateClips(s.project, ids), outputPath, label, range)
  return { ...result, range }
}

export async function exportSelectedClips() {
  const s = useProjectStore.getState()
  const path = await window.api.exportDialog(`${s.project.name} (selection)`)
  if (!path) return
  const res = await renderSelection(path, 'Exporting selected clips')
  if (res.ok) toast('info', 'Selected clips exported.')
  else toast('error', `Export failed: ${res.error}`)
}

/**
 * "Create compound clip": the selection is rendered to one file (kept under the app's data
 * folder) and replaced on the timeline by a single clip of it. Undo restores the originals.
 */
export async function createCompoundClip() {
  const ids = selectionOf(useProjectStore.getState())
  if (ids.length < 2) return toast('info', 'Select two or more clips (Cmd-click) to create a compound clip.')
  const out = await window.api.compoundPath()
  const res = await renderSelection(out, 'Creating compound clip')
  if (!res.ok) return toast('error', `Couldn't create the compound clip: ${res.error}`)
  const { assets, rejected } = await importAssets([out])
  const asset = assets[0]
  if (!asset) return toast('error', `Couldn't read the compound clip: ${rejected[0]?.reason ?? 'unknown error'}`)
  const n = useProjectStore.getState().project.assets.filter((a) => a.name.startsWith('Compound clip')).length + 1
  useProjectStore.getState().applyCompound(ids, { ...asset, name: `Compound clip ${n}` })
}

export async function extractAudioToBin(clipId: string) {
  const found = assetOf(clipId)
  if (!found) return
  const res = await window.api.extractAudio(found.asset.path)
  if (!res.ok || !res.outputPath) return toast('error', `Couldn't extract audio: ${res.error ?? 'unknown error'}`)
  const { assets } = await importAssets([res.outputPath])
  if (assets[0]) {
    useProjectStore.getState().addAsset(assets[0])
    toast('info', `Extracted audio added to Media: ${assets[0].name}`)
  }
}

export async function replaceClip(clipId: string) {
  const paths = await window.api.openMediaDialog()
  if (!paths || paths.length === 0) return
  const { assets, rejected } = await importAssets([paths[0]])
  if (!assets[0]) return toast('error', `Couldn't use that file: ${rejected[0]?.reason ?? 'unknown error'}`)
  useProjectStore.getState().replaceClipMedia(clipId, assets[0])
}

export function openFileLocation(clipId: string) {
  const found = assetOf(clipId)
  if (found) void window.api.showInFolder(found.clip.sourceOverride?.path ?? found.asset.path)
}

export function openTranscript(clipId: string) {
  useProjectStore.getState().selectClip(clipId)
  useBinRequest.getState().open('captions', 'selected')
}
