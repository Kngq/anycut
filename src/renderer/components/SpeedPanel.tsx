import { useState } from 'react'
import type { MediaClip, SpeedKeyframe } from '@shared/types'
import { effectiveDuration } from '@shared/types'

/**
 * The "Speed" inspector tab, styled to the dark/flat CapCut-like spec:
 *  - a pill sub-tab row (Standard / Curve [badge] / Velocity effects),
 *  - a Speed slider with evenly-spaced tick marks + a numeric stepper box,
 *  - a Duration slider (dashed track + arrow handle) + stepper box,
 *  - a "Change audio pitch" toggle,
 *  - a disabled/locked "Smooth slow-mo" premium row.
 *
 * Standard and Curve both drive the real speed model (flat speed vs. speed keyframes). Velocity
 * effects is a placeholder sub-tab. Duration is derived from speed (speed = sourceLen / duration),
 * so editing either end adjusts the clip's flat speed.
 */
export default function SpeedPanel({
  clip,
  onSpeed,
  onSpeedKeyframes,
  onReversed,
  onChangeAudioPitch
}: {
  clip: MediaClip
  onSpeed: (speed: number) => void
  onSpeedKeyframes: (kfs: SpeedKeyframe[] | undefined) => void
  onReversed: (reversed: boolean) => void
  onChangeAudioPitch: (v: boolean) => void
}) {
  const hasCurve = (clip.speedKeyframes?.length ?? 0) >= 2
  const curve = clip.speedKeyframes ?? []
  const [sub, setSub] = useState<'standard' | 'curve' | 'velocity'>(hasCurve ? 'curve' : 'standard')

  // Source length of the trimmed region (seconds), and the current timeline duration.
  const sourceLen = Math.max(0.01, clip.trimOut - clip.trimIn)
  const duration = effectiveDuration(clip)

  const SPEED_MIN = 0.1
  const SPEED_MAX = 4

  function selectSub(next: 'standard' | 'curve' | 'velocity') {
    setSub(next)
    if (next === 'standard' && hasCurve) onSpeedKeyframes(undefined)
    if (next === 'curve' && !hasCurve) {
      onSpeedKeyframes([
        { time: clip.trimIn, speed: clip.speed },
        { time: clip.trimOut, speed: clip.speed }
      ])
    }
  }

  function setDurationSeconds(sec: number) {
    const clamped = Math.max(sourceLen / SPEED_MAX, Math.min(sourceLen / SPEED_MIN, sec))
    onSpeed(sourceLen / clamped)
  }

  function updateCurve(next: SpeedKeyframe[]) {
    onSpeedKeyframes(next)
  }

  return (
    <div className="speed-panel">
      {/* Sub-tab pill row */}
      <div className="speed-subtabs">
        <button className={`speed-subtab ${sub === 'standard' ? 'active' : ''}`} onClick={() => selectSub('standard')}>
          Standard
        </button>
        <button className={`speed-subtab ${sub === 'curve' ? 'active' : ''}`} onClick={() => selectSub('curve')}>
          Curve
          <span className="speed-badge">3 uses</span>
        </button>
        <button className={`speed-subtab ${sub === 'velocity' ? 'active' : ''}`} onClick={() => selectSub('velocity')}>
          Velocity effects
        </button>
      </div>

      {sub === 'curve' ? (
        <div className="speed-section">
          <div className="speed-label">Speed curve (source time → speed)</div>
          {curve.map((kf, i) => (
            <div key={i} className="speed-curve-row">
              <input
                type="number"
                step={0.1}
                value={kf.time}
                title="Source-relative time (seconds)"
                onChange={(e) => {
                  const next = [...curve]
                  next[i] = { ...next[i], time: Number(e.target.value) }
                  updateCurve(next)
                }}
              />
              <input
                type="number"
                step={0.05}
                min={SPEED_MIN}
                max={SPEED_MAX}
                value={kf.speed}
                title="Speed multiplier"
                onChange={(e) => {
                  const next = [...curve]
                  next[i] = { ...next[i], speed: Number(e.target.value) }
                  updateCurve(next)
                }}
              />
              <button disabled={curve.length <= 2} title="Remove point" onClick={() => updateCurve(curve.filter((_, idx) => idx !== i))}>
                ×
              </button>
            </div>
          ))}
          <button
            className="speed-add-point"
            onClick={() => {
              const a = curve[curve.length - 2]
              const b = curve[curve.length - 1]
              updateCurve([...curve, { time: (a.time + b.time) / 2, speed: (a.speed + b.speed) / 2 }])
            }}
          >
            + Add point
          </button>
        </div>
      ) : sub === 'velocity' ? (
        <div className="speed-section">
          <div className="empty-hint">Velocity effects are coming soon.</div>
        </div>
      ) : (
        <>
          {/* Speed */}
          <div className="speed-section">
            <div className="speed-label">Speed</div>
            <div className="speed-control">
              <div className="speed-slider-wrap">
                <input
                  className="speed-slider ticks"
                  type="range"
                  min={SPEED_MIN}
                  max={SPEED_MAX}
                  step={0.05}
                  value={clip.speed}
                  onChange={(e) => onSpeed(Number(e.target.value))}
                />
                <div className="speed-ticks" aria-hidden="true">
                  {[0, 1, 2, 3, 4].map((t) => (
                    <span key={t} className="speed-tick" />
                  ))}
                </div>
              </div>
              <NumberStepper value={clip.speed} suffix="x" step={0.05} min={SPEED_MIN} max={SPEED_MAX} onChange={onSpeed} />
            </div>
          </div>

          {/* Duration */}
          <div className="speed-section">
            <div className="speed-label">Duration</div>
            <div className="speed-subvalue">{duration.toFixed(1)}s</div>
            <div className="speed-control">
              <div className="speed-slider-wrap">
                <input
                  className="speed-slider dashed"
                  type="range"
                  min={sourceLen / SPEED_MAX}
                  max={sourceLen / SPEED_MIN}
                  step={0.1}
                  value={duration}
                  onChange={(e) => setDurationSeconds(Number(e.target.value))}
                />
              </div>
              <NumberStepper value={duration} suffix="s" step={0.1} min={sourceLen / SPEED_MAX} max={sourceLen / SPEED_MIN} onChange={setDurationSeconds} digits={1} />
            </div>
          </div>

          {/* Change audio pitch toggle */}
          <div className="speed-toggle-row">
            <span className="speed-label">Change audio pitch</span>
            <button
              className={`toggle-switch ${clip.changeAudioPitch ? 'on' : ''}`}
              role="switch"
              aria-checked={!!clip.changeAudioPitch}
              onClick={() => onChangeAudioPitch(!clip.changeAudioPitch)}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          {/* Reversed (kept from the real model) */}
          <div className="speed-toggle-row">
            <span className="speed-label">Reverse</span>
            <button
              className={`toggle-switch ${clip.reversed ? 'on' : ''}`}
              role="switch"
              aria-checked={clip.reversed}
              onClick={() => onReversed(!clip.reversed)}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          {/* Disabled/locked premium row */}
          <div className="speed-locked-row">
            <span className="speed-checkbox" aria-hidden="true" />
            <span className="speed-locked-label">Smooth slow-mo</span>
            <span className="speed-gem" title="Premium feature">◆</span>
            <span className="speed-locked-help">Only slow-speed videos are supported. ⌄</span>
          </div>
        </>
      )}
    </div>
  )
}

/** Dark rounded numeric box + stacked up/down chevron stepper, matching the spec. */
function NumberStepper({
  value,
  suffix,
  step,
  min,
  max,
  digits = 2,
  onChange
}: {
  value: number
  suffix: string
  step: number
  min: number
  max: number
  digits?: number
  onChange: (v: number) => void
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v))
  return (
    <div className="num-stepper">
      <span className="num-stepper-value">
        {value.toFixed(digits)}
        {suffix}
      </span>
      <div className="num-stepper-buttons">
        <button title="Increase" onClick={() => onChange(clamp(value + step))}>⌃</button>
        <button title="Decrease" onClick={() => onChange(clamp(value - step))}>⌄</button>
      </div>
    </div>
  )
}
