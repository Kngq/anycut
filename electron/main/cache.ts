import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'

/**
 * Persistent, content-keyed cache for derived media artifacts (probe results, filmstrip sprites,
 * waveforms, preview proxies, remuxes). Modeled on CapCut's `User Data/Cache/<kind>/<hash>` layout:
 *
 *  - One global cache shared by every project, so importing the same file into a second project is
 *    free, and the whole folder can be deleted at any time without losing work.
 *  - Keys derive from (absolute path, size, mtime), so editing or replacing the source invalidates
 *    the entry automatically.
 *  - Each entry gets a `<key>.meta.json` sidecar recording the source path/size/mtime it was built
 *    from. CapCut stores the same thing as a header line. Cleanup uses it to tell which sources an
 *    entry belongs to.
 *
 * Location: `<userData>/Cache/<kind>/`. Earlier builds used the OS temp dir because the
 * freecut-media:// handler used net.fetch, which couldn't read userData. The handler now reads
 * with Node fs (see mediaProtocol.ts), so that constraint is gone. The OS can also wipe temp at
 * any time, which threw away proxies and forced re-transcodes.
 */

export type CacheKind = 'mediainfo' | 'thumbnails' | 'waveforms' | 'proxies' | 'remux' | 'mattes'

export const CACHE_KINDS: CacheKind[] = ['mediainfo', 'thumbnails', 'waveforms', 'proxies', 'remux', 'mattes']

/** Bump when an artifact's on-disk format or generation params change, so old entries are ignored. */
const KIND_VERSION: Record<CacheKind, string> = {
  mediainfo: 'v1',
  thumbnails: 'v2', // 40-frame sprite at 120px
  waveforms: 'v1',
  proxies: 'v1',
  remux: 'v1',
  mattes: 'v1' // background-removed ProRes 4444 bakes
}

export function cacheRoot(): string {
  return path.join(app.getPath('userData'), 'Cache')
}

export function cacheDir(kind: CacheKind): string {
  return path.join(cacheRoot(), kind)
}

export interface SourceStamp {
  path: string
  size: number
  mtimeMs: number
}

/** Stats a source file. Null if it doesn't exist (missing media). */
export async function stampSource(filePath: string): Promise<SourceStamp | null> {
  const st = await fs.stat(filePath).catch(() => null)
  if (!st || !st.isFile()) return null
  return { path: filePath, size: st.size, mtimeMs: st.mtimeMs }
}

/** Stable cache key for (kind, source identity). */
export function cacheKey(kind: CacheKind, src: SourceStamp): string {
  return crypto.createHash('sha1').update(`${kind}:${KIND_VERSION[kind]}:${src.path}:${src.size}:${src.mtimeMs}`).digest('hex')
}

/** Absolute path for an entry file inside a kind's folder (creates the folder). */
export async function entryPath(kind: CacheKind, key: string, ext: string): Promise<string> {
  const dir = cacheDir(kind)
  await fs.mkdir(dir, { recursive: true })
  return path.join(dir, `${key}${ext}`)
}

/** Records which source an entry was built from (used by cleanup + debugging). */
export async function writeMeta(kind: CacheKind, key: string, src: SourceStamp): Promise<void> {
  const metaPath = await entryPath(kind, key, '.meta.json')
  await writeFileAtomic(metaPath, JSON.stringify({ ...src, kind, builtAt: Date.now() }))
}

/** Marks an entry as just used (mtime = now), so age-based cleanup keeps hot entries. */
export async function touchEntry(file: string): Promise<void> {
  const now = new Date()
  await fs.utimes(file, now, now).catch(() => {})
}

export async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

/** Writes via a sibling tmp file + rename so a crash never leaves a half-written entry. */
export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, target)
}

/** Reads a cached JSON entry; null on miss or corruption. Touches it on hit. */
export async function readJsonEntry<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const value = JSON.parse(raw) as T
    void touchEntry(file)
    return value
  } catch {
    return null
  }
}

/**
 * Source paths referenced by the given project files ("draft protection"): every asset path in each
 * readable .fcproj. Cache entries built from these sources are never evicted by age-based cleanup,
 * so reopening a recent project never has to regenerate proxies or filmstrips.
 */
export async function protectedSourcesFor(projectPaths: string[]): Promise<string[]> {
  const out = new Set<string>()
  for (const p of projectPaths) {
    try {
      const project = JSON.parse(await fs.readFile(p, 'utf-8')) as {
        assets?: { path?: string }[]
        tracks?: { clips?: { sourceOverride?: { path?: string; previewPath?: string } }[] }[]
      }
      for (const a of project.assets ?? []) if (a.path) out.add(a.path)
      // Baked stand-ins (e.g. background removed) are referenced directly; protect the files.
      for (const t of project.tracks ?? [])
        for (const c of t.clips ?? []) {
          if (c.sourceOverride?.path) out.add(c.sourceOverride.path)
          if (c.sourceOverride?.previewPath) out.add(c.sourceOverride.previewPath)
        }
    } catch {
      // Missing/corrupt project file: nothing to protect from it.
    }
  }
  return [...out]
}

/**
 * Dedupes concurrent builds of the same entry (e.g. one asset used by several clips, or the bin and
 * the timeline both asking at once), so only one ffmpeg job ever runs per key.
 */
const inFlight = new Map<string, Promise<unknown>>()
export function dedupe<T>(key: string, build: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined
  if (existing) return existing
  const p = build().finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

export interface CacheUsage {
  root: string
  kinds: Record<CacheKind, { files: number; bytes: number }>
  totalBytes: number
}

/** Sizes of each cache kind, for the Inspector's storage readout. */
export async function cacheUsage(): Promise<CacheUsage> {
  const kinds = {} as CacheUsage['kinds']
  let totalBytes = 0
  for (const kind of CACHE_KINDS) {
    let files = 0
    let bytes = 0
    const names = await fs.readdir(cacheDir(kind)).catch(() => [] as string[])
    for (const name of names) {
      const st = await fs.stat(path.join(cacheDir(kind), name)).catch(() => null)
      if (st?.isFile()) {
        files++
        bytes += st.size
      }
    }
    kinds[kind] = { files, bytes }
    totalBytes += bytes
  }
  return { root: cacheRoot(), kinds, totalBytes }
}

/**
 * Deletes cache entries not used in `maxAgeDays`, except entries whose source path is in
 * `protectedSources`. CapCut calls this "draft protection": the media of open/recent projects is
 * never evicted. With `maxAgeDays = 0` everything unprotected is removed ("Clear cache").
 * Works per entry: an entry's files share a `<key>` prefix and its meta sidecar names the source.
 */
export async function cleanCache(maxAgeDays: number, protectedSources: string[] = []): Promise<{ removedFiles: number; freedBytes: number }> {
  const protectedSet = new Set(protectedSources)
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  let removedFiles = 0
  let freedBytes = 0

  for (const kind of CACHE_KINDS) {
    const dir = cacheDir(kind)
    const names = await fs.readdir(dir).catch(() => [] as string[])
    // Group files by entry key (everything before the first '.').
    const groups = new Map<string, string[]>()
    for (const name of names) {
      const key = name.split('.')[0]
      if (!key) continue
      const list = groups.get(key) ?? []
      list.push(name)
      groups.set(key, list)
    }

    for (const [key, files] of groups) {
      const meta = await readJsonEntry<SourceStamp>(path.join(dir, `${key}.meta.json`)).catch(() => null)
      // Protected if built from protected media, OR if one of its own files is referenced directly
      // (a clip's sourceOverride points at a cached bake).
      if (meta && protectedSet.has(meta.path)) continue
      if (files.some((f) => protectedSet.has(path.join(dir, f)))) continue

      // Newest mtime across the entry's files = last time it was built or used.
      let newest = 0
      let bytes = 0
      for (const f of files) {
        const st = await fs.stat(path.join(dir, f)).catch(() => null)
        if (!st) continue
        newest = Math.max(newest, st.mtimeMs)
        bytes += st.size
      }
      // Recently built or used: keep (unless this is a full clear, maxAgeDays = 0).
      if (maxAgeDays > 0 && newest > cutoff) continue

      for (const f of files) {
        await fs.unlink(path.join(dir, f)).catch(() => {})
        removedFiles++
      }
      freedBytes += bytes
    }
  }
  return { removedFiles, freedBytes }
}
