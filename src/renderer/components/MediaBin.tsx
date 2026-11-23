import { useEffect, useRef, useState } from 'react'
import FiltersPanel from './FiltersPanel'
import type { ReactNode, WheelEvent as ReactWheelEvent } from 'react'
import { useBinRequest } from '../state/layoutStore'
import { canHaveTransition, useProjectStore } from '../state/projectStore'
import { EffectPreview, TransitionPreview } from './EffectPreview'
import CaptionsPanel from './CaptionsPanel'
import {
  EFFECT_CATALOG,
  TRANSITION_CATALOG,
  effectCatalogEntry,
  formatMMSS,
  type Clip,
  type ClipEffectType,
  type MediaAsset,
  type TransitionType
} from '@shared/types'
import { ASSET_DRAG_MIME, assetsFromPaths, droppedFilePaths } from '../media'
import { locateMissing } from '../projectIO'
import { endAssetDrag, endFxDrag, startAssetDrag, startFxDrag } from '../dragPayload'
import { DEFAULT_TRANSITION_SECONDS } from '@shared/dropTargets'

function TabIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

type TabId = 'media' | 'audio' | 'text' | 'stickers' | 'effects' | 'transitions' | 'captions' | 'filters' | 'adjust'

const TABS: { id: TabId; label: string; enabled: boolean; icon: ReactNode }[] = [
  {
    id: 'media',
    label: 'Media',
    enabled: true,
    icon: (
      <TabIcon>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M10 9.2v5.6l5-2.8z" fill="currentColor" stroke="none" />
      </TabIcon>
    )
  },
  {
    id: 'audio',
    label: 'Audio',
    enabled: true,
    icon: (
      <TabIcon>
        <line x1="4" y1="9" x2="4" y2="15" />
        <line x1="8" y1="5" x2="8" y2="19" />
        <line x1="12" y1="2" x2="12" y2="22" />
        <line x1="16" y1="5" x2="16" y2="19" />
        <line x1="20" y1="9" x2="20" y2="15" />
      </TabIcon>
    )
  },
  {
    id: 'text',
    label: 'Text',
    enabled: true,
    icon: (
      <TabIcon>
        <line x1="5" y1="6" x2="19" y2="6" />
        <line x1="12" y1="6" x2="12" y2="19" />
      </TabIcon>
    )
  },
  {
    id: 'stickers',
    label: 'Stickers',
    enabled: false,
    icon: (
      <TabIcon>
        <path d="M12 3l2.47 5.4 5.93.58-4.47 4.03 1.3 5.84L12 15.9l-5.23 2.95 1.3-5.84L3.6 8.98l5.93-.58z" />
      </TabIcon>
    )
  },
  {
    id: 'effects',
    label: 'Effects',
    enabled: true,
    icon: (
      <TabIcon>
        <path d="M12 2c.6 3.8 2.2 5.4 6 6-3.8.6-5.4 2.2-6 6-.6-3.8-2.2-5.4-6-6 3.8-.6 5.4-2.2 6-6z" fill="currentColor" stroke="none" />
      </TabIcon>
    )
  },
  {
    id: 'transitions',
    label: 'Transitions',
    enabled: true,
    icon: (
      <TabIcon>
        <path d="M5 6l6 6-6 6V6z" />
        <path d="M19 6l-6 6 6 6V6z" />
      </TabIcon>
    )
  },
  {
    id: 'captions',
    label: 'Captions',
    enabled: true,
    icon: (
      <TabIcon>
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <line x1="7" y1="11" x2="12" y2="11" />
        <line x1="7" y1="14" x2="17" y2="14" />
      </TabIcon>
    )
  },
  {
    id: 'filters',
    label: 'Filters',
    enabled: true,
    icon: (
      <TabIcon>
        <circle cx="9" cy="12" r="6" />
        <circle cx="15" cy="12" r="6" />
      </TabIcon>
    )
  },
  {
    id: 'adjust',
    label: 'Adjust',
    enabled: false,
    icon: (
      <TabIcon>
        <line x1="6" y1="4" x2="6" y2="20" />
        <circle cx="6" cy="9" r="2" fill="currentColor" stroke="none" />
        <line x1="12" y1="4" x2="12" y2="20" />
        <circle cx="12" cy="15" r="2" fill="currentColor" stroke="none" />
        <line x1="18" y1="4" x2="18" y2="20" />
        <circle cx="18" cy="7" r="2" fill="currentColor" stroke="none" />
      </TabIcon>
    )
  }
]

export default function MediaBin() {
  const project = useProjectStore((s) => s.project)
  const addAsset = useProjectStore((s) => s.addAsset)
  const removeAsset = useProjectStore((s) => s.removeAsset)
  const addMediaClipToTrack = useProjectStore((s) => s.addMediaClipToTrack)
  const addTextClipToTrack = useProjectStore((s) => s.addTextClipToTrack)
  const setPreviewAsset = useProjectStore((s) => s.setPreviewAsset)
  const previewAssetId = useProjectStore((s) => s.previewAssetId)
  const missingAssetIds = useProjectStore((s) => s.missingAssetIds)
  const playhead = useProjectStore((s) => s.playhead)
  // The tab row is wider than a narrow panel. It scrolls sideways (wheel included), and the edges
  // fade where more tabs are hidden, so tabs past the edge (Captions) are discoverable.
  const tabsRef = useRef<HTMLDivElement>(null)
  const binRef = useRef<HTMLDivElement>(null)
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false })
  // Media-pool selection (click, ⇧/⌘-click, or a drag rectangle from empty space). Delete removes
  // the selection; dragging a selected item drags them all onto the timeline.
  const [selectedAssets, setSelectedAssets] = useState<string[]>([])
  const [binMarquee, setBinMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  function onAssetAreaPointerDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.asset-card')) return
    const area = e.currentTarget
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    const base = additive ? selectedAssets : []
    const r0 = area.getBoundingClientRect()
    const x0 = e.clientX - r0.left
    const y0 = e.clientY - r0.top + area.scrollTop
    let moved = false
    e.preventDefault()
    function onMove(ev: MouseEvent) {
      const r = area.getBoundingClientRect()
      const x1 = ev.clientX - r.left
      const y1 = ev.clientY - r.top + area.scrollTop
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 4) return
      moved = true
      setBinMarquee({ x0, y0, x1, y1 })
      const left = Math.min(x0, x1) + r.left
      const right = Math.max(x0, x1) + r.left
      const top = Math.min(y0, y1) + r.top - area.scrollTop
      const bottom = Math.max(y0, y1) + r.top - area.scrollTop
      const hit: string[] = []
      area.querySelectorAll<HTMLElement>('.asset-card[data-asset-id]').forEach((el) => {
        const b = el.getBoundingClientRect()
        if (b.right > left && b.left < right && b.bottom > top && b.top < bottom) hit.push(el.dataset.assetId!)
      })
      setSelectedAssets([...new Set([...base, ...hit])])
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setBinMarquee(null)
      if (!moved && !additive) setSelectedAssets([])
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function onBinKeyDown(e: React.KeyboardEvent) {
    const target0 = e.target as HTMLElement
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyA' && target0.tagName !== 'INPUT' && target0.tagName !== 'TEXTAREA') {
      e.preventDefault()
      setSelectedAssets(project.assets.map((a) => a.id))
      return
    }
    if ((e.key !== 'Backspace' && e.key !== 'Delete') || selectedAssets.length === 0) return
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    e.preventDefault()
    const ids = selectedAssets.filter((id) => project.assets.some((a) => a.id === id))
    const used = project.tracks.reduce((n, t) => n + t.clips.filter((c) => c.kind === 'media' && ids.includes(c.assetId)).length, 0)
    const label = ids.length === 1 ? `"${project.assets.find((a) => a.id === ids[0])?.name}"` : `${ids.length} items`
    if (used > 0 && !confirm(`${label} ${ids.length === 1 ? 'is' : 'are'} used in ${used} clip${used > 1 ? 's' : ''} on the timeline. Remove ${ids.length === 1 ? 'it' : 'them'} and those clips?`)) return
    ids.forEach(removeAsset)
    setSelectedAssets([])
  }
  function updateTabOverflow() {
    const el = tabsRef.current
    if (!el) return
    const next = { left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
    setTabOverflow((prev) => (prev.left === next.left && prev.right === next.right ? prev : next))
  }
  function onTabsWheel(e: ReactWheelEvent<HTMLDivElement>) {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
  }
  useEffect(() => {
    updateTabOverflow()
    const ro = new ResizeObserver(updateTabOverflow)
    if (binRef.current) ro.observe(binRef.current)
    return () => ro.disconnect()
  }, [])

  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const addClipEffect = useProjectStore((s) => s.addClipEffect)
  const removeClipEffect = useProjectStore((s) => s.removeClipEffect)
  const setClipTransition = useProjectStore((s) => s.setClipTransition)
  const [dropActive, setDropActive] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('media')
  const binRequest = useBinRequest((s) => s.request)
  useEffect(() => {
    if (binRequest) setActiveTab(binRequest.tab as TabId)
  }, [binRequest])

  // The clip the Effects/Transitions tabs act on (mirrors the Inspector's selection).
  let selectedClip: Clip | null = null
  for (const track of project.tracks) {
    const c = track.clips.find((cl) => cl.id === selectedClipId)
    if (c) {
      selectedClip = c
      break
    }
  }

  async function importPaths(paths: string[]) {
    for (const asset of await assetsFromPaths(paths)) addAsset(asset)
  }

  async function handleImport() {
    await importPaths(await window.api.openMediaDialog())
  }

  function handleAddToTimeline(asset: MediaAsset) {
    const trackType = asset.kind === 'audio' ? 'audio' : 'video'
    const track = project.tracks.find((t) => t.type === trackType)
    if (!track) return
    addMediaClipToTrack(track.id, asset, playhead)
  }

  function handleAddText() {
    const textTrack = project.tracks.find((t) => t.type === 'text')
    if (textTrack) addTextClipToTrack(textTrack.id, playhead)
  }

  function handleApplyEffect(type: ClipEffectType) {
    if (selectedClipId) addClipEffect(selectedClipId, type)
  }

  function handleApplyTransition(type: TransitionType) {
    if (!selectedClipId) return
    // One undo step: keep an existing transition's length, else CapCut's 0.5 s default.
    // A no-op on clips that can't carry a transition.
    const existing = selectedClip?.transitionIn?.duration ?? 0
    setClipTransition(selectedClipId, { type, duration: existing > 0 ? existing : DEFAULT_TRANSITION_SECONDS })
  }

  function handleRemoveAsset(asset: MediaAsset, e: React.MouseEvent) {
    e.stopPropagation()
    const usedCount = project.tracks.reduce(
      (n, t) => n + t.clips.filter((c) => c.kind === 'media' && c.assetId === asset.id).length,
      0
    )
    if (usedCount > 0 && !confirm(`"${asset.name}" is used in ${usedCount} clip${usedCount > 1 ? 's' : ''} on the timeline. Remove it and ${usedCount > 1 ? 'those clips' : 'that clip'}?`)) {
      return
    }
    removeAsset(asset.id)
  }

  function onDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  function onDrop(e: React.DragEvent) {
    setDropActive(false)
    const paths = droppedFilePaths(e.dataTransfer)
    if (paths.length === 0) return
    e.preventDefault()
    void importPaths(paths)
  }

  function renderAssetList(assets: MediaAsset[], emptyHint: string) {
    return (
      <>
        {assets.length === 0 && <div className="empty-hint">{emptyHint}</div>}
        <div className="asset-area" onMouseDown={onAssetAreaPointerDown}>
        {binMarquee && (
          <div
            className="bin-marquee"
            style={{ left: Math.min(binMarquee.x0, binMarquee.x1), top: Math.min(binMarquee.y0, binMarquee.y1), width: Math.abs(binMarquee.x1 - binMarquee.x0), height: Math.abs(binMarquee.y1 - binMarquee.y0) }}
          />
        )}
        <div className="asset-grid">
          {assets.map((asset) => {
            // Show the FIRST frame of the cover sprite as the card thumbnail, fit to the card's
            // full width with its natural aspect (letterboxed top/bottom in the square). The
            // sprite is `frames` frames wide, so width = frames*100% makes each frame one card
            // wide; height auto keeps the aspect; left/center isolates frame 0.
            const frames = asset.cover ? Math.max(1, asset.cover.frames) : 1
            const thumbStyle = asset.cover
              ? {
                  backgroundImage: `url(${window.api.fileUrl(asset.cover.path)})`,
                  backgroundSize: `${frames * 100}% auto`,
                  backgroundPosition: 'left center',
                  backgroundRepeat: 'no-repeat'
                }
              : undefined
            const offline = missingAssetIds.includes(asset.id)
            return (
              <div
                className={`asset-card ${previewAssetId === asset.id ? 'previewing' : ''} ${selectedAssets.includes(asset.id) ? 'selected' : ''} ${offline ? 'offline' : ''}`}
                key={asset.id}
                data-asset-id={asset.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(ASSET_DRAG_MIME, asset.id)
                  e.dataTransfer.effectAllowed = 'copy'
                  // Dragging one of several selected items drags them all (dropped one after another).
                  startAssetDrag(asset.id, selectedAssets.includes(asset.id) ? selectedAssets : [asset.id])
                }}
                onDragEnd={endAssetDrag}
                onClick={(e) => {
                  if (e.shiftKey || e.metaKey || e.ctrlKey) {
                    setSelectedAssets((sel) => (sel.includes(asset.id) ? sel.filter((id) => id !== asset.id) : [...sel, asset.id]))
                    return
                  }
                  setSelectedAssets([asset.id])
                  setPreviewAsset(asset.id)
                }}
                onDoubleClick={() => handleAddToTimeline(asset)}
                title="Click to preview, drag onto the timeline, or double-click to add"
              >
                <div className="asset-thumb" style={thumbStyle}>
                  {!asset.cover && !offline && <span className="asset-thumb-fallback">{asset.kind}</span>}
                  {offline && (
                    <div className="asset-offline" title={`Missing: ${asset.path}`}>
                      <span>Media offline</span>
                      <button
                        className="asset-locate"
                        onClick={(e) => {
                          e.stopPropagation()
                          void locateMissing(asset.id)
                        }}
                      >
                        Locate…
                      </button>
                    </div>
                  )}
                  {asset.duration > 0 && !offline && <span className="asset-duration">{formatMMSS(asset.duration)}</span>}
                  <button className="asset-item-remove" title="Remove from media pool" onClick={(e) => handleRemoveAsset(asset, e)}>
                    ×
                  </button>
                </div>
                <div className="asset-card-name" title={asset.name}>
                  {asset.name}
                </div>
              </div>
            )
          })}
        </div>
        </div>
      </>
    )
  }

  return (
    <div
      ref={binRef}
      className={`panel media-bin ${dropActive ? 'drop-active' : ''}`}
      tabIndex={-1}
      onKeyDown={onBinKeyDown}
      onDragOver={onDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
    >
      <div className={`media-tabs ${tabOverflow.left ? 'more-left' : ''} ${tabOverflow.right ? 'more-right' : ''}`} ref={tabsRef} onScroll={updateTabOverflow} onWheel={onTabsWheel}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`media-tab ${tab.id === activeTab ? 'active' : ''}`}
            disabled={!tab.enabled}
            title={tab.enabled ? undefined : 'Coming soon'}
            onClick={(e) => {
              setActiveTab(tab.id)
              e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
            }}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
      {activeTab === 'media' && (
        <div className="media-bin-body">
          <button onClick={handleImport} style={{ width: '100%', marginBottom: 10 }}>
            + Import media
          </button>
          {renderAssetList(
            project.assets.filter((a) => a.kind !== 'audio'),
            'No media imported yet. Drop files here or onto the timeline.'
          )}
        </div>
      )}
      {activeTab === 'audio' && (
        <div className="media-bin-body">
          <button onClick={handleImport} style={{ width: '100%', marginBottom: 10 }}>
            + Import audio
          </button>
          {renderAssetList(
            project.assets.filter((a) => a.kind === 'audio'),
            'No audio imported yet. Drop audio files here or onto the timeline.'
          )}
        </div>
      )}
      {activeTab === 'text' && (
        <div className="media-bin-body">
          <button onClick={handleAddText} style={{ width: '100%', marginBottom: 10 }}>
            + Add text
          </button>
          <div className="empty-hint">Adds a text clip to the Text track at the playhead.</div>
        </div>
      )}
      {activeTab === 'effects' && (
        <div className="media-bin-body">
          <div className="empty-hint" style={{ padding: '0 0 8px' }}>
            {selectedClip && selectedClip.kind === 'media'
              ? 'Drag an effect onto a clip, or click to add it to the selected clip.'
              : 'Drag an effect onto a video or image clip, or select a clip and click.'}
          </div>
          <div className="fx-grid">
            {EFFECT_CATALOG.map((entry) => {
              const applicable = selectedClip?.kind === 'media'
              return (
                <button
                  key={entry.type}
                  className={`fx-card ${applicable ? '' : 'fx-card-disabled'}`}
                  draggable
                  onDragStart={(e) => startFxDrag(e, { kind: 'effect', type: entry.type })}
                  onDragEnd={endFxDrag}
                  onClick={() => applicable && handleApplyEffect(entry.type)}
                  title={applicable ? `Add "${entry.label}" (or drag onto a clip)` : `Drag "${entry.label}" onto a clip`}
                >
                  <EffectPreview type={entry.type} />
                  <span className="fx-card-label">{entry.label}</span>
                </button>
              )
            })}
          </div>
          {selectedClip?.kind === 'media' && selectedClip.effects && selectedClip.effects.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Applied</h3>
              {selectedClip.effects.map((fx) => (
                <div className="fx-applied-row" key={fx.id}>
                  <span>{effectCatalogEntry(fx.type)?.label ?? fx.type}</span>
                  <button title="Remove effect" onClick={() => selectedClipId && removeClipEffect(selectedClipId, fx.id)}>
                    ×
                  </button>
                </div>
              ))}
              <div className="empty-hint" style={{ padding: '6px 0 0' }}>Fine-tune parameters in the Inspector.</div>
            </>
          )}
        </div>
      )}
      {activeTab === 'filters' && <FiltersPanel selectedClip={selectedClip} />}
      {activeTab === 'transitions' && (
        <div className="media-bin-body">
          <div className="empty-hint" style={{ padding: '0 0 8px' }}>
            {canHaveTransition(project, selectedClipId)
              ? 'Drag a transition onto a cut, or click to apply it to the selected clip.'
              : 'Drag a transition onto a cut between two clips on the main video track.'}
          </div>
          <div className="fx-grid">
            {TRANSITION_CATALOG.map((t) => {
              const applicable = canHaveTransition(project, selectedClipId)
              const active = selectedClip?.transitionIn?.type === t.type && (selectedClip?.transitionIn?.duration ?? 0) > 0
              return (
                <button
                  key={t.type}
                  className={`fx-card ${active ? 'active' : ''} ${applicable ? '' : 'fx-card-disabled'}`}
                  draggable
                  onDragStart={(e) => startFxDrag(e, { kind: 'transition', type: t.type })}
                  onDragEnd={endFxDrag}
                  onClick={() => applicable && handleApplyTransition(t.type)}
                  title={applicable ? `Apply "${t.label}" (or drag onto a cut)` : `Drag "${t.label}" onto a cut between two clips`}
                >
                  <TransitionPreview type={t.type} />
                  <span className="fx-card-label">{t.label}</span>
                </button>
              )
            })}
          </div>
          {selectedClip?.transitionIn && selectedClip.transitionIn.duration > 0 && (
            <div className="empty-hint" style={{ padding: '10px 0 0' }}>
              Current: {TRANSITION_CATALOG.find((t) => t.type === selectedClip!.transitionIn!.type)?.label} ·{' '}
              {selectedClip.transitionIn.duration.toFixed(2)}s — adjust duration in the Inspector.
            </div>
          )}
        </div>
      )}
      {activeTab === 'captions' && <CaptionsPanel />}
    </div>
  )
}
