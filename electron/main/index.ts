import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { fileURLToPath } from 'node:url'
import { probeMedia } from './probe'
import { ensurePreviewProxy } from './proxy'
import { ensureVideoCover } from './thumbnails'
import { ensureWaveform } from './waveform'
import { captionStatus, downloadCaptionModel, transcribeToCaptions } from './transcribe'
import { backgroundStatus, downloadBackgroundModel, removeBackground } from './background'
import { cacheRoot, cacheUsage, cleanCache, protectedSourcesFor } from './cache'
import { autoRelink, findMissing } from './relink'
import { exportProject } from './export'
import { handleMediaRequest } from './mediaProtocol'
import { FILE_EXTENSION, type Project } from '@shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/**
 * The renderer loads from http://localhost:5173 in dev, so <video>/<audio> elements can't
 * load file:// sources directly — Chromium's media URL safety check rejects the cross-scheme
 * load. Serving local media through this privileged custom scheme instead (handled by
 * handleMediaRequest, which reads the file with Node fs directly — see that file for why not
 * net.fetch) works from both the dev server origin and the packaged file:// origin.
 */
const MEDIA_SCHEME = 'freecut-media'

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // A file dropped outside a drop zone would otherwise replace the editor with that file.
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
}

app.whenReady().then(() => {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest)
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

const VIDEO_FILTERS = [
  { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'aac', 'm4a', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }
]

ipcMain.handle('media:openDialog', async () => {
  if (!win) return []
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: VIDEO_FILTERS
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('media:probe', async (_e, filePath: string) => {
  return probeMedia(filePath)
})

ipcMain.handle('media:ensureProxy', async (_e, filePath: string, videoCodec?: string, audioCodec?: string) => {
  return ensurePreviewProxy(filePath, videoCodec, audioCodec)
})

ipcMain.handle('media:thumbnails', async (_e, filePath: string, duration?: number) => {
  return ensureVideoCover(filePath, duration)
})

ipcMain.handle('media:waveform', async (_e, filePath: string) => {
  return ensureWaveform(filePath)
})

ipcMain.handle('cache:usage', async () => {
  return cacheUsage()
})

/** Age-based cleanup (CapCut-style `cacheDate`): drop entries unused for `maxAgeDays`, keeping
 *  anything built from media in the currently open project or in `recentProjectPaths`.
 *  `maxAgeDays = 0` is "Clear cache" (still protected). */
ipcMain.handle('cache:clean', async (_e, maxAgeDays: number, recentProjectPaths: string[], openAssetPaths: string[]) => {
  const fromRecents = await protectedSourcesFor(recentProjectPaths ?? [])
  return cleanCache(maxAgeDays, [...fromRecents, ...(openAssetPaths ?? [])])
})

ipcMain.handle('cache:reveal', async () => {
  await fs.mkdir(cacheRoot(), { recursive: true })
  await shell.openPath(cacheRoot())
  return true
})

ipcMain.handle('caption:status', async () => {
  return captionStatus()
})

ipcMain.handle('caption:download', async () => {
  return downloadCaptionModel()
})

ipcMain.handle('caption:transcribe', async (_e, filePath: string) => {
  return transcribeToCaptions(filePath)
})

ipcMain.handle('background:status', async () => {
  return backgroundStatus()
})

ipcMain.handle('background:download', async () => {
  return downloadBackgroundModel()
})

ipcMain.handle('background:remove', async (_e, filePath: string) => {
  return removeBackground(filePath, (ratio) => win?.webContents.send('background:progress', ratio))
})

ipcMain.handle('project:saveDialog', async (_e, defaultName: string) => {
  if (!win) return null
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName.endsWith(FILE_EXTENSION) ? defaultName : `${defaultName}${FILE_EXTENSION}`,
    filters: [{ name: 'freecut project', extensions: ['fcproj'] }]
  })
  return result.canceled || !result.filePath ? null : result.filePath
})

/** Reads a project, falling back to the `.bak` written by the previous save if the main file is
 *  missing or corrupt. `recoveredFromBackup` lets the UI tell the user. */
async function readProjectFile(filePath: string): Promise<{ path: string; project: Project; recoveredFromBackup?: boolean; lockedBy?: number } | null> {
  const parse = async (p: string) => JSON.parse(await fs.readFile(p, 'utf-8')) as Project
  let project: Project | null = null
  let recoveredFromBackup = false
  try {
    project = await parse(filePath)
  } catch {
    try {
      project = await parse(`${filePath}.bak`)
      recoveredFromBackup = true
    } catch {
      return null
    }
  }
  const lockedBy = await acquireProjectLock(filePath)
  return { path: filePath, project, recoveredFromBackup: recoveredFromBackup || undefined, lockedBy }
}

/* ── Project lock (CapCut's `.locked`) ─────────────────────────────────────────────
   `<project>.lock` holds the PID of the freecut process that has the project open. Opening a
   project that's locked by a DIFFERENT live process reports that PID so the UI can warn (two
   windows saving the same file would clobber each other). Advisory, never blocking: a lock left by
   a crashed process has a dead PID and is silently taken over. */
let heldLock: string | null = null

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Takes the lock for `projectPath`; returns the other live PID if someone else holds it. */
async function acquireProjectLock(projectPath: string): Promise<number | undefined> {
  const lockPath = `${projectPath}.lock`
  let otherPid: number | undefined
  try {
    const pid = Number((await fs.readFile(lockPath, 'utf-8')).trim())
    if (pid && pid !== process.pid && pidAlive(pid)) otherPid = pid
  } catch {
    // no lock file
  }
  await releaseProjectLock()
  if (otherPid === undefined) {
    await fs.writeFile(lockPath, String(process.pid), 'utf-8').catch(() => {})
    heldLock = lockPath
  }
  return otherPid
}

async function releaseProjectLock() {
  if (!heldLock) return
  const lock = heldLock
  heldLock = null
  try {
    if (Number((await fs.readFile(lock, 'utf-8')).trim()) === process.pid) await fs.unlink(lock)
  } catch {
    // already gone
  }
}

app.on('before-quit', () => {
  // Synchronous best-effort so the lock is gone even though the process is exiting.
  if (!heldLock) return
  try {
    if (Number(fsSync.readFileSync(heldLock, 'utf-8').trim()) === process.pid) fsSync.unlinkSync(heldLock)
  } catch {
    // ignore
  }
})

/** Which of these asset paths are missing on disk (moved/renamed/unplugged). */
ipcMain.handle('media:findMissing', async (_e, paths: string[]) => {
  return findMissing(paths ?? [])
})

/** Opens a file picker for one missing asset (pre-filtered to the same extension), then looks for
 *  the project's other missing files in the folder the user picked. Returns oldPath → newPath. */
ipcMain.handle('media:locate', async (_e, missingPath: string, otherMissing: string[]) => {
  if (!win) return null
  const ext = path.extname(missingPath).slice(1)
  const result = await dialog.showOpenDialog(win, {
    title: `Locate "${path.basename(missingPath)}"`,
    defaultPath: path.dirname(missingPath),
    properties: ['openFile'],
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : undefined
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const picked = result.filePaths[0]
  const siblings = await autoRelink(
    (otherMissing ?? []).filter((p) => p !== missingPath),
    path.dirname(picked)
  )
  return { [missingPath]: picked, ...siblings } as Record<string, string>
})

/** The renderer saved under a new path (Save As / first save): move the lock to it. */
ipcMain.handle('project:lock', async (_e, filePath: string | null) => {
  if (!filePath) {
    await releaseProjectLock()
    return undefined
  }
  return acquireProjectLock(filePath)
})

ipcMain.handle('project:openDialog', async () => {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'freecut project', extensions: ['fcproj'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return readProjectFile(result.filePaths[0])
})

ipcMain.handle('project:open', async (_e, filePath: string) => {
  return readProjectFile(filePath)
})

ipcMain.handle('project:write', async (_e, filePath: string, project: Project) => {
  // Atomic save, CapCut-style: write a sibling tmp file then rename over the target (never a
  // half-written project after a crash or full disk), keeping the previous version as `.bak`.
  const data = JSON.stringify(project, null, 2)
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, data, 'utf-8')
  const existed = await fs.access(filePath).then(
    () => true,
    () => false
  )
  if (existed) await fs.copyFile(filePath, `${filePath}.bak`).catch(() => {})
  await fs.rename(tmp, filePath)
  return true
})

ipcMain.handle('export:dialog', async (_e, defaultName: string) => {
  if (!win) return null
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName.endsWith('.mp4') ? defaultName : `${defaultName}.mp4`,
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
  })
  return result.canceled || !result.filePath ? null : result.filePath
})

ipcMain.handle('export:run', async (_e, project: Project, outputPath: string) => {
  return exportProject(project, outputPath, (progress) => {
    win?.webContents.send('export:progress', progress)
  })
})
