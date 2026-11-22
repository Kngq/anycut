import { useEffect, useState, type CSSProperties } from 'react'

/**
 * anycut's slider, modelled on CapCut's VESlider / VESpinBoxSlider (GeneralBizUI QML): a 2 px
 * track at 12% white with a solid white filled part, an 8×12 px white pill handle, and
 * optionally an editable value box to the right (72 px wide, 18 px gap, with a unit like "%").
 * The fill is driven by a CSS variable (--p) since Chromium range inputs have no fill part.
 */
export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number | 'any'
  onChange: (value: number) => void
  disabled?: boolean
  className?: string
  title?: string
  style?: CSSProperties
  /** Show CapCut's number box. `format` turns the value into the box text, `parse` back. */
  valueBox?: { format?: (v: number) => string; parse?: (s: string) => number; unit?: string }
}

export default function Slider(props: SliderProps) {
  const { value, min, max, step = 'any', onChange, disabled, className, title, style, valueBox } = props
  const span = max - min || 1
  const pct = Math.min(100, Math.max(0, ((value - min) / span) * 100))
  const vars = { '--p': `${pct}%` } as CSSProperties

  const slider = (
    <input
      type="range"
      className={`fc-range ${className ?? ''}`}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      title={title}
      style={{ ...vars, ...(valueBox ? {} : style) }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
  if (!valueBox) return slider
  return (
    <div className="fc-slider" style={style}>
      {slider}
      <ValueBox value={value} min={min} max={max} disabled={disabled} onChange={onChange} {...valueBox} />
    </div>
  )
}

function ValueBox(props: { value: number; min: number; max: number; disabled?: boolean; onChange: (v: number) => void; format?: (v: number) => string; parse?: (s: string) => number; unit?: string }) {
  const format = props.format ?? ((v: number) => String(Math.round(v * 100) / 100))
  const parse = props.parse ?? ((s: string) => Number(s))
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => setDraft(null), [props.value])

  function commit() {
    if (draft === null) return
    const v = parse(draft.trim())
    if (Number.isFinite(v)) props.onChange(Math.min(props.max, Math.max(props.min, v)))
    setDraft(null)
  }

  return (
    <label className={`fc-slider-box ${props.disabled ? 'disabled' : ''}`}>
      <input
        type="text"
        inputMode="decimal"
        disabled={props.disabled}
        value={draft ?? format(props.value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(null)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      {props.unit && <span className="fc-slider-unit">{props.unit}</span>}
    </label>
  )
}
