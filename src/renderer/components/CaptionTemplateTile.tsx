import { useEffect, useRef } from 'react'
import { captionTemplate, templateStyle } from '@shared/captionTemplates'
import { defaultCaptionStyle } from '@shared/captions'
import { defaultTransform, type TextClip } from '@shared/types'
import { drawTextClip } from '../textRender'

/** Internal resolution of a tile preview (drawn at devicePixelRatio for crispness). */
const W = 320
const H = 180
/** A fake "canvas" the template is sized for, so text fills a tile like it fills a video. */
const SIZING = { width: 470, height: 470, fps: 30 }
const SAMPLE = ['Make', 'every', 'word', 'count', 'today']
const WORD_S = 0.42
const LOOP_S = SAMPLE.length * WORD_S + 0.9

function sampleClip(id: string): TextClip {
  const tpl = captionTemplate(id)
  const style = tpl ? templateStyle(tpl, SIZING) : defaultCaptionStyle(SIZING)
  return {
    id: `tile-${id}`,
    kind: 'text',
    trackId: 'tile',
    start: 0,
    duration: LOOP_S,
    text: SAMPLE.join(' '),
    fontSize: style.fontSize,
    color: style.color,
    bold: style.bold,
    fontFamily: style.fontFamily,
    ...(style.stroke ? { stroke: style.stroke } : {}),
    // An empty look still turns on wrapping, so Basic's sample fits the tile.
    look: style.look ?? {},
    transform: { ...defaultTransform(), y: 0.5 },
    caption: { words: SAMPLE.map((text, i) => ({ text, start: 0.1 + i * WORD_S, end: 0.1 + i * WORD_S + WORD_S * 0.85 })) }
  }
}

/** A caption template preview that plays the template on sample words, using the real renderer. */
export default function CaptionTemplateTile(props: { id: string; name: string; title?: string; selected: boolean; onPick: (id: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const clip = sampleClip(props.id)
    const t0 = performance.now()
    let raf = 0
    const tick = () => {
      const t = ((performance.now() - t0) / 1000) % LOOP_S
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      drawTextClip(ctx, clip, t, W, H)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [props.id])

  return (
    <button className={`caption-template ${props.selected ? 'selected' : ''}`} title={props.title} onClick={() => props.onPick(props.id)}>
      <canvas ref={canvasRef} className="caption-template-canvas" />
      <span className="caption-template-name">{props.name}</span>
    </button>
  )
}
