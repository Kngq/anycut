import type { ProjectCanvas, TextLook, TextShadow, TextStroke } from './types'

/**
 * Caption templates, rebuilt from the first entries of CapCut's "Trending" caption-template
 * category (panel `heycan`, category_key "trending"; packages read from the local effect cache
 * and the panel's cached listing; see handoff "Caption templates"). Each records the CapCut
 * template it follows and the values taken from it: content.json (font, fill, keyword colour,
 * canvas box, words per page/line), the effectStyle "flower" (outline + shadow stacks), and
 * the caption animation's Lua (page split, per-word colour, entrance curve).
 *
 * CapCut's ZY fonts and its other display fonts aren't redistributable, so each template uses
 * the closest bundled open font (SIL OFL / Apache) instead.
 *
 * Sizes are relative to the default caption size (5.5% of the canvas's short side). Outline
 * width is a fraction of the font size here and converted to px when applied.
 */
export interface CaptionTemplate {
  id: string
  name: string
  /** The CapCut template it's modelled on (Chinese title as shipped, and a translation). */
  basedOn: string
  font: string
  sizeScale: number
  color: string
  weight: number
  stroke?: { color: string; width: number }
  look: Omit<TextLook, 'templateId' | 'weight'>
}

const shadow = (color: string, offsetX: number, offsetY: number, blur: number): TextShadow => ({ color, offsetX, offsetY, blur })

export const CAPTION_TEMPLATES: CaptionTemplate[] = [
  {
    // 逐字出现 (#1): cream fill, soft olive drop shadow (offset 0.044/0.024 em, smooth 0.018),
    // words appear as they're spoken.
    id: 'word-reveal',
    name: 'Word by word',
    basedOn: '逐字出现 · Word-by-word appear',
    font: 'rubik',
    sizeScale: 1,
    color: '#FFFEC0',
    weight: 800,
    look: { shadows: [shadow('rgba(50, 50, 23, 0.92)', 0.044, 0.024, 0.06)], unreadOpacity: 0 }
  },
  {
    // 边框弹出 / 短文本边框弹出Ⅱ (#3, #4): "border pop", short pages with a heavy outline that
    // pop in; keyword colour (0.094, 0.992, 0.11) used for the spoken word.
    id: 'outline-pop',
    name: 'Outline pop',
    basedOn: '边框弹出 · Border pop',
    font: 'fredoka',
    sizeScale: 1.15,
    color: '#FFFFFF',
    weight: 700,
    stroke: { color: '#000000', width: 0.14 },
    look: { shadows: [shadow('rgba(0, 0, 0, 0.9)', 0.04, 0.05, 0)], wordsPerPage: 3, highlight: { color: '#18FD1C' }, animation: 'overshoot' }
  },
  {
    // 逐字弹出黑体 (#5): ZY Resolve caps, near-white, three stacked hard black shadows at -76°
    // (straight down), one word at a time with the 3512850 damped-spring pop.
    id: 'word-pop',
    name: 'Word pop',
    basedOn: '逐字弹出黑体 · Word-by-word pop',
    font: 'montserrat',
    sizeScale: 1.45,
    color: '#FDFBFB',
    weight: 900,
    look: {
      uppercase: true,
      shadows: [shadow('#000000', 0.025, 0.1, 0.02), shadow('#000000', 0.025, 0.1, 0.08)],
      wordsPerPage: 1,
      animation: 'pop'
    }
  },
  {
    // cc粉色滑块 (#6): pink rounded box (0.933, 0.478, 1; radius 0.4) behind the spoken word,
    // which is set larger (13.4 vs 11 pt) and the box slides between words.
    id: 'pink-slider',
    name: 'Pink slider',
    basedOn: 'cc粉色滑块 · Pink slider',
    font: 'fredoka',
    sizeScale: 1.1,
    color: '#FFFFFF',
    weight: 700,
    look: {
      shadows: [shadow('rgba(0, 0, 0, 0.35)', 0, 0.03, 0.08)],
      wordsPerPage: 3,
      highlight: { box: { color: '#EE7AFF', radius: 0.4, padX: 0.18, padY: 0.04 }, slide: true, scale: 1.22 }
    }
  },
  {
    // 新_逐词边框 (#8): 2 lines × 2 words per page, unread words at 40% (selector_word_unread
    // "ti" ×0.4), the spoken word on a deep-blue box (0, 0.231, 0.541; radius 0.279) whose
    // padding eases 0.265 → 0.2 over 0.5 s.
    id: 'word-box',
    name: 'Word box',
    basedOn: '新_逐词边框 · Per-word box',
    font: 'montserrat',
    sizeScale: 1.2,
    color: '#FCFBFD',
    weight: 900,
    look: {
      uppercase: true,
      shadows: [shadow('rgba(0, 0, 0, 0.1)', 0, 0, 0.023)],
      wordsPerPage: 4,
      wordsPerLine: 2,
      unreadOpacity: 0.4,
      highlight: { box: { color: '#003B8A', radius: 0.279, padX: 0.2, padY: 0.2 } }
    }
  },
  {
    // 逐字弹出综艺体 (#11): Obelix Pro caps, white, black outline 0.09 em, three soft black glows
    // (0.67/0.86/1.0 alpha, 0.17/0.12/0.07 em), one word at a time with the spring pop.
    id: 'cartoon-pop',
    name: 'Cartoon pop',
    basedOn: '逐字弹出综艺体 · Variety-show pop',
    font: 'luckiest',
    sizeScale: 1.45,
    color: '#FFFFFF',
    weight: 400,
    stroke: { color: '#000000', width: 0.09 },
    look: {
      uppercase: true,
      shadows: [shadow('rgba(0, 0, 0, 0.67)', 0, 0, 0.17), shadow('rgba(0, 0, 0, 0.86)', 0, 0, 0.12), shadow('#000000', 0, 0, 0.07)],
      wordsPerPage: 1,
      animation: 'pop'
    }
  },
  {
    // 弹出-粗体阴影 (#12): ZY Elegant-Black (wide caps), white, a soft core shadow plus faint
    // side shadows, one word at a time with the 3512851 0 → 120% → 100% scale.
    id: 'bold-shadow',
    name: 'Bold shadow',
    basedOn: '弹出-粗体阴影 · Pop, bold shadow',
    font: 'archivo-wide',
    sizeScale: 1.1,
    color: '#FFFFFF',
    weight: 900,
    look: {
      uppercase: true,
      shadows: [
        shadow('rgba(0, 0, 0, 0.52)', 0, 0, 0.083),
        shadow('rgba(0, 0, 0, 0.2)', -0.07, 0, 0.167),
        shadow('rgba(0, 0, 0, 0.2)', 0.07, 0, 0.167),
        shadow('rgba(0, 0, 0, 0.1)', -0.13, 0, 0.167)
      ],
      wordsPerPage: 1,
      animation: 'overshoot'
    }
  },
  {
    // The "useLetterColor" family (e.g. 7331663669589216518): 3 words per page, black outline
    // 0.06 em and a hard shadow at -30°; the 100455884 animation turns the word being spoken
    // yellow and the others back to white.
    id: 'karaoke',
    name: 'Karaoke',
    basedOn: '逐词高亮 · Word highlight (useLetterColor)',
    font: 'montserrat',
    sizeScale: 1.1,
    color: '#FFFFFF',
    weight: 900,
    stroke: { color: '#000000', width: 0.06 },
    look: { uppercase: true, shadows: [shadow('#000000', 0.078, 0.045, 0.002)], wordsPerPage: 3, highlight: { color: '#FFEF00' } }
  }
]

export function captionTemplate(id: string | undefined): CaptionTemplate | undefined {
  return CAPTION_TEMPLATES.find((t) => t.id === id)
}

/** The text fields a template sets (everything but position). */
export interface TemplateStyle {
  fontSize: number
  color: string
  bold: boolean
  fontFamily: string
  stroke?: TextStroke
  look: TextLook
}

export function templateStyle(tpl: CaptionTemplate, canvas: ProjectCanvas): TemplateStyle {
  const base = Math.round(Math.min(canvas.width, canvas.height) * 0.055)
  const fontSize = Math.round(base * tpl.sizeScale)
  return {
    fontSize,
    color: tpl.color,
    bold: tpl.weight >= 600,
    fontFamily: tpl.font,
    ...(tpl.stroke ? { stroke: { color: tpl.stroke.color, width: Math.max(1, Math.round(tpl.stroke.width * fontSize)) } } : {}),
    look: { ...structuredClone(tpl.look), templateId: tpl.id, weight: tpl.weight }
  }
}
