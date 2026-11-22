import { EFFECT_DRAG_MIME, TRANSITION_DRAG_MIME, parseDragPayload, type DragPayload } from '@shared/dropTargets'

/**
 * The effect/transition currently being dragged from the media bin. Browsers hide drag data until
 * `drop` (only the MIME types are visible during `dragover`), so the card records the payload here
 * for the timeline's live hover preview. The drop itself reads the real DataTransfer data.
 */
let active: DragPayload | null = null

export function activeDragPayload(): DragPayload | null {
  return active
}

/** Begins an effect/transition drag from a media-bin card. */
export function startFxDrag(e: React.DragEvent<HTMLElement>, payload: DragPayload) {
  active = payload
  const mime = payload.kind === 'effect' ? EFFECT_DRAG_MIME : TRANSITION_DRAG_MIME
  e.dataTransfer.setData(mime, JSON.stringify({ type: payload.type }))
  e.dataTransfer.effectAllowed = 'copy'
  // CapCut anchors the drag ghost at the card's bottom-centre, so the drop point is where the
  // card's bottom edge is rather than wherever the user happened to grab it.
  const el = e.currentTarget
  e.dataTransfer.setDragImage(el, el.offsetWidth / 2, el.offsetHeight)
}

export function endFxDrag() {
  active = null
}

/** Whether a drag event carries an effect/transition. */
export function isFxDrag(dt: DataTransfer): boolean {
  return dt.types.includes(EFFECT_DRAG_MIME) || dt.types.includes(TRANSITION_DRAG_MIME)
}

/** Reads the payload at drop time (falls back to the recorded one). */
export function readFxPayload(dt: DataTransfer): DragPayload | null {
  for (const mime of [EFFECT_DRAG_MIME, TRANSITION_DRAG_MIME]) {
    const data = dt.getData(mime)
    if (data) return parseDragPayload(mime, data)
  }
  return active
}

/**
 * The media-bin asset being dragged, recorded for the same reason as the effect payload: the
 * timeline needs its duration during `dragover` to draw the follow ghost, and DataTransfer data
 * can't be read until `drop`.
 */
let activeAsset: string | null = null

export function startAssetDrag(assetId: string) {
  activeAsset = assetId
}

export function activeAssetDragId(): string | null {
  return activeAsset
}

export function endAssetDrag() {
  activeAsset = null
}
