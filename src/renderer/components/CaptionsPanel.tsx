import { useEffect, useState } from 'react'
import { useBinRequest } from '../state/layoutStore'
import { useProjectStore } from '../state/projectStore'
import { useToastStore } from '../state/toastStore'
import type { CaptionProgress, CaptionStatus } from '@shared/ipc'
import {
  CAPTION_LANGUAGES,
  DEFAULT_SEGMENT_OPTIONS,
  captionLinesFor,
  captionMaxChars,
  captionSources,
  captionStyleOf,
  defaultCaptionStyle,
  type CaptionScope
} from '@shared/captions'
import { CAPTION_TEMPLATES, captionTemplate, templateStyle } from '@shared/captionTemplates'
import CaptionTemplateTile from './CaptionTemplateTile'

/**
 * Auto captions: transcribes the chosen clips locally (Whisper in a utility process; see
 * electron/main/captions.ts), groups the words into short lines and puts them on a "Captions"
 * text track. Running it again replaces the previous captions but keeps their style.
 */
export default function CaptionsPanel() {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const setAutoCaptions = useProjectStore((s) => s.setAutoCaptions)
  const selectClip = useProjectStore((s) => s.selectClip)
  const applyCaptionTemplate = useProjectStore((s) => s.applyCaptionTemplate)
  const pushToast = useToastStore((s) => s.push)

  const [status, setStatus] = useState<CaptionStatus | null>(null)
  // The clip menu's "Transcript" opens this tab scoped to the selected clip.
  const [scope, setScope] = useState<CaptionScope>(() => (useBinRequest.getState().request?.captionScope === 'selected' ? 'selected' : 'main'))
  const binRequest = useBinRequest((s) => s.request)
  useEffect(() => {
    if (binRequest?.captionScope === 'selected') setScope('selected')
  }, [binRequest])
  const [language, setLanguage] = useState('auto')
  const [progress, setProgress] = useState<CaptionProgress | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    void window.api.captionStatus().then(setStatus)
    return window.api.onCaptionProgress(setProgress)
  }, [])

  const selected = project.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipId)
  const canUseSelected = selected?.kind === 'media'
  const effectiveScope: CaptionScope = scope === 'selected' && !canUseSelected ? 'main' : scope
  const { sources, skipped } = captionSources(project, effectiveScope, selectedClipId)
  const captionClips = project.tracks.flatMap((t) => t.clips).filter((c) => c.kind === 'text' && c.caption)
  // The template in use: the captions' own, else the one picked for the next run.
  const [pendingTemplate, setPendingTemplate] = useState('basic')
  const firstCaption = captionClips[0]
  const activeTemplate = firstCaption && firstCaption.kind === 'text' ? (firstCaption.look?.templateId ?? 'basic') : pendingTemplate

  function pickTemplate(id: string) {
    setPendingTemplate(id)
    if (captionClips.length > 0) applyCaptionTemplate(id)
  }

  async function generate() {
    if (sources.length === 0) return
    setRunning(true)
    setProgress(null)
    const res = await window.api.transcribeClips(sources, language)
    setRunning(false)
    setProgress(null)
    void window.api.captionStatus().then(setStatus)
    if (res.cancelled) return
    if (!res.ok || !res.results) {
      pushToast('error', `Couldn't generate captions: ${res.error ?? 'unknown error'}`)
      return
    }
    // Line length depends on the caption font size and the canvas width.
    const first = captionClips[0]
    const tpl = captionTemplate(pendingTemplate)
    const style = first && first.kind === 'text' ? captionStyleOf(first) : tpl ? templateStyle(tpl, project.canvas) : defaultCaptionStyle(project.canvas)
    const lines = captionLinesFor(useProjectStore.getState().project, res.results, {
      ...DEFAULT_SEGMENT_OPTIONS,
      maxChars: captionMaxChars(project.canvas, style.fontSize),
      fps: project.canvas.fps
    })
    if (lines.length === 0) {
      pushToast('info', 'No speech was found in the selected audio.')
      return
    }
    setAutoCaptions(lines, pendingTemplate)
    pushToast('info', `Added ${lines.length} caption${lines.length === 1 ? '' : 's'}.`)
  }

  const label = progressLabel(progress)
  const overall = progress ? (progress.phase === 'download' ? progress.ratio : (progress.clipIndex + (progress.phase === 'transcribe' ? progress.ratio : 0)) / progress.clipCount) : 0

  return (
    <div className="media-bin-body captions-panel">
      <h3>Auto captions</h3>
      <p className="captions-intro">Turns speech into captions on the timeline. Runs on this computer, so your audio is never uploaded.</p>

      <div className="field-row prop-row">
        <label>Caption</label>
        <select value={effectiveScope} disabled={running} onChange={(e) => setScope(e.target.value as CaptionScope)}>
          <option value="main">Main video track</option>
          <option value="all">All video and audio tracks</option>
          <option value="selected" disabled={!canUseSelected}>
            Selected clip{canUseSelected ? '' : ' (select a clip first)'}
          </option>
        </select>
      </div>

      <div className="field-row prop-row">
        <label>Language</label>
        <select value={language} disabled={running} onChange={(e) => setLanguage(e.target.value)}>
          {CAPTION_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      {running ? (
        <div className="captions-progress">
          <div className="captions-progress-label">{label}</div>
          <div className="progress-bar captions-progress-bar">
            <div className="progress-bar-fill" style={{ width: `${Math.round(overall * 100)}%` }} />
          </div>
          <button onClick={() => void window.api.cancelCaptions()}>Cancel</button>
        </div>
      ) : (
        <button className="captions-generate" disabled={sources.length === 0} onClick={() => void generate()}>
          {captionClips.length > 0 ? 'Generate again' : 'Generate captions'}
        </button>
      )}

      <h3 className="captions-section">Templates</h3>
      <div className="caption-templates">
        <CaptionTemplateTile id="basic" name="Basic" selected={activeTemplate === 'basic'} onPick={pickTemplate} />
        {CAPTION_TEMPLATES.map((t) => (
          <CaptionTemplateTile key={t.id} id={t.id} name={t.name} title={`Based on CapCut's ${t.basedOn}`} selected={activeTemplate === t.id} onPick={pickTemplate} />
        ))}
      </div>

      <div className="captions-notes">
        {sources.length === 0 && <div>Nothing to caption: add a clip with sound{effectiveScope === 'main' ? ' to the main video track' : ''}.</div>}
        {skipped.length > 0 && (
          <div>
            Skipping {skipped.length} clip{skipped.length === 1 ? '' : 's'} that {skipped.length === 1 ? 'is' : 'are'} {skippedReasons(skipped.map((s) => s.reason))}.
          </div>
        )}
        {captionClips.length > 0 && !running && (
          <div>
            Generating again replaces the {captionClips.length} current caption{captionClips.length === 1 ? '' : 's'} and keeps their style.{' '}
            <button className="link-button" onClick={() => selectClip(captionClips[0].id)}>
              Edit caption style
            </button>
          </div>
        )}
        {status && !status.modelDownloaded && (
          <div>
            The first run downloads the speech model ({status.modelName}, {status.modelSizeMB} MB) once. After that, captions work offline.
          </div>
        )}
      </div>
    </div>
  )
}

function progressLabel(p: CaptionProgress | null): string {
  if (!p) return 'Starting…'
  const clip = p.clipCount > 1 ? ` (clip ${p.clipIndex + 1} of ${p.clipCount})` : ''
  if (p.phase === 'download') return `Downloading speech model… ${Math.round(p.ratio * 100)}%`
  if (p.phase === 'extract') return `Reading audio${clip}…`
  return `Transcribing${clip}… ${Math.round(p.ratio * 100)}%`
}

function skippedReasons(reasons: string[]): string {
  const words = [...new Set(reasons)].map((r) => (r === 'muted' ? 'muted' : r === 'frozen' ? 'freeze frames' : 'reversed'))
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
}
