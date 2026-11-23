import { clipSpeedSegments, fontCatalogEntry, isFullCrop, resolveSourceOverridesWithAudio, type Clip, type ClipTransform, type MediaAsset, type MediaClip, type Project, type Track } from './types'
import { animatedTransform } from './animations'
import { buildLut, filterDef, filterFinish, LUT_SIZE, lutFileName, lutToCube, vignetteAngle } from './filters'
import { effectNeedsSubgraph, effectToFfmpegFilters, mirrorSubgraph, transitionToXfade } from './effects'

export interface FfmpegPlan {
  /** Files the filter graph reads (filter LUTs), keyed by absolute path; write them before
   *  running ffmpeg (writePlanFiles in electron/main/export.ts). */
  files?: { path: string; content: string }[]
  inputs: string[] // -i arguments, in order; filter graph refers to them as [0:v], [1:v], etc.
  filterComplex: string
  videoOutLabel: string
  audioOutLabel: string | null
  videoArgs: string[]
}

interface InputRef {
  index: number
  asset: MediaAsset
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ')
}

/** ffprobe transfer names for HDR: HLG and PQ. */
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084'])
/** Matrices/primaries that aren't Rec. 709 but are SDR (SD Rec. 601, Rec. 2020 SDR). */
const NON_709_SDR = new Set(['smpte170m', 'bt470bg', 'bt470m', 'bt2020', 'bt2020nc', 'bt2020c', 'bt601'])

/**
 * Filters (comma-terminated, or '') that convert one source into Rec. 709 SDR, the project's
 * colour space. Untagged and Rec. 709 sources pass through untouched. HDR (HLG/PQ, e.g. iPhone
 * Dolby Vision/HLG clips) is linearised, gamut-mapped to Rec. 709 primaries and tone-mapped
 * (Hable) down to SDR; tagged SD/Rec. 2020 SDR sources get a primaries+matrix conversion.
 */
export function colorConversionFilters(color: MediaAsset['color']): string {
  if (!color) return ''
  if (color.transfer && HDR_TRANSFERS.has(color.transfer)) {
    // Input tags are spelled out (not read from the frame) so this also works after a scale or
    // other filter that drops the frame's colour properties.
    const tin = color.transfer
    const min = color.matrix && color.matrix !== 'unknown' ? color.matrix : 'bt2020nc'
    const pin = color.primaries && color.primaries !== 'unknown' ? color.primaries : 'bt2020'
    const rin = color.range === 'pc' ? 'full' : 'limited'
    return `zscale=tin=${tin}:min=${min}:pin=${pin}:rin=${rin}:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,`
  }
  if ((color.primaries && NON_709_SDR.has(color.primaries)) || (color.matrix && NON_709_SDR.has(color.matrix))) {
    return 'colorspace=all=bt709:fast=0,'
  }
  return ''
}

/** Crop (comma-terminated, or '') for a clip's crop window; sizes rounded to even pixels. */
export function cropFilter(crop: MediaClip['crop']): string {
  if (!crop || isFullCrop(crop)) return ''
  const f = (v: number) => Number(v.toFixed(5))
  return `crop=w='trunc(iw*${f(crop.w)}/2)*2':h='trunc(ih*${f(crop.h)}/2)*2':x='iw*${f(crop.x)}':y='ih*${f(crop.y)}',`
}

/** Output tagging + matrix for the final YUV conversion: everything is Rec. 709 limited range. */
export const REC709_OUTPUT_ARGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']

function sortedClips<T extends Clip>(track: Track): T[] {
  return [...track.clips].sort((a, b) => a.start - b.start) as T[]
}

/**
 * Builds an ffmpeg filter expression that linearly interpolates a value across a sorted list
 * of (time, value) keyframes as a function of `timeVar` (e.g. `t` inside most filters' own
 * per-frame expression evaluation, `T` specifically inside `geq`, which uses uppercase X/Y/T
 * in its per-pixel expression language — verified empirically, not from the filter docs alone).
 * Clamps to the first/last value outside the keyframe range. This is the export-side mirror of
 * `interpolateTransform` in shared/types.ts — used by the keyframe-animation feature for
 * position/scale/opacity (x/y/scale/opacity each get their own call), one property per
 * invocation.
 */
/** Drops keyframes that lie on the straight line between their neighbours (and collapses a
 *  constant track to one point), so baked animations don't bloat ffmpeg expressions. */
function simplifyKeyframes(kfs: { time: number; value: number }[]): { time: number; value: number }[] {
  if (kfs.length <= 2) return kfs
  if (kfs.every((k) => Math.abs(k.value - kfs[0].value) < 1e-9)) return [kfs[0]]
  const out = [kfs[0]]
  for (let i = 1; i < kfs.length - 1; i++) {
    const a = out[out.length - 1]
    const b = kfs[i]
    const c = kfs[i + 1]
    const span = c.time - a.time
    const expected = span <= 0 ? c.value : a.value + ((c.value - a.value) * (b.time - a.time)) / span
    if (Math.abs(expected - b.value) > 1e-6) out.push(b)
  }
  out.push(kfs[kfs.length - 1])
  return out
}

export function piecewiseLinearExpr(keyframes: { time: number; value: number }[], timeVar: string): string {
  const sorted = simplifyKeyframes([...keyframes].sort((a, b) => a.time - b.time))
  if (sorted.length === 0) return '0'
  if (sorted.length === 1) return String(sorted[0].value)
  let expr = String(sorted[sorted.length - 1].value)
  for (let i = sorted.length - 2; i >= 0; i--) {
    const a = sorted[i]
    const b = sorted[i + 1]
    const span = b.time - a.time
    const interp = span <= 0 ? String(b.value) : `(${a.value}+(${b.value}-${a.value})*(${timeVar}-${a.time})/${span})`
    expr = `if(lt(${timeVar},${b.time}),${interp},${expr})`
  }
  return `if(lt(${timeVar},${sorted[0].time}),${sorted[0].value},${expr})`
}

/**
 * ffmpeg's `atempo` filter only accepts a 0.5-2.0 rate per instance, so a speed outside that
 * range needs to be expressed as a chain of several (e.g. 3x -> atempo=2,atempo=1.5). Always
 * returns at least one factor; a flat `[1]` means "no atempo needed at all".
 */
export function atempoFactors(speed: number): number[] {
  const factors: number[] = []
  let remaining = speed
  while (remaining > 2) {
    factors.push(2)
    remaining /= 2
  }
  while (remaining < 0.5) {
    factors.push(0.5)
    remaining /= 0.5
  }
  factors.push(remaining)
  return factors
}

function hasActiveKeyframes(transform: ClipTransform): boolean {
  return (transform.keyframes?.length ?? 0) >= 2
}

/**
 * Builds the ffmpeg inputs + filter_complex needed to render a Project to a single
 * output file. Scope (barebones v1):
 *  - One or more video tracks, composited bottom-to-top with `overlay`, each clip's own
 *    cut/crossfade transitions handled within its own track's chain before compositing.
 *  - Text tracks rendered with `drawtext`, layered on top of all video.
 *  - Audio tracks and un-muted video clip audio are trimmed, delayed, and mixed with `amix`.
 */
/** A baked text overlay: an RGBA PNG sequence from frame 0 at the project fps (see
 *  electron/main/textOverlay.ts). When given, it replaces drawtext for every text clip. */
export interface TextOverlayInput {
  pattern: string
  fps: number
}

export function buildFfmpegPlan(inputProject: Project, opts: { textOverlay?: TextOverlayInput; lutDir?: string } = {}): FfmpegPlan {
  // Clips with a baked stand-in (e.g. background removed) render from that file instead.
  const resolved = resolveSourceOverridesWithAudio(inputProject)
  const audioAssetFor = resolved.audioAssetFor
  // Deactivated clips: dropped from every track except the main video roll, where they stay as
  // black (the roll is a contiguous sequence, so later clips keep their timing).
  const firstVideoId = resolved.project.tracks.find((t) => t.type === 'video')?.id
  const project: Project = {
    ...resolved.project,
    tracks: resolved.project.tracks.map((t) => {
      const clips = t.id === firstVideoId ? t.clips : t.clips.filter((c) => !c.disabled)
      // Animation presets become ordinary transform keyframes (shared/animations.ts), the same
      // ones the preview plays, so everything below only ever sees keyframed transforms.
      return { ...t, clips: clips.map((c) => (c.kind === 'media' && c.animations ? { ...c, transform: animatedTransform(c) } : c)) }
    })
  }
  const { width, height, fps } = project.canvas
  const assetById = new Map(project.assets.map((a) => [a.id, a]))

  const inputs: string[] = []
  let inputCount = 0
  const inputRefByAssetId = new Map<string, InputRef>()
  function inputFor(assetId: string): InputRef {
    const existing = inputRefByAssetId.get(assetId)
    if (existing) return existing
    const asset = assetById.get(assetId)
    if (!asset) throw new Error(`Unknown asset ${assetId}`)
    const index = inputCount++
    if (asset.kind === 'image') {
      inputs.push('-loop', '1', '-framerate', String(fps), '-i', asset.path)
    } else {
      inputs.push('-i', asset.path)
    }
    const ref: InputRef = { index, asset }
    inputRefByAssetId.set(assetId, ref)
    return ref
  }

  const filters: string[] = []
  let labelCounter = 0
  const nextLabel = (prefix: string) => `${prefix}${labelCounter++}`

  const videoTracks = project.tracks.filter((t) => t.type === 'video' && !t.hidden)
  const audioTracks = project.tracks.filter((t) => t.type === 'audio' && !t.muted)
  const textTracks = project.tracks.filter((t) => t.type === 'text' && !t.hidden)

  // ---- Video ----
  // Only the *first* video track is treated as a contiguous roll (its clips always start
  // at absolute 0 by construction — see repackVideoTrack — so a local xfade/concat chain
  // is safe here). Every later video track is a free-floating overlay: each clip is scaled
  // to its native-fit size (not stretched to fill the canvas), positioned/scaled/faded per
  // its transform, shifted to its own absolute `start`, and composited with
  // `overlay=...:enable=between(...)` so it appears at the right place regardless of what
  // else is happening on the track. Transitions on overlay tracks are not modeled in export
  // (hard cut) — the Inspector only offers the transition control on the primary track to
  // keep preview/export in agreement.
  const scalePadFor = () =>
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`

  /** Bounding box of a w×h frame rotated by `degrees` (what Preview's ctx.rotate covers). */
  function rotatedBox(w: number, h: number, degrees: number): { w: number; h: number } {
    const r = (degrees * Math.PI) / 180
    const c = Math.abs(Math.cos(r))
    const s = Math.abs(Math.sin(r))
    return { w: w * c + h * s, h: w * s + h * c }
  }
  const even = (v: number) => Math.max(2, 2 * Math.round(v / 2))
  const normRotation = (clip: MediaClip) => (((clip.transform.rotation ?? 0) % 360) + 360) % 360

  /**
   * Places a primary-track clip's canvas-fit (and already rotated/mirrored) frame on a black
   * canvas exactly the way Preview.tsx's drawContain does: scale around the fit size by
   * `transform.scale` (any value — below 1x leaves black around it), center it at
   * (x·W, y·H) (anywhere — off-canvas positions slide it out of frame), then fade toward black by
   * `opacity` (nothing sits behind the primary track). Scale and position are `eval=frame`
   * expressions when keyframed (animations are baked to keyframes upstream); the composite is an
   * `overlay` onto a W×H black `color` source, which tracks the per-frame size of a dynamically
   * scaled input (see compositeOverlayClip for why overlay rather than crop/pad). The segment's
   * own timestamps start at 0, so `t` is clip-local time.
   *
   * No-op (returns `label` unchanged) at the default transform, so untransformed primary-track
   * clips produce byte-identical filter output to before this feature existed.
   */
  function applyCanvasTransform(label: string, clip: MediaClip): string {
    const transform = clip.transform
    const hasKf = hasActiveKeyframes(transform)
    const kfs = transform.keyframes ?? []
    const rotation = normRotation(clip)
    const isDefaultGeometry = !hasKf && transform.x === 0.5 && transform.y === 0.5 && transform.scale === 1 && rotation === 0
    const opacityConst = hasKf ? (kfs.every((k) => k.opacity === kfs[0].opacity) ? kfs[0].opacity : null) : transform.opacity
    const isDefaultOpacity = opacityConst === 1
    if (isDefaultGeometry && isDefaultOpacity) return label

    let out = label

    if (!isDefaultGeometry) {
      const scaleExpr = hasKf ? piecewiseLinearExpr(kfs.map((k) => ({ time: k.time, value: k.scale })), 't') : String(transform.scale)
      const xExpr = hasKf ? piecewiseLinearExpr(kfs.map((k) => ({ time: k.time, value: k.x })), 't') : String(transform.x)
      const yExpr = hasKf ? piecewiseLinearExpr(kfs.map((k) => ({ time: k.time, value: k.y })), 't') : String(transform.y)
      // The rotated frame is its bounding box (applyRotateFlip grows it), so size from that.
      const box = rotatedBox(width, height, rotation)
      const scaled = nextLabel('zoomscale')
      if (hasKf) {
        filters.push(
          `[${out}]scale=w='max(2,2*trunc(${box.w.toFixed(3)}*(${scaleExpr})/2))':h='max(2,2*trunc(${box.h.toFixed(3)}*(${scaleExpr})/2))':eval=frame[${scaled}]`
        )
      } else {
        filters.push(`[${out}]scale=${even(box.w * transform.scale)}:${even(box.h * transform.scale)}[${scaled}]`)
      }
      const bg = nextLabel('zoombg')
      // A little longer than the clip; overlay's shortest=1 ends the composite with the clip.
      filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${(clip.duration + 1).toFixed(3)},setsar=1[${bg}]`)
      const placed = nextLabel('zoomplace')
      filters.push(
        `[${bg}][${scaled}]overlay=x='${width}*(${xExpr})-w/2':y='${height}*(${yExpr})-h/2':eval=frame:shortest=1:format=auto,format=yuv420p,setsar=1[${placed}]`
      )
      out = placed
    }

    if (!isDefaultOpacity) {
      const opaced = nextLabel('zoomop')
      if (opacityConst !== null) {
        filters.push(`[${out}]colorchannelmixer=rr=${opacityConst}:gg=${opacityConst}:bb=${opacityConst}[${opaced}]`)
      } else {
        // geq is per-pixel, so only run it while the opacity is actually below 1.
        const dim = kfs.filter((k) => k.opacity < 1)
        const from = Math.max(0, Math.min(...dim.map((k) => k.time)) - 0.05)
        const to = Math.max(...dim.map((k) => k.time)) + 0.05
        const opacityExpr = piecewiseLinearExpr(kfs.map((k) => ({ time: k.time, value: k.opacity })), 'T')
        filters.push(
          `[${out}]geq=lum='lum(X,Y)*(${opacityExpr})':cb='128+(cb(X,Y)-128)*(${opacityExpr})':cr='128+(cr(X,Y)-128)*(${opacityExpr})':enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'[${opaced}]`
        )
      }
      out = opaced
    }

    return out
  }

  /**
   * Returns one label holding the clip's trimmed, speed-adjusted, (optionally reversed) video,
   * finished per `finish`: 'canvas' scales/pads to fill the full canvas, then mirrors/rotates,
   * places it per its transform (applyCanvasTransform) and runs its effects over the whole
   * frame — the primary-track shape, in the same order Preview draws it; 'native' only
   * normalizes fps/SAR, leaving the clip at its native asset resolution for the caller to
   * position itself (see compositeOverlayClip) — the overlay-track shape. A flat (no curve)
   * 1x-speed, non-reversed, untransformed 'canvas' clip produces exactly the single
   * trim/setpts/scale chain this did before speed/reverse/transform existed; anything else (a
   * curve, non-1x flat speed, `reversed`, or a non-default transform) assembles the clip from
   * clipSpeedSegments() (one constant-speed trim+setpts per segment, concatenated — always in
   * ascending SOURCE-time order regardless of `reversed`), then applies a single `reverse` filter
   * to the whole assembled (still-forward) result before the finish step — reverse is a final
   * flip, never per-segment, so it composes correctly with any speed curve.
   */
  function trimmedSegmentLabel(clip: MediaClip, asset: MediaAsset, finish: 'canvas' | 'native' = 'canvas'): string {
    const finishFilter = finish === 'native' ? `setsar=1,fps=${fps}` : scalePadFor()
    const base = buildBaseSegment(clip, asset, finishFilter)
    if (finish === 'canvas') return applyClipFade(applyEffectsChain(applyCanvasTransform(applyRotateFlip(base, clip, 'canvas'), clip), clip), clip, 'canvas')
    return applyClipFade(applyRotateFlip(applyEffectsChain(base, clip), clip, 'native'), clip, 'native')
  }

  /** The clip's fade in / out (timeline corner handles): to black on the main track, to transparent
   *  on an overlay. Runs on the clip's own segment (its timestamps start at 0), linear like the
   *  preview's clipFadeGain. */
  function applyClipFade(label: string, clip: MediaClip, finish: 'canvas' | 'native'): string {
    const fi = Math.min(clip.fadeIn ?? 0, clip.duration)
    const fo = Math.min(clip.fadeOut ?? 0, clip.duration)
    if (fi <= 0 && fo <= 0) return label
    const alpha = finish === 'native' ? ':alpha=1' : ''
    const parts: string[] = finish === 'native' ? ['format=yuva420p'] : []
    if (fi > 0) parts.push(`fade=t=in:st=0:d=${fi}${alpha}`)
    if (fo > 0) parts.push(`fade=t=out:st=${Math.max(0, clip.duration - fo)}:d=${fo}${alpha}`)
    const out = nextLabel('fade')
    filters.push(`[${label}]${parts.join(',')}[${out}]`)
    return out
  }

  /**
   * Applies the clip's horizontal mirror (`flipH`) and rotation (`rotation`, any angle) from its
   * transform. Mirrors drawContain in Preview.tsx: flip, then rotate about the center, keeping
   * the whole rotated frame — the output grows to the rotated bounding box. A primary ('canvas')
   * clip's corners fill black (applyCanvasTransform then crops it back onto the canvas); an
   * overlay ('native') clip's corners are transparent so what's beneath shows through, and
   * compositeOverlayClip sizes it from the same bounding box. No-op at the default (rotation 0,
   * flipH false), so untouched clips emit identical output to before.
   */
  function applyRotateFlip(label: string, clip: MediaClip, finish: 'canvas' | 'native'): string {
    const rotation = normRotation(clip)
    const flipH = clip.transform.flipH ?? false
    if (rotation === 0 && !flipH) return label
    let current = label
    if (flipH) {
      const out = nextLabel('flip')
      filters.push(`[${current}]hflip[${out}]`)
      current = out
    }
    if (rotation !== 0) {
      const out = nextLabel('rot')
      const radians = ((rotation * Math.PI) / 180).toFixed(6)
      if (finish === 'canvas') {
        const box = rotatedBox(width, height, rotation)
        filters.push(`[${current}]rotate=${radians}:ow=${even(box.w)}:oh=${even(box.h)}:fillcolor=black[${out}]`)
      } else {
        filters.push(`[${current}]format=rgba,rotate=${radians}:ow='rotw(${radians})':oh='roth(${radians})':fillcolor=none[${out}]`)
      }
      current = out
    }
    // Primary-track clips flow into concat/xfade, which reject a non-1 SAR ("SAR … do not
    // match"); normalize it (and fps) once, same guard as the effect chain uses.
    if (finish === 'canvas') {
      const norm = nextLabel('rfnorm')
      filters.push(`[${current}]setsar=1,fps=${fps}[${norm}]`)
      current = norm
    }
    return current
  }

  /**
   * Splices a clip's effect stack onto its already-finished (trimmed/transformed) video label,
   * mirroring shared/effects.ts (the preview applies the same stack). Most effects are
   * comma-joinable inline filters (effectToFfmpegFilters); mirror needs a labeled subgraph
   * (mirrorSubgraph). Returns the final label — unchanged when the clip has no effects, so
   * effect-free clips produce byte-identical output to before this feature.
   */
  function applyEffectsChain(label: string, clip: MediaClip): string {
    const effects = clip.effects
    if (!effects || effects.length === 0) return label
    let current = label
    for (const effect of effects) {
      if (effectNeedsSubgraph(effect)) {
        const out = nextLabel('fxmir')
        const inter = { a: nextLabel('fxa'), b: nextLabel('fxb'), flipped: nextLabel('fxf') }
        for (const line of mirrorSubgraph(effect, width, height, current, out, inter)) filters.push(line)
        current = out
      } else {
        const inline = effectToFfmpegFilters(effect, width, height, fps)
        if (inline.length === 0) continue
        const out = nextLabel('fx')
        filters.push(`[${current}]${inline.join(',')}[${out}]`)
        current = out
      }
    }
    // Geometry effects (shake/Ken Burns) scale to fractional pixel sizes, which leaves a
    // non-1 SAR that breaks a downstream concat/xfade ("SAR … do not match"). Normalize SAR
    // (and fps, for safety) once at the end of the chain. No-op if the chain emitted nothing.
    if (current === label) return label
    const normalized = nextLabel('fxnorm')
    filters.push(`[${current}]setsar=1,fps=${fps}[${normalized}]`)
    return normalized
  }

  const planFiles = new Map<string, string>()
  const lutDir = (opts.lutDir ?? '.').replace(/\/+$/, '')
  /**
   * The clip's Filter (shared/filters.ts) as a filter-chain prefix (ending in a comma), applied
   * to the clip's own pixels before it's fitted to the canvas, like the preview's WebGL pass.
   * Colour: the filter's LUT (intensity baked in) through `lut3d` in RGB, converting with the
   * Rec. 709 matrix both ways (swscale would otherwise assume 601). Then the spatial finish in
   * YUV: unsharp / gblur sized to the source, temporal noise, cos⁴ vignette.
   */
  function clipFilterChain(clip: MediaClip, asset: MediaAsset): string {
    const def = clip.filter ? filterDef(clip.filter.id) : undefined
    const intensity = clip.filter ? Math.min(1, Math.max(0, clip.filter.intensity)) : 0
    if (!def || intensity <= 0) return ''
    const name = lutFileName(def.id, intensity)
    const path = `${lutDir}/${name}`
    if (!planFiles.has(path)) planFiles.set(path, lutToCube(buildLut(def, intensity), LUT_SIZE, def.label))
    const alpha = asset.kind === 'image' || !!clip.sourceOverride?.hasAlpha
    const fin = filterFinish(def, intensity)
    const srcH = Math.max(1, (asset.height || height) * (clip.crop && !isFullCrop(clip.crop) ? clip.crop.h : 1))
    const parts = [
      `scale=in_color_matrix=bt709:in_range=tv,format=${alpha ? 'rgba' : 'rgb24'}`,
      `lut3d=file='${path}':interp=trilinear`,
      `scale=out_color_matrix=bt709:out_range=tv,format=${alpha ? 'yuva420p' : 'yuv420p'}`
    ]
    if (fin.sharpen > 0) parts.push(`unsharp=5:5:${(fin.sharpen * 1.6).toFixed(3)}:5:5:0`)
    if (fin.soften > 0) parts.push(`gblur=sigma=${(fin.soften * 0.004 * srcH).toFixed(2)}`)
    if (fin.grain > 0) parts.push(`noise=c0s=${Math.round(fin.grain * 22)}:c0f=t`)
    if (fin.vignette > 0) parts.push(`vignette=angle=${vignetteAngle(fin.vignette).toFixed(4)}`)
    return parts.join(',') + ','
  }

  function buildBaseSegment(clip: MediaClip, asset: MediaAsset, finishFilter: string): string {
    const ref = inputFor(clip.assetId)
    const segLabel = nextLabel('vseg')
    // Colour conversion to Rec. 709 and the crop run on the trimmed frames, before fit/scale.
    // Still images decode as RGB; convert to YUV with the Rec. 709 matrix (swscale's implicit
    // conversion would use 601 and shift every colour).
    const rgbIn = asset.kind === 'image' ? 'scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,' : ''
    finishFilter = rgbIn + colorConversionFilters(asset.color) + cropFilter(clip.crop) + clipFilterChain(clip, asset) + finishFilter
    if (asset.kind === 'image') {
      filters.push(`[${ref.index}:v]trim=duration=${clip.duration},${finishFilter},setpts=PTS-STARTPTS[${segLabel}]`)
      return segLabel
    }

    // Frozen clips hold a single source frame (trimIn === trimOut, which would be a
    // zero-length span to clipSpeedSegments below) for the clip's authored `duration` —
    // grab one frame and hold it with `tpad`'s clone mode, no speed/reverse/curve involved.
    if (clip.frozen) {
      const pre = nextLabel('vfreeze')
      filters.push(`[${ref.index}:v]trim=start=${clip.trimIn}:end=${clip.trimIn + 1 / fps},setpts=PTS-STARTPTS,${finishFilter}[${pre}]`)
      const holdDuration = Math.max(clip.duration - 1 / fps, 0)
      filters.push(`[${pre}]tpad=stop_mode=clone:stop_duration=${holdDuration}[${segLabel}]`)
      return segLabel
    }

    const segments = clipSpeedSegments(clip)
    if (segments.length === 1 && !clip.reversed) {
      const seg = segments[0]
      const ptsExpr = seg.speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${seg.speed}`
      filters.push(`[${ref.index}:v]trim=start=${seg.start}:end=${seg.end},setpts=${ptsExpr},${finishFilter}[${segLabel}]`)
      return segLabel
    }

    let assembledLabel: string
    if (segments.length === 1) {
      const seg = segments[0]
      const ptsExpr = seg.speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${seg.speed}`
      const pre = nextLabel('vpre')
      filters.push(`[${ref.index}:v]trim=start=${seg.start}:end=${seg.end},setpts=${ptsExpr}[${pre}]`)
      assembledLabel = pre
    } else {
      const pieceLabels = segments.map((seg) => {
        const piece = nextLabel('vspeed')
        const ptsExpr = seg.speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${seg.speed}`
        filters.push(`[${ref.index}:v]trim=start=${seg.start}:end=${seg.end},setpts=${ptsExpr}[${piece}]`)
        return piece
      })
      const concatLabel = nextLabel('vconcat')
      filters.push(`${pieceLabels.map((l) => `[${l}]`).join('')}concat=n=${pieceLabels.length}:v=1:a=0[${concatLabel}]`)
      assembledLabel = concatLabel
    }

    if (clip.reversed) {
      const revLabel = nextLabel('vrev')
      filters.push(`[${assembledLabel}]reverse[${revLabel}]`)
      assembledLabel = revLabel
    }

    filters.push(`[${assembledLabel}]${finishFilter}[${segLabel}]`)
    return segLabel
  }

  /**
   * Composites one overlay-track clip (its 'native'-finished, already pts-shifted label) onto
   * `baseLabel`, applying its (possibly keyframed) position/scale/opacity, and returns the new
   * combined label. Mirrors what Preview.tsx's drawContain already does: fit the asset's native
   * size within the canvas preserving aspect ratio, multiply by `transform.scale`, center at
   * (transform.x*canvasW, transform.y*canvasH).
   *
   * The position+scale step, and opacity, are deliberately NOT combined into one pre-overlay
   * alpha-compositing pass — every alpha mechanism tried there (colorchannelmixer, geq) either
   * doesn't support a time-varying value at all, or (geq specifically) silently resets a
   * stream's per-frame-varying dimensions if placed before a frame-varying `scale`, breaking
   * keyframed scale (confirmed empirically: the overlay visibly stopped growing once geq sat
   * upstream of it, despite `scale`'s own eval=frame output genuinely differing in size every
   * frame when checked directly). What *is* confirmed to track a dynamically-scaled input
   * correctly, every time it was tested in isolation from geq, is `overlay` itself: its own
   * `x`/`y` expressions can reference the overlay input's live current `w`/`h` with
   * `eval=frame`. So position+scale go through a full-opacity `overlay` first; opacity (when
   * not simply 1) is applied *after*, by blending that fully-composited result back toward the
   * untouched `baseLabel` with a time-varying mix factor — both blend inputs are already
   * constant canvasW x canvasH by that point, so there's no dynamic-sizing interaction left to
   * break.
   */
  function compositeOverlayClip(baseLabel: string, nativeLabel: string, clip: MediaClip, asset: MediaAsset): string {
    const transform = clip.transform
    const hasKf = hasActiveKeyframes(transform)
    const kfs = transform.keyframes
    const cw = clip.crop && !isFullCrop(clip.crop) ? clip.crop.w : 1
    const ch = clip.crop && !isFullCrop(clip.crop) ? clip.crop.h : 1
    const nativeW = Math.max(1, Math.round((asset.width || width) * cw))
    const nativeH = Math.max(1, Math.round((asset.height || height) * ch))
    const fit = Math.min(width / nativeW, height / nativeH)
    // A rotated clip arrives as its bounding box (applyRotateFlip), so size that box.
    const box = rotatedBox(nativeW * fit, nativeH * fit, normRotation(clip))
    const baseW = Math.max(Math.round(box.w), 1)
    const baseH = Math.max(Math.round(box.h), 1)
    const localT = `(t-${clip.start})`

    const scaleExpr = hasKf ? piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.scale })), localT) : String(transform.scale)
    const xExpr = hasKf ? piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.x })), localT) : String(transform.x)
    const yExpr = hasKf ? piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.y })), localT) : String(transform.y)

    let scaledLabel = nativeLabel
    const scaled = nextLabel('ovscale')
    if (hasKf) {
      filters.push(`[${scaledLabel}]scale=w='max(1,${baseW}*(${scaleExpr}))':h='max(1,${baseH}*(${scaleExpr}))':eval=frame[${scaled}]`)
    } else {
      const w = Math.max(Math.round(baseW * transform.scale), 1)
      const h = Math.max(Math.round(baseH * transform.scale), 1)
      filters.push(`[${scaledLabel}]scale=${w}:${h}[${scaled}]`)
    }
    scaledLabel = scaled

    const end = clip.start + clip.duration

    if (!hasKf && transform.opacity === 1) {
      // format=auto is required, not cosmetic: verified empirically that overlay's default
      // format mode silently drops blending correctness when the main input comes from
      // `xfade`/`concat` rather than a raw decoded stream.
      const composited = nextLabel('comp')
      filters.push(
        `[${baseLabel}][${scaledLabel}]overlay=x='${width}*(${xExpr})-w/2':y='${height}*(${yExpr})-h/2':eval=frame:format=auto:` +
          `enable='between(t,${clip.start},${end})'[${composited}]`
      )
      return composited
    }

    // Opacity needs `baseLabel` a second time (as the blend's "A" input, see below) — using
    // the same label as input to two different filters silently broke ffmpeg's filtergraph
    // resolution in this build (confirmed empirically: identical graph, swap the implicit
    // reuse for an explicit `split`, and a mystifying "Invalid stream specifier" error from a
    // seemingly unrelated label disappears). `split` is the canonical, always-safe way to fan
    // a label out to multiple consumers — use it instead of relying on implicit reuse again.
    const baseA = nextLabel('base')
    const baseB = nextLabel('base')
    filters.push(`[${baseLabel}]split=2[${baseA}][${baseB}]`)

    const composited = nextLabel('comp')
    filters.push(
      `[${baseA}][${scaledLabel}]overlay=x='${width}*(${xExpr})-w/2':y='${height}*(${yExpr})-h/2':eval=frame:format=auto:` +
        `enable='between(t,${clip.start},${end})'[${composited}]`
    )
    baseLabel = baseB

    const opacityExpr = hasKf ? piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.opacity })), `(T-${clip.start})`) : String(transform.opacity)
    const blended = nextLabel('ovblend')
    filters.push(
      `[${baseLabel}][${composited}]blend=all_expr='A*(1-(${opacityExpr}))+B*(${opacityExpr})':enable='between(t,${clip.start},${end})'[${blended}]`
    )
    return blended
  }

  let videoOutLabel: string | null = null

  const [primaryTrack, ...overlayTracks] = videoTracks
  if (primaryTrack) {
    const clips = sortedClips<MediaClip>(primaryTrack).filter((c) => c.kind === 'media')
    if (clips.length > 0) {
      const segmentLabels: string[] = []
      const segmentDurations: number[] = []
      for (const clip of clips) {
        const asset = assetById.get(clip.assetId)
        if (!asset) continue
        if (clip.disabled) {
          const black = nextLabel('voff')
          filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${clip.duration},setsar=1,format=yuv420p[${black}]`)
          segmentLabels.push(black)
        } else {
          segmentLabels.push(trimmedSegmentLabel(clip, asset))
        }
        segmentDurations.push(clip.duration)
      }

      // Chain segments with xfade (crossfade) where a transitionIn is specified, otherwise
      // plain concat. xfade's `offset` is measured on the *running* chain, so we track it.
      let chainLabel = segmentLabels[0]
      let runningDuration = segmentDurations[0]

      for (let i = 1; i < segmentLabels.length; i++) {
        const clip = clips[i]
        const nextSeg = segmentLabels[i]
        const nextDuration = segmentDurations[i]
        const out = nextLabel('vchain')

        if (clip.transitionIn && clip.transitionIn.duration > 0) {
          const d = Math.min(clip.transitionIn.duration, runningDuration, nextDuration)
          const offset = Math.max(runningDuration - d, 0)
          const xfadeType = transitionToXfade(clip.transitionIn.type)
          filters.push(`[${chainLabel}][${nextSeg}]xfade=transition=${xfadeType}:duration=${d}:offset=${offset}[${out}]`)
          runningDuration = runningDuration + nextDuration - d
        } else {
          filters.push(`[${chainLabel}][${nextSeg}]concat=n=2:v=1:a=0[${out}]`)
          runningDuration = runningDuration + nextDuration
        }
        chainLabel = out
      }

      videoOutLabel = chainLabel
    }
  }

  if (videoOutLabel === null) {
    const base = nextLabel('base')
    filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=1[${base}]`)
    videoOutLabel = base
  }

  for (const track of overlayTracks) {
    const clips = sortedClips<MediaClip>(track).filter((c) => c.kind === 'media')
    for (const clip of clips) {
      const asset = assetById.get(clip.assetId)
      if (!asset) continue
      const native = trimmedSegmentLabel(clip, asset, 'native')
      const shifted = nextLabel('vshift')
      filters.push(`[${native}]setpts=PTS+${clip.start}/TB[${shifted}]`)
      videoOutLabel = compositeOverlayClip(videoOutLabel, shifted, clip, asset)
    }
  }

  // ---- Text overlays ----
  if (opts.textOverlay) {
    const index = inputCount++
    inputs.push('-framerate', String(opts.textOverlay.fps), '-i', opts.textOverlay.pattern)
    const out = nextLabel('txt')
    // eof_action=pass: after the last caption frame the video continues untouched.
    filters.push(`[${videoOutLabel}][${index}:v]overlay=0:0:format=auto:eof_action=pass[${out}]`)
    videoOutLabel = out
  }
  for (const track of opts.textOverlay ? [] : textTracks) {
    const clips = sortedClips(track).filter((c): c is Clip & { kind: 'text' } => c.kind === 'text')
    for (const clip of clips) {
      const out = nextLabel('txt')
      const start = clip.start
      const end = clip.start + clip.duration
      const fontColor = clip.color || 'white'
      const transform = clip.transform
      const hasKf = hasActiveKeyframes(transform)
      const kfs = transform.keyframes
      const localT = `(t-${start})`

      // Static values keep the exact unquoted format this produced before transform/keyframe
      // support existed (byte-identical filter output at the default transform); keyframed
      // values need the quoting piecewiseLinearExpr's embedded commas require.
      const fontSizeStr = hasKf
        ? `'${clip.fontSize}*(${piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.scale })), localT)})'`
        : String(Math.round(clip.fontSize * transform.scale))
      const xStr = hasKf
        ? `'(w-text_w)*(${piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.x })), localT)})'`
        : `(w-text_w)*${transform.x}`
      const yStr = hasKf
        ? `'(h-text_h)*(${piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.y })), localT)})'`
        : `(h-text_h)*${transform.y}`

      const parts = [`drawtext=text='${escapeDrawtext(clip.text)}'`, `fontcolor=${fontColor}`, `fontsize=${fontSizeStr}`, `x=${xStr}`, `y=${yStr}`]
      const font = fontCatalogEntry(clip.fontFamily)
      // drawtext needs an actual font FILE. Escape the path's special chars the same way the
      // text is escaped (colons/backslashes/quotes). If the file is missing on this machine,
      // ffmpeg falls back to its built-in font rather than failing the whole render.
      if (font.fontFile) parts.push(`fontfile='${escapeDrawtext(font.fontFile)}'`)
      if (clip.stroke && clip.stroke.width > 0) {
        parts.push(`borderw=${Math.round(clip.stroke.width * transform.scale)}`, `bordercolor=${clip.stroke.color}`)
      }
      if (hasKf || transform.opacity !== 1) {
        const alphaStr = hasKf ? `'${piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.opacity })), localT)}'` : String(transform.opacity)
        parts.push(`alpha=${alphaStr}`)
      }
      parts.push(`enable='between(t,${start},${end})'`)

      filters.push(`[${videoOutLabel}]${parts.join(':')}[${out}]`)
      videoOutLabel = out
    }
  }

  // ---- Audio: mix audio-track clips + un-muted video-clip audio ----
  const audioMixLabels: string[] = []

  // Main-roll transitions crossfade the audio too (preview does the same): each clip's audio is
  // still placed at its own `start` — the incoming clip already overlaps the outgoing one by the
  // transition length (see repackVideoTrack) — and the overlap gets an equal-power fade (qsin)
  // out on the outgoing clip and in on the incoming one, so the sum stays level and the total
  // length matches the xfade'd video. A transition next to a deactivated clip has nothing to
  // fade against (preview plays the live clip at full volume), so it gets no fade.
  const audioFades = new Map<string, { in?: number; out?: number }>()
  if (primaryTrack) {
    const rollClips = sortedClips<MediaClip>(primaryTrack).filter((c) => c.kind === 'media')
    for (let i = 1; i < rollClips.length; i++) {
      const clip = rollClips[i]
      const prev = rollClips[i - 1]
      if (!clip.transitionIn || clip.transitionIn.duration <= 0 || clip.disabled || prev.disabled) continue
      const d = Math.min(clip.transitionIn.duration, prev.duration, clip.duration)
      if (d <= 0) continue
      audioFades.set(clip.id, { ...audioFades.get(clip.id), in: d })
      audioFades.set(prev.id, { ...audioFades.get(prev.id), out: d })
    }
  }
  /** `afade=…,` for a clip's transition fades (clip-local time, after speed/reverse), or ''. */
  function fadePrefix(clip: MediaClip): string {
    const f = audioFades.get(clip.id)
    // The clip's own fade handles (linear), then any transition crossfade (equal-power).
    const ui = Math.min(clip.fadeIn ?? 0, clip.duration)
    const uo = Math.min(clip.fadeOut ?? 0, clip.duration)
    let chain = ''
    if (ui > 0) chain += `afade=t=in:st=0:d=${ui},`
    if (uo > 0) chain += `afade=t=out:st=${Math.max(0, clip.duration - uo)}:d=${uo},`
    if (!f) return chain
    if (f.in) chain += `afade=t=in:st=0:d=${f.in}:curve=qsin,`
    if (f.out) chain += `afade=t=out:st=${Math.max(0, clip.duration - f.out)}:d=${f.out}:curve=qsin,`
    return chain
  }

  function addAudioClip(clip: MediaClip, asset: MediaAsset) {
    if (clip.disabled || !asset.hasAudio || clip.muted || clip.volume <= 0) return
    // An overridden clip (e.g. background removed) still plays the ORIGINAL file's audio.
    const ref = inputFor(audioAssetFor.get(clip.assetId) ?? clip.assetId)
    const trimmed = nextLabel('atrim')
    const delayMs = Math.round(clip.start * 1000)
    const segments = clipSpeedSegments(clip)

    if (segments.length === 1 && segments[0].speed === 1 && !clip.reversed) {
      filters.push(
        `[${ref.index}:a]atrim=start=${segments[0].start}:end=${segments[0].end},asetpts=PTS-STARTPTS,` +
          `${fadePrefix(clip)}volume=${clip.volume},adelay=${delayMs}|${delayMs}[${trimmed}]`
      )
      audioMixLabels.push(trimmed)
      return
    }

    // atempo only accepts 0.5-2.0 per instance, so each segment's speed may need chaining
    // (see atempoFactors). Segments are assembled first, then volume/adelay applied once to
    // the whole concatenated clip (those don't need to vary per segment).
    const pieceLabels = segments.map((seg) => {
      const piece = nextLabel('aspeed')
      const factors = atempoFactors(seg.speed)
      // "Change audio pitch": resample like a sped-up tape (pitch follows speed) instead of
      // atempo's pitch-preserving time-stretch.
      const tempoChain =
        seg.speed === 1
          ? ''
          : clip.changeAudioPitch
            ? `,aresample=48000,asetrate=${Math.round(48000 * seg.speed)},aresample=48000`
            : factors.length === 1 && factors[0] === 1
              ? ''
              : `,${factors.map((f) => `atempo=${f}`).join(',')}`
      filters.push(`[${ref.index}:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS${tempoChain}[${piece}]`)
      return piece
    })
    let concatLabel =
      pieceLabels.length > 1
        ? (() => {
            const label = nextLabel('aconcat')
            filters.push(`${pieceLabels.map((l) => `[${l}]`).join('')}concat=n=${pieceLabels.length}:v=0:a=1[${label}]`)
            return label
          })()
        : pieceLabels[0]

    // Mirrors trimmedSegmentLabel's video handling: reverse is a final flip applied to the
    // whole assembled (still-forward) clip, not per-segment.
    if (clip.reversed) {
      const revLabel = nextLabel('arev')
      filters.push(`[${concatLabel}]areverse[${revLabel}]`)
      concatLabel = revLabel
    }

    filters.push(`[${concatLabel}]${fadePrefix(clip)}volume=${clip.volume},adelay=${delayMs}|${delayMs}[${trimmed}]`)
    audioMixLabels.push(trimmed)
  }

  for (const track of audioTracks) {
    for (const clip of sortedClips<MediaClip>(track)) {
      if (clip.kind !== 'media') continue
      const asset = assetById.get(clip.assetId)
      if (asset) addAudioClip(clip, asset)
    }
  }
  for (const track of videoTracks) {
    for (const clip of sortedClips<MediaClip>(track)) {
      if (clip.kind !== 'media') continue
      const asset = assetById.get(clip.assetId)
      if (asset) addAudioClip(clip, asset)
    }
  }

  let audioOutLabel: string | null = null
  if (audioMixLabels.length === 1) {
    audioOutLabel = audioMixLabels[0]
  } else if (audioMixLabels.length > 1) {
    const out = nextLabel('amix')
    filters.push(`${audioMixLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioMixLabels.length}:normalize=0[${out}]`)
    audioOutLabel = out
  }

  return {
    inputs,
    filterComplex: filters.join(';'),
    videoOutLabel,
    audioOutLabel,
    videoArgs: ['-r', String(fps), '-s', `${width}x${height}`],
    files: [...planFiles].map(([path, content]) => ({ path, content }))
  }
}

/** `range` renders only [start, end) of the timeline (Export selected clips / compound clips). */
export function planToFfmpegArgs(plan: FfmpegPlan, outputPath: string, range?: { start: number; end: number }): string[] {
  // The final RGB/YUV conversion uses the Rec. 709 matrix explicitly; swscale's default is
  // Rec. 601, which would shift colours (most visibly in text and RGBA overlays).
  const filterComplex = `${plan.filterComplex};[${plan.videoOutLabel}]scale=in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv,format=yuv420p[vout709]`
  const args: string[] = ['-y', ...plan.inputs, '-filter_complex', filterComplex]
  args.push('-map', '[vout709]')
  if (plan.audioOutLabel) {
    args.push('-map', `[${plan.audioOutLabel}]`)
  }
  if (range) args.push('-ss', range.start.toFixed(3), '-t', Math.max(0.05, range.end - range.start).toFixed(3))
  args.push(...plan.videoArgs, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...REC709_OUTPUT_ARGS)
  if (plan.audioOutLabel) {
    args.push('-c:a', 'aac')
  } else {
    args.push('-an')
  }
  args.push(outputPath)
  return args
}
