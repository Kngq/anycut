import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Missing-media detection + relink. Like CapCut, anycut references media by absolute path and
 * never copies it into the project, so a moved/renamed/unplugged source makes an asset go
 * "offline". On project open the renderer asks which asset paths no longer exist. The user then
 * locates ONE file, and the rest are searched for by filename in that same folder (and one level
 * of its subfolders). That's the common "I moved the whole footage folder" case CapCut's relink
 * handles.
 */

/** Returns the subset of `paths` that don't exist as files right now. */
export async function findMissing(paths: string[]): Promise<string[]> {
  const results = await Promise.all(
    paths.map(async (p) => {
      const st = await fs.stat(p).catch(() => null)
      return st && st.isFile() ? null : p
    })
  )
  return results.filter((p): p is string => p !== null)
}

/**
 * Given the folder the user just located one file in, finds replacements for the other missing
 * paths by matching basenames (case-insensitive) in that folder and its immediate subfolders.
 * Returns oldPath → newPath for every match it's confident about (exactly one candidate).
 */
export async function autoRelink(missing: string[], folder: string): Promise<Record<string, string>> {
  const index = new Map<string, string[]>()
  async function addDir(dir: string, depth: number) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isFile()) {
        const k = e.name.toLowerCase()
        index.set(k, [...(index.get(k) ?? []), full])
      } else if (e.isDirectory() && depth > 0 && !e.name.startsWith('.')) {
        await addDir(full, depth - 1)
      }
    }
  }
  await addDir(folder, 1)

  const out: Record<string, string> = {}
  for (const oldPath of missing) {
    const candidates = index.get(path.basename(oldPath).toLowerCase()) ?? []
    if (candidates.length === 1) out[oldPath] = candidates[0]
  }
  return out
}
