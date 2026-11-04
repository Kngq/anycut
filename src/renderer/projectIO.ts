import type { OpenedProject } from '@shared/ipc'
import { useProjectStore } from './state/projectStore'
import { useRecentsStore } from './state/recentsStore'
import { useToastStore } from './state/toastStore'
import { refreshAsset } from './media'

/**
 * Single place for loading/saving projects so every entry point (Home, Open…, Recents, Save,
 * Save As) gets the same behavior:
 *  - warn when the main file was corrupt and the `.bak` was used,
 *  - warn when another freecut process already has the project open (advisory lock),
 *  - detect offline media (moved/renamed/unplugged sources) and flag those assets,
 *  - re-derive proxies/filmstrips/waveforms in the background (cache-backed, near-instant).
 */

/** Loads an opened project into the editor. */
export function loadOpenedProject(opened: OpenedProject): void {
  const toast = useToastStore.getState().push
  useProjectStore.getState().setProject(opened.project, opened.path)
  useRecentsStore.getState().addRecent(opened.path, opened.project.name)
  if (opened.recoveredFromBackup) {
    toast('info', `"${opened.project.name}" couldn't be read, so its last backup (.bak) was opened instead.`)
  }
  if (opened.lockedBy !== undefined) {
    toast('error', `This project is already open in another freecut window (process ${opened.lockedBy}). Saving from both will overwrite each other's changes.`)
  }
  void checkMedia()
}

/** Re-checks every asset's source file; flags missing ones and refreshes present ones. */
export async function checkMedia(): Promise<void> {
  const { project, setMissingAssets } = useProjectStore.getState()
  const missingPaths = new Set(await window.api.findMissingMedia(project.assets.map((a) => a.path)))
  // The project may have changed while we awaited; resolve ids against the current one.
  const current = useProjectStore.getState().project
  const missingIds = current.assets.filter((a) => missingPaths.has(a.path)).map((a) => a.id)
  setMissingAssets(missingIds)
  if (missingIds.length > 0) {
    useToastStore
      .getState()
      .push('error', `${missingIds.length} media file${missingIds.length === 1 ? ' is' : 's are'} offline (moved, renamed, or on an unplugged drive). Use "Locate" in the media bin to relink.`)
  }
  for (const a of current.assets) if (!missingPaths.has(a.path)) void refreshAsset(a)
}

/** Asks the user to locate one missing asset, auto-relinks siblings found in the same folder, and
 *  refreshes the relinked assets. Returns how many were relinked. */
export async function locateMissing(assetId: string): Promise<number> {
  const { project, missingAssetIds, relinkAssets } = useProjectStore.getState()
  const target = project.assets.find((a) => a.id === assetId)
  if (!target) return 0
  const otherMissing = project.assets.filter((a) => missingAssetIds.includes(a.id) && a.id !== assetId).map((a) => a.path)
  const map = await window.api.locateMedia(target.path, otherMissing)
  if (!map) return 0
  relinkAssets(map)
  const relinked = useProjectStore.getState().project.assets.filter((a) => Object.values(map).includes(a.path))
  for (const a of relinked) void refreshAsset(a)
  const count = Object.keys(map).length
  if (count > 1) useToastStore.getState().push('info', `Relinked ${count} files (found ${count - 1} more in the same folder).`)
  return count
}

/** Saves to the current path, or prompts for one. `saveAs` always prompts. Returns success. */
export async function saveProject(saveAs = false): Promise<boolean> {
  const { project, filePath } = useProjectStore.getState()
  let path = saveAs ? null : filePath
  if (!path) {
    path = await window.api.saveProjectDialog(project.name)
    if (!path) return false
  }
  const ok = await window.api.writeProject(path, project)
  if (!ok) return false
  if (path !== filePath) await window.api.lockProject(path)
  useProjectStore.setState({ filePath: path, dirty: false })
  useRecentsStore.getState().addRecent(path, project.name)
  return true
}
