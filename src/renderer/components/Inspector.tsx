import { useEffect, useRef, useState } from 'react'
import { captionTemplate } from '@shared/captionTemplates'
import Slider from './Slider'
import { canMergeWithNext, useProjectStore } from '../state/projectStore'
import { useLayoutStore } from '../state/layoutStore'
import BackgroundRemovalButton from './BackgroundRemovalButton'
import SpeedPanel from './SpeedPanel'
import MotionBlurSection from './MotionBlurSection'
import { filterDef } from '@shared/filters'
import { animationsOfKind, poseAt, type AnimationDef, type AnimationKind } from '@shared/animations'
import StorageSection from './StorageSection'
import {
  COLOR_SPACES,
  EFFECT_CATALOG,
  FONT_CATALOG,
  TRANSITION_CATALOG,
  aspectPresetFor,
  effectCatalogEntry,
  projectDuration,
  type ClipEffect,
  type ClipEffectType,
  type ClipTransform,
  type ColorSpaceId,
  type MediaClip,
  type SpeedKeyframe,
  type TextCase,
  type TransitionType
} from '@shared/types'

const SECTION_KEY = 'anycut.inspectorSections'
function readOpenSections(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SECTION_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

/** A collapsible inspector group (CapCut's "Transform", "Blend", … headers with a chevron).
 *  Open/closed state is remembered per title. */
function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  const [open, setOpen] = useState(() => readOpenSections()[title] ?? true)
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(SECTION_KEY, JSON.stringify({ ...readOpenSections(), [title]: !o }))
      } catch {
        /* per-viewer convenience only */
      }
      return !o
    })
  }
  return (
    <section className={`insp-section ${open ? 'open' : ''}`}>
      <div className="insp-section-head">
        <button className="insp-section-toggle" aria-expanded={open} onClick={toggle}>
          <svg className="insp-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {title}
        </button>
        {action}
      </div>
      {open && <div className="insp-section-body">{children}</div>}
    </section>
  )
}

function ResetButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button className="insp-reset" title={title} aria-label={title} onClick={onClick}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 6a3.5 3.5 0 1 0 1.1-2.55M2.5 1.8v2h2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/** A compact numeric field with a leading axis label (Position X / Y). */
function AxisField({ axis, value, onChange, unit }: { axis: string; value: number; onChange: (v: number) => void; unit?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const n = Number(draft)
    if (Number.isFinite(n)) onChange(n)
    setDraft(null)
  }
  return (
    <label className="axis-field">
      <span className="axis-label">{axis}</span>
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? String(Math.round(value))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            onChange(Math.round(value) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1))
          }
        }}
      />
      {unit && <span className="axis-unit">{unit}</span>}
    </label>
  )
}

/** Transform + Blend groups shared by text and media clips (both have `transform` on ClipBase).
 *  Static values only (no keyframe editor); touching a control drops any legacy keyframes so
 *  nothing keeps animating that the UI can't show. Position is shown the way CapCut shows it:
 *  pixels from the canvas centre, Y up. */
function TransformSections({ transform, onChange }: { transform: ClipTransform; onChange: (t: ClipTransform) => void }) {
  const canvas = useProjectStore((s) => s.project.canvas)
  const set = (patch: Partial<ClipTransform>) => onChange({ ...transform, ...patch, keyframes: undefined })
  const pct = { format: (v: number) => String(Math.round(v * 100)), parse: (s: string) => Number(s) / 100, unit: '%' }
  const rotation = transform.rotation ?? 0
  return (
    <>
      <Section title="Transform" action={<ResetButton title="Reset transform" onClick={() => set({ x: 0.5, y: 0.5, scale: 1, rotation: 0 })} />}>
        <div className="field-row prop-row">
          <label>Scale</label>
          <Slider min={0.1} max={4} step={0.01} value={transform.scale} onChange={(v) => set({ scale: v })} valueBox={pct} />
        </div>
        <div className="field-row prop-row">
          <label>Position</label>
          <div className="axis-pair">
            <AxisField axis="X" value={(transform.x - 0.5) * canvas.width} onChange={(v) => set({ x: 0.5 + v / canvas.width })} />
            <AxisField axis="Y" value={(0.5 - transform.y) * canvas.height} onChange={(v) => set({ y: 0.5 - v / canvas.height })} />
          </div>
        </div>
        <div className="field-row prop-row">
          <label>Rotate</label>
          <Slider
            min={-180}
            max={180}
            step={1}
            value={rotation > 180 ? rotation - 360 : rotation}
            onChange={(v) => set({ rotation: Math.round(v) })}
            valueBox={{ format: (v) => String(Math.round(v)), unit: '°' }}
          />
        </div>
      </Section>
      <Section title="Blend" action={<ResetButton title="Reset opacity" onClick={() => set({ opacity: 1 })} />}>
        <div className="field-row prop-row">
          <label>Opacity</label>
          <Slider min={0} max={1} step={0.01} value={transform.opacity} onChange={(v) => set({ opacity: v })} valueBox={pct} />
        </div>
      </Section>
    </>
  )
}

/** Small looping preview of an animation preset on a tile (runs while hovered or selected). */
function AnimationTile({ def, selected, onPick }: { def: AnimationDef | null; selected: boolean; onPick: () => void }) {
  const [hover, setHover] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const active = !!def && (hover || selected)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const apply = (p: number) => {
      const q = def ? poseAt(def, p, def.kind === 'combo' ? 2 : 0.6) : { scale: 1, dx: 0, dy: 0, opacity: 1 }
      el.style.transform = `translate(${q.dx * 100}%, ${q.dy * 100}%) scale(${q.scale})`
      el.style.opacity = String(q.opacity)
    }
    if (!active) {
      // At rest: In tiles show their finished pose, Out tiles their starting pose.
      apply(def?.kind === 'in' ? 1 : 0)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const span = def!.kind === 'combo' ? 2000 : 700
    const tick = (now: number) => {
      const cycle = (now - t0) % (span + 500)
      apply(Math.min(1, cycle / span))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [def, active])
  return (
    <button
      className={`anim-tile ${selected ? 'selected' : ''}`}
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={def?.label ?? 'None'}
    >
      <div className="anim-tile-stage">
        {def ? (
          <div ref={boxRef} className="anim-tile-box" />
        ) : (
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5.5 16.5l11-11" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        )}
      </div>
      <span className="anim-tile-label">{def?.label ?? 'None'}</span>
    </button>
  )
}

const ANIM_KINDS: { id: AnimationKind; label: string }[] = [
  { id: 'in', label: 'In' },
  { id: 'out', label: 'Out' },
  { id: 'combo', label: 'Combo' }
]

/** Inspector → Animation: CapCut's In / Out / Combo preset grids and the chosen preset's length. */
function AnimationPanel({ clip }: { clip: MediaClip }) {
  const setClipAnimations = useProjectStore((s) => s.setClipAnimations)
  const anims = clip.animations ?? {}
  const [kind, setKind] = useState<AnimationKind>(anims.combo ? 'combo' : anims.in || !anims.out ? 'in' : 'out')
  const current = anims[kind]
  const maxDur = Math.max(0.1, Math.min(10, clip.duration))

  function pick(def: AnimationDef | null) {
    if (!def) {
      setClipAnimations(clip.id, { ...anims, [kind]: undefined })
      return
    }
    const duration = kind === 'combo' ? clip.duration : Math.min(def.defaultDuration, maxDur)
    // Combo replaces In/Out (and vice versa), as in CapCut.
    const next = kind === 'combo' ? { combo: { id: def.id, duration } } : { ...anims, combo: undefined, [kind]: { id: def.id, duration } }
    setClipAnimations(clip.id, next)
  }

  return (
    <div className="anim-panel">
      <div className="pill-tabs" role="tablist">
        {ANIM_KINDS.map((k) => (
          <button key={k.id} role="tab" aria-selected={kind === k.id} className={`pill-tab ${kind === k.id ? 'active' : ''}`} onClick={() => setKind(k.id)}>
            {k.label}
            {anims[k.id] && <span className="pill-dot" aria-label="applied" />}
          </button>
        ))}
      </div>
      <div className="anim-grid">
        <AnimationTile def={null} selected={!current} onPick={() => pick(null)} />
        {animationsOfKind(kind).map((def) => (
          <AnimationTile key={def.id} def={def} selected={current?.id === def.id} onPick={() => pick(def)} />
        ))}
      </div>
      {current && (
        <div className="field-row prop-row anim-duration">
          <label>Duration</label>
          <Slider
            min={0.1}
            max={maxDur}
            step={0.1}
            value={Math.min(current.duration || clip.duration, maxDur)}
            onChange={(v) => setClipAnimations(clip.id, { ...anims, [kind]: { ...current, duration: Math.round(v * 10) / 10 } }, false)}
            valueBox={{ format: (v) => v.toFixed(1), unit: 's' }}
          />
        </div>
      )}
    </div>
  )
}

/** Add/remove/configure the per-clip effect stack. Each effect is a labeled row with a remove
 *  button and one slider per catalog param. Mirrors TransformFields' shape. The rendering math
 *  lives in shared/effects.ts (preview) and ffmpegGraph.ts (export). */
function EffectFields({
  effects,
  onAdd,
  onRemove,
  onParam
}: {
  effects: ClipEffect[]
  onAdd: (type: ClipEffectType) => void
  onRemove: (effectId: string) => void
  onParam: (effectId: string, key: string, value: number) => void
}) {
  return (
    <div className="field-row">
      {effects.length === 0 && <div className="empty-hint" style={{ marginBottom: 6 }}>No effects.</div>}
      {effects.map((effect) => {
        const entry = effectCatalogEntry(effect.type)
        return (
          <div key={effect.id} className="fx-field" data-effect-id={effect.id} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 6, marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <strong style={{ fontSize: 12 }}>{entry?.label ?? effect.type}</strong>
              <button title="Remove effect" onClick={() => onRemove(effect.id)}>
                ×
              </button>
            </div>
            {entry?.params.map((p) => {
              const value = typeof effect.params[p.key] === 'number' ? effect.params[p.key] : p.default
              return (
                <div key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ flex: '0 0 96px', fontSize: 11, color: 'var(--text-dim)' }}>{p.label}</span>
                  <Slider min={p.min} max={p.max} step={p.step} value={value} style={{ flex: 1, minWidth: 0 }} onChange={(v) => onParam(effect.id, p.key, v)} valueBox={{}} />
                </div>
              )
            })}
          </div>
        )
      })}
      <select
        value=""
        style={{ width: '100%' }}
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value as ClipEffectType)
          e.target.value = ''
        }}
      >
        <option value="">+ Add effect…</option>
        {EFFECT_CATALOG.map((entry) => (
          <option key={entry.type} value={entry.type}>
            {entry.label}
          </option>
        ))}
      </select>
    </div>
  )
}

const CASE_OPTIONS: { id: TextCase; glyph: string; title: string }[] = [
  { id: 'upper', glyph: 'AA', title: 'Uppercase' },
  { id: 'lower', glyph: 'aa', title: 'Lowercase' },
  { id: 'title', glyph: 'Aa', title: 'Title case' }
]

export default function Inspector() {
  const project = useProjectStore((s) => s.project)
  const filePath = useProjectStore((s) => s.filePath)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const useProxies = useLayoutStore((s) => s.useProxies)
  const setUseProxies = useLayoutStore((s) => s.setUseProxies)
  const [tab, setTab] = useState<'video' | 'speed' | 'animation'>('video')
  const effectFocus = useProjectStore((s) => s.effectFocus)

  // A clip's effect badge (or a drop onto a clip) asks to reveal one effect: switch to the Video
  // tab, then scroll its row into view and flash it once it has rendered.
  useEffect(() => {
    if (effectFocus) setTab('video')
  }, [effectFocus])
  useEffect(() => {
    if (!effectFocus || tab !== 'video') return
    const raf = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-effect-id="${CSS.escape(effectFocus.effectId)}"]`)
      if (!row) return
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      row.classList.remove('focus-flash')
      void row.offsetWidth // restart the animation on repeat clicks
      row.classList.add('focus-flash')
    })
    return () => cancelAnimationFrame(raf)
  }, [effectFocus, tab])
  const removeClip = useProjectStore((s) => s.removeClip)
  const mergeWithNext = useProjectStore((s) => s.mergeWithNext)
  const setTransition = useProjectStore((s) => s.setTransition)
  const setTransitionType = useProjectStore((s) => s.setTransitionType)
  const addClipEffect = useProjectStore((s) => s.addClipEffect)
  const removeClipEffect = useProjectStore((s) => s.removeClipEffect)
  const updateClipEffectParam = useProjectStore((s) => s.updateClipEffectParam)
  const updateTextClip = useProjectStore((s) => s.updateTextClip)
  const applyCaptionStyleToAll = useProjectStore((s) => s.applyCaptionStyleToAll)
  const updateMediaClipProps = useProjectStore((s) => s.updateMediaClipProps)
  const setClipSpeed = useProjectStore((s) => s.setClipSpeed)
  const setClipSpeedKeyframes = useProjectStore((s) => s.setClipSpeedKeyframes)
  const setClipReversed = useProjectStore((s) => s.setClipReversed)
  const setClipTransform = useProjectStore((s) => s.setClipTransform)
  const setColorSpace = useProjectStore((s) => s.setColorSpace)
  const setClipFilter = useProjectStore((s) => s.setClipFilter)

  let found: { track: typeof project.tracks[number]; clip: typeof project.tracks[number]['clips'][number]; index: number } | null = null
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === selectedClipId)
    if (index !== -1) {
      found = { track, clip: track.clips[index], index }
      break
    }
  }

  if (!found) {
    const { width, height, fps, colorSpace } = project.canvas
    const preset = aspectPresetFor(width, height)
    const aspectLabel = preset ? preset.label : `${width}:${height} (custom)`
    const proxied = project.assets.filter((a) => a.previewPath).length
    const totalDur = projectDuration(project)
    const mm = String(Math.floor(totalDur / 60)).padStart(2, '0')
    const ss = String(Math.round(totalDur % 60)).padStart(2, '0')
    return (
      <div className="panel inspector">
        <h3>Project</h3>
        <dl className="detail-list">
          <div className="detail-row"><dt>Name</dt><dd>{project.name}</dd></div>
          <div className="detail-row"><dt>File path</dt><dd className="detail-path" title={filePath ?? 'Unsaved'}>{filePath ? `\u200E${filePath}\u200E` : 'Unsaved'}</dd></div>
          <div className="detail-row"><dt>Aspect ratio</dt><dd>{aspectLabel}</dd></div>
          <div className="detail-row"><dt>Resolution</dt><dd>{width} × {height}</dd></div>
          <div className="detail-row"><dt>Frame rate</dt><dd>{fps} fps</dd></div>
          <div className="detail-row"><dt>Duration</dt><dd>{mm}:{ss}</dd></div>
          <div className="detail-row"><dt>Tracks</dt><dd>{project.tracks.length}</dd></div>
          <div className="detail-row"><dt>Media</dt><dd>{project.assets.length} asset{project.assets.length === 1 ? '' : 's'}</dd></div>
          <div className="detail-row"><dt>Proxy</dt><dd>{proxied > 0 ? `${proxied} proxied for preview` : 'None'}</dd></div>
        </dl>
        <div className="field-row prop-row" style={{ marginTop: 14 }}>
          <label>Color space</label>
          <select value={colorSpace ?? 'rec709'} title={COLOR_SPACES.find((c) => c.id === (colorSpace ?? 'rec709'))?.description} onChange={(e) => setColorSpace(e.target.value as ColorSpaceId)}>
            {COLOR_SPACES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="empty-hint" style={{ padding: '0 0 4px' }}>{COLOR_SPACES.find((c) => c.id === (colorSpace ?? 'rec709'))?.description}</div>
        <div className="field-row" style={{ marginTop: 12 }}>
          <label>
            <input type="checkbox" checked={useProxies} onChange={(e) => setUseProxies(e.target.checked)} />{' '}
            Use preview proxies
          </label>
          <div className="empty-hint" style={{ padding: '4px 0 0' }}>
            Generates H.264 proxies on import for codecs the preview can't decode (ProRes, etc.).
            Export always uses the original. Applies to newly imported media.
          </div>
        </div>
        <StorageSection />
        <div className="empty-hint" style={{ marginTop: 12 }}>Select a clip to edit its properties.</div>
      </div>
    )
  }

  const { track, clip, index } = found
  const firstVideoTrack = project.tracks.find((t) => t.type === 'video')
  const canHaveTransition = track.type === 'video' && track.id === firstVideoTrack?.id && index > 0
  const canMerge = clip.kind === 'media' && canMergeWithNext(project, clip.id)
  // Tabs only apply to media clips ON A VIDEO TRACK (they have speed + animation to adjust).
  // Audio clips show their single volume/mute editor; text clips show the text editor.
  const showTabs = clip.kind === 'media' && track.type === 'video'
  const showVideoTab = !showTabs || tab === 'video'
  const showSpeedTab = showTabs && tab === 'speed'
  const showAnimationTab = showTabs && tab === 'animation'
  const asset = clip.kind === 'media' ? project.assets.find((a) => a.id === clip.assetId) : undefined

  return (
    <div className="panel inspector clip-inspector">
      {showTabs && (
        <div className="inspector-tabs">
          <button className={`inspector-tab ${tab === 'video' ? 'active' : ''}`} onClick={() => setTab('video')}>Video</button>
          <button className={`inspector-tab ${tab === 'speed' ? 'active' : ''}`} onClick={() => setTab('speed')}>Speed</button>
          <button className={`inspector-tab ${tab === 'animation' ? 'active' : ''}`} onClick={() => setTab('animation')}>Animation</button>
        </div>
      )}

      {clip.kind === 'text' && (
        <>
          <Section title="Text">
            <div className="field-row">
              <input type="text" value={clip.text} aria-label="Text" onChange={(e) => updateTextClip(clip.id, { text: e.target.value })} />
            </div>
            <div className="field-row prop-row">
              <label>Font</label>
              <select value={clip.fontFamily ?? 'sans'} onChange={(e) => updateTextClip(clip.id, { fontFamily: e.target.value })}>
                {FONT_CATALOG.map((f) => (
                  <option key={f.id} value={f.id} style={{ fontFamily: f.family }}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-row prop-row">
              <label>Font size</label>
              <input type="number" value={clip.fontSize} onChange={(e) => updateTextClip(clip.id, { fontSize: Number(e.target.value) })} />
            </div>
            <div className="field-row prop-row">
              <label>Color</label>
              <input type="text" value={clip.color} onChange={(e) => updateTextClip(clip.id, { color: e.target.value })} />
            </div>
            <div className="field-row prop-row">
              <label>Pattern</label>
              <div className="toggle-group" role="group" aria-label="Pattern">
                <button className={`toggle-btn ${clip.bold ? 'active' : ''}`} aria-pressed={clip.bold} title="Bold" onClick={() => updateTextClip(clip.id, { bold: !clip.bold })}>
                  <span className="glyph-b">B</span>
                </button>
                <button className={`toggle-btn ${clip.underline ? 'active' : ''}`} aria-pressed={!!clip.underline} title="Underline" onClick={() => updateTextClip(clip.id, { underline: !clip.underline })}>
                  <span className="glyph-u">U</span>
                </button>
                <button className={`toggle-btn ${clip.italic ? 'active' : ''}`} aria-pressed={!!clip.italic} title="Italic" onClick={() => updateTextClip(clip.id, { italic: !clip.italic })}>
                  <span className="glyph-i">I</span>
                </button>
              </div>
            </div>
            <div className="field-row prop-row">
              <label>Case</label>
              <div className="toggle-group" role="group" aria-label="Case">
                {CASE_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    className={`toggle-btn ${clip.textCase === o.id ? 'active' : ''}`}
                    aria-pressed={clip.textCase === o.id}
                    title={o.title}
                    // Clicking the active option turns case back off (text shows as typed).
                    onClick={() => updateTextClip(clip.id, { textCase: clip.textCase === o.id ? undefined : o.id })}
                  >
                    {o.glyph}
                  </button>
                ))}
              </div>
            </div>
            <div className="field-row prop-row">
              <label>Outline</label>
              <div className="field-inline">
                <button
                  className={`toggle-switch ${clip.stroke ? 'on' : ''}`}
                  role="switch"
                  aria-checked={!!clip.stroke}
                  title="Outline"
                  onClick={() => updateTextClip(clip.id, { stroke: clip.stroke ? undefined : { color: 'black', width: Math.max(2, Math.round(clip.fontSize * 0.08)) } })}
                >
                  <span className="toggle-knob" />
                </button>
                {clip.stroke && (
                  <>
                    <input
                      type="number"
                      min={1}
                      max={40}
                      value={clip.stroke.width}
                      title="Outline width"
                      onChange={(e) => updateTextClip(clip.id, { stroke: { ...clip.stroke!, width: Math.max(0, Number(e.target.value)) } })}
                    />
                    <input
                      type="text"
                      value={clip.stroke.color}
                      title="Outline colour"
                      onChange={(e) => updateTextClip(clip.id, { stroke: { ...clip.stroke!, color: e.target.value } })}
                    />
                  </>
                )}
              </div>
            </div>
            {clip.look?.highlight && (
              <div className="field-row prop-row">
                <label title={`Spoken-word highlight (${captionTemplate(clip.look.templateId)?.name ?? 'custom'})`}>Highlight</label>
                <input
                  type="text"
                  value={clip.look.highlight.box?.color ?? clip.look.highlight.color ?? ''}
                  title="Colour of the highlight on the word being spoken"
                  onChange={(e) => {
                    const hl = clip.look!.highlight!
                    const highlight = hl.box ? { ...hl, box: { ...hl.box, color: e.target.value } } : { ...hl, color: e.target.value }
                    updateTextClip(clip.id, { look: { ...clip.look, highlight } })
                  }}
                />
              </div>
            )}
            {clip.caption && (
              <div className="field-row">
                <button onClick={() => applyCaptionStyleToAll(clip.id)}>Apply style to all captions</button>
                <div className="empty-hint">Copies font, size, colours, outline, template and height to every auto caption.</div>
              </div>
            )}
          </Section>
          <TransformSections transform={clip.transform} onChange={(t) => updateTextClip(clip.id, { transform: t })} />
        </>
      )}

      {clip.kind === 'media' && showVideoTab && (
        <>
          {track.type === 'video' && asset?.kind !== 'audio' && (
            <>
              <TransformSections transform={clip.transform} onChange={(t) => setClipTransform(clip.id, t)} />
              {clip.filter && filterDef(clip.filter.id) && (
                <Section
                  title="Filter"
                  action={
                    <button className="insp-reset" title="Remove filter" aria-label="Remove filter" onClick={() => setClipFilter(clip.id, undefined)}>
                      ×
                    </button>
                  }
                >
                  <div className="field-row prop-row">
                    <label>{filterDef(clip.filter.id)!.label}</label>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      value={clip.filter.intensity}
                      onChange={(v) => setClipFilter(clip.id, { ...clip.filter!, intensity: Math.round(v * 100) / 100 }, false)}
                      valueBox={{ format: (v) => String(Math.round(v * 100)), parse: (s) => Number(s) / 100 }}
                    />
                  </div>
                </Section>
              )}
              {asset && (
                <Section title="Motion blur">
                  <MotionBlurSection clip={clip} assetPath={asset.path} />
                </Section>
              )}
            </>
          )}
          <Section title="Audio">
            <div className="field-row prop-row">
              <label>Volume</label>
              <Slider min={0} max={1} step={0.01} value={clip.volume} onChange={(v) => updateMediaClipProps(clip.id, { volume: v })} valueBox={{ format: (v) => String(Math.round(v * 100)), parse: (s) => Number(s) / 100, unit: '%' }} />
            </div>
            <div className="field-row prop-row">
              <label>Mute</label>
              <div>
                <button className={`toggle-switch ${clip.muted ? 'on' : ''}`} role="switch" aria-checked={clip.muted} title="Mute" onClick={() => updateMediaClipProps(clip.id, { muted: !clip.muted })}>
                  <span className="toggle-knob" />
                </button>
              </div>
            </div>
          </Section>
          {track.type === 'video' && (
            <Section title="Effects">
              <EffectFields
                effects={clip.effects ?? []}
                onAdd={(type) => addClipEffect(clip.id, type)}
                onRemove={(effectId) => removeClipEffect(clip.id, effectId)}
                onParam={(effectId, key, value) => updateClipEffectParam(clip.id, effectId, key, value)}
              />
            </Section>
          )}
          {track.type === 'video' && asset && (
            <Section title="Remove background">
              <BackgroundRemovalButton clip={clip} assetPath={asset.path} />
            </Section>
          )}
        </>
      )}

      {track.type === 'video' && clip.kind === 'media' && showSpeedTab && (
        <SpeedPanel
          clip={clip}
          onSpeed={(s) => setClipSpeed(clip.id, s)}
          onSpeedKeyframes={(kfs) => setClipSpeedKeyframes(clip.id, kfs)}
          onReversed={(r) => setClipReversed(clip.id, r)}
          onChangeAudioPitch={(v) => updateMediaClipProps(clip.id, { changeAudioPitch: v })}
        />
      )}

      {clip.kind === 'media' && showAnimationTab && <AnimationPanel clip={clip} />}

      {canHaveTransition && showVideoTab && (
        <Section title="Transition">
          <div className="field-row prop-row">
            <label>Duration</label>
            <Slider min={0} max={2} step={0.05} value={clip.transitionIn?.duration ?? 0} onChange={(v) => setTransition(clip.id, v)} valueBox={{ format: (v) => v.toFixed(2), unit: 's' }} />
          </div>
          {clip.transitionIn && clip.transitionIn.duration > 0 && (
            <div className="field-row prop-row">
              <label>Type</label>
              <select value={clip.transitionIn.type} onChange={(e) => setTransitionType(clip.id, e.target.value as TransitionType)}>
                {TRANSITION_CATALOG.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </Section>
      )}

      {showVideoTab && (
        <div className="insp-footer">
          {canMerge && (
            <button onClick={() => mergeWithNext(clip.id)} title="Rejoin with the next clip (undoes a Split)">
              Merge with next clip
            </button>
          )}
          <button onClick={() => removeClip(clip.id)}>Delete clip</button>
        </div>
      )}
    </div>
  )
}
