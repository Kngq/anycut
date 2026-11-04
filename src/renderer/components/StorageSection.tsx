import { useEffect, useState } from 'react'
import type { CacheUsage } from '@shared/ipc'
import { useProjectStore } from '../state/projectStore'
import { useRecentsStore } from '../state/recentsStore'
import { useToastStore } from '../state/toastStore'
import { refreshAsset } from '../media'

const LABELS: Record<keyof CacheUsage['kinds'], string> = {
  proxies: 'Preview proxies',
  remux: 'Remuxed media',
  thumbnails: 'Filmstrips',
  waveforms: 'Waveforms',
  mediainfo: 'Media info',
  mattes: 'Background removals'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/**
 * Cache readout + controls (Inspector → Project). Everything here is derived data that can be
 * regenerated from the source media, so clearing it never loses work. Media used by the open
 * project and recent projects is protected, so clearing doesn't force a regenerate the moment
 * you reopen them.
 */
export default function StorageSection() {
  const [usage, setUsage] = useState<CacheUsage | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setUsage(await window.api.cacheUsage())
  }
  useEffect(() => {
    void refresh()
  }, [])

  async function handleClear() {
    setBusy(true)
    const recents = useRecentsStore.getState().recents.map((r) => r.path)
    const project = useProjectStore.getState().project
    const open = [
      ...project.assets.map((a) => a.path),
      ...project.tracks.flatMap((t) =>
        t.clips.flatMap((c) => (c.kind === 'media' && c.sourceOverride ? [c.sourceOverride.path, c.sourceOverride.previewPath ?? ''].filter(Boolean) : []))
      )
    ]
    const res = await window.api.cleanCache(0, recents, open)
    // Re-derive anything the open project still needs (protected entries survived, so this is cheap).
    for (const a of useProjectStore.getState().project.assets) void refreshAsset(a)
    await refresh()
    setBusy(false)
    useToastStore.getState().push('info', `Freed ${formatBytes(res.freedBytes)} of cached media (${res.removedFiles} files). Media used by open and recent projects was kept.`)
  }

  return (
    <div className="storage-section">
      <div className="storage-row">
        <span>Cache</span>
        <strong>{usage ? formatBytes(usage.totalBytes) : '…'}</strong>
      </div>
      {usage &&
        (Object.keys(LABELS) as (keyof CacheUsage['kinds'])[])
          .filter((k) => usage.kinds[k].files > 0)
          .map((k) => (
            <div className="storage-row" key={k}>
              <span>{LABELS[k]}</span>
              <span>{formatBytes(usage.kinds[k].bytes)}</span>
            </div>
          ))}
      <div className="storage-actions">
        <button disabled={busy} onClick={handleClear}>
          {busy ? 'Clearing…' : 'Clear cache'}
        </button>
        <button onClick={() => void window.api.revealCache()}>Show in Finder</button>
      </div>
      <div className="empty-hint" style={{ padding: '6px 0 0' }}>
        Unused cache older than 30 days is cleaned automatically.
      </div>
    </div>
  )
}
