import { packWordTimes, type PackedWord } from '@shared/captions'
import { applyTextCase, fontCatalogEntry, interpolateTransform, type Clip, type Project, type TextBox, type TextClip } from '@shared/types'

/**
 * Draws text clips onto a 2D canvas. The live preview and the export (which bakes text into a
 * transparent overlay, see export/textOverlay.ts) both call this, so what you see is what you
 * export: fonts, outlines, shadows, per-word highlight, word-at-a-time pages and animations.
 *
 * Caption templates follow CapCut's caption engine (CaptionModule.lua + TextAnim.lua in its
 * caption animation packages): a caption is split into pages of N words, each word is
 * before/reading/after-read by its packed time (packWordTimes with splitPage(0, 1), so a word
 * stays "reading" until the next starts), and the page plays an entrance animation.
 */

/** Seconds a page's entrance animation runs (CapCut caption anims are authored at 0.5 s). */
const ANIM_SECONDS = 0.5
/** How long the highlight box takes to glide to the next word. */
const SLIDE_SECONDS = 0.15
/** Fade-in for a word appearing when unread words are hidden. */
const REVEAL_SECONDS = 0.08

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3)
const easeInOutSine = (x: number) => -(Math.cos(Math.PI * clamp01(x)) - 1) / 2

/** Page entrance scale (x, y) at `dt` seconds into the page. */
export function animationScale(kind: string | undefined, dt: number): [number, number] {
  if (dt < 0) return [1, 1]
  switch (kind) {
    case 'pop': {
      // CapCut 3512850 "funcEaseAction3": a damped spring from 0 to 1.
      const p = dt / ANIM_SECONDS
      if (p >= 1) return [1, 1]
      const s = Math.exp(-7 * p) * Math.sin(((p - 0.075) * 2 * Math.PI) / 0.3) + 1
      return [s, s]
    }
    case 'overshoot': {
      // CapCut 3512851 AE keyframes: scale 0 → 120% by frame 6.45, back to 100% by frame 12.1 (30 fps).
      const t1 = 6.451172 / 30
      const t2 = 12.09668 / 30
      if (dt >= t2) return [1, 1]
      const s = dt < t1 ? 1.2 * easeOutCubic(dt / t1) : 1.2 - 0.2 * easeInOutSine((dt - t1) / (t2 - t1))
      return [s, s]
    }
    case 'squash': {
      // CapCut 160095677: horizontal scale snaps from 80% to 100% over the first 0.1 s.
      return [0.8 + 0.2 * clamp01(dt / 0.1), 1]
    }
    default:
      return [1, 1]
  }
}

/** The clip's words with clip-local packed times. Uses the recognised timing when the (possibly
 *  edited) text still has the same number of words, else spreads the words evenly. */
export function clipWords(clip: TextClip): PackedWord[] {
  const tokens = clip.text.split(/\s+/).filter(Boolean)
  const recognised = clip.caption?.words ?? []
  const n = tokens.length
  const base =
    recognised.length === n && n > 0
      ? tokens.map((text, i) => ({ text, start: recognised[i].start, end: recognised[i].end }))
      : tokens.map((text, i) => ({ text, start: (i * clip.duration) / Math.max(n, 1), end: ((i + 1) * clip.duration) / Math.max(n, 1) }))
  return packWordTimes(base, 0, 1, 1)
}

/** The page (group of words) visible at clip-local time t, and when it started. */
export function pageAt(words: PackedWord[], perPage: number, t: number): { words: PackedWord[]; start: number; index: number } {
  if (!perPage || perPage <= 0 || words.length <= perPage) return { words, start: 0, index: 0 }
  let index = 0
  for (let i = 0; i < words.length; i += perPage) {
    if (i === 0 || words[i].packStart <= t) index = i / perPage
  }
  const start = index === 0 ? 0 : words[index * perPage].packStart
  return { words: words.slice(index * perPage, index * perPage + perPage), start, index }
}

interface Placed {
  word: PackedWord
  text: string
  x: number
  y: number // baseline-top of the line box
  w: number
  h: number
  size: number
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function fillBox(ctx: CanvasRenderingContext2D, box: TextBox, x: number, y: number, w: number, h: number, size: number, padBoost = 0) {
  const px = (box.padX + padBoost) * size
  const py = (box.padY + padBoost) * size
  ctx.fillStyle = box.color
  roundRect(ctx, x - px, y - py, w + px * 2, h + py * 2, box.radius * size)
  ctx.fill()
}

/** Where each text clip's block was last laid out (canvas px, before the page entrance
 *  animation), keyed by clip id, with the timeline time it was drawn at. The preview reads it to
 *  hit-test and outline the selected text without re-running the layout. */
export const textBlockBounds = new Map<string, { x: number; y: number; w: number; h: number; t: number }>()

/** Draws one text clip at timeline time `t`. Returns false if nothing was visible. */
export function drawTextClip(ctx: CanvasRenderingContext2D, clip: TextClip, t: number, width: number, height: number): boolean {
  if (t < clip.start || t >= clip.start + clip.duration) return false
  const local = t - clip.start
  const tf = interpolateTransform(clip.transform, local)
  const look = clip.look ?? {}
  const font = fontCatalogEntry(clip.fontFamily)
  const weight = look.weight ?? (clip.bold ? 700 : 400)
  const baseSize = clip.fontSize * tf.scale
  const style = clip.italic ? 'italic ' : ''
  const fontFor = (size: number) => `${style}${weight} ${size}px ${font.family}`
  const setFont = (size: number) => {
    ctx.font = fontFor(size)
    // fontStretch is newer than the TS DOM typings in use here.
    ;(ctx as unknown as { fontStretch: string }).fontStretch = font.stretch ? stretchKeyword(font.stretch) : 'normal'
  }
  const display = (s: string) => applyTextCase(s, look.uppercase ? 'upper' : clip.textCase)

  const words = clipWords(clip)
  if (words.length === 0) return false
  const page = pageAt(words, look.wordsPerPage ?? 0, local)
  const reading = page.words.find((w) => local >= w.packStart && local < w.packEnd) ?? null
  const hlScale = look.highlight?.scale ?? 1

  // ---- Layout: lines of words, measured with the current word at its highlighted size. ----
  setFont(baseSize)
  const space = ctx.measureText(' ').width
  const maxLineWidth = width * 0.9
  const lines: Placed[][] = []
  let line: Placed[] = []
  let lineWidth = 0
  for (const word of page.words) {
    const size = word === reading ? baseSize * hlScale : baseSize
    setFont(size)
    const text = display(word.text)
    const w = ctx.measureText(text).width
    const byCount = look.wordsPerLine ? line.length >= look.wordsPerLine : false
    // Plain text keeps its old single-line behaviour; templated text wraps to the canvas.
    const byWidth = clip.look ? line.length > 0 && lineWidth + space + w > maxLineWidth : false
    if (line.length > 0 && (byCount || byWidth)) {
      lines.push(line)
      line = []
      lineWidth = 0
    }
    line.push({ word, text, x: 0, y: 0, w, h: size * 1.2, size })
    lineWidth += (line.length > 1 ? space : 0) + w
  }
  if (line.length > 0) lines.push(line)

  const lineHeights = lines.map((l) => Math.max(...l.map((p) => p.h)))
  const lineWidths = lines.map((l) => l.reduce((sum, p, i) => sum + p.w + (i > 0 ? space : 0), 0))
  const blockW = Math.max(...lineWidths)
  const blockH = lineHeights.reduce((a, b) => a + b, 0)
  const x0 = (width - blockW) * tf.x
  const y0 = (height - blockH) * tf.y
  textBlockBounds.set(clip.id, { x: x0, y: y0, w: blockW, h: blockH, t })
  let y = y0
  for (let i = 0; i < lines.length; i++) {
    let x = x0 + (blockW - lineWidths[i]) / 2
    for (const p of lines[i]) {
      p.x = x
      p.y = y + (lineHeights[i] - p.h) / 2
      x += p.w + space
    }
    y += lineHeights[i]
  }
  const placed = lines.flat()
  const lineEnds = new Set(lines.map((l) => l[l.length - 1]))

  // ---- Page entrance animation, scaled about the block's centre. ----
  const [sx, sy] = animationScale(look.animation, local - page.start)
  if (sx <= 0.001 || sy <= 0.001) return true
  ctx.save()
  ctx.globalAlpha = tf.opacity
  const cx = x0 + blockW / 2
  const cy = y0 + blockH / 2
  ctx.translate(cx, cy)
  ctx.scale(sx, sy)
  ctx.translate(-cx, -cy)
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'

  if (look.pageBox) fillBox(ctx, look.pageBox, x0, y0, blockW, blockH, baseSize)

  // ---- Highlight box behind the word being spoken. ----
  const hbox = look.highlight?.box
  if (hbox && reading) {
    const cur = placed.find((p) => p.word === reading)!
    let { x, y: by, w, h } = cur
    if (look.highlight?.slide) {
      const prev = placed[placed.indexOf(cur) - 1]
      const k = easeOutCubic((local - reading.packStart) / SLIDE_SECONDS)
      if (prev && k < 1) {
        x = prev.x + (x - prev.x) * k
        by = prev.y + (by - prev.y) * k
        w = prev.w + (w - prev.w) * k
        h = prev.h + (h - prev.h) * k
      }
    }
    // CapCut's per-word box pops: its padding eases from 0.265 to 0.2 em over 0.5 s.
    const boost = 0.065 * (1 - easeOutCubic((local - reading.packStart) / ANIM_SECONDS))
    fillBox(ctx, hbox, x, by, w, h, cur.size, boost)
  }

  // ---- Words: shadows, then outline, then fill. ----
  const unread = look.unreadOpacity ?? 1
  for (const p of placed) {
    let alpha = 1
    if (local < p.word.packStart) alpha = unread
    else if (unread < 1) alpha = unread + (1 - unread) * clamp01((local - p.word.packStart) / REVEAL_SECONDS)
    if (alpha <= 0.001) continue
    ctx.globalAlpha = tf.opacity * alpha
    setFont(p.size)
    const isReading = p.word === reading
    const fill = isReading && look.highlight?.color ? look.highlight.color : clip.color || 'white'
    const strokeW = clip.stroke && clip.stroke.width > 0 ? clip.stroke.width * (p.size / clip.fontSize) : 0
    // Text sits a little below the line box's top so descenders and outlines fit.
    const ty = p.y + p.size * 0.1

    for (const sh of look.shadows ?? []) {
      // Canvas shadows ignore the transform, so scale offsets/blur by the page animation.
      ctx.shadowColor = sh.color
      ctx.shadowBlur = sh.blur * p.size * sx
      ctx.shadowOffsetX = sh.offsetX * p.size * sx
      ctx.shadowOffsetY = sh.offsetY * p.size * sy
      if (strokeW > 0) {
        ctx.lineJoin = 'round'
        ctx.lineWidth = strokeW * 2
        ctx.strokeStyle = clip.stroke!.color
        ctx.strokeText(p.text, p.x, ty)
      } else {
        ctx.fillStyle = fill
        ctx.fillText(p.text, p.x, ty)
      }
    }
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    if (strokeW > 0) {
      ctx.lineJoin = 'round'
      ctx.lineWidth = strokeW * 2
      ctx.strokeStyle = clip.stroke!.color
      ctx.strokeText(p.text, p.x, ty)
    }
    ctx.fillStyle = fill
    ctx.fillText(p.text, p.x, ty)
    if (clip.underline) {
      // One continuous rule per line: each word's rule runs on through the following space.
      const thick = Math.max(1, p.size * 0.06)
      const uy = ty + p.size * 0.98
      const w = p.w + (lineEnds.has(p) ? 0 : space)
      if (strokeW > 0) {
        ctx.fillStyle = clip.stroke!.color
        ctx.fillRect(p.x - strokeW, uy - strokeW, w + strokeW * 2, thick + strokeW * 2)
        ctx.fillStyle = fill
      }
      ctx.fillRect(p.x, uy, w, thick)
    }
  }
  ctx.restore()
  return true
}

function stretchKeyword(pct: string): string {
  const n = parseFloat(pct)
  if (n >= 200) return 'ultra-expanded'
  if (n >= 150) return 'extra-expanded'
  if (n >= 125) return 'expanded'
  if (n >= 112.5) return 'semi-expanded'
  if (n <= 50) return 'ultra-condensed'
  if (n <= 62.5) return 'extra-condensed'
  if (n <= 75) return 'condensed'
  if (n <= 87.5) return 'semi-condensed'
  return 'normal'
}

/** Draws every visible text track at time t (later tracks on top). Returns whether anything was drawn. */
export function drawTextLayer(ctx: CanvasRenderingContext2D, project: Project, t: number, width: number, height: number): boolean {
  let drew = false
  for (const track of project.tracks) {
    if (track.type !== 'text' || track.hidden) continue
    for (const clip of track.clips as Clip[]) {
      if (clip.kind === 'text' && !clip.disabled && drawTextClip(ctx, clip, t, width, height)) drew = true
    }
  }
  return drew
}

/** Starts loading the bundled caption fonts so the first frames don't draw in a fallback face. */
export function preloadCaptionFonts(): Promise<unknown> {
  const fams = ['"TikTok Sans"', 'Montserrat', 'Archivo', 'Anton', '"Luckiest Guy"', 'Fredoka', 'Rubik']
  return Promise.all(fams.flatMap((f) => [document.fonts.load(`400 48px ${f}`), document.fonts.load(`900 48px ${f}`)])).catch(() => undefined)
}
