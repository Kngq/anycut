import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Slider from './Slider'
import type { MediaClip, Project, SpeedCurvePoint, SpeedKeyframe } from '@shared/types'
import { effectiveDuration, sourceTimeFor } from '@shared/types'
import {
  SPEED_CURVE_MAX,
  SPEED_CURVE_MIN,
  SPEED_CURVE_PRESETS,
  curvePointsFromKeyframes,
  evalSpeedCurve,
  graphYToSpeed,
  speedCurvePreset,
  speedToGraphY
} from '@shared/speedCurve'
import { useProjectStore } from '../state/projectStore'

/**
 * The "Speed" inspector tab, styled to the dark/flat CapCut-like spec:
 *  - a pill sub-tab row (Standard / Curve),
 *  - Standard: a Speed slider + stepper, a Duration slider + stepper, audio pitch + reverse toggles,
 *  - Curve: a preset strip (Custom, Montage, Hero, …) above an interactive speed-curve graph.
 *
 * Standard drives the clip's flat `speed`; Curve stores control points on the clip
 * (`speedCurvePoints`) and the store samples the smooth curve through them into
 * `speedKeyframes`, which is what preview and export actually play.
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
  const [sub, setSub] = useState<'standard' | 'curve'>(hasCurve ? 'curve' : 'standard')

  // Source length of the trimmed region (seconds), and the current timeline duration.
  const sourceLen = Math.max(0.01, clip.trimOut - clip.trimIn)
  const duration = effectiveDuration(clip)

  const SPEED_MIN = 0.1
  const SPEED_MAX = 4

  function selectSub(next: 'standard' | 'curve') {
    setSub(next)
    if (next === 'standard' && hasCurve) onSpeedKeyframes(undefined)
  }

  function setDurationSeconds(sec: number) {
    const clamped = Math.max(sourceLen / SPEED_MAX, Math.min(sourceLen / SPEED_MIN, sec))
    onSpeed(sourceLen / clamped)
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
        </button>
      </div>

      {sub === 'curve' ? (
        <SpeedCurveEditor clip={clip} />
      ) : (
        <>
          {/* Speed */}
          <div className="speed-section">
            <div className="speed-label">Speed</div>
            <div className="speed-control">
              <div className="speed-slider-wrap">
                <Slider className="speed-slider ticks" min={SPEED_MIN} max={SPEED_MAX} step={0.05} value={clip.speed} onChange={onSpeed} />
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
                <Slider className="speed-slider dashed" min={sourceLen / SPEED_MAX} max={sourceLen / SPEED_MIN} step={0.1} value={duration} onChange={setDurationSeconds} />
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
        </>
      )}
    </div>
  )
}

// ── Curve sub-tab ────────────────────────────────────────────────────────────

const GRAPH_H = 168
const PAD = { left: 34, right: 12, top: 12, bottom: 12 }
/** Minimum x gap kept between neighbouring control points while dragging. */
const MIN_GAP = 0.02

function SpeedCurveEditor({ clip }: { clip: MediaClip }) {
  const setClipSpeedCurve = useProjectStore((s) => s.setClipSpeedCurve)
  const recordUndoPoint = useProjectStore((s) => s.recordUndoPoint)
  const playhead = useProjectStore((s) => s.playhead)

  const hasCurve = (clip.speedKeyframes?.length ?? 0) >= 2
  // The control points the graph shows: stored ones, else recovered from a legacy keyframe list,
  // else a flat line at the clip's current speed (nothing is written until the user edits).
  const points: SpeedCurvePoint[] = useMemo(() => {
    if (hasCurve && clip.speedCurvePoints && clip.speedCurvePoints.length >= 2) return clip.speedCurvePoints
    if (hasCurve) return curvePointsFromKeyframes(clip.speedKeyframes!, clip.trimIn, clip.trimOut)
    return speedCurvePreset('custom')!.points.map((p) => ({ ...p, speed: clip.speed }))
  }, [hasCurve, clip.speedCurvePoints, clip.speedKeyframes, clip.trimIn, clip.trimOut, clip.speed])
  const preset = hasCurve ? clip.speedCurvePreset ?? 'custom' : undefined

  const [selected, setSelected] = useState<number | null>(null)
  useEffect(() => setSelected(null), [clip.id])
  const sel = selected !== null && selected < points.length ? selected : null

  // Graph width follows the panel.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(280)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setWidth(Math.max(160, el.clientWidth))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const plotW = width - PAD.left - PAD.right
  const plotH = GRAPH_H - PAD.top - PAD.bottom
  const toPx = (x: number) => PAD.left + x * plotW
  const toPy = (speed: number) => PAD.top + (1 - speedToGraphY(speed)) * plotH
  const fromPx = (px: number) => Math.min(1, Math.max(0, (px - PAD.left) / plotW))
  const fromPy = (py: number) => graphYToSpeed(1 - (py - PAD.top) / plotH)

  const write = (next: SpeedCurvePoint[], presetId = 'custom', live = false) =>
    setClipSpeedCurve(clip.id, next, presetId, { live })

  // ── Drag handling ──
  const drag = useRef<{ index: number; before: Project; points: SpeedCurvePoint[] } | null>(null)

  function localXY(e: React.PointerEvent): { x: number; y: number } {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function movePoint(pts: SpeedCurvePoint[], index: number, px: number, py: number): SpeedCurvePoint[] {
    const next = pts.map((p) => ({ ...p }))
    const speed = Math.round(fromPy(py) * 100) / 100
    let x = next[index].x
    if (index > 0 && index < next.length - 1) {
      x = Math.min(next[index + 1].x - MIN_GAP, Math.max(next[index - 1].x + MIN_GAP, fromPx(px)))
    }
    next[index] = { x, speed }
    return next
  }

  function onPointDown(e: React.PointerEvent, index: number) {
    e.stopPropagation()
    e.preventDefault()
    setSelected(index)
    const svg = (e.currentTarget as SVGElement).ownerSVGElement
    svg?.setPointerCapture(e.pointerId)
    drag.current = { index, before: useProjectStore.getState().project, points }
  }

  function onGraphDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    const { x: px, y: py } = localXY(e)
    const x = fromPx(px)
    if (x <= MIN_GAP || x >= 1 - MIN_GAP) return
    // Click on empty graph area adds a point there (and starts dragging it).
    const insertAt = points.findIndex((p) => p.x > x)
    if (insertAt <= 0) return
    const prev = points[insertAt - 1]
    const nextP = points[insertAt]
    if (x - prev.x < MIN_GAP || nextP.x - x < MIN_GAP) return
    e.preventDefault()
    const before = useProjectStore.getState().project
    const added = [...points.slice(0, insertAt), { x, speed: Math.round(fromPy(py) * 100) / 100 }, ...points.slice(insertAt)]
    ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
    drag.current = { index: insertAt, before, points: added }
    setSelected(insertAt)
    write(added, 'custom', true)
  }

  function onGraphMove(e: React.PointerEvent) {
    const d = drag.current
    if (!d) return
    const { x, y } = localXY(e)
    d.points = movePoint(d.points, d.index, x, y)
    write(d.points, 'custom', true)
  }

  function endDrag() {
    const d = drag.current
    if (!d) return
    drag.current = null
    recordUndoPoint(d.before)
  }

  function addPoint() {
    // Insert in the middle of the widest gap, on the curve (so the shape doesn't change).
    let gi = 0
    for (let i = 1; i < points.length - 1; i++) if (points[i + 1].x - points[i].x > points[gi + 1].x - points[gi].x) gi = i
    const x = (points[gi].x + points[gi + 1].x) / 2
    const speed = Math.round(evalSpeedCurve(points, x) * 100) / 100
    write([...points.slice(0, gi + 1), { x, speed }, ...points.slice(gi + 1)])
    setSelected(gi + 1)
  }

  function deletePoint() {
    if (sel === null || points.length <= 2 || sel === 0 || sel === points.length - 1) return
    write(points.filter((_, i) => i !== sel))
    setSelected(null)
  }

  function applyPreset(id: string) {
    const p = speedCurvePreset(id)
    if (!p) return
    if (id === 'custom' && preset === 'custom') return
    write(p.points, id)
    setSelected(null)
  }

  // ── Geometry ──
  const SAMPLES = 96
  let linePath = ''
  for (let i = 0; i <= SAMPLES; i++) {
    const x = i / SAMPLES
    linePath += `${i === 0 ? 'M' : 'L'}${toPx(x).toFixed(1)},${toPy(evalSpeedCurve(points, x)).toFixed(1)}`
  }
  const areaPath = `${linePath}L${toPx(1)},${PAD.top + plotH}L${toPx(0)},${PAD.top + plotH}Z`

  // What actually plays: the stepped keyframes the store sampled.
  let stepPath = ''
  if (hasCurve) {
    const kfs = clip.speedKeyframes!
    const len = Math.max(1e-6, clip.trimOut - clip.trimIn)
    for (let i = 0; i < kfs.length - 1; i++) {
      const x0 = toPx((kfs[i].time - clip.trimIn) / len)
      const x1 = toPx((kfs[i + 1].time - clip.trimIn) / len)
      const y = toPy(kfs[i].speed)
      stepPath += `${i === 0 ? 'M' : 'L'}${x0.toFixed(1)},${y.toFixed(1)}L${x1.toFixed(1)},${y.toFixed(1)}`
    }
  }

  // Playhead within the clip, as a position in its source range.
  const dur = effectiveDuration(clip)
  const local = playhead - clip.start
  const playheadX =
    local >= 0 && local <= dur ? (sourceTimeFor(clip, local) - clip.trimIn) / Math.max(1e-6, clip.trimOut - clip.trimIn) : null

  const sourceLen = Math.max(0.01, clip.trimOut - clip.trimIn)
  const selPoint = sel !== null ? points[sel] : null
  const canDelete = sel !== null && sel > 0 && sel < points.length - 1 && points.length > 2

  const gridSpeeds = [SPEED_CURVE_MIN, 0.5, 1, 2, SPEED_CURVE_MAX]

  return (
    <div className="speed-curve">
      <div className="speed-curve-presets">
        {SPEED_CURVE_PRESETS.map((p) => (
          <button
            key={p.id}
            className={`speed-curve-preset ${preset === p.id ? 'active' : ''}`}
            title={p.label}
            onClick={() => applyPreset(p.id)}
          >
            <span className="speed-curve-thumb">
              <PresetThumb points={p.points} />
            </span>
            <span className="speed-curve-preset-label">{p.label}</span>
          </button>
        ))}
      </div>

      <div className="speed-curve-header">
        <span className="speed-label">{speedCurvePreset(preset)?.label ?? 'Custom'}</span>
        <span className="speed-curve-duration">
          Duration {sourceLen.toFixed(1)}s → {dur.toFixed(1)}s
        </span>
      </div>

      <div className="speed-curve-graph" ref={wrapRef}>
        <svg
          width={width}
          height={GRAPH_H}
          onPointerDown={onGraphDown}
          onPointerMove={onGraphMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {gridSpeeds.map((s) => (
            <g key={s}>
              <line
                className={`speed-curve-grid ${s === 1 ? 'mid' : ''}`}
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={toPy(s)}
                y2={toPy(s)}
              />
              {(s === SPEED_CURVE_MIN || s === 1 || s === SPEED_CURVE_MAX) && (
                <text className="speed-curve-axis" x={PAD.left - 6} y={toPy(s) + 3.5} textAnchor="end">
                  {s}x
                </text>
              )}
            </g>
          ))}
          <path className="speed-curve-area" d={areaPath} />
          {stepPath && <path className="speed-curve-steps" d={stepPath} />}
          <path className="speed-curve-line" d={linePath} />
          {playheadX !== null && (
            <line className="speed-curve-playhead" x1={toPx(playheadX)} x2={toPx(playheadX)} y1={PAD.top - 6} y2={PAD.top + plotH + 6} />
          )}
          {points.map((p, i) => (
            <circle
              key={i}
              className={`speed-curve-point ${sel === i ? 'selected' : ''}`}
              data-index={i}
              cx={toPx(p.x)}
              cy={toPy(p.speed)}
              r={sel === i ? 6 : 5}
              onPointerDown={(e) => onPointDown(e, i)}
            />
          ))}
        </svg>
      </div>

      <div className="speed-curve-actions">
        <span className="speed-curve-readout">{selPoint ? `${selPoint.speed.toFixed(2)}x` : 'Click the graph to add a point'}</span>
        <button className="speed-curve-btn" onClick={addPoint}>
          + Add point
        </button>
        <button className="speed-curve-btn" disabled={!canDelete} onClick={deletePoint}>
          Delete point
        </button>
      </div>
    </div>
  )
}

/** Tiny curve thumbnail for a preset tile. */
function PresetThumb({ points }: { points: SpeedCurvePoint[] }) {
  const W = 44
  const H = 26
  let d = ''
  for (let i = 0; i <= 24; i++) {
    const x = i / 24
    const y = 2 + (1 - speedToGraphY(evalSpeedCurve(points, x))) * (H - 4)
    d += `${i === 0 ? 'M' : 'L'}${(2 + x * (W - 4)).toFixed(1)},${y.toFixed(1)}`
  }
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <line x1={2} x2={W - 2} y1={H / 2} y2={H / 2} className="speed-curve-thumb-mid" />
      <path d={d} className="speed-curve-thumb-line" />
    </svg>
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
