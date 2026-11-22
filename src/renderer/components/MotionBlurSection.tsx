import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../state/projectStore'
import { useToastStore } from '../state/toastStore'
import Slider from './Slider'
import { MOTION_BLUR_DEFAULTS, MOTION_BLUR_TIMES, motionBlurInput } from '@shared/motionBlur'
import type { MediaClip, MotionBlurSettings, SourceOverride } from '@shared/types'

/**
 * Video > Motion blur (CapCut's "Motion blur" section): Blur / Blend / Direction / Times, then
 * Apply bakes the clip offline (electron/main/motionBlur.ts: optical-flow sub-frames + a virtual
 * shutter) and swaps THIS clip's source to the bake via `sourceOverride`, like background removal.
 * The preview simply plays the baked file. When the clip already has a background-removed bake,
 * that is what gets blurred (alpha kept), and "Remove motion blur" restores it.
 */
const DIRECTIONS: { id: MotionBlurSettings['direction']; label: string }[] = [
  { id: 'both', label: 'Both' },
  { id: 'forward', label: 'Forward' },
  { id: 'backward', label: 'Backward' }
]
/** Text segments: share the row instead of the icon toggles' fixed 34 px. */
const SEG_BTN = { width: 'auto', flex: 1, minWidth: 0, padding: '0 2px', fontSize: 11, whiteSpace: 'nowrap' } as const
const TIMES_LABEL: Record<MotionBlurSettings['times'], string> = { 1: 'Once', 2: 'Twice', 4: '4 times', 6: '6 times' }

export default function MotionBlurSection({ clip, assetPath }: { clip: MediaClip; assetPath: string }) {
  const pushToast = useToastStore((s) => s.push)
  const setClipSourceOverride = useProjectStore((s) => s.setClipSourceOverride)
  const applied = clip.sourceOverride?.kind === 'motionBlur' ? clip.sourceOverride.motionBlur : undefined
  const [settings, setSettings] = useState<MotionBlurSettings>(() => pick(applied))
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const cancelled = useRef(false)

  // Selecting another clip shows that clip's applied settings (or the defaults).
  useEffect(() => setSettings(pick(applied)), [clip.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<MotionBlurSettings>) => setSettings((s) => ({ ...s, ...patch }))
  const dirty = !applied || (Object.keys(MOTION_BLUR_DEFAULTS) as (keyof MotionBlurSettings)[]).some((k) => applied[k] !== settings[k])

  async function apply() {
    const clipId = clip.id
    const { path, base } = motionBlurInput(clip.sourceOverride, assetPath)
    cancelled.current = false
    setRunning(true)
    setProgress(0)
    const unsubscribe = window.api.onMotionBlurProgress(setProgress)
    const res = await window.api.motionBlur(path, settings).finally(unsubscribe)
    setRunning(false)
    if (res.cancelled || cancelled.current) {
      pushToast('info', 'Motion blur canceled')
      return
    }
    if (!res.ok || !res.outputPath) {
      console.error('[anycut] motion blur failed:', res.error)
      pushToast('error', 'Couldn’t apply Motion blur. Try again.')
      return
    }
    setClipSourceOverride(clipId, {
      path: res.outputPath,
      previewPath: res.previewPath,
      kind: 'motionBlur',
      hasAlpha: !!res.hasAlpha,
      motionBlur: { ...settings, base }
    })
    pushToast('info', 'Motion blur applied')
  }

  function cancel() {
    cancelled.current = true
    void window.api.cancelMotionBlur()
  }

  function remove() {
    setClipSourceOverride(clip.id, applied?.base)
  }

  const pct = Math.round(progress * 100)
  const unit = { format: (v: number) => String(Math.round(v)) }
  return (
    <>
      <div className="empty-hint">Motion blur uses an optical flow to create an apparent streaking of moving objects in a video.</div>
      <div className="field-row prop-row">
        <label>Blur</label>
        <Slider min={0} max={100} step={1} value={settings.blur} disabled={running} onChange={(v) => set({ blur: Math.round(v) })} valueBox={unit} />
      </div>
      <div className="field-row prop-row">
        <label>Blend</label>
        <Slider min={0} max={100} step={1} value={settings.blend} disabled={running} onChange={(v) => set({ blend: Math.round(v) })} valueBox={unit} />
      </div>
      <div className="field-row prop-row">
        <label>Direction</label>
        <div className="toggle-group" style={{ gap: 4 }} role="radiogroup" aria-label="Direction">
          {DIRECTIONS.map((d) => (
            <button
              key={d.id}
              role="radio"
              aria-checked={settings.direction === d.id}
              className={`toggle-btn ${settings.direction === d.id ? 'active' : ''}`}
              style={SEG_BTN}
              disabled={running}
              onClick={() => set({ direction: d.id })}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field-row prop-row">
        <label>Times</label>
        <div className="toggle-group" style={{ gap: 4 }} role="radiogroup" aria-label="Times">
          {MOTION_BLUR_TIMES.map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={settings.times === t}
              className={`toggle-btn ${settings.times === t ? 'active' : ''}`}
              style={SEG_BTN}
              disabled={running}
              onClick={() => set({ times: t })}
            >
              {TIMES_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      {running ? (
        <div className="field-row prop-row">
          <label>Applying motion blur... {pct}%</label>
          <button onClick={cancel}>Cancel</button>
        </div>
      ) : (
        <div className="field-row" style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" style={{ flex: 1 }} disabled={!dirty} onClick={() => void apply()}>
            {applied ? 'Apply changes' : 'Apply'}
          </button>
          {applied && (
            <button style={{ flex: 1 }} onClick={remove}>
              Remove motion blur
            </button>
          )}
        </div>
      )}
    </>
  )
}

function pick(applied: SourceOverride['motionBlur']): MotionBlurSettings {
  if (!applied) return { ...MOTION_BLUR_DEFAULTS }
  return { blur: applied.blur, blend: applied.blend, direction: applied.direction, times: applied.times }
}
