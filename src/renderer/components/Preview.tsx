import { useEffect, useRef, useState } from 'react'
import { animatedTransformCached } from '@shared/animations'
import { filterDef } from '@shared/filters'
import { renderFiltered } from '../filterRenderer'
import { useProjectStore } from '../state/projectStore'
import type { Clip, ClipTransform, MediaAsset, MediaClip, Project, Track } from '@shared/types'
import { clipFadeGain, clipSpeedAt, interpolateTransform, isFullCrop, projectDuration, sourceTimeFor, formatMMSS } from '@shared/types'
import { applyPostEffects, effectGeometry } from '@shared/effects'
import { compositeTransition, getTransitionLayer, transitionLayerCanvas } from '../transitions'
import { drawTextLayer, preloadCaptionFonts, textBlockBounds } from '../textRender'
import { offsetTransform, pointInBox, scaleTransform, snapAxis, type CanvasBox } from '@shared/transformEdit'
import { useCropEditor } from './CropDialog'
import '../preview.css'

void preloadCaptionFonts()

/** Seek-driven elements (paused scrub, reversed, frozen) re-seek once off by more than this:
 *  about half a frame, so scrubbing and reverse playback land on the exact frame. Seeks are never
 *  stacked (see syncMediaElement), so a small threshold doesn't flood the decoder. */
const SEEK_DRIFT_THRESHOLD = 0.017
/** Clips starting within this many seconds of the playhead get their <video> loaded and parked on
 *  their first frame ahead of time, so a cut / transition / freeze frame doesn't flash black while
 *  a cold element loads. */
const PRELOAD_AHEAD = 1.5
/** Long edge of the held-frame snapshot (see frameFor): enough to look right for the few frames
 *  it's shown, small enough to keep one per clip cheap. */
const HOLD_FRAME_MAX = 1280
/** Held frames kept (most recently used): a few clips' worth, so scrubbing back and forth across
 *  cuts always has something to show. ~3.7 MB each at HOLD_FRAME_MAX. */
const HOLD_FRAME_COUNT = 16
/** While free-running, drift below this (seconds) is ignored entirely — the element's own
 *  clock is trusted. Roughly 3-4 frames at 30fps. */
const PLAYBACK_DRIFT_TOLERANCE = 0.12
/** While free-running, a drift above this (seconds) is treated as a real discontinuity (clip
 *  switch, loop, large scrub) and corrected with a hard seek rather than a playbackRate nudge. */
const RESYNC_SEEK_THRESHOLD = 0.6
/** Screen pixels within which a dragged clip's centre snaps to the canvas centre lines. */
const SNAP_PX = 6
/** Screen pixels the pointer must travel before a press on a clip becomes a drag (a plain click
 *  only selects). */
const DRAG_START_PX = 2
/** Fullscreen: hide the transport after this long without pointer movement. */
const FULLSCREEN_IDLE_MS = 2500

/** An in-progress preview gesture: moving a clip, or scaling it from a corner handle. */
interface PreviewDrag {
  clipId: string
  mode: 'move' | 'scale'
  kind: 'media' | 'text'
  /** Project before the gesture, recorded as one undo step on release. */
  before: Project
  start: ClipTransform
  box: CanvasBox
  /** Pointer position at press, canvas px. */
  px: number
  py: number
  /** Client position at press (drag threshold is in screen px). */
  clientX: number
  clientY: number
  active: boolean
  snapX: boolean
  snapY: boolean
}

interface ActiveMedia {
  clip: MediaClip
  asset: MediaAsset
  alpha: number
  /** Set while a transition is running: which layer (0 = outgoing, 1 = incoming) this clip
   *  renders into, so the two can be composited per transition type instead of alpha-blended. */
  layer?: 0 | 1
}

interface ActiveTransition {
  type: import('@shared/types').TransitionType
  progress: number
}

function findActiveMedia(
  track: Track,
  assetById: Map<string, MediaAsset>,
  t: number
): { items: ActiveMedia[]; transition: ActiveTransition | null } {
  let transition: ActiveTransition | null = null
  const clips = track.clips.filter((c): c is MediaClip => c.kind === 'media')
  const result: ActiveMedia[] = []
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    if (t < clip.start || t >= clip.start + clip.duration) continue
    // Deactivated clips are skipped (the main roll shows black in their slot, like export).
    if (clip.disabled) continue
    const asset = assetById.get(clip.assetId)
    if (!asset) continue

    const d = clip.transitionIn?.duration ?? 0
    if (d > 0 && t < clip.start + d && i > 0) {
      const prev = clips[i - 1]
      const prevAsset = prev.disabled ? undefined : assetById.get(prev.assetId)
      const progress = (t - clip.start) / d
      if (prevAsset) {
        transition = { type: clip.transitionIn!.type, progress }
        result.push({ clip: prev, asset: prevAsset, alpha: 1, layer: 0 })
        result.push({ clip, asset, alpha: 1, layer: 1 })
      } else {
        result.push({ clip, asset, alpha: 1 })
      }
    } else {
      result.push({ clip, asset, alpha: 1 })
    }
  }
  return { items: result, transition }
}

/** Draws media "contain"-fit within the canvas, then scaled and re-centered by the clip's
 *  (possibly keyframed) transform: `scale` enlarges around the fit size, `x`/`y` (0-1) move
 *  the center away from the canvas middle. Clip effects are folded in: geometry effects
 *  (shake/Ken Burns) adjust the draw scale/center before `drawImage`, and pixel effects
 *  (blur/vignette/grain/B&W/flash/mirror) are applied to the drawn region afterward via
 *  applyPostEffects — the same stack the exporter mirrors in shared/effects.ts. */
function drawContain(
  ctx: CanvasRenderingContext2D,
  media: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  canvasW: number,
  canvasH: number,
  alpha: number,
  transform: { x: number; y: number; scale: number; rotation?: number; flipH?: boolean },
  effects: MediaClip['effects'],
  localT: number,
  clipDuration: number,
  crop?: MediaClip['crop'],
  filter?: MediaClip['filter']
) {
  const fullW = media instanceof HTMLVideoElement ? media.videoWidth : media instanceof HTMLImageElement ? media.naturalWidth : media.width
  const fullH = media instanceof HTMLVideoElement ? media.videoHeight : media instanceof HTMLImageElement ? media.naturalHeight : media.height
  if (!fullW || !fullH) return
  // Crop: draw only the source window, fitted as if it were the whole frame (export crops the
  // same way before its fit/scale).
  const c = crop && !isFullCrop(crop) ? crop : { x: 0, y: 0, w: 1, h: 1 }
  const sx = fullW * c.x
  const sy = fullH * c.y
  const mw = Math.max(1, fullW * c.w)
  const mh = Math.max(1, fullH * c.h)
  const geo = effectGeometry(effects, localT, clipDuration)
  const fit = Math.min(canvasW / mw, canvasH / mh) * transform.scale * geo.scale
  const w = mw * fit
  const h = mh * fit
  const cx = canvasW * (transform.x + geo.dx)
  const cy = canvasH * (transform.y + geo.dy)
  const rotation = transform.rotation ?? 0
  const flipH = transform.flipH ?? false
  // Filter: grade the clip's own pixels (at the size they're drawn, capped at the source size)
  // on the GPU, then draw that instead of the raw frame. Same LUT as export.
  let img: CanvasImageSource = media
  let isx = sx
  let isy = sy
  let imw = mw
  let imh = mh
  const fdef = filter && filter.intensity > 0 ? filterDef(filter.id) : undefined
  if (fdef) {
    const k = Math.min(1, Math.max(Math.abs(w) / mw, Math.abs(h) / mh, 0.25))
    let graded: HTMLCanvasElement | null = null
    try {
      graded = renderFiltered(media, fullW, fullH, { sx, sy, sw: mw, sh: mh }, mw * k, mh * k, fdef, filter!.intensity, localT)
    } catch (err) {
      console.warn('[filters] preview grading failed', err)
    }
    if (graded) {
      img = graded
      isx = 0
      isy = 0
      imw = graded.width
      imh = graded.height
    }
  }
  const prevAlpha = ctx.globalAlpha
  ctx.globalAlpha = alpha
  if (rotation !== 0 || flipH) {
    // Rotate/mirror about the clip's center: move the origin there, apply rotation (degrees ->
    // radians) and a horizontal flip (scaleX = -1), then draw centered on the new origin.
    ctx.save()
    ctx.translate(cx, cy)
    if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180)
    if (flipH) ctx.scale(-1, 1)
    ctx.drawImage(img, isx, isy, imw, imh, -w / 2, -h / 2, w, h)
    ctx.restore()
  } else {
    ctx.drawImage(img, isx, isy, imw, imh, cx - w / 2, cy - h / 2, w, h)
  }
  ctx.globalAlpha = prevAlpha
  // Pixel effects operate on the whole canvas region (the frame fills it after contain-fit +
  // any over-scale), so pass the full canvas rect. Mirror/blur read back canvas pixels, which
  // is why this runs after the draw, not before.
  applyPostEffects(ctx, effects, { x: 0, y: 0, w: canvasW, h: canvasH }, localT)
}

/** Draws a visible error banner instead of leaving a clip silently black/soundless. */
let audioCtx: AudioContext | null = null
const gainNodes = new WeakMap<HTMLMediaElement, GainNode>()
/** A gain node for an <audio> element, created on first need. Once an element is routed through
 *  Web Audio it stays routed (createMediaElementSource is one-shot), so the node is kept and set
 *  back to 1 when the volume drops to 100% or below. */
function audioGain(el: HTMLMediaElement): GainNode | null {
  const existing = gainNodes.get(el)
  if (existing) return existing
  try {
    audioCtx ??= new AudioContext()
    const src = audioCtx.createMediaElementSource(el)
    const gain = audioCtx.createGain()
    src.connect(gain).connect(audioCtx.destination)
    gainNodes.set(el, gain)
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    return gain
  } catch (err) {
    console.warn('[anycut preview] volume above 100% unavailable', err)
    return null
  }
}

function drawMediaError(ctx: CanvasRenderingContext2D, canvasW: number, canvasH: number, assetName: string, message: string) {
  const padding = 16
  const lineHeight = Math.max(canvasH * 0.028, 16)
  ctx.save()
  ctx.fillStyle = 'rgba(120, 20, 20, 0.85)'
  ctx.fillRect(0, canvasH / 2 - lineHeight * 2, canvasW, lineHeight * 4)
  ctx.fillStyle = 'white'
  ctx.font = `bold ${lineHeight}px 'TikTok Sans', sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`Can't play "${assetName}"`, canvasW / 2, canvasH / 2 - lineHeight * 0.6, canvasW - padding * 2)
  ctx.font = `${lineHeight * 0.75}px 'TikTok Sans', sans-serif`
  ctx.fillText(message, canvasW / 2, canvasH / 2 + lineHeight * 0.8, canvasW - padding * 2)
  ctx.restore()
}

/** A "media offline" placeholder (source file moved/renamed/unplugged) drawn where the clip would be. */
function drawOffline(ctx: CanvasRenderingContext2D, canvasW: number, canvasH: number, assetName: string) {
  const lh = Math.max(canvasH * 0.026, 16)
  ctx.save()
  ctx.fillStyle = '#2a1416'
  ctx.fillRect(0, 0, canvasW, canvasH)
  ctx.strokeStyle = 'rgba(220, 80, 80, 0.5)'
  ctx.lineWidth = Math.max(2, canvasW * 0.004)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(canvasW, canvasH)
  ctx.moveTo(canvasW, 0)
  ctx.lineTo(0, canvasH)
  ctx.stroke()
  ctx.fillStyle = 'white'
  ctx.font = `bold ${lh * 1.2}px 'TikTok Sans', sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('Media offline', canvasW / 2, canvasH / 2 - lh * 0.8, canvasW - 32)
  ctx.font = `${lh * 0.8}px 'TikTok Sans', sans-serif`
  ctx.fillText(assetName, canvasW / 2, canvasH / 2 + lh * 0.8, canvasW - 32)
  ctx.restore()
}

/** HTMLMediaElement.error.code -> a human-readable reason, since MediaError.message is often
 *  empty in practice (Chromium doesn't always fill it in). */
function mediaErrorReason(code: number): string {
  switch (code) {
    case 1:
      return 'loading aborted'
    case 2:
      return 'network error'
    case 3:
      return 'decoding failed (corrupt file or unsupported encoding)'
    case 4:
      return 'source not supported (unsupported format/codec, or the file could not be read)'
    default:
      return 'unknown error'
  }
}

export default function Preview() {
  // Subscribed so the time readout under the preview re-renders as playback advances / clips
  // change. The canvas render loop reads the store imperatively via getState(); these hooks are
  // only for the readout below.
  const playhead = useProjectStore((s) => s.playhead)
  const project = useProjectStore((s) => s.project)
  const previewAssetId = useProjectStore((s) => s.previewAssetId)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying)
  const setPlayhead = useProjectStore((s) => s.setPlayhead)
  const duration = projectDuration(project)
  const previewAsset = previewAssetId ? project.assets.find((a) => a.id === previewAssetId) ?? null : null
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  // The preview bar's Crop button: shown while a video/image clip on a video track is selected.
  const cropTarget = (() => {
    if (!selectedClipId || previewAssetId) return null
    for (const track of project.tracks) {
      if (track.type !== 'video') continue
      const clip = track.clips.find((c) => c.id === selectedClipId)
      if (!clip || clip.kind !== 'media') continue
      const asset = project.assets.find((a) => a.id === clip.assetId)
      return asset && asset.kind !== 'audio' ? clip : null
    }
    return null
  })()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsIdle, setControlsIdle] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoPoolRef = useRef<Map<string, HTMLVideoElement>>(new Map())
  const imagePoolRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const audioPoolRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const rafRef = useRef<number>(0)
  const lastTickRef = useRef<number>(0)
  // Standalone playback position (seconds) for a single raw asset being previewed from the
  // MediaBin, independent of the timeline playhead.
  const previewClockRef = useRef<number>(0)
  const previewAssetIdRef = useRef<string | null>(null)
  // Per-clip playback problems, surfaced on canvas instead of failing silently — a clip whose
  // <video>/<audio> element can't load or play used to just never draw/sound with zero
  // indication why. Cleared the moment that element plays or loads successfully again.
  const errorsRef = useRef<Map<string, string>>(new Map())
  // Codec safety-net: readyState/canplay can lie (observed with ProRes — demuxes fine, reports
  // HAVE_ENOUGH_DATA, but videoWidth/videoHeight never leave 0, no error event ever fires).
  // ensurePreviewProxy catches known-bad codecs proactively at import; this catches anything
  // that slips through, by timing how long a clip has looked "ready" with no actual frame.
  const zeroSizeStartRef = useRef<Map<string, number>>(new Map())
  // Last decoded frame per clip (see frameFor), shown while that clip's <video> is seeking or not
  // ready yet instead of leaving its slot black.
  const frameCacheRef = useRef<Map<string, { canvas: HTMLCanvasElement; time: number; src: string; assetId: string }>>(new Map())
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // Selection overlay: a layer exactly over the canvas's drawn area (pointer target for
  // select/move/scale), the selected clip's box with corner handles, and the centre guides.
  // Positioned imperatively from the render loop (no React re-render per frame).
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const selBoxRef = useRef<HTMLDivElement | null>(null)
  const guideVRef = useRef<HTMLDivElement | null>(null)
  const guideHRef = useRef<HTMLDivElement | null>(null)
  const overlayStyleCache = useRef<Map<HTMLElement, string>>(new Map())
  const dragRef = useRef<PreviewDrag | null>(null)

  /** Sets an element's inline style only when it changed (the loop runs every frame). */
  function setCss(el: HTMLElement | null, css: string) {
    if (!el || overlayStyleCache.current.get(el) === css) return
    overlayStyleCache.current.set(el, css)
    el.style.cssText = css
  }

  /** Source frame size of a media clip as drawn (before crop), from its live element when loaded. */
  function sourceSize(clip: MediaClip, asset: MediaAsset): { w: number; h: number } | null {
    if (asset.kind === 'image') {
      const img = imagePoolRef.current.get(asset.id)
      const w = img?.naturalWidth || asset.width || 0
      const h = img?.naturalHeight || asset.height || 0
      return w && h ? { w, h } : null
    }
    const v = videoPoolRef.current.get(clip.id)
    const w = v?.videoWidth || asset.width || 0
    const h = v?.videoHeight || asset.height || 0
    return w && h ? { w, h } : null
  }

  /** Where a clip sits on the canvas at timeline time t (canvas px), matching drawContain /
   *  drawTextClip — or null if it isn't on screen then. Effect geometry (shake, Ken Burns) is
   *  left out on purpose so the box doesn't jitter. */
  function clipBoxAt(project: Project, clip: Clip, t: number): CanvasBox | null {
    if (clip.disabled || t < clip.start || t >= clip.start + clip.duration) return null
    const { width: W, height: H } = project.canvas
    if (clip.kind === 'text') {
      const b = textBlockBounds.get(clip.id)
      if (!b) return null
      return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, rot: 0 }
    }
    if (clip.kind !== 'media') return null
    const asset = project.assets.find((a) => a.id === clip.assetId)
    if (!asset || asset.kind === 'audio') return null
    const size = sourceSize(clip, asset)
    if (!size) return null
    const c = clip.crop && !isFullCrop(clip.crop) ? clip.crop : { x: 0, y: 0, w: 1, h: 1 }
    const mw = Math.max(1, size.w * c.w)
    const mh = Math.max(1, size.h * c.h)
    const tf = interpolateTransform(animatedTransformCached(clip), t - clip.start)
    const fit = Math.min(W / mw, H / mh) * tf.scale
    return { cx: W * tf.x, cy: H * tf.y, w: mw * fit, h: mh * fit, rot: clip.transform.rotation ?? 0 }
  }

  /** Clips under canvas point (px, py) at time t, topmost first: text (always drawn last), then
   *  video tracks from the top down; within a track the later clip wins (a transition's
   *  incoming clip). */
  function clipsUnder(project: Project, t: number, px: number, py: number): Clip[] {
    const hits: Clip[] = []
    const scan = (type: Track['type']) => {
      for (const track of [...project.tracks].reverse()) {
        if (track.type !== type || track.hidden) continue
        for (const clip of [...track.clips].reverse()) {
          if (type === 'video' && clip.kind === 'media' && interpolateTransform(animatedTransformCached(clip), t - clip.start).opacity <= 0.01) continue
          const box = clipBoxAt(project, clip, t)
          if (box && pointInBox(box, px, py)) hits.push(clip)
        }
      }
    }
    scan('text')
    scan('video')
    return hits
  }

  function findClipById(project: Project, clipId: string): Clip | null {
    for (const track of project.tracks) {
      if (track.hidden || (track.type !== 'video' && track.type !== 'text')) continue
      const clip = track.clips.find((c) => c.id === clipId)
      if (clip) return clip
    }
    return null
  }

  /** Canvas px per CSS px is 1/k; returns the overlay's rect and k (CSS px per canvas px). */
  function overlayScale(project: Project) {
    const layer = overlayRef.current
    if (!layer) return null
    const rect = layer.getBoundingClientRect()
    if (!rect.width) return null
    return { rect, k: rect.width / project.canvas.width }
  }

  /** Called at the end of every rendered frame: keeps the overlay over the canvas and the
   *  selection box on the selected clip. */
  function syncOverlay(state: ReturnType<typeof useProjectStore.getState>, t: number) {
    const canvas = canvasRef.current
    const layer = overlayRef.current
    if (!canvas || !layer) return
    const { width: W, height: H } = state.project.canvas
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    // Sub-pixel exact (offsetLeft/Top round): the canvas is centred in the wrap, often at .5 px.
    const cr = canvas.getBoundingClientRect()
    const wr = (layer.offsetParent ?? canvas.parentElement)?.getBoundingClientRect()
    const left = cr.left - (wr?.left ?? 0) + canvas.clientLeft
    const top = cr.top - (wr?.top ?? 0) + canvas.clientTop
    setCss(layer, `left:${left.toFixed(2)}px;top:${top.toFixed(2)}px;width:${cw}px;height:${ch}px`)
    const k = cw / W
    const clip = !state.previewAssetId && state.selectedClipId ? findClipById(state.project, state.selectedClipId) : null
    const box = clip && k > 0 ? clipBoxAt(state.project, clip, t) : null
    if (!box) {
      setCss(selBoxRef.current, 'display:none')
    } else {
      const w = Math.abs(box.w) * k
      const h = Math.abs(box.h) * k
      setCss(
        selBoxRef.current,
        `left:${(box.cx * k - w / 2).toFixed(1)}px;top:${(box.cy * k - h / 2).toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;transform:rotate(${box.rot}deg)`
      )
    }
    const drag = dragRef.current
    setCss(guideVRef.current, drag?.active && drag.snapX ? `left:${((W / 2) * k).toFixed(1)}px` : 'display:none')
    setCss(guideHRef.current, drag?.active && drag.snapY ? `top:${((H / 2) * k).toFixed(1)}px` : 'display:none')
  }

  /** Press on the preview: pick the clip under the pointer (keeping the current selection when
   *  the press is inside it, so a clip under an overlay can still be dragged), then drag to move
   *  it or, from a corner handle, to scale it. Clicking empty canvas deselects. */
  function onOverlayPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const state = useProjectStore.getState()
    if (state.previewAssetId) return
    const geo = overlayScale(state.project)
    if (!geo) return
    e.preventDefault()
    const { rect, k } = geo
    const px = (e.clientX - rect.left) / k
    const py = (e.clientY - rect.top) / k
    const t = state.playhead
    const project = state.project
    const corner = (e.target as HTMLElement).closest('[data-corner]') !== null
    const selected = state.selectedClipId ? findClipById(project, state.selectedClipId) : null
    const selectedBox = selected ? clipBoxAt(project, selected, t) : null
    let target: Clip | null = null
    if (selected && selectedBox && (corner || pointInBox(selectedBox, px, py, 2 / k))) target = selected
    else target = clipsUnder(project, t, px, py)[0] ?? null
    if (!target) {
      if (state.selectedClipId) state.selectClip(null)
      return
    }
    if (target.id !== state.selectedClipId) state.selectClip(target.id)
    const box = clipBoxAt(project, target, t)
    if (!box) return
    dragRef.current = {
      clipId: target.id,
      mode: corner && target === selected ? 'scale' : 'move',
      kind: target.kind === 'text' ? 'text' : 'media',
      before: project,
      start: target.transform,
      box,
      px,
      py,
      clientX: e.clientX,
      clientY: e.clientY,
      active: false,
      snapX: false,
      snapY: false
    }
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      if (!drag.active && Math.hypot(ev.clientX - drag.clientX, ev.clientY - drag.clientY) < DRAG_START_PX) return
      drag.active = true
      const s = useProjectStore.getState()
      const g = overlayScale(s.project)
      if (!g) return
      const qx = (ev.clientX - g.rect.left) / g.k
      const qy = (ev.clientY - g.rect.top) / g.k
      const { width: W, height: H } = s.project.canvas
      if (drag.mode === 'scale') {
        const d0 = Math.hypot(drag.px - drag.box.cx, drag.py - drag.box.cy)
        const d1 = Math.hypot(qx - drag.box.cx, qy - drag.box.cy)
        s.setClipTransform(drag.clipId, scaleTransform(drag.start, d1 / Math.max(d0, 1)))
        return
      }
      const sx = snapAxis(drag.box.cx + qx - drag.px, W / 2, SNAP_PX / g.k)
      const sy = snapAxis(drag.box.cy + qy - drag.py, H / 2, SNAP_PX / g.k)
      drag.snapX = sx.snapped
      drag.snapY = sy.snapped
      const dxPx = sx.value - drag.box.cx
      const dyPx = sy.value - drag.box.cy
      // Media position is the centre as a canvas fraction; text position places the block's
      // top-left at (canvas - block) × fraction, so a pixel move spans canvas - block.
      const spanX = drag.kind === 'text' ? W - drag.box.w : W
      const spanY = drag.kind === 'text' ? H - drag.box.h : H
      const fx = Math.abs(spanX) > 1 ? dxPx / spanX : 0
      const fy = Math.abs(spanY) > 1 ? dyPx / spanY : 0
      s.setClipTransform(drag.clipId, offsetTransform(drag.start, fx, fy))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const drag = dragRef.current
      dragRef.current = null
      // One undo step for the whole gesture (the live updates above recorded none).
      if (drag?.active) useProjectStore.getState().recordUndoPoint(drag.before)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Full screen: the whole preview block (canvas + transport) goes full screen; the button and
  // Esc (handled by the browser) leave it.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null && document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void wrapRef.current?.requestFullscreen().catch((err: unknown) => console.warn('[anycut preview] fullscreen refused', err))
  }
  // In full screen the transport fades out after a moment without pointer movement.
  const idleTimerRef = useRef<number>(0)
  function wakeControls() {
    if (!isFullscreen) return
    setControlsIdle(false)
    window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(() => setControlsIdle(true), FULLSCREEN_IDLE_MS)
  }
  useEffect(() => {
    if (isFullscreen) wakeControls()
    else {
      window.clearTimeout(idleTimerRef.current)
      setControlsIdle(false)
    }
    return () => window.clearTimeout(idleTimerRef.current)
  }, [isFullscreen]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * What to draw for a clip's <video> this frame. A <video> has no frame to give while it's
   * seeking or before its first frame decodes (readyState < HAVE_CURRENT_DATA): drawing it then
   * yields nothing, so the canvas showed black. That happened on every seek, which is constant for
   * reversed clips (reverse playback is seek-driven), on scrubbing, and on a cold element at a
   * cut. Every good frame is snapshotted per clip, and the snapshot stands in until the element
   * has a frame again. Returns null only before the clip has ever decoded a frame.
   */
  function frameFor(clipId: string, assetId: string, video: HTMLVideoElement): HTMLVideoElement | HTMLCanvasElement | null {
    const cache = frameCacheRef.current
    const ready = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
    const entry = cache.get(clipId)
    if (entry) {
      // Re-insert: Map order is the LRU order.
      cache.delete(clipId)
      cache.set(clipId, entry)
    }
    if (ready && !video.seeking) {
      if (!entry || entry.time !== video.currentTime || entry.src !== video.currentSrc) {
        const k = Math.min(1, HOLD_FRAME_MAX / Math.max(video.videoWidth, video.videoHeight))
        const w = Math.max(1, Math.round(video.videoWidth * k))
        const h = Math.max(1, Math.round(video.videoHeight * k))
        const canvas = entry?.canvas ?? document.createElement('canvas')
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
        }
        canvas.getContext('2d')!.drawImage(video, 0, 0, w, h)
        cache.delete(clipId)
        cache.set(clipId, { canvas, time: video.currentTime, src: video.currentSrc, assetId })
        while (cache.size > HOLD_FRAME_COUNT) cache.delete(cache.keys().next().value as string)
      }
      return video
    }
    if (entry) return entry.canvas
    if (ready) return video
    // Never decoded yet (e.g. a split piece scrubbed onto for the first time): the latest held frame
    // of the same media is a close stand-in for the moment until the seek lands, better than black.
    let fallback: HTMLCanvasElement | null = null
    for (const e of cache.values()) if (e.assetId === assetId) fallback = e.canvas
    return fallback
  }

  function reportMediaError(clipId: string, assetName: string, message: string) {
    if (errorsRef.current.get(clipId) === message) return // already reported, don't spam
    errorsRef.current.set(clipId, message)
    console.error(`[anycut preview] "${assetName}": ${message}`)
  }

  /** The URL a pooled element should play for `asset` right now: the preview proxy if one has been
   *  generated (it can arrive after import, or be cleared by turning proxies off), else the original.
   *  Pools are keyed by clip id, so an element must be re-pointed when this changes (relink, a proxy
   *  finishing in the background), or it keeps playing the stale file. */
  function playableUrl(asset: MediaAsset, clip?: MediaClip): string {
    // A clip's baked stand-in (e.g. background removed) wins over the asset's own file/proxy.
    if (clip?.sourceOverride) return window.api.fileUrl(clip.sourceOverride.previewPath ?? clip.sourceOverride.path)
    return window.api.fileUrl(asset.previewPath ?? asset.path)
  }

  function getVideoEl(clip: MediaClip, asset: MediaAsset): HTMLVideoElement {
    let el = videoPoolRef.current.get(clip.id)
    if (!el) {
      el = document.createElement('video')
      el.crossOrigin = 'anonymous' // frames are read back for Filters (WebGL)
      el.src = playableUrl(asset, clip)
      el.preload = 'auto'
      el.muted = true
      el.addEventListener('error', () => {
        const reason = el!.error ? mediaErrorReason(el!.error.code) : 'failed to load'
        reportMediaError(clip.id, asset.name, reason)
      })
      el.addEventListener('loadeddata', () => errorsRef.current.delete(clip.id))
      videoPoolRef.current.set(clip.id, el)
    } else if (el.src !== playableUrl(asset, clip)) {
      const t = el.currentTime
      el.src = playableUrl(asset, clip)
      el.currentTime = t
      errorsRef.current.delete(clip.id)
      zeroSizeStartRef.current.delete(clip.id)
    }
    return el
  }

  function getImageEl(asset: MediaAsset): HTMLImageElement {
    let el = imagePoolRef.current.get(asset.id)
    const url = window.api.fileUrl(asset.path)
    if (!el) {
      el = new Image()
      el.crossOrigin = 'anonymous'
      el.src = url
      imagePoolRef.current.set(asset.id, el)
    } else if (el.src !== url) {
      el.src = url
    }
    return el
  }

  function getAudioEl(clip: MediaClip, asset: MediaAsset): HTMLAudioElement {
    let el = audioPoolRef.current.get(clip.id)
    if (!el) {
      el = document.createElement('audio')
      // CORS-clean so it can feed a Web Audio gain node (volumes above 100%; see audioGain).
      el.crossOrigin = 'anonymous'
      el.src = playableUrl(asset, clip)
      el.preload = 'auto'
      el.addEventListener('error', () => {
        const reason = el!.error ? mediaErrorReason(el!.error.code) : 'failed to load'
        reportMediaError(clip.id, asset.name, `audio ${reason}`)
      })
      el.addEventListener('loadeddata', () => errorsRef.current.delete(clip.id))
      audioPoolRef.current.set(clip.id, el)
    } else if (el.src !== playableUrl(asset, clip)) {
      const t = el.currentTime
      el.src = playableUrl(asset, clip)
      el.currentTime = t
      errorsRef.current.delete(clip.id)
    }
    return el
  }

  /**
   * Keeps a pooled <video>/<audio> element in sync with the timeline.
   *
   * The subtlety that used to cause visible flicker/stutter (most noticeably on .mov files —
   * ProRes proxies and long-GOP H.264 both re-decode expensively on every seek): during normal
   * forward playback the render loop advances its own `t` on a RAF clock while the media
   * element plays on its own hardware clock. Those two clocks always drift a little, and the
   * old code issued an `el.currentTime = …` seek whenever the drift passed a small threshold —
   * i.e. several seeks per second *while playing*, each flushing the decoder.
   *
   * Fix: when the element can free-run at a constant native rate (playing, speed-constant,
   * not reversed, not frozen — `canFreeRun`), let it play untouched and only correct drift via
   * `playbackRate` nudges, reserving a hard seek for a large discontinuity (clip switch, loop,
   * a big scrub). When scrubbing (paused) or when the time mapping is non-linear (reverse /
   * speed curve / frozen), seek precisely as before.
   */
  function syncMediaElement(
    el: HTMLMediaElement,
    desiredSourceTime: number,
    maxTime: number,
    isPlaying: boolean,
    shouldMute: boolean,
    volume = 1,
    clip?: MediaClip,
    assetName?: string,
    nativeRate = 1,
    canFreeRun = false
  ) {
    const clamped = Math.min(Math.max(desiredSourceTime, 0), Math.max(maxTime - 0.03, 0))
    const drift = el.currentTime - clamped

    if (canFreeRun && !el.paused) {
      // Free-running: never hard-seek for ordinary drift. Correct only via playbackRate, and
      // resync with a seek solely on a large jump (a different clip, a loop, or a big scrub).
      if (Math.abs(drift) > RESYNC_SEEK_THRESHOLD) {
        el.currentTime = clamped
        el.playbackRate = nativeRate
      } else if (Math.abs(drift) > PLAYBACK_DRIFT_TOLERANCE) {
        // Speed the element up slightly when it's behind, slow it when ahead, so it converges
        // on the timeline without a seek. Clamped to a tiny ±8% so it's imperceptible.
        const correction = drift < 0 ? 1.08 : 0.92
        el.playbackRate = nativeRate * correction
      } else {
        el.playbackRate = nativeRate
      }
    } else {
      // Paused scrub, reversed or frozen: seek to the exact frame. Never while a seek is still in
      // flight: a new seek aborts the pending one, so re-seeking every frame (reverse playback
      // asks for a new frame each tick) meant seeks kept cancelling and the element almost
      // never had a frame to show. The next tick after `seeked` catches up to the latest target.
      if (Math.abs(drift) > SEEK_DRIFT_THRESHOLD && !el.seeking) el.currentTime = clamped
      el.playbackRate = nativeRate
    }

    // Speed > "Change audio pitch": off keeps the pitch (time-stretch), on lets it rise/fall
    // with the speed like tape. Matches export (atempo vs asetrate).
    const keepPitch = !clip?.changeAudioPitch
    if (el.preservesPitch !== keepPitch) el.preservesPitch = keepPitch
    el.muted = shouldMute
    if (volume > 1 && el.crossOrigin === 'anonymous') {
      // <audio>.volume stops at 1: louder than 100% (the timeline's volume line goes to 200%,
      // like CapCut) goes through a Web Audio gain node, as export's volume filter does.
      el.volume = 1
      const g = audioGain(el)
      if (g) g.gain.value = Math.min(volume, 4)
    } else {
      el.volume = Math.min(Math.max(volume, 0), 1)
      const g = gainNodes.get(el)
      if (g) g.gain.value = 1
    }
    if (isPlaying) {
      if (el.paused) {
        // On (re)start, land on the right frame before playing so the first frame isn't stale.
        if (Math.abs(drift) > SEEK_DRIFT_THRESHOLD && !el.seeking) el.currentTime = clamped
        el.play()
          .then(() => {
            if (clip) errorsRef.current.delete(clip.id)
          })
          .catch((err: DOMException) => {
            if (clip && assetName) reportMediaError(clip.id, assetName, `playback blocked: ${err.name} (${err.message})`)
          })
      }
    } else if (!el.paused) {
      el.pause()
    }
  }

  function render(nowMs: number) {
    const canvas = canvasRef.current
    if (!canvas) {
      rafRef.current = requestAnimationFrame(render)
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      rafRef.current = requestAnimationFrame(render)
      return
    }

    const state = useProjectStore.getState()
    const project: Project = state.project
    const { width, height } = project.canvas
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    // Standalone single-asset preview (clicking a MediaBin card). Renders just that asset with
    // its own playback clock, instead of the timeline, and returns early. Interacting with the
    // timeline (selecting a clip / scrubbing) clears previewAssetId in the store, which drops us
    // back to the normal path below.
    if (state.previewAssetId) {
      // Reset the standalone clock whenever the previewed asset changes, and pause any timeline
      // media so we don't hear a clip that's no longer on screen.
      if (previewAssetIdRef.current !== state.previewAssetId) {
        previewAssetIdRef.current = state.previewAssetId
        previewClockRef.current = 0
        for (const el of videoPoolRef.current.values()) if (!el.paused) el.pause()
        for (const el of audioPoolRef.current.values()) if (!el.paused) el.pause()
      }
      ctx.fillStyle = 'black'
      ctx.fillRect(0, 0, width, height)
      const asset = project.assets.find((a) => a.id === state.previewAssetId)
      if (asset && state.missingAssetIds.includes(asset.id)) {
        drawOffline(ctx, width, height, asset.name)
      } else if (asset) {
        const tf = { x: 0.5, y: 0.5, scale: 1, opacity: 1, rotation: 0, flipH: false }
        if (asset.kind === 'image') {
          const img = getImageEl(asset)
          if (img.complete) drawContain(ctx, img, width, height, 1, tf, undefined, 0, asset.duration || 1)
        } else {
          // Synthetic clip id keeps a stable pool entry without clashing with real clips.
          const pseudo = { id: `preview:${asset.id}` } as MediaClip
          const el = getVideoEl(pseudo, asset)
          const maxT = asset.duration || el.duration || 0
          if (state.isPlaying) {
            // Restart from the top if we're resuming playback from the very end.
            if (maxT && previewClockRef.current >= maxT - 0.05) previewClockRef.current = 0
            const last = lastTickRef.current || nowMs
            const dt = Math.min((nowMs - last) / 1000, 0.1)
            previewClockRef.current = Math.min(previewClockRef.current + dt, maxT || Infinity)
            if (maxT && previewClockRef.current >= maxT) useProjectStore.setState({ isPlaying: false })
          }
          lastTickRef.current = nowMs
          syncMediaElement(el, previewClockRef.current, maxT || 1e9, state.isPlaying, false, 1, pseudo, asset.name, 1, state.isPlaying)
          const frame = frameFor(pseudo.id, asset.id, el)
          if (frame) drawContain(ctx, frame, width, height, 1, tf, undefined, 0, asset.duration || 1)
          const err = errorsRef.current.get(pseudo.id)
          if (err) drawMediaError(ctx, width, height, asset.name, err)
        }
      }
      syncOverlay(state, state.playhead)
      rafRef.current = requestAnimationFrame(render)
      return
    }
    // Leaving preview mode: clear the ref so re-entering later starts fresh.
    if (previewAssetIdRef.current !== null) {
      previewAssetIdRef.current = null
      for (const id of frameCacheRef.current.keys()) if (id.startsWith('preview:')) frameCacheRef.current.delete(id)
    }

    let t = state.playhead
    const duration = projectDuration(project)

    if (state.isPlaying) {
      const last = lastTickRef.current || nowMs
      const dt = Math.min((nowMs - last) / 1000, 0.1)
      t = Math.min(t + dt, duration)
      useProjectStore.setState({ playhead: t })
      if (t >= duration) {
        useProjectStore.setState({ isPlaying: false })
      }
    }
    lastTickRef.current = nowMs

    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, width, height)

    const assetById = new Map(project.assets.map((a) => [a.id, a]))
    const liveClipIds = new Set<string>()

    for (const track of project.tracks) {
      if (track.type !== 'video' || track.hidden) continue
      const { items: active, transition: activeTransition } = findActiveMedia(track, assetById, t)
      // While a transition runs, each of the two clips draws into its own offscreen layer; they
      // are composited per transition type after the loop.
      const inTransition = activeTransition !== null && active.some((a) => a.layer !== undefined)
      // Both clips stay audible through a transition: an equal-power crossfade (outgoing ×
      // cos, incoming × sin of the progress), the same qsin curve export's afade uses.
      const transitionGain = new Map<string, number>()
      if (inTransition && activeTransition) {
        const p = Math.min(Math.max(activeTransition.progress, 0), 1)
        for (const a of active) {
          if (a.layer === 0) transitionGain.set(a.clip.id, Math.cos((p * Math.PI) / 2))
          else if (a.layer === 1) transitionGain.set(a.clip.id, Math.sin((p * Math.PI) / 2))
        }
      }
      for (const { clip, asset, alpha, layer } of active) {
        const target = inTransition && layer !== undefined ? getTransitionLayer(layer, width, height) ?? ctx : ctx
        if (state.missingAssetIds.includes(asset.id)) {
          drawOffline(ctx, width, height, asset.name)
          continue
        }
        const localT = t - clip.start
        // Animation presets ride on the transform as baked keyframes (shared/animations.ts), the
        // same ones export plays.
        const interp = interpolateTransform(animatedTransformCached(clip), localT)
        // interpolateTransform only drives x/y/scale/opacity; rotation/flipH are static, read
        // straight from the clip transform so the preview matches export.
        const tf = { ...interp, rotation: clip.transform.rotation ?? 0, flipH: clip.transform.flipH ?? false }
        // Fade handles: the clip fades from/to black on the main track (the canvas is black under
        // it) and from/to transparent on overlays, and its sound with it, as in export.
        const fade = clipFadeGain(clip, localT)
        const finalAlpha = alpha * tf.opacity * fade
        if (asset.kind === 'image') {
          const img = getImageEl(asset)
          if (img.complete) drawContain(target, img, width, height, finalAlpha, tf, clip.effects, localT, clip.duration, clip.crop, clip.filter)
          continue
        }
        const video = getVideoEl(clip, asset)
        liveClipIds.add(clip.id)
        const desired = sourceTimeFor(clip, localT)
        const mute = clip.muted || clip.volume <= 0
        const volume = clip.volume * (transitionGain.get(clip.id) ?? 1) * fade
        // A clip lets its <video> free-run (no per-frame seeking — the .mov flicker fix) whenever
        // it plays forward: playing, not frozen, not reversed. A speed curve is piecewise-constant,
        // so it free-runs too, at the current segment's rate (clipSpeedAt); seeking every few
        // frames to follow the curve is what made curves flash black.
        const canFreeRun = state.isPlaying && !clip.frozen && !clip.reversed
        const nativeRate = clipSpeedAt(clip, localT)
        // Frozen clips hold a single source frame: seek there once, never actually play. Reversed
        // clips can't play (no negative playbackRate): they're seek-driven, element paused.
        syncMediaElement(video, desired, asset.duration, state.isPlaying && !clip.frozen && !clip.reversed, mute, volume, clip, asset.name, nativeRate, canFreeRun)
        const frame = frameFor(clip.id, asset.id, video)
        if (frame) drawContain(target, frame, width, height, finalAlpha, tf, clip.effects, localT, clip.duration, clip.crop, clip.filter)
        if (video.readyState >= 2) {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            zeroSizeStartRef.current.delete(clip.id)
          } else {
            const firstSeen = zeroSizeStartRef.current.get(clip.id) ?? nowMs
            zeroSizeStartRef.current.set(clip.id, firstSeen)
            if (nowMs - firstSeen > 1200) {
              reportMediaError(clip.id, asset.name, 'video stream could not be decoded (unsupported codec)')
            }
          }
        }
        const err = errorsRef.current.get(clip.id)
        if (err) drawMediaError(ctx, width, height, asset.name, err)
      }
      if (inTransition && activeTransition) {
        compositeTransition(ctx, transitionLayerCanvas(0), transitionLayerCanvas(1), activeTransition.type, activeTransition.progress, width, height)
      }
    }

    // Warm up clips about to start: load their <video>, park it on the first frame and snapshot
    // it, so the cut into them never shows black while a cold element loads.
    for (const track of project.tracks) {
      if (track.type !== 'video' || track.hidden) continue
      for (const clip of track.clips) {
        if (clip.kind !== 'media' || clip.disabled || liveClipIds.has(clip.id)) continue
        // Transitions start the incoming clip early, so look ahead from its transition start too.
        const lead = clip.start - t
        if (lead < -0.05 || lead > PRELOAD_AHEAD) continue
        const asset = assetById.get(clip.assetId)
        if (!asset || asset.kind !== 'video' || state.missingAssetIds.includes(asset.id)) continue
        const video = getVideoEl(clip, asset)
        syncMediaElement(video, sourceTimeFor(clip, 0), asset.duration, false, true, 0, clip, asset.name)
        frameFor(clip.id, asset.id, video)
      }
    }

    // Pause/mute any pooled video elements that aren't currently active.
    for (const [clipId, el] of videoPoolRef.current) {
      if (!liveClipIds.has(clipId) && !el.paused) el.pause()
    }

    const liveAudioIds = new Set<string>()
    for (const track of project.tracks) {
      if (track.type !== 'audio' || track.muted) continue
      for (const clip of track.clips) {
        if (clip.kind !== 'media' || clip.disabled) continue
        if (t < clip.start || t >= clip.start + clip.duration) continue
        const asset = assetById.get(clip.assetId)
        if (!asset) continue
        if (state.missingAssetIds.includes(asset.id)) continue
        const audioEl = getAudioEl(clip, asset)
        liveAudioIds.add(clip.id)
        const desired = sourceTimeFor(clip, t - clip.start)
        const canFreeRun = state.isPlaying && !clip.frozen && !clip.reversed
        const nativeRate = clipSpeedAt(clip, t - clip.start)
        syncMediaElement(
          audioEl,
          desired,
          asset.duration,
          state.isPlaying && !clip.frozen && !clip.reversed,
          clip.muted || clip.volume <= 0,
          clip.volume * clipFadeGain(clip, t - clip.start),
          clip,
          asset.name,
          nativeRate,
          canFreeRun
        )
        const err = errorsRef.current.get(clip.id)
        if (err && !liveClipIds.has(clip.id)) drawMediaError(ctx, width, height, asset.name, err)
      }
    }
    for (const [clipId, el] of audioPoolRef.current) {
      if (!liveAudioIds.has(clipId) && !el.paused) el.pause()
    }

    // Text overlays, drawn last (on top). Same renderer as the export's text overlay bake.
    drawTextLayer(ctx, project, t, width, height)

    syncOverlay(state, t)

    rafRef.current = requestAnimationFrame(render)
  }

  useEffect(() => {
    rafRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  const noFocus = (e: React.MouseEvent) => e.preventDefault() // keep Space for play/pause, not the button

  return (
    <div
      ref={wrapRef}
      className={`preview-canvas-wrap ${isFullscreen ? 'is-fullscreen' : ''} ${controlsIdle ? 'controls-idle' : ''}`}
      onPointerMove={wakeControls}
    >
      <canvas ref={canvasRef} className="preview-canvas" />
      <div ref={overlayRef} className="pv-overlay" onPointerDown={onOverlayPointerDown}>
        <div ref={guideVRef} className="pv-guide pv-guide-v" style={{ display: 'none' }} />
        <div ref={guideHRef} className="pv-guide pv-guide-h" style={{ display: 'none' }} />
        <div ref={selBoxRef} className="pv-sel" style={{ display: 'none' }}>
          {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
            <div key={c} className={`pv-handle ${c}`} data-corner={c} />
          ))}
        </div>
      </div>
      <div className="preview-controls">
        <button
          className="preview-skip"
          title="Jump to start"
          onClick={() => setPlayhead(0)}
          aria-label="Jump to start"
        >
          ⏮
        </button>
        <button
          className={`preview-playpause ${isPlaying ? 'playing' : 'paused'}`}
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          onClick={() => setIsPlaying(!isPlaying)}
        >
          {isPlaying ? (
            // Pause glyph: two bars
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            // Play glyph: triangle
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <div className="preview-time">
          {previewAsset ? `Preview · ${previewAsset.name} · ${formatMMSS(previewAsset.duration)}` : `${formatMMSS(playhead)} / ${formatMMSS(duration)}`}
        </div>
      </div>
      <div className="pv-tools">
        {cropTarget && !isFullscreen && (
          <button className="pv-tool" title="Crop" aria-label="Crop" onMouseDown={noFocus} onClick={() => useCropEditor.getState().open(cropTarget.id)}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 1.5V12h10.5" />
              <path d="M1.5 4H12v10.5" />
            </svg>
          </button>
        )}
        <button
          className="pv-tool pv-fullscreen"
          title={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
          aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
          aria-pressed={isFullscreen}
          onMouseDown={noFocus}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? (
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 1.5V6H1.5M10 1.5V6h4.5M6 14.5V10H1.5M10 14.5V10h4.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1.5 5.5v-4h4M14.5 5.5v-4h-4M1.5 10.5v4h4M14.5 10.5v4h-4" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
