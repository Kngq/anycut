import { create } from 'zustand'
import type { ExportProgress } from '@shared/ipc'
import type { Project } from '@shared/types'
import { bakeTextOverlay } from './textOverlay'

/** One export at a time; the Toolbar shows its progress whoever started it. */
interface ExportStatus {
  running: boolean
  progress: ExportProgress | null
  /** What's being exported ("Export", "Exporting selected clips", "Creating compound clip"). */
  label: string
}

export const useExportStatus = create<ExportStatus>(() => ({ running: false, progress: null, label: '' }))

let listening = false
function ensureProgressListener() {
  if (listening) return
  listening = true
  window.api.onExportProgress((p) => {
    if (!useExportStatus.getState().running) return
    // Text baking took the first 30 %; ffmpeg reports 0..1 for the encode.
    useExportStatus.setState({ progress: { ratio: 0.3 + p.ratio * 0.7, message: p.message } })
  })
}

/**
 * Renders `project` (optionally only [range.start, range.end)) to `outputPath`: text is baked
 * by the preview's renderer first, then ffmpeg encodes. Resolves with the result; never throws.
 */
export async function runExport(
  project: Project,
  outputPath: string,
  label: string,
  range?: { start: number; end: number }
): Promise<{ ok: boolean; outputPath?: string; error?: string }> {
  if (useExportStatus.getState().running) return { ok: false, error: 'Another export is already running.' }
  ensureProgressListener()
  useExportStatus.setState({ running: true, label, progress: { ratio: 0, message: 'Starting…' } })
  try {
    let overlayId: string | null = null
    try {
      overlayId = await bakeTextOverlay(project, (r) => useExportStatus.setState({ progress: { ratio: r * 0.3, message: `Rendering text… ${Math.round(r * 100)}%` } }))
    } catch (err) {
      return { ok: false, error: `rendering text failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    const result = await window.api.exportProject(project, outputPath, overlayId ?? undefined, range)
    return result.ok ? { ok: true, outputPath: result.outputPath ?? outputPath } : { ok: false, error: result.error }
  } finally {
    useExportStatus.setState({ running: false, progress: null, label: '' })
  }
}
