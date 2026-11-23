import { useEffect, useState } from 'react'
import Toolbar from './components/Toolbar'
import MediaBin from './components/MediaBin'
import Preview from './components/Preview'
import Timeline from './components/Timeline'
import Inspector from './components/Inspector'
import Home from './components/Home'
import ResizeHandle from './components/ResizeHandle'
import Toasts from './components/Toasts'
import CropDialog from './components/CropDialog'
import { createCompoundClip } from './clipActions'
import { selectionOf, useProjectStore } from './state/projectStore'
import { projectDuration } from '@shared/types'

const store = () => useProjectStore.getState()
import { useLayoutStore } from './state/layoutStore'
import { useToastStore } from './state/toastStore'
import { useRecentsStore } from './state/recentsStore'
import { setImportErrorHandler } from './media'

export default function App() {
  const [view, setView] = useState<'home' | 'editor'>('home')
  const mediaBinWidth = useLayoutStore((s) => s.mediaBinWidth)
  const inspectorWidth = useLayoutStore((s) => s.inspectorWidth)
  const timelineHeight = useLayoutStore((s) => s.timelineHeight)
  const setMediaBinWidth = useLayoutStore((s) => s.setMediaBinWidth)
  const setInspectorWidth = useLayoutStore((s) => s.setInspectorWidth)
  const setTimelineHeight = useLayoutStore((s) => s.setTimelineHeight)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying)
  const splitClipAtPlayhead = useProjectStore((s) => s.splitClipAtPlayhead)
  const removeClip = useProjectStore((s) => s.removeClip)
  const undo = useProjectStore((s) => s.undo)
  const redo = useProjectStore((s) => s.redo)
  const toggleClipFlipH = useProjectStore((s) => s.toggleClipFlipH)
  const rotateClip = useProjectStore((s) => s.rotateClip)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)

  // Route media-import rejections through the on-screen toast stack (explanatory, non-blocking)
  // instead of a bare alert().
  useEffect(() => {
    setImportErrorHandler((message) => useToastStore.getState().push('error', message))
    // Age-based cache cleanup once per launch (CapCut's cacheDate=30): drop derived media unused
    // for 30 days, keeping anything referenced by recent projects.
    const recents = useRecentsStore.getState().recents.map((r) => r.path)
    void window.api.cleanCache(30, recents, [])
  }, [])

  useEffect(() => {
    if (view !== 'editor') return
    /** Text entry only: Space and shortcuts still work with a button, slider or clip focused. */
    function isTextEntry(el: HTMLElement | null): boolean {
      if (!el) return false
      if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
      if (el.tagName !== 'INPUT') return false
      return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes((el as HTMLInputElement).type)
    }
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      // Space always plays / pauses the preview, whatever has focus (a clip, a button, the
      // timeline's scroll area), except while typing. Handled in the capture phase so a focused
      // button can't "click" and the timeline can't scroll on it.
      if (e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isTextEntry(target)) return
        e.preventDefault()
        e.stopPropagation()
        if (e.repeat) return
        const s = store()
        s.setIsPlaying(!s.isPlaying)
        return
      }
      // Don't hijack typing in form fields.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return
      }
      const mod = e.metaKey || e.ctrlKey
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyA') {
        // ⌘A / Ctrl+A selects every clip on the timeline (in the media pool: all media, see MediaBin).
        if (target?.closest('.media-bin')) return
        e.preventDefault()
        const s = store()
        s.setSelection(s.project.tracks.flatMap((t) => t.clips.map((c) => c.id)))
        return
      }
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        // Cmd+Z = undo, Cmd+Shift+Z = redo.
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && (e.key === 'b' || e.key === 'B')) {
        // Cmd+B = split at playhead.
        e.preventDefault()
        splitClipAtPlayhead()
      } else if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        // Cmd+Shift+F = flip (rotate 90°) the selected clip.
        e.preventDefault()
        if (selectedClipId) rotateClip(selectedClipId, 90)
      } else if (mod && (e.key === 'm' || e.key === 'M')) {
        // Cmd+M = mirror (horizontal flip) the selected clip.
        e.preventDefault()
        if (selectedClipId) toggleClipFlipH(selectedClipId)
      } else if (!mod && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // ← / → step the playhead one frame (⇧ = one second), landing on frame boundaries. Stepping
        // pauses playback, as in CapCut.
        e.preventDefault()
        const s = store()
        const fps = s.project.canvas.fps || 30
        const dir = e.key === 'ArrowRight' ? 1 : -1
        const frames = e.shiftKey ? fps : 1
        const frame = Math.round(s.playhead * fps) + dir * frames
        const end = projectDuration(s.project)
        if (s.isPlaying) setIsPlaying(false)
        s.setPlayhead(Math.min(Math.max(frame / fps, 0), Math.max(end, 0)))
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        // In the media pool, Delete removes the selected media (MediaBin handles it).
        if (target?.closest('.media-bin')) return
        store().deleteSelection()
      } else if (mod && e.altKey && e.code === 'KeyC') {
        // ⌥⌘C / ⌥⌘V = copy / paste attributes (before plain ⌘C/⌘V).
        e.preventDefault()
        if (selectedClipId) store().copyAttributes(selectedClipId)
      } else if (mod && e.altKey && e.code === 'KeyV') {
        e.preventDefault()
        store().pasteAttributesToSelection()
      } else if (mod && !e.shiftKey && e.code === 'KeyC') {
        e.preventDefault()
        store().copySelection()
      } else if (mod && !e.shiftKey && e.code === 'KeyX') {
        e.preventDefault()
        store().cutSelection()
      } else if (mod && !e.shiftKey && e.code === 'KeyV') {
        e.preventDefault()
        store().paste()
      } else if (mod && e.shiftKey && e.code === 'KeyG') {
        e.preventDefault()
        store().ungroupSelection()
      } else if (mod && e.code === 'KeyG') {
        e.preventDefault()
        store().groupSelection()
      } else if (!mod && e.altKey && e.code === 'KeyG') {
        e.preventDefault()
        void createCompoundClip()
      } else if (!mod && !e.altKey && e.shiftKey && e.code === 'KeyF') {
        if (selectedClipId) store().insertFreezeFrame(selectedClipId)
      } else if (!mod && !e.altKey && !e.shiftKey && e.code === 'KeyV') {
        // V toggles Deactivate / Activate for the selection.
        const s = store()
        const ids = selectionOf(s)
        if (ids.length === 0) return
        const all = ids.every((id) => s.project.tracks.some((t) => t.clips.some((c) => c.id === id && c.disabled)))
        s.setSelectionDisabled(!all)
      } else if (!mod && !e.altKey && !e.shiftKey && (e.code === 'KeyQ' || e.code === 'KeyW')) {
        // Q / W = trim the selected clip's start / end to the playhead.
        if (selectedClipId) store().trimClipToPlayhead(selectedClipId, e.code === 'KeyQ' ? 'start' : 'end')
      }
    }
    // Key-up too: a focused <button> fires its click on Space's key-up.
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space' && !isTextEntry(e.target as HTMLElement | null)) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [view, isPlaying, selectedClipId, setIsPlaying, splitClipAtPlayhead, removeClip, undo, redo, toggleClipFlipH, rotateClip])

  if (view === 'home') {
    return <Home onEnterEditor={() => setView('editor')} />
  }

  return (
    <div className="app" style={{ gridTemplateRows: `auto 1fr auto ${timelineHeight}px` }}>
      <Toolbar onGoHome={() => setView('home')} />
      <div className="main" style={{ gridTemplateColumns: `${mediaBinWidth}px auto 1fr auto ${inspectorWidth}px` }}>
        <MediaBin />
        <ResizeHandle orientation="vertical" value={mediaBinWidth} onChange={setMediaBinWidth} />
        <div className="preview-area">
          <Preview />
        </div>
        <ResizeHandle orientation="vertical" value={inspectorWidth} onChange={setInspectorWidth} invert />
        <Inspector />
      </div>
      <ResizeHandle orientation="horizontal" value={timelineHeight} onChange={setTimelineHeight} invert />
      <Timeline />
      <CropDialog />
      <Toasts />
    </div>
  )
}
