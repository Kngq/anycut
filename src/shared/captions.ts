import { clipSpeedSegments, effectiveDuration, type CaptionWord, type MediaClip, type Project, type ProjectCanvas, type TextClip } from './types'

/**
 * Auto-caption logic shared by the panel and the store: which clips get transcribed, how a word's
 * time in the SOURCE file maps onto the timeline, and how words are grouped into caption lines.
 * The speech-to-text itself runs in the main process (electron/main/captions.ts). Pure and
 * unit-tested.
 */

export type { CaptionWord }

/** A caption line ready to become a text clip (timeline seconds). */
export interface CaptionLine {
  start: number
  end: number
  text: string
  words: CaptionWord[]
}

/** A clip whose audio gets transcribed: the source range to read plus the clip itself, which is
 *  needed to map the words back onto the timeline. */
export interface CaptionSource {
  clipId: string
  path: string
  /** Source range to transcribe (seconds into the file). */
  from: number
  to: number
}

export type CaptionScope = 'main' | 'all' | 'selected'

/** Languages offered in the panel (Whisper codes). 'auto' lets the model detect it. */
export const CAPTION_LANGUAGES: { code: string; label: string }[] = [
  { code: 'auto', label: 'Detect automatically' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'pl', label: 'Polish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'th', label: 'Thai' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' }
]

/** Why a clip with audio was left out, for the panel to report. */
export interface SkippedClip {
  clipId: string
  reason: 'reversed' | 'frozen' | 'muted'
}

/**
 * The media clips to transcribe for a scope:
 *  - 'main': clips on the first video track (CapCut's default: the main track's speech);
 *  - 'all': every video and audio track;
 *  - 'selected': just the selected clip.
 * Only clips whose asset has audio. Muted, frozen and reversed clips are skipped and reported:
 * a frozen clip plays no sound, and reversed speech isn't words.
 */
export function captionSources(project: Project, scope: CaptionScope, selectedClipId: string | null): { sources: CaptionSource[]; skipped: SkippedClip[] } {
  const firstVideo = project.tracks.find((t) => t.type === 'video')
  const tracks =
    scope === 'main' ? (firstVideo ? [firstVideo] : []) : project.tracks.filter((t) => t.type === 'video' || t.type === 'audio')
  const sources: CaptionSource[] = []
  const skipped: SkippedClip[] = []
  for (const track of tracks) {
    if (track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'media') continue
      if (scope === 'selected' && clip.id !== selectedClipId) continue
      const asset = project.assets.find((a) => a.id === clip.assetId)
      if (!asset || !asset.hasAudio) continue
      if (clip.muted) skipped.push({ clipId: clip.id, reason: 'muted' })
      else if (clip.frozen) skipped.push({ clipId: clip.id, reason: 'frozen' })
      else if (clip.reversed) skipped.push({ clipId: clip.id, reason: 'reversed' })
      else sources.push({ clipId: clip.id, path: asset.path, from: clip.trimIn, to: clip.trimOut })
    }
  }
  return { sources, skipped }
}

/** Timeline time of a source time inside a (forward, non-frozen) clip, honoring its speed curve.
 *  Inverse of sourceTimeFor. Clamped to the clip's source range. */
export function timelineTimeForSource(clip: MediaClip, sourceTime: number): number {
  const s = Math.min(Math.max(sourceTime, clip.trimIn), clip.trimOut)
  let elapsed = 0
  for (const seg of clipSpeedSegments(clip)) {
    if (s <= seg.end) return clip.start + elapsed + (Math.max(s, seg.start) - seg.start) / seg.speed
    elapsed += (seg.end - seg.start) / seg.speed
  }
  return clip.start + effectiveDuration(clip)
}

/** Maps a clip's source-time words onto the timeline, dropping words outside its trimmed range. */
export function wordsToTimeline(clip: MediaClip, words: CaptionWord[]): CaptionWord[] {
  const out: CaptionWord[] = []
  for (const w of words) {
    if (w.end <= clip.trimIn || w.start >= clip.trimOut) continue
    const start = timelineTimeForSource(clip, w.start)
    const end = timelineTimeForSource(clip, w.end)
    if (end > start) out.push({ text: w.text, start, end })
  }
  return out
}

/** One timed piece of Whisper output (a word with `return_timestamps: 'word'`, a phrase with
 *  `return_timestamps: true`). Times are seconds into the audio that was transcribed. */
export interface AsrChunk {
  text: string
  timestamp: [number, number | null]
}

/**
 * Whisper's cross-attention word alignment sometimes fails outright: every word lands on one
 * instant, typically 29.98 s (the end of Whisper's padded 30 s input) even for a 16 s clip.
 * Those words fall outside the clip and are dropped, so a clip full of speech came back as
 * "no speech". This spots that: most words starting past the end of the audio, or (with
 * several words) all of them having zero length.
 */
export function wordAlignmentFailed(chunks: AsrChunk[], durationS: number): boolean {
  const words = chunks.filter((c) => c.text.trim().length > 0)
  if (words.length === 0) return false
  const pastEnd = words.filter((c) => c.timestamp[0] > durationS + 0.25).length
  const zeroLength = words.filter((c) => (c.timestamp[1] ?? c.timestamp[0]) - c.timestamp[0] <= 0).length
  return pastEnd > words.length / 2 || (words.length >= 3 && zeroLength === words.length)
}

/** Word chunks → words in the audio's time, offset by `offset`, clamped into [0, durationS]. */
export function chunksToWords(chunks: AsrChunk[], offset: number, durationS: number): CaptionWord[] {
  const out: CaptionWord[] = []
  const clamp = (t: number) => Math.min(Math.max(t, 0), durationS)
  for (const c of chunks) {
    const text = c.text.trim()
    if (!text) continue
    const start = clamp(c.timestamp[0])
    const end = Math.max(clamp(c.timestamp[1] ?? c.timestamp[0]), Math.min(start + 0.05, durationS))
    out.push({ text, start: start + offset, end: end + offset })
  }
  return out
}

/**
 * Fallback when word alignment failed: phrase-level chunks (`return_timestamps: true`, which
 * come from Whisper's own timestamp tokens, not the alignment) split into words, each phrase's
 * time shared out by word length. Coarser than real word times, but correctly placed.
 */
export function spreadPhraseWords(phrases: AsrChunk[], offset: number, durationS: number): CaptionWord[] {
  const out: CaptionWord[] = []
  const clamp = (t: number) => Math.min(Math.max(t, 0), durationS)
  for (const p of phrases) {
    const words = p.text.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) continue
    const start = clamp(p.timestamp[0])
    const end = Math.max(clamp(p.timestamp[1] ?? durationS), start)
    const weights = words.map((w) => w.length + 1)
    const total = weights.reduce((a, b) => a + b, 0)
    let t = start
    words.forEach((text, i) => {
      const next = i === words.length - 1 ? end : t + ((end - start) * weights[i]) / total
      out.push({ text, start: t + offset, end: next + offset })
      t = next
    })
  }
  return out
}

export interface SegmentOptions {
  /** Longest line, in characters (CapCut-style short lines). */
  maxChars: number
  /** Longest a line stays on screen, seconds. CapCut's captions top out at exactly 3.0 s. */
  maxDuration: number
  /** A silence at least this long (seconds) starts a new line. */
  maxGap: number
  /** Snap line boundaries to this frame rate (CapCut's land on the project's frame grid). */
  fps?: number
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = { maxChars: 32, maxDuration: 3, maxGap: 0.6 }

const SENTENCE_END = /[.!?…。！？]$/
const CLAUSE_END = /[,;:，、]$/

/** A word with CapCut's "packed" times: when it counts as being spoken for highlighting. */
export interface PackedWord extends CaptionWord {
  packStart: number
  packEnd: number
}

/**
 * CapCut's word-time packing, ported from the caption engine's `initCaptionInfo` (Lua, shipped
 * inside every caption animation package as modules/CaptionModule.lua). Raw recogniser times
 * leave gaps between words; packing hands each gap to its neighbours so a highlight doesn't
 * flicker off between words:
 *  - a word that starts before the previous one ends is pushed to that end;
 *  - a gap up to `timeSpace` is shared: the earlier word keeps `extendRight` of it, the later
 *    word starts `extendLeft` of it early (CapCut's default 0.5/0.5 meets in the middle; the
 *    per-word highlight templates use splitPage(0, 1), i.e. a word stays lit until the next one);
 *  - a longer gap is only bridged towards its midpoint, so a real pause still reads as one.
 */
export function packWordTimes(words: CaptionWord[], extendLeft = 0.5, extendRight = 0.5, timeSpace = 1): PackedWord[] {
  const right = Math.min(Math.max(extendRight, 0), 1)
  const left = Math.min(Math.max(extendLeft, 0), 1 - right)
  const out: PackedWord[] = words.map((w) => ({ ...w, packStart: w.start, packEnd: w.end }))
  for (let i = 0; i + 1 < out.length; i++) {
    const cur = out[i]
    const next = out[i + 1]
    if (next.start < cur.end) {
      next.packStart = Math.max(next.packStart, cur.end)
      continue
    }
    const gap = next.start - cur.end
    const share = gap > timeSpace ? gap / 2 : gap
    cur.packEnd = cur.end + share * right
    next.packStart = next.start - share * left
  }
  for (const w of out) w.packEnd = Math.max(w.packEnd, w.packStart)
  return out
}

/**
 * Groups timeline-ordered words into caption lines. A line ends:
 *  - after a word ending a sentence;
 *  - before a pause of `maxGap` or more;
 *  - before the line would exceed `maxChars` or `maxDuration`;
 *  - after a clause comma, once the line is already more than half full (reads more naturally
 *    than breaking mid-clause).
 * Line times follow CapCut: a line starts on its first word and ends on its last, using packed
 * word times, so consecutive lines butt together across short pauses (76% of CapCut captions
 * measured in real projects touch the next one) and leave a gap across long ones. Boundaries
 * snap to the frame grid when `fps` is given.
 */
export function segmentWords(words: CaptionWord[], opts: SegmentOptions = DEFAULT_SEGMENT_OPTIONS): CaptionLine[] {
  const sorted = words.map((w) => ({ ...w, text: w.text.trim() })).filter((w) => w.text.length > 0).sort((a, b) => a.start - b.start)
  const packed = packWordTimes(sorted)
  const groups: PackedWord[][] = []
  let cur: PackedWord[] = []
  const textOf = (ws: CaptionWord[]) => ws.map((w) => w.text).join(' ')

  for (const w of packed) {
    if (cur.length > 0) {
      const last = cur[cur.length - 1]
      const tooLong = textOf([...cur, w]).length > opts.maxChars
      const tooSlow = w.end - cur[0].start > opts.maxDuration
      const gap = w.start - last.end >= opts.maxGap
      const sentence = SENTENCE_END.test(last.text)
      const clause = CLAUSE_END.test(last.text) && textOf(cur).length > opts.maxChars / 2
      if (tooLong || tooSlow || gap || sentence || clause) {
        groups.push(cur)
        cur = []
      }
    }
    cur.push(w)
  }
  if (cur.length > 0) groups.push(cur)

  const snap = (t: number) => (opts.fps ? Math.round(t * opts.fps) / opts.fps : t)
  const minLen = opts.fps ? 1 / opts.fps : 0.1
  return groups.map((g, i) => {
    const start = snap(Math.max(0, g[0].packStart))
    let end = snap(g[g.length - 1].packEnd)
    if (i + 1 < groups.length) end = Math.min(end, snap(Math.max(0, groups[i + 1][0].packStart)))
    end = Math.max(end, start + minLen)
    return { start, end, text: textOf(g), words: g.map(({ text, start, end }) => ({ text, start, end })) }
  })
}

/** Turns per-clip transcriptions into caption lines on the timeline. */
export function captionLinesFor(project: Project, results: { clipId: string; words: CaptionWord[] }[], opts?: SegmentOptions): CaptionLine[] {
  const timelineWords: CaptionWord[] = []
  for (const r of results) {
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === r.clipId)
      if (clip && clip.kind === 'media') timelineWords.push(...wordsToTimeline(clip, r.words))
    }
  }
  return segmentWords(timelineWords, opts)
}

/** The look fields a caption carries. Templates (captionTemplates.ts) set these, and "apply to
 *  all captions" copies them from one clip to the rest. */
export type CaptionStyle = Pick<TextClip, 'fontSize' | 'color' | 'bold' | 'italic' | 'underline' | 'textCase' | 'fontFamily' | 'stroke' | 'look'> & { y: number }

/** CapCut-like default: bold white with a dark outline, in the lower third. */
export function defaultCaptionStyle(canvas: ProjectCanvas): CaptionStyle {
  const fontSize = Math.round(Math.min(canvas.width, canvas.height) * 0.055)
  return { fontSize, color: 'white', bold: true, fontFamily: 'sans', stroke: { color: 'black', width: Math.max(2, Math.round(fontSize * 0.08)) }, y: 0.8 }
}

export function captionStyleOf(clip: TextClip): CaptionStyle {
  return { fontSize: clip.fontSize, color: clip.color, bold: clip.bold, italic: clip.italic, underline: clip.underline, textCase: clip.textCase, fontFamily: clip.fontFamily, stroke: clip.stroke, look: clip.look, y: clip.transform.y }
}

/** Longest line (characters) that fits 90% of the canvas width at this font size, capped at the
 *  default. Uses ~0.6 em per character, a safe average for bold sans text. */
export function captionMaxChars(canvas: ProjectCanvas, fontSize: number): number {
  return Math.max(12, Math.min(DEFAULT_SEGMENT_OPTIONS.maxChars, Math.floor((canvas.width * 0.9) / (fontSize * 0.6))))
}
