import { useEffect, useState } from 'react'
import { useProjectStore } from '../state/projectStore'
import { useToastStore } from '../state/toastStore'
import type { BackgroundStatus } from '@shared/ipc'
import type { MediaClip } from '@shared/types'

/**
 * Removes a clip's background locally (ONNX matting) and applies the result to THIS clip only, the
 * way CapCut swaps a timeline material's path to a baked cache file while the media-bin entry keeps
 * the original. The bake is a ProRes 4444 .mov (export) plus a VP9+alpha WebM (preview), both cached
 * by source, so re-applying on the same footage is instant. "Restore original" clears the override.
 *
 * Needs the optional onnxruntime-node runtime and a one-time model download, and degrades with
 * guidance when either is missing.
 */
export default function BackgroundRemovalButton({ clip, assetPath }: { clip: MediaClip; assetPath: string }) {
  const pushToast = useToastStore((s) => s.push)
  const setClipSourceOverride = useProjectStore((s) => s.setClipSourceOverride)
  const [status, setStatus] = useState<BackgroundStatus | null>(null)
  const [busy, setBusy] = useState<'idle' | 'checking' | 'downloading' | 'running'>('checking')
  const [progress, setProgress] = useState(0)

  async function refresh() {
    setBusy('checking')
    setStatus(await window.api.backgroundStatus())
    setBusy('idle')
  }
  useEffect(() => {
    void refresh()
  }, [])

  async function handleDownload() {
    setBusy('downloading')
    const res = await window.api.downloadBackgroundModel()
    if (!res.ok) pushToast('error', `Couldn't download the matting model: ${res.error ?? 'unknown error'}`)
    await refresh()
  }

  async function handleRun() {
    setBusy('running')
    setProgress(0)
    const unsubscribe = window.api.onBackgroundProgress(setProgress)
    const res = await window.api.removeBackground(assetPath)
    unsubscribe()
    setBusy('idle')
    if (!res.ok || !res.outputPath) {
      pushToast('error', `Background removal failed: ${res.error ?? 'unknown error'}`)
      return
    }
    setClipSourceOverride(clip.id, { path: res.outputPath, previewPath: res.previewPath, kind: 'backgroundRemoved', hasAlpha: true })
    pushToast('info', 'Background removed. Put this clip on an upper video track to composite it over another one.')
  }

  const applied = clip.sourceOverride?.kind === 'backgroundRemoved'

  return (
    <div className="field-row">
      <label>Background removal (beta)</label>
      {applied ? (
        <button style={{ width: '100%' }} onClick={() => setClipSourceOverride(clip.id, undefined)}>
          Restore original background
        </button>
      ) : (
        <>
          {busy === 'checking' && <div className="empty-hint">Checking local ML runtime…</div>}
          {status && !status.runtimeAvailable && <div className="empty-hint">{status.installHint ?? 'Local ML runtime not installed.'}</div>}
          {status && status.runtimeAvailable && !status.modelDownloaded && (
            <button style={{ width: '100%' }} disabled={busy === 'downloading'} onClick={handleDownload}>
              {busy === 'downloading' ? 'Downloading model…' : 'Download matting model (4.6 MB)'}
            </button>
          )}
          {status && status.runtimeAvailable && status.modelDownloaded && (
            <button style={{ width: '100%' }} disabled={busy === 'running'} onClick={handleRun}>
              {busy === 'running' ? `Removing background… ${Math.round(progress * 100)}%` : 'Remove background'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
