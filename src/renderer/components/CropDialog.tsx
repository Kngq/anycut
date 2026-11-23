import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useProjectStore } from '../state/projectStore'
import { isFullCrop, sourceTimeFor, type ClipCrop } from '@shared/types'

/** Which clip the crop editor is open for (opened from the clip menu's Edit > Crop). */
export const useCropEditor = create<{ clipId: string | null; open: (id: string) => void; close: () => void }>((set) => ({
  clipId: null,
  open: (clipId) => set({ clipId }),
  close: () => set({ clipId: null })
}))

const RATIOS: { id: string; label: string; value: number | null | 'original' }[] = [
  { id: 'free', label: 'Free', value: null },
  { id: 'original', label: 'Original', value: 'original' },
  { id: '9:16', label: '9:16', value: 9 / 16 },
  { id: '16:9', label: '16:9', value: 16 / 9 },
  { id: '1:1', label: '1:1', value: 1 },
  { id: '4:5', label: '4:5', value: 4 / 5 },
  { id: '4:3', label: '4:3', value: 4 / 3 }
]

const MIN = 0.05
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Largest crop of aspect `ratio` (in pixels w/h) centred on the current box, inside the frame. */
function fitRatio(box: ClipCrop, ratio: number, frameAspect: number): ClipCrop {
  // In fraction space a pixel ratio r means w/h = r / frameAspect.
  const k = ratio / frameAspect
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  let w = box.w
  let h = w / k
  if (h > 1) {
    h = 1
    w = h * k
  }
  if (w > 1) {
    w = 1
    h = w / k
  }
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h }
}

export default function CropDialog() {
  const clipId = useCropEditor((s) => s.clipId)
  const close = useCropEditor((s) => s.close)
  const project = useProjectStore((s) => s.project)
  const playhead = useProjectStore((s) => s.playhead)
  const setClipCrop = useProjectStore((s) => s.setClipCrop)
  const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  const media = clip?.kind === 'media' ? clip : null
  const asset = media ? project.assets.find((a) => a.id === media.assetId) : undefined

  const [box, setBox] = useState<ClipCrop>({ x: 0, y: 0, w: 1, h: 1 })
  const [ratioId, setRatioId] = useState('free')
  const [frame, setFrame] = useState<{ url: string; w: number; h: number } | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!media) return
    setBox(media.crop && !isFullCrop(media.crop) ? { ...media.crop } : { x: 0, y: 0, w: 1, h: 1 })
    setRatioId('free')
  }, [clipId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Grab the frame under the playhead (or the clip's first frame) as the crop backdrop.
  useEffect(() => {
    setFrame(null)
    if (!media || !asset) return
    let cancelled = false
    // Same file the preview plays: a baked stand-in (e.g. background removed) wins, then the proxy.
    const src = window.api.fileUrl(media.sourceOverride ? (media.sourceOverride.previewPath ?? media.sourceOverride.path) : (asset.previewPath ?? asset.path))
    if (asset.kind === 'image') {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => !cancelled && setFrame({ url: src, w: img.naturalWidth, h: img.naturalHeight })
      img.src = src
      return () => void (cancelled = true)
    }
    const local = clamp(playhead - media.start, 0, Math.max(0, media.duration - 0.05))
    const video = document.createElement('video')
    video.muted = true
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'
    video.src = src
    video.onloadeddata = () => {
      video.currentTime = sourceTimeFor(media, local)
    }
    video.onseeked = () => {
      if (cancelled) return
      const c = document.createElement('canvas')
      c.width = video.videoWidth
      c.height = video.videoHeight
      c.getContext('2d')?.drawImage(video, 0, 0)
      setFrame({ url: c.toDataURL('image/jpeg', 0.85), w: video.videoWidth, h: video.videoHeight })
      video.removeAttribute('src')
      video.load()
    }
    return () => void (cancelled = true)
  }, [clipId, asset?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!clipId) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clipId, close])

  if (!clipId || !media || !asset) return null
  const frameAspect = frame ? frame.w / frame.h : (asset.width ?? 16) / (asset.height ?? 9)
  const ratio = RATIOS.find((r) => r.id === ratioId)!.value
  const lockedRatio = ratio === 'original' ? frameAspect : ratio

  function chooseRatio(id: string) {
    setRatioId(id)
    const r = RATIOS.find((x) => x.id === id)!.value
    if (r === 'original') setBox({ x: 0, y: 0, w: 1, h: 1 })
    else if (r !== null) setBox((b) => fitRatio(b, r, frameAspect))
  }

  /** Drag the box (mode 'move') or one of its corners. */
  function startDrag(e: React.PointerEvent, mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') {
    e.preventDefault()
    e.stopPropagation()
    const stage = stageRef.current!.getBoundingClientRect()
    const start = { px: e.clientX, py: e.clientY, box: { ...box } }
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.px) / stage.width
      const dy = (ev.clientY - start.py) / stage.height
      const b = start.box
      if (mode === 'move') {
        setBox({ ...b, x: clamp(b.x + dx, 0, 1 - b.w), y: clamp(b.y + dy, 0, 1 - b.h) })
        return
      }
      // The opposite corner stays put.
      const ax = mode.includes('w') ? b.x + b.w : b.x
      const ay = mode.includes('n') ? b.y + b.h : b.y
      let px = clamp((mode.includes('w') ? b.x : b.x + b.w) + dx, 0, 1)
      let py = clamp((mode.includes('n') ? b.y : b.y + b.h) + dy, 0, 1)
      let w = Math.max(MIN, Math.abs(px - ax))
      let h = Math.max(MIN, Math.abs(py - ay))
      if (lockedRatio) {
        const k = lockedRatio / frameAspect
        if (w / h > k) w = h * k
        else h = w / k
        const maxW = mode.includes('w') ? ax : 1 - ax
        const maxH = mode.includes('n') ? ay : 1 - ay
        if (w > maxW) (w = maxW), (h = w / k)
        if (h > maxH) (h = maxH), (w = h * k)
      }
      px = mode.includes('w') ? ax - w : ax
      py = mode.includes('n') ? ay - h : ay
      setBox({ x: clamp(px, 0, 1 - w), y: clamp(py, 0, 1 - h), w, h })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Stage size: the frame fitted into 640x420.
  const stageW = Math.round(Math.min(640, 420 * frameAspect))
  const stageH = Math.round(stageW / frameAspect)
  const pct = (v: number) => `${v * 100}%`

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal crop-modal" role="dialog" aria-label="Crop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Crop</div>
        <div ref={stageRef} className="crop-stage" style={{ width: stageW, height: stageH, backgroundImage: frame ? `url("${frame.url}")` : undefined }}>
          {!frame && <div className="crop-loading">Loading frame…</div>}
          <div className="crop-box" style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }} onPointerDown={(e) => startDrag(e, 'move')}>
            <div className="crop-grid" />
            {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
              <div key={c} className={`crop-handle ${c}`} onPointerDown={(e) => startDrag(e, c)} />
            ))}
          </div>
        </div>
        <div className="crop-ratios toggle-group" role="radiogroup" aria-label="Aspect ratio">
          {RATIOS.map((r) => (
            <button key={r.id} role="radio" aria-checked={ratioId === r.id} className={`toggle-btn crop-ratio ${ratioId === r.id ? 'active' : ''}`} onClick={() => chooseRatio(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button
            onClick={() => {
              setRatioId('free')
              setBox({ x: 0, y: 0, w: 1, h: 1 })
            }}
          >
            Reset
          </button>
          <span className="tl-spacer" />
          <button onClick={close}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => {
              setClipCrop(clipId, box)
              close()
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
