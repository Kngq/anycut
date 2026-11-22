import { useEffect, useRef, useState } from 'react'
import { buildLut, FILTER_CATALOG, FILTER_CATEGORIES, LUT_SIZE, type FilterDef } from '@shared/filters'
import type { Clip, MediaAsset } from '@shared/types'
import { useProjectStore } from '../state/projectStore'

const TILE_W = 120
const TILE_H = 120

/** A stand-in photo for tiles when no clip is selected: sky, sun, foliage, skin and shadow. */
function sampleScene(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = TILE_W
  c.height = TILE_H
  const g = c.getContext('2d')!
  const sky = g.createLinearGradient(0, 0, 0, TILE_H * 0.6)
  sky.addColorStop(0, '#5f8fc7')
  sky.addColorStop(1, '#e8c39a')
  g.fillStyle = sky
  g.fillRect(0, 0, TILE_W, TILE_H)
  g.fillStyle = '#fff1cf'
  g.beginPath()
  g.arc(TILE_W * 0.72, TILE_H * 0.32, 11, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#4f7d3a'
  g.fillRect(0, TILE_H * 0.6, TILE_W, TILE_H * 0.4)
  g.fillStyle = '#2b3d22'
  g.fillRect(0, TILE_H * 0.86, TILE_W, TILE_H * 0.14)
  g.fillStyle = '#d9a27f'
  g.beginPath()
  g.ellipse(TILE_W * 0.3, TILE_H * 0.55, 13, 16, 0, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#3a2a22'
  g.fillRect(TILE_W * 0.3 - 15, TILE_H * 0.64, 30, 30)
  return c
}

/** Trilinear lookup into a buildLut() table (the CPU twin of the preview's GPU pass). */
function applyLut(data: Uint8ClampedArray, lut: Float32Array) {
  const n = LUT_SIZE - 1
  const at = (r: number, g: number, b: number, ch: number) => lut[((b * LUT_SIZE + g) * LUT_SIZE + r) * 3 + ch]
  for (let i = 0; i < data.length; i += 4) {
    const fr = (data[i] / 255) * n
    const fg = (data[i + 1] / 255) * n
    const fb = (data[i + 2] / 255) * n
    const r0 = Math.min(n - 1, Math.floor(fr))
    const g0 = Math.min(n - 1, Math.floor(fg))
    const b0 = Math.min(n - 1, Math.floor(fb))
    const dr = fr - r0
    const dg = fg - g0
    const db = fb - b0
    for (let ch = 0; ch < 3; ch++) {
      const c00 = at(r0, g0, b0, ch) * (1 - dr) + at(r0 + 1, g0, b0, ch) * dr
      const c10 = at(r0, g0 + 1, b0, ch) * (1 - dr) + at(r0 + 1, g0 + 1, b0, ch) * dr
      const c01 = at(r0, g0, b0 + 1, ch) * (1 - dr) + at(r0 + 1, g0, b0 + 1, ch) * dr
      const c11 = at(r0, g0 + 1, b0 + 1, ch) * (1 - dr) + at(r0 + 1, g0 + 1, b0 + 1, ch) * dr
      data[i + ch] = ((c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db) * 255
    }
  }
}

/** The tile's source picture: the middle frame of the selected clip's cover sprite, if any. */
function useTileSource(asset: MediaAsset | undefined): HTMLCanvasElement | null {
  const [src, setSrc] = useState<HTMLCanvasElement | null>(null)
  const cover = asset?.cover
  useEffect(() => {
    if (!cover) {
      setSrc(sampleScene())
      return
    }
    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (cancelled) return
      const frames = Math.max(1, cover.frames)
      const fw = img.naturalWidth / frames
      const fh = img.naturalHeight
      const k = Math.max(TILE_W / fw, TILE_H / fh)
      const c = document.createElement('canvas')
      c.width = TILE_W
      c.height = TILE_H
      const sx = Math.floor(frames / 2) * fw
      c.getContext('2d')!.drawImage(img, sx, 0, fw, fh, (TILE_W - fw * k) / 2, (TILE_H - fh * k) / 2, fw * k, fh * k)
      setSrc(c)
    }
    img.onerror = () => !cancelled && setSrc(sampleScene())
    img.src = window.api.fileUrl(cover.path)
    return () => void (cancelled = true)
  }, [cover?.path, cover?.frames]) // eslint-disable-line react-hooks/exhaustive-deps
  return src
}

function FilterTile({ def, source, selected, onPick }: { def: FilterDef | null; source: HTMLCanvasElement | null; selected: boolean; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const c = ref.current
    if (!c || !source) return
    const g = c.getContext('2d')!
    g.drawImage(source, 0, 0)
    if (!def) return
    const img = g.getImageData(0, 0, TILE_W, TILE_H)
    applyLut(img.data, buildLut(def, def.defaultIntensity < 0.5 ? 0.6 : 1))
    g.putImageData(img, 0, 0)
  }, [def, source])
  return (
    <button className={`filter-tile ${selected ? 'selected' : ''}`} onClick={onPick} title={def ? def.label : 'None'}>
      <span className="filter-tile-stage">
        <canvas ref={ref} width={TILE_W} height={TILE_H} />
        {!def && (
          <svg className="filter-none-icon" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5.5 16.5l11-11" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        )}
      </span>
      <span className="filter-tile-label">{def ? def.label : 'None'}</span>
    </button>
  )
}

/** Left panel → Filters: CapCut-style look grid applied to the selected video/image clip. */
export default function FiltersPanel({ selectedClip }: { selectedClip: Clip | null }) {
  const project = useProjectStore((s) => s.project)
  const setClipFilter = useProjectStore((s) => s.setClipFilter)
  const [category, setCategory] = useState<(typeof FILTER_CATEGORIES)[number]>('Featured')
  const media = selectedClip?.kind === 'media' ? selectedClip : null
  const asset = media ? project.assets.find((a) => a.id === media.assetId) : undefined
  const usable = !!media && asset?.kind !== 'audio'
  const source = useTileSource(usable ? asset : undefined)
  const current = media?.filter?.id

  return (
    <div className="media-bin-body filters-panel">
      <div className="pill-tabs filter-cats" role="tablist">
        {FILTER_CATEGORIES.map((c) => (
          <button key={c} role="tab" aria-selected={category === c} className={`pill-tab ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </div>
      {!usable && <div className="empty-hint filter-hint">Select a video or image clip on the timeline to apply a filter.</div>}
      <div className="filter-grid">
        <FilterTile def={null} source={source} selected={usable && !current} onPick={() => media && setClipFilter(media.id, undefined)} />
        {FILTER_CATALOG.filter((f) => f.category === category).map((def) => (
          <FilterTile
            key={def.id}
            def={def}
            source={source}
            selected={current === def.id}
            onPick={() => {
              if (!media || !usable) return
              setClipFilter(media.id, { id: def.id, intensity: media.filter?.id === def.id ? media.filter.intensity : def.defaultIntensity })
            }}
          />
        ))}
      </div>
      {usable && current && <div className="empty-hint filter-hint">Adjust the intensity in the Inspector → Video → Filter.</div>}
    </div>
  )
}
