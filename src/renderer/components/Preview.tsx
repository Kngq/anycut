import { useEffect, useRef } from 'react'
import { animatedTransformCached } from '@shared/animations'
import { filterDef } from '@shared/filters'
import { renderFiltered } from '../filterRenderer'
import { useProjectStore } from '../state/projectStore'
import type { Clip, MediaAsset, MediaClip, Project, Track } from '@shared/types'
import { clipSpeedAt, interpolateTransform, isFullCrop, projectDuration, sourceTimeFor, formatMMSS } from '@shared/types'
import { applyPostEffects, effectGeometry } from '@shared/effects'
import { compositeTransition, getTransitionLayer, transitionLayerCanvas } from '../transitions'
import { drawTextLayer, preloadCaptionFonts } from '../textRender'

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
    el.volume = Math.min(Math.max(volume, 0), 1)
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
        const finalAlpha = alpha * tf.opacity
        if (asset.kind === 'image') {
          const img = getImageEl(asset)
          if (img.complete) drawContain(target, img, width, height, finalAlpha, tf, clip.effects, localT, clip.duration, clip.crop, clip.filter)
          continue
        }
        const video = getVideoEl(clip, asset)
        liveClipIds.add(clip.id)
        const desired = sourceTimeFor(clip, localT)
        const mute = clip.muted || clip.volume <= 0 || active.length > 1
        // A clip lets its <video> free-run (no per-frame seeking — the .mov flicker fix) whenever
        // it plays forward: playing, not frozen, not reversed. A speed curve is piecewise-constant,
        // so it free-runs too, at the current segment's rate (clipSpeedAt); seeking every few
        // frames to follow the curve is what made curves flash black.
        const canFreeRun = state.isPlaying && !clip.frozen && !clip.reversed
        const nativeRate = clipSpeedAt(clip, localT)
        // Frozen clips hold a single source frame: seek there once, never actually play. Reversed
        // clips can't play (no negative playbackRate): they're seek-driven, element paused.
        syncMediaElement(video, desired, asset.duration, state.isPlaying && !clip.frozen && !clip.reversed, mute, clip.volume, clip, asset.name, nativeRate, canFreeRun)
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
          clip.volume,
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

    rafRef.current = requestAnimationFrame(render)
  }

  useEffect(() => {
    rafRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return (
    <div className="preview-canvas-wrap">
      <canvas ref={canvasRef} className="preview-canvas" />
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
    </div>
  )
}
