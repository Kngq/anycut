import { useEffect, useState } from 'react'
import { useProjectStore } from '../state/projectStore'
import { useToastStore } from '../state/toastStore'
import type { BackgroundStatus, MattingModelId } from '@shared/ipc'
import type { MediaClip } from '@shared/types'

/**
 * Removes a clip's background locally (ONNX matting) and applies the result to THIS clip only, the
 * way CapCut swaps a timeline material's path to a baked cache file while the media-bin entry keeps
 * the original. The bake is a ProRes 4444 .mov (export) plus a VP9+alpha WebM (preview), both cached
 * by source, so re-applying on the same footage is instant. "Restore original" clears the override.
 *
 * Two models: People (MODNet, 25 MB, fast) and Any subject (ISNet, 170 MB, ~7x slower). Every frame
 * of the clip is matted. Needs the optional onnxruntime-node runtime and a one-time download per
 * model, and degrades with guidance when either is missing.
 */
const MODEL_PREF_KEY = 'anycut.bgModel'

function loadModelPref(): MattingModelId {
  try {
    return localStorage.getItem(MODEL_PREF_KEY) === 'general' ? 'general' : 'person'
  } catch {
    return 'person'
  }
}

export default function BackgroundRemovalButton({ clip, assetPath }: { clip: MediaClip; assetPath: string }) {
  const pushToast = useToastStore((s) => s.push)
  const setClipSourceOverride = useProjectStore((s) => s.setClipSourceOverride)
  const [status, setStatus] = useState<BackgroundStatus | null>(null)
  const [busy, setBusy] = useState<'idle' | 'checking' | 'downloading' | 'running'>('checking')
  const [progress, setProgress] = useState(0)
  const [modelId, setModelId] = useState<MattingModelId>(loadModelPref)

  async function refresh() {
    setBusy('checking')
    setStatus(await window.api.backgroundStatus())
    setBusy('idle')
  }
  useEffect(() => {
    void refresh()
  }, [])

  function chooseModel(id: MattingModelId) {
    setModelId(id)
    try {
      localStorage.setItem(MODEL_PREF_KEY, id)
    } catch {
      // Preference only; fine to lose.
    }
  }

  async function handleDownload() {
    setBusy('downloading')
    setProgress(0)
    const unsubscribe = window.api.onBackgroundProgress(setProgress)
    const res = await window.api.downloadBackgroundModel(modelId)
    unsubscribe()
    if (!res.ok) pushToast('error', `Couldn't download the matting model: ${res.error ?? 'unknown error'}`)
    await refresh()
  }

  async function handleRun() {
    setBusy('running')
    setProgress(0)
    const unsubscribe = window.api.onBackgroundProgress(setProgress)
    const res = await window.api.removeBackground(assetPath, modelId)
    unsubscribe()
    setBusy('idle')
    if (!res.ok || !res.outputPath) {
      pushToast('error', `Background removal failed: ${res.error ?? 'unknown error'}`)
      return
    }
    setClipSourceOverride(clip.id, { path: res.outputPath, previewPath: res.previewPath, kind: 'backgroundRemoved', hasAlpha: true })
    pushToast('info', 'Background removed. Put this clip on an upper video track to composite it over another one.')
  }

  // Also "applied" when a motion blur was baked on top of the background-removed file; restoring
  // the original background then drops both (re-running removal replaces any override).
  const o = clip.sourceOverride
  const applied = o?.kind === 'backgroundRemoved' || o?.motionBlur?.base?.kind === 'backgroundRemoved'
  const model = status?.models.find((m) => m.id === modelId)
  const pct = Math.round(progress * 100)

  return (
    <div className="field-row">
      <label>Background removal</label>
      {applied ? (
        <button style={{ width: '100%' }} onClick={() => setClipSourceOverride(clip.id, undefined)}>
          Restore original background
        </button>
      ) : (
        <>
          {busy === 'checking' && !status && <div className="empty-hint">Checking local ML runtime…</div>}
          {status && !status.runtimeAvailable && <div className="empty-hint">{status.installHint ?? 'Local ML runtime not installed.'}</div>}
          {status && status.runtimeAvailable && (
            <>
              <div className="seg-control" role="radiogroup" aria-label="Subject">
                {status.models.map((m) => (
                  <button
                    key={m.id}
                    role="radio"
                    aria-checked={m.id === modelId}
                    className={m.id === modelId ? 'active' : ''}
                    disabled={busy === 'running' || busy === 'downloading'}
                    onClick={() => chooseModel(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {model && <div className="seg-hint">{model.description}</div>}
              {model && !model.downloaded && (
                <button style={{ width: '100%' }} disabled={busy === 'downloading'} onClick={handleDownload}>
                  {busy === 'downloading' ? `Downloading model… ${pct}%` : `Download ${model.label} model (${model.sizeMB} MB)`}
                </button>
              )}
              {model && model.downloaded && (
                <button className="btn-primary" style={{ width: '100%' }} disabled={busy === 'running'} onClick={handleRun}>
                  {busy === 'running' ? `Removing background… ${pct}%` : 'Remove background'}
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
