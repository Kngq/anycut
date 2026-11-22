import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AnycutApi } from '@shared/ipc'

/**
 * Builds a anycut-media:// URL, escaping characters like '#', '?', '%' and spaces that
 * break a raw path. Not a plain file:// URL: the renderer runs on http://localhost in dev,
 * and Chromium rejects <video>/<audio> loading a file:// source cross-scheme from there.
 * The main process serves this custom scheme from the real file (see electron/main/mediaProtocol.ts).
 *
 * The fixed "local" host is deliberate, not decorative: a scheme registered with
 * `standard: true` parses like http(s) (scheme://host/path), so an EMPTY host
 * (anycut-media:///Users/...) gets its first path segment silently reinterpreted as the host
 * during Chromium's URL normalization — "/Users/kng/x" became host "users", path "/kng/x".
 * Confirmed empirically: this was masked in testing only because /private/tmp (where test
 * fixtures happened to live) has a /tmp symlink alias that coincidentally still resolved after
 * the leading segment was swallowed — any real path (~/Desktop, ~/Library, /var/folders/...)
 * broke outright. A non-empty, constant host sidesteps the ambiguity entirely.
 */
function toFileUrl(filePath: string): string {
  let p = filePath.replace(/\\/g, '/')
  if (!p.startsWith('/')) p = `/${p}` // Windows drive paths: C:/x -> /C:/x
  const encoded = p.split('/').map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/')
  return `anycut-media://local${encoded}`
}

const api: AnycutApi = {
  openMediaDialog: () => ipcRenderer.invoke('media:openDialog'),
  probeMedia: (path) => ipcRenderer.invoke('media:probe', path),
  ensurePreviewProxy: (path, videoCodec, audioCodec) => ipcRenderer.invoke('media:ensureProxy', path, videoCodec, audioCodec),
  generateThumbnails: (path, duration) => ipcRenderer.invoke('media:thumbnails', path, duration),
  generateWaveform: (path) => ipcRenderer.invoke('media:waveform', path),
  captionStatus: () => ipcRenderer.invoke('caption:status'),
  transcribeClips: (sources, language) => ipcRenderer.invoke('caption:transcribe', sources, language),
  cancelCaptions: () => ipcRenderer.invoke('caption:cancel'),
  onCaptionProgress: (cb) => {
    const listener = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p)
    ipcRenderer.on('caption:progress', listener)
    return () => ipcRenderer.removeListener('caption:progress', listener)
  },
  backgroundStatus: () => ipcRenderer.invoke('background:status'),
  downloadBackgroundModel: (model) => ipcRenderer.invoke('background:download', model),
  removeBackground: (path, model) => ipcRenderer.invoke('background:remove', path, model),
  onBackgroundProgress: (cb) => {
    const listener = (_e: unknown, ratio: number) => cb(ratio)
    ipcRenderer.on('background:progress', listener)
    return () => ipcRenderer.removeListener('background:progress', listener)
  },
  motionBlur: (path, settings) => ipcRenderer.invoke('motionBlur:run', path, settings),
  cancelMotionBlur: () => ipcRenderer.invoke('motionBlur:cancel'),
  onMotionBlurProgress: (cb) => {
    const listener = (_e: unknown, ratio: number) => cb(ratio)
    ipcRenderer.on('motionBlur:progress', listener)
    return () => ipcRenderer.removeListener('motionBlur:progress', listener)
  },
  saveProjectDialog: (defaultName) => ipcRenderer.invoke('project:saveDialog', defaultName),
  openProjectDialog: () => ipcRenderer.invoke('project:openDialog'),
  openProjectAtPath: (path) => ipcRenderer.invoke('project:open', path),
  writeProject: (path, project) => ipcRenderer.invoke('project:write', path, project),
  lockProject: (path) => ipcRenderer.invoke('project:lock', path),
  findMissingMedia: (paths) => ipcRenderer.invoke('media:findMissing', paths),
  locateMedia: (missingPath, otherMissing) => ipcRenderer.invoke('media:locate', missingPath, otherMissing),
  cacheUsage: () => ipcRenderer.invoke('cache:usage'),
  cleanCache: (maxAgeDays, recentProjectPaths, openAssetPaths) => ipcRenderer.invoke('cache:clean', maxAgeDays, recentProjectPaths, openAssetPaths),
  revealCache: () => ipcRenderer.invoke('cache:reveal'),
  exportDialog: (defaultName) => ipcRenderer.invoke('export:dialog', defaultName),
  exportProject: (project, outputPath, overlayId, range) => ipcRenderer.invoke('export:run', project, outputPath, overlayId, range),
  showInFolder: (path) => ipcRenderer.invoke('media:showInFolder', path),
  compoundPath: () => ipcRenderer.invoke('media:compoundPath'),
  extractAudio: (path) => ipcRenderer.invoke('media:extractAudio', path),
  overlayBegin: () => ipcRenderer.invoke('overlay:begin'),
  overlayBlank: (id, data) => ipcRenderer.invoke('overlay:blank', id, data),
  overlayFrame: (id, index, data) => ipcRenderer.invoke('overlay:frame', id, index, data),
  overlayDiscard: (id) => ipcRenderer.invoke('overlay:discard', id),
  onExportProgress: (cb) => {
    const listener = (_e: unknown, progress: Parameters<typeof cb>[0]) => cb(progress)
    ipcRenderer.on('export:progress', listener)
    return () => ipcRenderer.removeListener('export:progress', listener)
  },
  fileUrl: toFileUrl,
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('api', api)
