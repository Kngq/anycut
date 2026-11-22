import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { canInsertFreezeFrame, selectionOf, useProjectStore } from '../state/projectStore'
import { createCompoundClip, exportSelectedClips, extractAudioToBin, openFileLocation, openTranscript, replaceClip } from '../clipActions'
import { useCropEditor } from './CropDialog'

/** A timeline clip's right-click menu (CapCut's layout: edit, look, audio, structure, file). */
interface Item {
  label: string
  shortcut?: string
  disabled?: boolean
  run?: () => void
  submenu?: Item[]
}
type Entry = Item | 'sep'

export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
/** Formats a shortcut written with ⌘ ⌥ ⇧ for the current platform. */
export function keys(mac: string): string {
  if (isMac) return mac
  return mac.replace('⌘', 'Ctrl+').replace('⌥', 'Alt+').replace('⇧', 'Shift+').replace('⌫', 'Del')
}

/** `clipId` null = right-click on empty timeline (CapCut shows Paste there). */
export default function ClipContextMenu({ x, y, clipId, onClose }: { x: number; y: number; clipId: string | null; onClose: () => void }) {
  const s = useProjectStore()
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [openSub, setOpenSub] = useState<string | null>(null)

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
  }, [x, y])

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close, true)
    window.addEventListener('wheel', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const found = clipId ? s.project.tracks.flatMap((t) => t.clips.map((c) => ({ c, t }))).find((e) => e.c.id === clipId) : null
  if (!found || !clipId) {
    if (clipId) return null
    const items: Entry[] = [{ label: 'Paste', shortcut: keys('⌘V'), disabled: !s.clipboard, run: s.paste }]
    return (
      <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.left, top: pos.top }} onContextMenu={(e) => e.preventDefault()}>
        {renderItems(items, 0)}
      </div>
    )
  }
  const { c: clip, t: track } = found
  const media = clip.kind === 'media' ? clip : null
  const asset = media ? s.project.assets.find((a) => a.id === media.assetId) : undefined
  const selection = selectionOf(s)
  const multi = selection.length > 1
  const anyGrouped = selection.some((id) => s.project.tracks.some((t) => t.clips.some((c) => c.id === id && c.groupId)))
  const allDisabled = selection.length > 0 && selection.every((id) => s.project.tracks.some((t) => t.clips.some((c) => c.id === id && c.disabled)))
  const hasSound = !!media && !!asset?.hasAudio
  const onVideoTrack = track.type === 'video'
  const playheadInside = s.playhead > clip.start + 0.05 && s.playhead < clip.start + clip.duration - 0.05

  // Order and grouping follow CapCut 9.5's timeline clip menu (MainTimelineMenuModel v2).
  const entries: Entry[] = [
    { label: 'Copy', shortcut: keys('⌘C'), run: s.copySelection },
    { label: 'Cut', shortcut: keys('⌘X'), run: s.cutSelection },
    {
      label: 'Copy/paste attributes',
      submenu: [
        { label: 'Copy attributes', shortcut: keys('⌥⌘C'), disabled: multi, run: () => s.copyAttributes(clipId) },
        { label: 'Paste attributes', shortcut: keys('⌥⌘V'), disabled: !s.attributeClipboard, run: s.pasteAttributesToSelection }
      ]
    },
    { label: 'Delete', shortcut: keys('⌫'), run: s.deleteSelection },
    {
      label: 'Edit',
      disabled: !media || multi,
      submenu: [
        { label: 'Freeze', disabled: !canInsertFreezeFrame(s.project, s.playhead, clipId), run: () => s.insertFreezeFrame(clipId) },
        { label: 'Reverse', disabled: !media || asset?.kind !== 'video' || !onVideoTrack, run: () => media && s.setClipReversed(clipId, !media.reversed) },
        { label: 'Mirror', run: () => s.toggleClipFlipH(clipId) },
        { label: 'Rotate', run: () => s.rotateClip(clipId, 90) },
        { label: 'Crop', disabled: !media || asset?.kind === 'audio', run: () => useCropEditor.getState().open(clipId) }
      ]
    },
    'sep',
    { label: 'Transcript', disabled: !hasSound || multi, run: () => openTranscript(clipId) },
    { label: 'Separate audio', disabled: !hasSound || !onVideoTrack || asset?.kind !== 'video' || !!media?.muted || multi, run: () => s.separateAudio(clipId) },
    { label: 'Extract audio', disabled: !hasSound || multi, run: () => void extractAudioToBin(clipId) },
    'sep',
    anyGrouped
      ? { label: 'Ungroup', shortcut: keys('⇧⌘G'), run: s.ungroupSelection }
      : { label: 'Group', shortcut: keys('⌘G'), disabled: !multi, run: s.groupSelection },
    { label: 'Create compound clip', shortcut: keys('⌥G'), disabled: !multi, run: () => void createCompoundClip() },
    'sep',
    { label: 'Export selected clips', run: () => void exportSelectedClips() },
    {
      label: 'More clip actions',
      submenu: [
        { label: allDisabled ? 'Activate clip' : 'Deactivate clip', shortcut: keys('V'), run: () => s.setSelectionDisabled(!allDisabled) },
        { label: 'Replace clip', disabled: !media || multi, run: () => void replaceClip(clipId) },
        { label: 'Trim start to playhead', shortcut: keys('Q'), disabled: multi || !playheadInside, run: () => s.trimClipToPlayhead(clipId, 'start') },
        { label: 'Trim end to playhead', shortcut: keys('W'), disabled: multi || !playheadInside, run: () => s.trimClipToPlayhead(clipId, 'end') },
        { label: 'Open file location', disabled: !media || multi, run: () => openFileLocation(clipId) }
      ]
    }
  ]

  function renderItems(items: Entry[], depth: number) {
    return items.map((e, i) => {
      if (e === 'sep') return <div key={`sep${i}`} className="ctx-sep" role="separator" />
      const hasSub = !!e.submenu
      const isOpen = hasSub && openSub === e.label
      return (
        <div
          key={e.label}
          className={`ctx-item ${e.disabled ? 'disabled' : ''} ${isOpen ? 'open' : ''}`}
          role="menuitem"
          aria-disabled={e.disabled}
          aria-haspopup={hasSub || undefined}
          onMouseEnter={() => depth === 0 && setOpenSub(hasSub && !e.disabled ? e.label : null)}
          onClick={(ev) => {
            ev.stopPropagation()
            if (e.disabled || hasSub || !e.run) return
            onClose()
            e.run()
          }}
        >
          <span className="ctx-label">{e.label}</span>
          {e.shortcut && <span className="ctx-shortcut">{e.shortcut}</span>}
          {hasSub && (
            <svg className="ctx-arrow" width="6" height="10" viewBox="0 0 6 10" aria-hidden="true">
              <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {isOpen && <Submenu>{renderItems(e.submenu!, depth + 1)}</Submenu>}
        </div>
      )
    })
  }

  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.left, top: pos.top }} onContextMenu={(e) => e.preventDefault()}>
      {renderItems(entries, 0)}
    </div>
  )
}

/** A flyout that stays inside the window: shifts up when it would run off the bottom and opens
 *  to the left when there's no room on the right. */
function Submenu({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const p = parent.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const top = Math.min(-7, window.innerHeight - 4 - h - p.top)
    const openLeft = p.right + 4 + w > window.innerWidth - 4
    setStyle(openLeft ? { top, left: 'auto', right: 'calc(100% + 4px)' } : { top })
  }, [])
  return (
    <div ref={ref} className="ctx-menu ctx-submenu" role="menu" style={style}>
      {children}
    </div>
  )
}
