import type { MediaAsset } from '@shared/types'
import { ALL_SUPPORTED_EXTENSIONS, SUPPORTED_EXTENSIONS, fileExtension } from '@shared/types'
import { useLayoutStore } from './state/layoutStore'
import { useProjectStore } from './state/projectStore'

/** MIME type used when dragging an already-imported asset from the media bin. */
export const ASSET_DRAG_MIME = 'application/x-freecut-asset'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

/** Human-readable list of supported formats, for import error messages. */
function supportedFormatsSentence(): string {
  const strip = (exts: readonly string[]) => exts.map((e) => e.slice(1)).join(', ')
  return (
    `Video: ${strip(SUPPORTED_EXTENSIONS.video)}\n` +
    `Audio: ${strip(SUPPORTED_EXTENSIONS.audio)}\n` +
    `Images: ${strip(SUPPORTED_EXTENSIONS.image)}`
  )
}

/** Result of an import attempt: the assets that loaded, plus any files that were rejected with
 *  a specific, human-readable reason (surfaced to the user instead of a silent drop). */
export interface ImportResult {
  assets: MediaAsset[]
  rejected: { name: string; reason: string }[]
}

/**
 * Imports media FAST: only the cheap `probeMedia` (an ffprobe metadata read) runs synchronously,
 * so an asset is returned — and can appear in the bin — the moment the Finder dialog closes.
 *
 * The expensive, full-file ffmpeg work (preview proxy transcode, thumbnail sprite, audio
 * waveform) is kicked off in the BACKGROUND by `enrichAsset` and patched onto the asset in the
 * store as each job finishes. This used to all run up-front, blocking the import for seconds per
 * clip. Export never depended on any of it, and the preview/timeline read these fields per-render
 * so they light up as they arrive.
 */
export async function importAssets(paths: string[]): Promise<ImportResult> {
  const assets: MediaAsset[] = []
  const rejected: { name: string; reason: string }[] = []
  for (const path of paths) {
    const ext = fileExtension(path)
    // Classify BEFORE probing so an unsupported container gets a precise message rather than a
    // generic "couldn't read" (the probe returns null for both cases otherwise).
    if (!ALL_SUPPORTED_EXTENSIONS.includes(ext)) {
      rejected.push({
        name: basename(path),
        reason: ext
          ? `"${ext}" files aren't supported.`
          : `files without a recognized extension aren't supported.`
      })
      continue
    }
    const probe = await window.api.probeMedia(path)
    if (!probe) {
      rejected.push({
        name: basename(path),
        reason: `the file couldn't be read (it may be corrupt or use an unsupported codec).`
      })
      continue
    }

    // Images are their own cover immediately (no extraction needed) — cheap, so do it inline.
    const cover =
      probe.kind === 'image'
        ? { path, frames: 1, frameWidth: probe.width ?? 1920, frameHeight: probe.height ?? 1080 }
        : undefined

    const asset: MediaAsset = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      path,
      kind: probe.kind,
      name: basename(path),
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      cover
    }
    assets.push(asset)
    // Fire-and-forget the heavy artifacts; they patch themselves onto the asset when ready.
    void enrichAsset(asset, probe)
  }
  return { assets, rejected }
}

/**
 * Re-derives an existing asset's proxy/filmstrip/waveform from its current `path`: after a relink,
 * or when a project is opened (stored artifact paths may point into a cache that has since been
 * cleaned). Probe and every artifact are disk-cached, so this is near-instant when nothing changed.
 */
export async function refreshAsset(asset: MediaAsset): Promise<void> {
  const probe = await window.api.probeMedia(asset.path)
  if (!probe) return
  // Duration/size can change if the user relinked to a different encode of the "same" file.
  useProjectStore.getState().patchAsset(asset.id, {
    duration: asset.kind === 'image' ? asset.duration : probe.duration,
    width: probe.width ?? asset.width,
    height: probe.height ?? asset.height,
    hasAudio: probe.hasAudio
  })
  await enrichAsset(asset, probe)
}

/**
 * Background-generates an asset's preview proxy, filmstrip cover, and waveform (each a full-file
 * ffmpeg pass), patching the store as each completes. Runs entirely after the asset is already
 * visible, so import feels instant. All jobs are independent and cached on disk by the main
 * process, so re-importing the same file is cheap.
 */
async function enrichAsset(asset: MediaAsset, probe: NonNullable<Awaited<ReturnType<typeof window.api.probeMedia>>>): Promise<void> {
  const patch = useProjectStore.getState().patchAsset

  // Preview proxy (only for codecs/containers Chromium can't play, and only if proxies are on).
  if (probe.kind !== 'image' && useLayoutStore.getState().useProxies) {
    window.api
      .ensurePreviewProxy(asset.path, probe.videoCodec, probe.audioCodec)
      .then((previewPath) => patch(asset.id, { previewPath: previewPath ?? undefined }))
      .catch(() => {})
  } else if (asset.previewPath) {
    patch(asset.id, { previewPath: undefined })
  }

  // Filmstrip cover (video first-frame sprite).
  if (probe.kind === 'video') {
    window.api
      .generateThumbnails(asset.path, probe.duration)
      .then((videoCover) => {
        if (videoCover) patch(asset.id, { cover: videoCover })
      })
      .catch(() => {})
  }

  // Audio waveform (anything with an audio stream).
  if (probe.hasAudio || probe.kind === 'audio') {
    window.api
      .generateWaveform(asset.path)
      .then((waveform) => {
        if (waveform) patch(asset.id, { waveform })
      })
      .catch(() => {})
  }
}

/** Back-compat convenience: import and surface any rejections via the toast channel, returning
 *  just the successful assets. Callers that want to show the reasons inline use importAssets. */
export async function assetsFromPaths(paths: string[]): Promise<MediaAsset[]> {
  const { assets, rejected } = await importAssets(paths)
  if (rejected.length > 0) {
    const lines = rejected.map((r) => `• ${r.name} — ${r.reason}`).join('\n')
    notifyImportError(`Couldn't import ${rejected.length} file${rejected.length > 1 ? 's' : ''}:\n${lines}\n\nSupported formats:\n${supportedFormatsSentence()}`)
  }
  return assets
}

/** Where import errors go. Defaults to a simple alert; the app overrides this at startup to
 *  route rejections through the on-screen toast/slash popup instead. */
let importErrorHandler: (message: string) => void = (message) => alert(message)
export function setImportErrorHandler(handler: (message: string) => void) {
  importErrorHandler = handler
}
function notifyImportError(message: string) {
  importErrorHandler(message)
}

/** Absolute paths of OS files in a drop event (empty if none, e.g. an in-app drag). */
export function droppedFilePaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => window.api.getPathForFile(file))
    .filter((p) => p.length > 0)
}

export function isMediaDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes(ASSET_DRAG_MIME) || types.includes('Files')
}
