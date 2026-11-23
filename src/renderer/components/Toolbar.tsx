import { useProjectStore } from '../state/projectStore'
import { loadOpenedProject, saveProject } from '../projectIO'
import { ASPECT_PRESETS, aspectPresetFor } from '@shared/types'
import { runExport, useExportStatus } from '../export/runExport'
import logoUrl from '../assets/logo.png'
import { useToastStore } from '../state/toastStore'

export default function Toolbar({ onGoHome }: { onGoHome: () => void }) {
  const project = useProjectStore((s) => s.project)
  const dirty = useProjectStore((s) => s.dirty)
  const addTextClipToTrack = useProjectStore((s) => s.addTextClipToTrack)
  const setCanvasSize = useProjectStore((s) => s.setCanvasSize)
  const playhead = useProjectStore((s) => s.playhead)
  const newProject = useProjectStore((s) => s.newProject)

  const exporting = useExportStatus((s) => s.running)
  const exportState = useExportStatus((s) => s.progress)
  const exportLabel = useExportStatus((s) => s.label)

  async function handleNew() {
    if (dirty && !confirm('Discard unsaved changes and start a new project?')) return
    newProject()
    void window.api.lockProject(null)
  }

  function handleGoHome() {
    if (dirty && !confirm('Discard unsaved changes and go back to Home?')) return
    onGoHome()
  }

  async function handleOpen() {
    const result = await window.api.openProjectDialog()
    if (!result) return
    loadOpenedProject(result)
  }

  async function handleSave() {
    await saveProject(false)
  }

  async function handleSaveAs() {
    await saveProject(true)
  }

  async function handleExport() {
    const path = await window.api.exportDialog(project.name)
    if (!path) return
    const result = await runExport(project, path, 'Export')
    const toast = useToastStore.getState().push
    if (!result.ok) {
      toast('error', `Export failed: ${result.error}`, 12000)
      return
    }
    // Tell the user it's done and where it went (CapCut shows a finished card with "Open folder").
    const saved = result.outputPath ?? path
    const name = saved.split(/[\\/]/).pop() ?? saved
    const where = navigator.platform.toLowerCase().includes('mac') ? 'Show in Finder' : 'Show in folder'
    toast('success', `Video exported: "${name}" was saved.`, 12000, { label: where, run: () => void window.api.showInFolder(saved) })
  }

  function addText() {
    const textTrack = project.tracks.find((t) => t.type === 'text')
    if (textTrack) addTextClipToTrack(textTrack.id, playhead)
  }

  return (
    <div className="toolbar">
      <button onClick={handleGoHome}>Home</button>
      <span className="title">
        <img className="title-logo" src={logoUrl} alt="anycut" width={18} height={18} />
        {project.name}
        {dirty ? ' *' : ''}
      </span>
      <button onClick={handleNew}>New</button>
      <button onClick={handleOpen}>Open</button>
      <button onClick={handleSave}>Save</button>
      <button onClick={handleSaveAs}>Save As</button>
      <button onClick={addText}>+ Text</button>
      <span style={{ width: 1, background: 'var(--border)', height: 20, margin: '0 4px' }} />
      <label style={{ color: 'var(--text-dim)', fontSize: 12 }}>Aspect</label>
      <select
        value={aspectPresetFor(project.canvas.width, project.canvas.height)?.id ?? 'custom'}
        title="Output aspect ratio / resolution"
        onChange={(e) => {
          const preset = ASPECT_PRESETS.find((p) => p.id === e.target.value)
          if (preset) setCanvasSize(preset.width, preset.height)
        }}
      >
        {!aspectPresetFor(project.canvas.width, project.canvas.height) && (
          <option value="custom">
            Custom ({project.canvas.width}×{project.canvas.height})
          </option>
        )}
        {ASPECT_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <span className="spacer" />
      {exporting && exportState && (
        <>
          <span>{exportLabel && exportLabel !== 'Export' ? `${exportLabel}: ` : ''}{exportState.message}</span>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${Math.round(exportState.ratio * 100)}%` }} />
          </div>
        </>
      )}
      <button className="btn-primary" onClick={handleExport} disabled={exporting}>
        Export MP4
      </button>
    </div>
  )
}
