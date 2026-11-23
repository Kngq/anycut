import { useEffect, useMemo, useRef, useState } from 'react'
import Slider from './Slider'
import { isMainVideoTrack, selectionOf, useProjectStore } from '../state/projectStore'
import ClipContextMenu from './ClipContextMenu'
import { useLayoutStore, TRACK_HEIGHTS, type TrackHeightMode } from '../state/layoutStore'
import { effectCatalogEntry, formatMMSS, projectDuration, TRANSITION_CATALOG, type Clip, type MediaAsset, type ThumbnailCover, type Track } from '@shared/types'
import { displayTracks } from '@shared/trackOrder'
import { resolveDrop, type DragPayload, type DropResolution } from '@shared/dropTargets'
import { clipDrawInsets, resizedTransitionDuration, transitionBlocks, type TransitionBlock } from '@shared/transitionBlocks'
import { resolveMediaDrop, snapFreeStart, trackForAsset as trackForAssetIn, type MediaDropGhost } from '@shared/mediaDrop'
import { ASSET_DRAG_MIME, assetsFromPaths, droppedFilePaths, isMediaDrag } from '../media'
import { activeAssetDragId, activeDragPayload, endAssetDrag, endFxDrag, isFxDrag, readFxPayload } from '../dragPayload'
import { useToastStore } from '../state/toastStore'

/** Width of the sticky track label column; lanes and the ruler's 0s mark start after it. */
const LABEL_WIDTH = 90

/** Clip decoration heights (default mode baseline; scaled per track-height mode in the component). */
const TRACK_VIDEO_WAVE_HEIGHT = 24 // waveform strip under a video clip's thumbnails
const TRACK_AUDIO_WAVE_HEIGHT = 56 // taller waveform for a standalone audio clip

interface DragState {
  clipId: string
  sourceTrackId: string
  pointerStartX: number
  pointerStartY: number
  clipStartPx: number
  dx: number
  trackRowY: number[]
  trackRowIds: string[]
  /** Snap to clip edges / the playhead while moving along a free track (⌘/Ctrl turns it off). */
  snap: boolean
}

/** Live hover state of an effect/transition drag: what a drop here would do (the ghost). */
interface FxDropState {
  trackId: string
  payload: DragPayload
  resolution: DropResolution
  /** Pointer x within the lane (px), for placing the reject chip. */
  laneX: number
}

/** Live hover state of a media-bin asset drag: CapCut's "follow segment" ghost. */
interface MediaGhostState extends MediaDropGhost {
  name: string
  kind: 'video' | 'audio'
}

/** Pointer distance (px) from the timeline's visible edge that starts auto-scrolling during a
 *  drag (CapCut's `autoScrollMargin: 20`), and how far each dragover tick scrolls. */
const DRAG_SCROLL_MARGIN = 20
const DRAG_SCROLL_STEP = 14
/** Scrubbing the playhead into this many px of the lane's left/right edge scrolls the timeline;
 *  the further in (or past the edge), the faster, up to SCRUB_SCROLL_MAX px per frame. */
const SCRUB_SCROLL_ZONE = 40
const SCRUB_SCROLL_MAX = 28

function sameGhost(a: MediaGhostState | null, b: MediaGhostState | null): boolean {
  if (!a || !b) return a === b
  return a.trackId === b.trackId && a.start === b.start && a.snapTime === b.snapTime && a.snapKind === b.snapKind && a.name === b.name
}

function payloadLabel(payload: DragPayload): string {
  if (payload.kind === 'effect') return effectCatalogEntry(payload.type)?.label ?? payload.type
  return TRANSITION_CATALOG.find((t) => t.type === payload.type)?.label ?? payload.type
}

interface TrimState {
  clipId: string
  edge: 'start' | 'end'
}

function clipClassName(clip: Clip, track: Track): string {
  if (clip.kind === 'text') return 'text'
  return track.type === 'audio' ? 'audio' : 'video'
}

/** Formats seconds as HH:MM:SS:FF (frames at 30fps), the CapCut-style clip duration readout. */
function formatTimecode(seconds: number, fps = 30): string {
  const total = Math.max(0, seconds)
  const whole = Math.floor(total)
  const frames = Math.round((total - whole) * fps) % fps
  const hh = Math.floor(whole / 3600)
  const mm = Math.floor((whole % 3600) / 60)
  const ss = whole % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(frames)}`
}

/** Draws a clip's audio waveform as a symmetric bar graph on a canvas. VIRTUALIZED: the canvas
 *  only spans the visible slice of the clip ([visibleStart, visibleEnd) in clip-local px), so a
 *  clip that's hundreds of thousands of px wide at high zoom never exceeds the browser's max
 *  canvas size (which would blank it). Peak sampling still maps against the FULL clip width so
 *  the waveform is positionally correct. Redraws on any size/scroll/peak/trim change. */
function WaveformCanvas({
  peaks,
  fullWidth,
  height,
  startFrac,
  endFrac,
  visibleStart,
  visibleEnd
}: {
  peaks: number[]
  fullWidth: number
  height: number
  startFrac: number
  endFrac: number
  visibleStart: number
  visibleEnd: number
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const segLeft = Math.max(0, Math.floor(visibleStart))
  const segWidth = Math.max(1, Math.ceil(visibleEnd) - segLeft)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, segWidth)
    const h = Math.max(1, Math.floor(height))
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (peaks.length === 0 || w < 2 || fullWidth < 2) return

    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    const mid = h / 2
    const span = Math.max(1e-6, endFrac - startFrac)
    // Each local column x maps to an absolute clip-local pixel (segLeft + x), then to a source
    // fraction across the full clip width, then to a peak bucket.
    for (let x = 0; x < w; x++) {
      const frac = startFrac + ((segLeft + x) / fullWidth) * span
      const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor(frac * peaks.length)))
      const amp = peaks[idx]
      const barH = Math.max(1, amp * (h - 2))
      ctx.fillRect(x, mid - barH / 2, 1, barH)
    }
  }, [peaks, fullWidth, height, startFrac, endFrac, segLeft, segWidth])

  return <canvas ref={ref} className="clip-waveform" style={{ left: segLeft, width: segWidth, height }} />
}

/** A filmstrip of thumbnail frames sliced from an asset's sprite sheet, tiled edge-to-edge (no
 *  gaps) across the clip. VIRTUALIZED: only the tiles overlapping the visible scroll window are
 *  rendered, so an extremely wide clip (high zoom) stays cheap and never hits the browser's
 *  wide-element paint limit. Each tile shows a distinct frame chosen by its position within the
 *  clip's trimmed source window, so zooming in reveals more frames. */
function FilmstripTiles({
  cover,
  width,
  height,
  startFrac,
  endFrac,
  visibleStart,
  visibleEnd
}: {
  cover: ThumbnailCover
  width: number
  height: number
  startFrac: number
  endFrac: number
  /** Visible x-range within the clip (clip-local px, already clamped to [0, width]). */
  visibleStart: number
  visibleEnd: number
}) {
  const url = window.api.fileUrl(cover.path)
  const frames = Math.max(1, cover.frames)
  const aspect = cover.frameWidth > 0 && cover.frameHeight > 0 ? cover.frameWidth / cover.frameHeight : 16 / 9
  const tileW = Math.max(16, Math.round(height * aspect))
  const tileCount = Math.max(1, Math.ceil(width / tileW))
  const span = Math.max(1e-6, endFrac - startFrac)

  // Only emit tiles whose [x, x+tileW) intersects the visible window.
  const firstTile = Math.max(0, Math.floor(visibleStart / tileW))
  const lastTile = Math.min(tileCount - 1, Math.ceil(visibleEnd / tileW))

  const tiles = []
  for (let i = firstTile; i <= lastTile; i++) {
    const frac = startFrac + ((i + 0.5) / tileCount) * span
    const frameIdx = Math.min(frames - 1, Math.max(0, Math.floor(frac * frames)))
    tiles.push(
      <div
        key={i}
        className="clip-tile"
        style={{
          left: i * tileW,
          width: tileW,
          backgroundImage: `url(${url})`,
          backgroundSize: `${frames * tileW}px 100%`,
          backgroundPosition: `${-frameIdx * tileW}px center`,
          backgroundRepeat: 'no-repeat'
        }}
      />
    )
  }
  return (
    <div className="clip-filmstrip" style={{ height }}>
      {tiles}
    </div>
  )
}

/** Thin SVG wrapper matching the media-bin tab icons (same stroke style as CapCut's toolbar). */
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
      {children}
    </svg>
  )
}

// CapCut-style glyphs, kept minimal and recognizable at 18px.
const IconUndo = (
  <Icon>
    <path d="M9 7H16a4 4 0 0 1 0 8h-3" />
    <path d="M9 7 5.5 10.5 9 14" />
  </Icon>
)
const IconRedo = (
  <Icon>
    <path d="M15 7H8a4 4 0 0 0 0 8h3" />
    <path d="M15 7l3.5 3.5L15 14" />
  </Icon>
)
const IconSplit = (
  <Icon>
    <line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2 2.5" />
    <path d="M7 6v12M7 6l-2 2M7 6l2 2" />
    <path d="M17 6v12M17 18l-2-2M17 18l2-2" />
  </Icon>
)
const IconDelete = (
  <Icon>
    <path d="M5 7h14" />
    <path d="M9 7V5h6v2" />
    <path d="M7 7l1 13h8l1-13" />
  </Icon>
)
const IconMirror = (
  <Icon>
    <line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2 2.5" />
    <path d="M9 7l-4 5 4 5z" />
    <path d="M15 7l4 5-4 5z" />
  </Icon>
)
const IconRotate = (
  <Icon>
    <path d="M4 12a8 8 0 1 1 2.3 5.6" />
    <path d="M4 20v-4h4" />
  </Icon>
)
const IconAddVideo = (
  <Icon>
    <rect x="3" y="6" width="12" height="12" rx="2" />
    <path d="M19 9v6" />
    <path d="M16 12h6" />
  </Icon>
)
const IconAddAudio = (
  <Icon>
    <path d="M4 10v4" />
    <path d="M8 7v10" />
    <path d="M12 9v6" />
    <path d="M19 9v6" />
    <path d="M16 12h6" />
  </Icon>
)

interface ToolButtonProps {
  icon: React.ReactNode
  label: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

/** One CapCut-style icon button with a hover tooltip showing the action name and its shortcut
 *  (e.g. "Undo (⌘Z)"), matching the reference screenshot. Icon-only; the label lives in the
 *  tooltip and the title attribute (for accessibility). */
function ToolButton({ icon, label, shortcut, active, disabled, onClick }: ToolButtonProps) {
  return (
    <button
      className={`tl-tool ${active ? 'active' : ''}`}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      {icon}
      <span className="tl-tooltip">
        {label}
        {shortcut ? ` (${shortcut})` : ''}
      </span>
    </button>
  )
}

function sameFxDrop(a: FxDropState, b: FxDropState): boolean {
  if (a.trackId !== b.trackId || a.payload !== b.payload) return false
  const ra = a.resolution
  const rb = b.resolution
  if (ra.kind !== rb.kind) return false
  if (ra.kind === 'attach' && rb.kind === 'attach') return ra.clipId === rb.clipId
  if (ra.kind === 'transition' && rb.kind === 'transition') return ra.rightClipId === rb.rightClipId && ra.duration === rb.duration
  // Reject chips follow the pointer, so only skip tiny moves.
  return ra.kind === 'reject' && rb.kind === 'reject' && ra.reason === rb.reason && Math.abs(a.laneX - b.laneX) < 4
}

/** Height of a text/caption track row (CapCut keeps these compact). */
const TEXT_ROW_HEIGHT = 36

export default function Timeline() {
  const project = useProjectStore((s) => s.project)
  const pxPerSecond = useProjectStore((s) => s.pxPerSecond)
  const playhead = useProjectStore((s) => s.playhead)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const selectedClipIds = useProjectStore((s) => s.selectedClipIds)
  const toggleClipSelection = useProjectStore((s) => s.toggleClipSelection)
  const deleteSelection = useProjectStore((s) => s.deleteSelection)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; clipId: string | null } | null>(null)
  // CapCut row order: text/captions above the video, audio below.
  const rowTracks = useMemo(() => displayTracks(project), [project])
  const selectedIds = useMemo(() => selectionOf({ project, selectedClipId, selectedClipIds }), [project, selectedClipId, selectedClipIds])
  const missingAssetIds = useProjectStore((s) => s.missingAssetIds)
  const setPlayhead = useProjectStore((s) => s.setPlayhead)
  const selectClip = useProjectStore((s) => s.selectClip)
  const trimClip = useProjectStore((s) => s.trimClip)
  const moveFreeClip = useProjectStore((s) => s.moveFreeClip)
  const reorderVideoClip = useProjectStore((s) => s.reorderVideoClip)
  const setZoom = useProjectStore((s) => s.setZoom)
  const addAsset = useProjectStore((s) => s.addAsset)
  const addMediaClipToTrack = useProjectStore((s) => s.addMediaClipToTrack)
  const addTrack = useProjectStore((s) => s.addTrack)
  const splitClipAtPlayhead = useProjectStore((s) => s.splitClipAtPlayhead)
  const removeClip = useProjectStore((s) => s.removeClip)
  const rotateClip = useProjectStore((s) => s.rotateClip)
  const toggleClipFlipH = useProjectStore((s) => s.toggleClipFlipH)
  const undo = useProjectStore((s) => s.undo)
  const addClipEffect = useProjectStore((s) => s.addClipEffect)
  const setClipTransition = useProjectStore((s) => s.setClipTransition)
  const focusEffect = useProjectStore((s) => s.focusEffect)
  const pushToast = useToastStore((s) => s.push)
  const trackHeightMode = useLayoutStore((s) => s.trackHeight)
  const setTrackHeight = useLayoutStore((s) => s.setTrackHeight)
  const rowHeight = TRACK_HEIGHTS[trackHeightMode]
  // Short mode shows only the name bar (no filmstrip/waveform); default/tall scale the
  // decoration heights to fill the taller row.
  const showDecorations = trackHeightMode !== 'short'
  const coverRowHeight = trackHeightMode === 'tall' ? 96 : 60
  const videoWaveHeight = trackHeightMode === 'tall' ? 30 : TRACK_VIDEO_WAVE_HEIGHT
  const audioWaveHeight = trackHeightMode === 'tall' ? Math.round(rowHeight * 0.7) : TRACK_AUDIO_WAVE_HEIGHT
  const redo = useProjectStore((s) => s.redo)
  const canUndo = useProjectStore((s) => s.past.length > 0)
  const canRedo = useProjectStore((s) => s.future.length > 0)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** True while the playhead is being dragged (the drag does its own scrolling). */
  const scrubbingRef = useRef(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const trackRowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [trim, setTrim] = useState<TrimState | null>(null)
  const [dropTrackId, setDropTrackId] = useState<string | null>(null)
  const [fxDrop, setFxDrop] = useState<FxDropState | null>(null)
  const [mediaGhost, setMediaGhost] = useState<MediaGhostState | null>(null)
  /** A transition block being resized by its edge handle (committed on release). */
  const [transResize, setTransResize] = useState<{ clipId: string; duration: number } | null>(null)
  /** Which transition block is highlighted (keyed by its owning clip). Clicking a block selects
   *  that clip too, so the Inspector shows the transition's settings. */
  const [selectedTransition, setSelectedTransition] = useState<string | null>(null)

  // An effect/transition drag can end anywhere (released over the bin, Esc, dropped outside the
  // window); clear the ghost and the recorded payload whenever any drag finishes.
  useEffect(() => {
    const clear = () => {
      setFxDrop(null)
      setMediaGhost(null)
      setDropTrackId(null)
      endFxDrag()
      endAssetDrag()
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])
  // Available width of the scroll container, tracked so the timeline can stretch to fill it
  // when the content is shorter than the panel (and still scroll when it's longer).
  const [wrapWidth, setWrapWidth] = useState(0)
  // Horizontal scroll offset of the timeline, tracked so clip decorations (filmstrip, waveform)
  // can render only the slice that's actually on screen — essential at high zoom, where a clip
  // can be hundreds of thousands of pixels wide (a single canvas/background that large fails to
  // paint, and one tile per frame would be tens of thousands of DOM nodes).
  const [scrollLeft, setScrollLeft] = useState(0)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      setWrapWidth(el.clientWidth)
      setScrollLeft(el.scrollLeft)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    el.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [])

  // Keep the playhead on screen when it moves by itself (playback, arrow-key stepping): page the
  // timeline so the playhead sits near the left of the lane again, like CapCut.
  useEffect(() => {
    const el = wrapRef.current
    if (!el || scrubbingRef.current) return
    const x = LABEL_WIDTH + playhead * pxPerSecond
    const viewLeft = el.scrollLeft + LABEL_WIDTH
    const viewRight = el.scrollLeft + el.clientWidth
    if (x > viewRight - 8) el.scrollLeft = x - LABEL_WIDTH - 40
    else if (x < viewLeft) el.scrollLeft = Math.max(0, x - LABEL_WIDTH - (el.clientWidth - LABEL_WIDTH) / 2)
  }, [playhead, pxPerSecond])

  const duration = useMemo(() => Math.max(projectDuration(project), 10), [project])
  const contentWidth = duration * pxPerSecond + 200
  // Stretch to the full panel width when the content doesn't already overflow it.
  const totalWidth = Math.max(contentWidth, wrapWidth)

  // Minimum zoom: the whole project must always occupy at least half the visible timeline,
  // regardless of its length. laneWidth is the pixels available after the sticky label column;
  // half of that divided by the duration gives the px/second floor. Falls back to the store's
  // own floor (10) until the container has been measured.
  const laneWidth = Math.max(0, wrapWidth - LABEL_WIDTH)
  const minPxPerSecond = laneWidth > 0 ? Math.max(1, (laneWidth / 2) / duration) : 10
  const maxPxPerSecond = 400

  // Keep the current zoom at or above the dynamic floor (e.g. after a longer clip is added, or
  // the panel is resized smaller). Only pushes up, never fights a user zooming in.
  useEffect(() => {
    if (pxPerSecond < minPxPerSecond) setZoom(minPxPerSecond)
  }, [minPxPerSecond, pxPerSecond, setZoom])

  function timeAt(clientX: number): number {
    const rect = bodyRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, (clientX - rect.left - LABEL_WIDTH) / pxPerSecond)
  }

  /** The track a dropped asset should land on: the hovered one if its type fits, else the first that does. */
  function trackForAsset(asset: MediaAsset, hovered: Track): Track | undefined {
    return trackForAssetIn(project, asset, hovered.id)
  }

  /** Scrolls the timeline while a drag hovers near its visible edge. dragover keeps firing while
   *  the pointer is still, so each event is one scroll tick (CapCut runs a timer instead). */
  function autoScrollDuringDrag(e: React.DragEvent) {
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (e.clientX > r.right - DRAG_SCROLL_MARGIN) el.scrollLeft += DRAG_SCROLL_STEP
    else if (e.clientX < r.left + LABEL_WIDTH + DRAG_SCROLL_MARGIN) el.scrollLeft -= DRAG_SCROLL_STEP
    if (e.clientY > r.bottom - DRAG_SCROLL_MARGIN) el.scrollTop += DRAG_SCROLL_STEP
    else if (e.clientY < r.top + DRAG_SCROLL_MARGIN) el.scrollTop -= DRAG_SCROLL_STEP
  }

  /** Hover AND drop placement for a media-bin asset (one resolver, so the ghost is the result).
   *  Holding ⌘/Ctrl turns snapping off, as in CapCut. */
  function resolveAssetAt(e: React.DragEvent, track: Track, asset: MediaAsset): MediaGhostState | null {
    const state = useProjectStore.getState()
    const ghost = resolveMediaDrop(state.project, asset, {
      trackId: track.id,
      time: timeAt(e.clientX),
      pxPerSecond,
      playhead: state.playhead,
      snap: !(e.metaKey || e.ctrlKey)
    })
    return ghost && { ...ghost, name: asset.name, kind: asset.kind === 'audio' ? 'audio' : 'video' }
  }

  /** One decision point for hover AND drop (CapCut's model): the same resolver result drives
   *  the ghost and the commit, so what you see before releasing is what you get. */
  function resolveFxAt(e: React.DragEvent, track: Track, payload: DragPayload): FxDropState {
    const rect = bodyRef.current?.getBoundingClientRect()
    const laneX = rect ? e.clientX - rect.left - LABEL_WIDTH : 0
    const resolution = resolveDrop(useProjectStore.getState().project, payload, { trackId: track.id, time: timeAt(e.clientX), pxPerSecond })
    return { trackId: track.id, payload, resolution, laneX }
  }

  function onFxDragOver(e: React.DragEvent, track: Track) {
    const payload = activeDragPayload()
    if (!payload) return
    const next = resolveFxAt(e, track, payload)
    if (next.resolution.kind !== 'reject') {
      e.preventDefault() // accept: the browser shows the copy cursor and will fire drop
      e.dataTransfer.dropEffect = 'copy'
    } else {
      e.dataTransfer.dropEffect = 'none'
    }
    setFxDrop((prev) => (prev && sameFxDrop(prev, next) ? prev : next))
  }

  function onLaneDragOver(e: React.DragEvent, track: Track) {
    if (isFxDrag(e.dataTransfer) || isMediaDrag(e.dataTransfer)) autoScrollDuringDrag(e)
    if (isFxDrag(e.dataTransfer)) return onFxDragOver(e, track)
    if (!isMediaDrag(e.dataTransfer)) return
    const assetId = activeAssetDragId()
    const asset = assetId ? useProjectStore.getState().project.assets.find((a) => a.id === assetId) : undefined
    if (asset) {
      // Bin asset: CapCut's follow ghost, at the snapped spot it will land on.
      const next = resolveAssetAt(e, track, asset)
      if (!next) {
        e.dataTransfer.dropEffect = 'none'
        setMediaGhost(null)
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setMediaGhost((prev) => (sameGhost(prev, next) ? prev : next))
      return
    }
    // Files from Finder: durations are unknown until import, so there's no ghost. CapCut doesn't
    // draw one either. Highlight the lane instead.
    e.preventDefault() // required, or the browser refuses the drop
    e.dataTransfer.dropEffect = 'copy'
    if (dropTrackId !== track.id) setDropTrackId(track.id)
  }

  function onLaneDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDropTrackId(null)
      setFxDrop(null)
      setMediaGhost(null)
    }
  }

  function onFxDrop(e: React.DragEvent, track: Track) {
    e.preventDefault()
    const payload = readFxPayload(e.dataTransfer)
    setFxDrop(null)
    endFxDrag()
    if (!payload) return
    const { resolution } = resolveFxAt(e, track, payload)
    if (resolution.kind === 'attach' && payload.kind === 'effect') {
      addClipEffect(resolution.clipId, payload.type)
      // Reveal the new effect in the Inspector, like CapCut selecting the segment it landed on.
      const clip = useProjectStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === resolution.clipId)
      const added = clip?.kind === 'media' ? clip.effects?.[clip.effects.length - 1] : undefined
      if (added) focusEffect(resolution.clipId, added.id)
    } else if (resolution.kind === 'transition' && payload.kind === 'transition') {
      setClipTransition(resolution.rightClipId, { type: payload.type, duration: resolution.duration })
      selectClip(resolution.rightClipId)
    } else if (resolution.kind === 'reject') {
      pushToast('info', resolution.reason)
    }
  }

  async function onLaneDrop(e: React.DragEvent, track: Track) {
    if (isFxDrag(e.dataTransfer)) return onFxDrop(e, track)
    if (!isMediaDrag(e.dataTransfer)) return
    e.preventDefault()
    setDropTrackId(null)
    setMediaGhost(null)
    // DataTransfer is only readable during the event, so read everything before awaiting.
    const dropTime = timeAt(e.clientX)
    const assetId = e.dataTransfer.getData(ASSET_DRAG_MIME)
    const paths = assetId ? [] : droppedFilePaths(e.dataTransfer)

    // A single bin asset commits exactly where its ghost was drawn (same resolver).
    if (assetId) {
      endAssetDrag()
      const asset = useProjectStore.getState().project.assets.find((a) => a.id === assetId)
      const ghost = asset && resolveAssetAt(e, track, asset)
      if (asset && ghost) addMediaClipToTrack(ghost.trackId, asset, ghost.start, { insertAtStart: true })
      return
    }

    let assets: MediaAsset[]
    if (assetId) {
      const asset = useProjectStore.getState().project.assets.find((a) => a.id === assetId)
      assets = asset ? [asset] : []
    } else {
      assets = await assetsFromPaths(paths)
      assets.forEach(addAsset)
    }

    // Multiple files are laid out one after another starting at the drop point.
    let cursor = dropTime
    for (const asset of assets) {
      const target = trackForAsset(asset, track)
      if (!target) continue
      addMediaClipToTrack(target.id, asset, cursor, { insertAtStart: true })
      const state = useProjectStore.getState()
      const added = state.project.tracks.flatMap((t) => t.clips).find((c) => c.id === state.selectedClipId)
      if (added) cursor = added.start + added.duration
    }
  }

  /** Press-and-drag on the ruler scrubs the playhead: it jumps to the pointer on mousedown and
   *  then follows the cursor until release (a plain click is just the degenerate zero-move case). */
  function onRulerPointerDown(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    scrubbingRef.current = true
    const scrubEnd = (totalWidth - LABEL_WIDTH) / pxPerSecond
    let pointerX = e.clientX
    let raf = 0

    /** The playhead follows the pointer, held inside the visible lane: past an edge the timeline
     *  scrolls instead, and the playhead rides along at that edge. */
    function follow() {
      const el = wrapRef.current
      // Never past the end of the timeline: the playhead line would widen the scroll area and
      // auto-scroll would run on into empty space.
      const end = (n: number) => setPlayhead(Math.min(n, scrubEnd))
      if (!el) return end(timeAt(pointerX))
      const r = el.getBoundingClientRect()
      const laneLeft = r.left + LABEL_WIDTH
      end(timeAt(Math.min(Math.max(pointerX, laneLeft), r.right - 1)))
    }
    function tick() {
      raf = 0
      const el = wrapRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const laneLeft = r.left + LABEL_WIDTH
      let step = 0
      if (pointerX > r.right - SCRUB_SCROLL_ZONE) step = Math.min(SCRUB_SCROLL_MAX, (pointerX - (r.right - SCRUB_SCROLL_ZONE)) / 2 + 2)
      else if (pointerX < laneLeft + SCRUB_SCROLL_ZONE) step = -Math.min(SCRUB_SCROLL_MAX, (laneLeft + SCRUB_SCROLL_ZONE - pointerX) / 2 + 2)
      if (step === 0) return
      el.scrollLeft += step
      follow()
      // Keep scrolling while the pointer rests in the edge zone (mousemove doesn't fire while
      // it's still); stops on release or when the pointer moves back out of the zone.
      raf = requestAnimationFrame(tick)
    }
    function onMove(ev: MouseEvent) {
      pointerX = ev.clientX
      follow()
      if (!raf) raf = requestAnimationFrame(tick)
    }
    function onUp() {
      if (raf) cancelAnimationFrame(raf)
      scrubbingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    follow()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** Where a clip being dragged along a floating track (overlay video, audio, text) would land:
   *  its dragged start, snapped like a bin drop. Null for the main video roll (it reorders). */
  function freeDragPlacement(d: DragState): { start: number; snapTime: number | null } | null {
    const state = useProjectStore.getState()
    const source = state.project.tracks.find((t) => t.id === d.sourceTrackId)
    const clip = source?.clips.find((c) => c.id === d.clipId)
    if (!source || !clip || isMainVideoTrack(state.project, source.id)) return null
    const raw = Math.max(0, d.clipStartPx + d.dx) / pxPerSecond
    if (!d.snap) return { start: raw, snapTime: null }
    return snapFreeStart(state.project, raw, clip.duration, pxPerSecond, state.playhead, clip.id)
  }

  function onClipPointerDown(e: React.MouseEvent, clip: Clip, track: Track) {
    e.stopPropagation()
    // Right button: keep a multi-selection the clip belongs to (the context menu acts on it).
    if (e.button === 2) {
      if (!selectedIds.includes(clip.id)) selectClip(clip.id)
      return
    }
    // Cmd/Ctrl/Shift-click adds to (or removes from) the selection, no drag.
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      toggleClipSelection(clip.id)
      return
    }
    selectClip(clip.id)
    setSelectedTransition(null)
    const rows = rowTracks.map((t) => {
      const el = trackRowRefs.current.get(t.id)
      const rect = el?.getBoundingClientRect()
      return rect ? rect.top + rect.height / 2 : 0
    })
    const initial: DragState = {
      clipId: clip.id,
      sourceTrackId: track.id,
      pointerStartX: e.clientX,
      pointerStartY: e.clientY,
      clipStartPx: clip.start * pxPerSecond,
      dx: 0,
      trackRowY: rows,
      trackRowIds: rowTracks.map((t) => t.id),
      snap: true
    }
    dragRef.current = initial
    setDrag(initial)

    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return
      dragRef.current = { ...dragRef.current, dx: ev.clientX - dragRef.current.pointerStartX, snap: !(ev.metaKey || ev.ctrlKey) }
      setDrag(dragRef.current)
    }
    function onUp(ev: MouseEvent) {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!d) return
      // A plain click shouldn't count as a move (it would mark the project dirty for nothing).
      if (Math.abs(ev.clientX - d.pointerStartX) < 3 && Math.abs(ev.clientY - d.pointerStartY) < 3) return

      const newLeftPx = Math.max(0, d.clipStartPx + (ev.clientX - d.pointerStartX))
      const newStart = newLeftPx / pxPerSecond
      const placed = freeDragPlacement({ ...d, dx: ev.clientX - d.pointerStartX, snap: !(ev.metaKey || ev.ctrlKey) })

      let targetTrackId = d.sourceTrackId
      let bestDist = Infinity
      d.trackRowY.forEach((y, i) => {
        const dist = Math.abs(ev.clientY - y)
        if (dist < bestDist) {
          bestDist = dist
          targetTrackId = d.trackRowIds[i]
        }
      })
      const tracks = useProjectStore.getState().project.tracks
      const targetTrack = tracks.find((t) => t.id === targetTrackId)
      const sourceTrack = tracks.find((t) => t.id === d.sourceTrackId)
      if (!targetTrack || !sourceTrack) return

      if (targetTrack.type !== sourceTrack.type) {
        // Don't allow cross-type drops in this barebones build.
        return
      }

      if (isMainVideoTrack(useProjectStore.getState().project, targetTrack.id)) {
        // The main roll is magnetic: a drop picks an insertion point between its clips.
        const siblings = targetTrack.clips.filter((c) => c.id !== d.clipId)
        let index = siblings.length
        for (let i = 0; i < siblings.length; i++) {
          if (newStart < siblings[i].start + siblings[i].duration / 2) {
            index = i
            break
          }
        }
        reorderVideoClip(d.clipId, targetTrackId, index)
      } else {
        // Overlay video / audio / text float: the clip lands where it was dropped (snapped).
        moveFreeClip(d.clipId, placed?.start ?? newStart, targetTrackId)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function onTrimPointerDown(e: React.MouseEvent, clip: Clip, edge: 'start' | 'end') {
    e.stopPropagation()
    selectClip(clip.id)
    setTrim({ clipId: clip.id, edge })

    function onMove(ev: MouseEvent) {
      const t = timeAt(ev.clientX)
      trimClip(clip.id, edge, t)
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setTrim(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** CapCut-style attached-effect badge: the first effect's name plus a count; click to reveal it
   *  in the Inspector. An effect whose type this build doesn't know is flagged as lost. */
  function renderEffectBadge(clip: Extract<Clip, { kind: 'media' }>) {
    const effects = clip.effects ?? []
    const first = effects[0]
    const entry = effectCatalogEntry(first.type)
    const lost = effects.some((fx) => !effectCatalogEntry(fx.type))
    const names = effects.map((fx) => effectCatalogEntry(fx.type)?.label ?? `${fx.type} (lost)`)
    return (
      <span
        className={`clip-effect-badge ${lost ? 'lost' : ''}`}
        title={`Effects: ${names.join(', ')}. Click to edit.`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          focusEffect(clip.id, first.id)
        }}
      >
        {lost ? '⚠ ' : ''}Effect: {entry?.label ?? 'Lost effect'}
        {effects.length > 1 ? ` +${effects.length - 1}` : ''}
      </span>
    )
  }

  /** CapCut-style transition block over a cut: a translucent grey segment centred on the cut,
   *  icon in the middle, edge handles that stretch it symmetrically (longer = slower). */
  function renderTransitionBlock(block: TransitionBlock) {
    const live = transResize?.clipId === block.clipId ? transResize.duration : block.duration
    const width = live * pxPerSecond
    const left = (block.mid - live / 2) * pxPerSecond
    const label = TRANSITION_CATALOG.find((t) => t.type === block.type)?.label ?? block.type
    const selected = selectedClipId === block.clipId && selectedTransition === block.clipId

    function onHandleDown(e: React.MouseEvent) {
      e.stopPropagation()
      e.preventDefault()
      selectClip(block.clipId)
      setSelectedTransition(block.clipId)
      let latest = block.duration
      setTransResize({ clipId: block.clipId, duration: latest })
      function onMove(ev: MouseEvent) {
        latest = resizedTransitionDuration(block, timeAt(ev.clientX))
        setTransResize({ clipId: block.clipId, duration: latest })
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setTransResize(null)
        // One undo step for the whole gesture.
        if (Math.abs(latest - block.duration) > 1e-3) setClipTransition(block.clipId, { type: block.type, duration: latest })
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    return (
      <div
        key={`tr-${block.clipId}`}
        className={`transition-block ${selected ? 'selected' : ''} ${transResize?.clipId === block.clipId ? 'resizing' : ''}`}
        style={{ left, width: Math.max(width, 4) }}
        title={`${label} · ${live.toFixed(2)}s. Drag an edge to make it faster or slower.`}
        onMouseDown={(e) => {
          e.stopPropagation()
          selectClip(block.clipId)
          setSelectedTransition(block.clipId)
        }}
      >
        {width >= 20 && (
          <svg className="transition-block-icon" viewBox="0 0 18 18" width="18" height="18" aria-hidden>
            <path d="M3 6.5h10.5L11 4M15 11.5H4.5L7 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <div className="transition-handle left" onMouseDown={onHandleDown} />
        <div className="transition-handle right" onMouseDown={onHandleDown} />
        {transResize?.clipId === block.clipId && <span className="transition-readout">{live.toFixed(1)}s</span>}
      </div>
    )
  }

  function renderClip(clip: Clip, track: Track, inset: { left: number; right: number } = { left: 0, right: 0 }) {
    const isDraggingThis = drag?.clipId === clip.id
    // Clips next to a transition are drawn shortened by half of it, so they meet at the cut and
    // the transition block sits over the join (CapCut's look). Time positions are unchanged.
    const dragPlaced = isDraggingThis ? freeDragPlacement(drag) : null
    const left = (isDraggingThis ? (dragPlaced ? dragPlaced.start * pxPerSecond : drag.clipStartPx + drag.dx) : clip.start * pxPerSecond) + inset.left * pxPerSecond
    const width = Math.max((clip.duration - inset.left - inset.right) * pxPerSecond, 4)

    const asset = clip.kind === 'media' ? project.assets.find((a) => a.id === clip.assetId) : undefined
    const offline = clip.kind === 'media' && missingAssetIds.includes(clip.assetId)
    const name = clip.kind === 'text' ? clip.text : asset?.name ?? track.name
    const headerLabel = clip.kind === 'text' ? clip.text : `${name}  ${formatTimecode(clip.duration)}`

    // The portion of the source this clip shows, as fractions of the full source duration —
    // used to crop the waveform to the trimmed window so it tracks trimming.
    let startFrac = 0
    let endFrac = 1
    if (clip.kind === 'media' && asset && asset.duration > 0) {
      startFrac = Math.min(1, Math.max(0, clip.trimIn / asset.duration))
      endFrac = Math.min(1, Math.max(startFrac + 1e-4, clip.trimOut / asset.duration))
      // Crop the decorations to the drawn (inset) part of the clip.
      if (clip.duration > 0 && (inset.left > 0 || inset.right > 0)) {
        const span = endFrac - startFrac
        const s0 = startFrac + (span * inset.left) / clip.duration
        const e0 = endFrac - (span * inset.right) / clip.duration
        startFrac = s0
        endFrac = Math.max(s0 + 1e-4, e0)
      }
    }

    // A filmstrip of distinct frames sliced from the asset's sprite sheet, tiled edge-to-edge
    // (no gaps) across the clip. Rendered as discrete tiles so it scales to any zoom without the
    // wide-background painting failure, and shows more frames the further you zoom in.
    const hasCover = showDecorations && clip.kind === 'media' && track.type !== 'audio' && !!asset?.cover
    const hasWaveform = showDecorations && clip.kind === 'media' && !!asset?.waveform && asset.waveform.peaks.length > 0
    const coverHeight = track.type === 'audio' ? 0 : coverRowHeight

    // Visible slice of this clip in clip-local px (what overlaps the scrolled viewport). Both the
    // filmstrip and waveform render only this slice, so an enormous clip at high zoom stays cheap
    // and never overflows a canvas/element size limit. A small margin pre-renders just offscreen.
    const VIRT_MARGIN = 256
    const clipBodyLeft = LABEL_WIDTH + left
    const visibleStart = Math.max(0, Math.min(width, scrollLeft - clipBodyLeft - VIRT_MARGIN))
    const visibleEnd = Math.max(0, Math.min(width, scrollLeft + wrapWidth - clipBodyLeft + VIRT_MARGIN))
    const anyVisible = visibleEnd > visibleStart

    return (
      <div
        key={clip.id}
        className={`clip ${clipClassName(clip, track)} ${hasCover ? 'has-cover' : ''} ${selectedIds.includes(clip.id) ? 'selected' : ''} ${clip.disabled ? 'disabled' : ''} ${offline ? 'offline' : ''} ${fxDrop?.resolution.kind === 'attach' && fxDrop.resolution.clipId === clip.id ? 'drop-attach' : ''}`}
        style={{ left, width, zIndex: isDraggingThis ? 10 : 1 }}
        onMouseDown={(e) => onClipPointerDown(e, clip, track)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setCtxMenu({ x: e.clientX, y: e.clientY, clipId: clip.id })
        }}
        title={clip.kind === 'text' ? clip.text : `${name} · ${clip.duration.toFixed(1)}s`}
      >
        {hasCover && anyVisible && (
          <FilmstripTiles
            cover={asset!.cover!}
            width={width}
            height={coverHeight}
            startFrac={startFrac}
            endFrac={endFrac}
            visibleStart={visibleStart}
            visibleEnd={visibleEnd}
          />
        )}
        <div
          className="clip-header"
          // Keep the title clear of a transition block covering this clip's head.
          style={inset.left > 0 ? { paddingLeft: inset.left * pxPerSecond + 6 } : undefined}
        >
          {offline && <span className="clip-offline-tag">Offline</span>}
          {clip.groupId && (
            <svg className="clip-group-mark" width="11" height="11" viewBox="0 0 24 24" aria-label="Grouped">
              <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          )}
          {clip.kind === 'media' && clip.effects && clip.effects.length > 0 && renderEffectBadge(clip)}
          <span className="clip-title">{headerLabel}</span>
        </div>
        {fxDrop?.resolution.kind === 'attach' && fxDrop.resolution.clipId === clip.id && (
          <div className="clip-drop-chip">+fx {payloadLabel(fxDrop.payload)}</div>
        )}
        {hasWaveform && anyVisible && (
          <WaveformCanvas
            peaks={asset!.waveform!.peaks}
            fullWidth={width}
            height={track.type === 'audio' ? audioWaveHeight : videoWaveHeight}
            startFrac={startFrac}
            endFrac={endFrac}
            visibleStart={visibleStart}
            visibleEnd={visibleEnd}
          />
        )}
        {track.type !== 'audio' && <div className="trim-handle left" onMouseDown={(e) => onTrimPointerDown(e, clip, 'start')} />}
        {track.type !== 'audio' && <div className="trim-handle right" onMouseDown={(e) => onTrimPointerDown(e, clip, 'end')} />}
      </div>
    )
  }

  // Adaptive ruler ticks. Pick the smallest "nice" step (in seconds) that keeps tick labels at
  // least MIN_TICK_PX apart at the current zoom, choosing from a ladder that runs from sub-second
  // all the way up to whole minutes.
  const MIN_TICK_PX = 64
  const STEP_LADDER = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  const tickStep = STEP_LADDER.find((step) => step * pxPerSecond >= MIN_TICK_PX) ?? STEP_LADDER[STEP_LADDER.length - 1]
  // Minor subdivisions between labeled (major) ticks — classic ruler look: a few short unlabeled
  // marks per labeled interval. Kept to a count that divides the step evenly where possible.
  const MINOR_PER_MAJOR = tickStep % 5 === 0 ? 5 : tickStep % 4 === 0 ? 4 : tickStep % 2 === 0 ? 2 : tickStep % 3 === 0 ? 3 : 1
  const minorStep = tickStep / MINOR_PER_MAJOR
  const marks: { t: number; major: boolean }[] = []
  for (let s = 0; s <= duration + tickStep; s += minorStep) {
    // A mark is "major" (labeled, taller) when it lands on a multiple of the major step.
    const major = Math.abs((s / tickStep) - Math.round(s / tickStep)) < 1e-6
    marks.push({ t: Math.round(s * 1000) / 1000, major })
  }

  /** Ruler tick label — always zero-padded MM:SS, matching the position/duration readout. */
  function tickLabel(seconds: number): string {
    return formatMMSS(seconds)
  }

  return (
    <div className="timeline-wrap" ref={wrapRef}>
      {ctxMenu && <ClipContextMenu x={ctxMenu.x} y={ctxMenu.y} clipId={ctxMenu.clipId} onClose={() => setCtxMenu(null)} />}
      <div className="timeline-toolbar">
        <div className="tl-tools">
          <ToolButton icon={IconUndo} label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={undo} />
          <ToolButton icon={IconRedo} label="Redo" shortcut="⌘⇧Z" disabled={!canRedo} onClick={redo} />
          <span className="tl-sep" />
          <ToolButton icon={IconSplit} label="Split" shortcut="⌘B" disabled={!selectedClipId} onClick={splitClipAtPlayhead} />
          <ToolButton icon={IconDelete} label="Delete" shortcut="⌫" disabled={!selectedClipId} onClick={deleteSelection} />
          <span className="tl-sep" />
          <ToolButton icon={IconMirror} label="Mirror" shortcut="⌘M" disabled={!selectedClipId} onClick={() => selectedClipId && toggleClipFlipH(selectedClipId)} />
          <ToolButton icon={IconRotate} label="Flip" shortcut="⌘⇧F" disabled={!selectedClipId} onClick={() => selectedClipId && rotateClip(selectedClipId, 90)} />
          <span className="tl-sep" />
          <ToolButton icon={IconAddVideo} label="Add video track" onClick={() => addTrack('video')} />
          <ToolButton icon={IconAddAudio} label="Add audio track" onClick={() => addTrack('audio')} />
        </div>
        <span className="tl-spacer" />
        <span style={{ color: 'var(--text-dim)' }}>Zoom</span>
        <Slider className="tl-zoom" min={minPxPerSecond} max={maxPxPerSecond} value={pxPerSecond} onChange={(v) => setZoom(Math.max(minPxPerSecond, v))} />
        <span className="tl-sep" />
        <div className="tl-rowheight" title="Track row height">
          {(['short', 'default', 'tall'] as TrackHeightMode[]).map((mode) => (
            <button
              key={mode}
              className={`tl-rowheight-btn ${trackHeightMode === mode ? 'active' : ''}`}
              onClick={() => setTrackHeight(mode)}
              title={`${mode[0].toUpperCase()}${mode.slice(1)} rows`}
            >
              {mode === 'short' ? '▬' : mode === 'default' ? '▭' : '▢'}
            </button>
          ))}
        </div>
      </div>
      <div className="timeline-body" ref={bodyRef} style={{ width: totalWidth }}>
        <div className="ruler" onMouseDown={onRulerPointerDown}>
          {/* Sticky corner above the track labels, so ticks and the playhead handle slide under it. */}
          <div className="ruler-corner" onMouseDown={(e) => e.stopPropagation()} />
          {marks.map(({ t, major }) => (
            <div
              key={t}
              className={`ruler-mark ${major ? 'major' : 'minor'}`}
              style={{ left: LABEL_WIDTH + t * pxPerSecond }}
            >
              {major && <span className="ruler-label">{tickLabel(t)}</span>}
            </div>
          ))}
        </div>
        {rowTracks.map((track) => (
          <div
            className={`track-row th-${trackHeightMode} ${dropTrackId === track.id ? 'drop-active' : ''} ${fxDrop?.trackId === track.id && fxDrop.resolution.kind === 'reject' ? 'drop-reject' : ''}`}
            key={track.id}
            // Text/caption rows are thin strips like CapCut's; media rows use the density setting.
            style={{ height: track.type === 'text' ? Math.min(rowHeight, TEXT_ROW_HEIGHT) : rowHeight }}
            onDragOver={(e) => onLaneDragOver(e, track)}
            onDragLeave={onLaneDragLeave}
            onDrop={(e) => void onLaneDrop(e, track)}
          >
            <div className="track-label">{track.name}</div>
            <div
              className="track-lane"
              ref={(el) => {
                if (el) trackRowRefs.current.set(track.id, el)
              }}
              style={{ width: totalWidth - LABEL_WIDTH }}
              onMouseDown={(e) => e.button !== 2 && selectClip(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxMenu({ x: e.clientX, y: e.clientY, clipId: null })
              }}
            >
              {(() => {
                const insets = clipDrawInsets(track)
                return track.clips.map((clip) => renderClip(clip, track, insets.get(clip.id)))
              })()}
              {transitionBlocks(track).map(renderTransitionBlock)}
              {fxDrop?.trackId === track.id && fxDrop.resolution.kind === 'transition' && (() => {
                // CapCut's transition follow item: a rounded block as long as the transition,
                // centred on the cut, with a 16×12 icon shown only when it fits.
                const width = Math.max(fxDrop.resolution.duration * pxPerSecond, 6)
                return (
                  <div className="cut-drop-marker" style={{ left: fxDrop.resolution.cutTime * pxPerSecond - width / 2, width }}>
                    {width >= 16 && (
                      <svg className="cut-drop-icon" viewBox="0 0 16 12" width="16" height="12" aria-hidden>
                        <path d="M1 3h10l-3-2.5M15 9H5l3 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    <span className="cut-drop-chip">
                      {payloadLabel(fxDrop.payload)} · {fxDrop.resolution.duration.toFixed(1)}s
                    </span>
                  </div>
                )
              })()}
              {mediaGhost?.trackId === track.id && (
                <div
                  className={`drop-ghost ${mediaGhost.kind}`}
                  style={{ left: mediaGhost.start * pxPerSecond, width: Math.max(mediaGhost.duration * pxPerSecond, 4) }}
                >
                  <div className="drop-ghost-chips">
                    <span className="drop-ghost-chip">{mediaGhost.name}</span>
                    <span className="drop-ghost-chip">{formatTimecode(mediaGhost.duration)}</span>
                  </div>
                </div>
              )}
              {fxDrop?.trackId === track.id && fxDrop.resolution.kind === 'reject' && (
                <div className="drop-reject-chip" style={{ left: Math.max(0, fxDrop.laneX) }}>
                  {fxDrop.resolution.reason}
                </div>
              )}
            </div>
          </div>
        ))}
        {drag && (() => {
          const placed = freeDragPlacement(drag)
          return placed?.snapTime != null ? <div className="drop-snap-line" style={{ left: LABEL_WIDTH + placed.snapTime * pxPerSecond }} /> : null
        })()}
        {mediaGhost?.snapTime != null && mediaGhost.snapKind !== 'playhead' && (
          <div className="drop-snap-line" style={{ left: LABEL_WIDTH + mediaGhost.snapTime * pxPerSecond }} />
        )}
        <div className={`playhead ${mediaGhost?.snapKind === 'playhead' ? 'snapped' : ''}`} style={{ left: LABEL_WIDTH + playhead * pxPerSecond }}>
          <div className="playhead-handle" onMouseDown={onRulerPointerDown} title="Drag to scrub" />
        </div>
      </div>
    </div>
  )
}
