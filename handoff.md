# freecut — Project Handoff

This document is the single source of truth for the project's mission, architecture, and state.
It is written to be self-contained: a new session should be able to start from here with no prior
context.

## Mission

freecut is a **from-scratch, local-first video editor** (Electron + React + TypeScript + Vite)
inspired by CapCut's UX, using its own `.fcproj` JSON project format. The guiding principles:

- **Local and offline-first.** Everything runs on the user's machine. The bundled ffmpeg does all
  media work; optional ML features (captions, background removal) use locally-downloaded models,
  never a cloud API. No telemetry, no network at edit time (only one-time model downloads).
- **Faithful to CapCut's feel** — timeline with filmstrip thumbnails + waveforms, a media bin,
  a preview with transport controls under it, an inspector, effects/transitions, text, and MP4
  export — but a clean, minimal, understandable codebase.
- **Correctness shared between preview and export.** The Canvas-2D live preview and the ffmpeg
  export are driven by the same pure logic (`src/shared/`) so what you see is what you render.

## Tech stack & layout

- **Main process** (`electron/main/`): Node APIs, ffmpeg/ffprobe spawning, model download/run,
  the `freecut-media://` privileged scheme for serving local files to the renderer, all IPC
  handlers (`index.ts`). Marked external in the main vite build: `ffmpeg-static`, `ffprobe-static`,
  `onnxruntime-node`.
- **Preload** (`electron/preload/`): contextBridge `window.api`, thin `ipcRenderer.invoke` wrappers.
- **Renderer** (`src/renderer/`): React UI. Zustand stores in `src/renderer/state/`.
- **Shared** (`src/shared/`): isomorphic, unit-tested pure logic — `types.ts` (data model +
  catalogs + helpers), `ffmpegGraph.ts` (builds the export filter graph), `effects.ts` (effect
  math used by both preview and export), `ipc.ts` (the `FreecutApi` contract).

### Key files
- `src/shared/types.ts` — Project/Track/Clip model; `ProjectCanvas` (width/height/fps/colorSpace);
  catalogs: `EFFECT_CATALOG`, `TRANSITION_CATALOG`, `FONT_CATALOG`, `ASPECT_PRESETS`,
  `SUPPORTED_EXTENSIONS`; helpers `createEmptyProject`, `formatMMSS`, `fontCatalogEntry`,
  `aspectPresetFor`, `fileExtension`.
- `src/renderer/state/projectStore.ts` — the document + transient UI state (selection, playhead,
  isPlaying, pxPerSecond, previewAssetId, missingAssetIds) and all mutation actions.
- `src/renderer/state/layoutStore.ts` — persisted view prefs: panel sizes, `trackHeight`
  (short/default/tall via `TRACK_HEIGHTS`), `useProxies`.
- `src/renderer/state/toastStore.ts` — non-modal notification stack (`Toasts.tsx`).
- `src/renderer/components/` — `Timeline.tsx`, `Preview.tsx`, `Inspector.tsx`, `MediaBin.tsx`,
  `Toolbar.tsx`, `Home.tsx`, `EffectPreview.tsx`, `CaptionsPanel.tsx`, `BackgroundRemovalButton.tsx`,
  `SpeedPanel.tsx`, `StorageSection.tsx`.
- `electron/main/` — `export.ts`, `cache.ts` (content-keyed derived-media cache), `proxy.ts`,
  `probe.ts`, `thumbnails.ts`, `waveform.ts`, `relink.ts` (missing-media), `captions.ts` + `captionWorker.ts`
  (captions), `background.ts` (bg removal), `mediaProtocol.ts`.
- `src/renderer/projectIO.ts` — the single open/save path (lock, `.bak` recovery, offline check,
  re-enrich, relink). `src/renderer/media.ts` — import + background enrichment.

## Current feature state (all implemented & verified)

Core (pre-existing): media import, trim/split/delete/merge, speed (constant + curve), reverse,
freeze frame, keyframe animation, crossfade+more transitions on the primary video track, overlay
video tracks + multi audio tracks in export, text overlays, MP4 export, resizable panels, proxy
transcoding for codecs Chromium can't decode, filmstrip thumbnails + waveforms, media grid,
standalone media preview, MM:SS ruler, aspect-ratio-aware preview.

Recently added (this track of work — all on `main`, pushed to github.com/Kngq/Freecut):
1. **Font selection for text** — `FONT_CATALOG`; `TextClip.fontFamily`; threaded into the preview
   `ctx.font` and the ffmpeg `drawtext fontfile=`. Dropdown in the Inspector text editor.
2. **Auto-captions (local)**: see "Auto captions (rebuilt)" below. Whisper base via transformers.js
   in a utilityProcess (`electron/main/captions.ts` + `captionWorker.ts`); no Homebrew/whisper.cpp.
3. **Top bar cleanup** — removed Split/Freeze/Play/skip; play-pause + skip indicator now lives
   under the preview (`Preview.tsx` `.preview-controls`). Spacebar still toggles play.
4. **Preview effects/transitions without a clip** — `EffectPreview.tsx` renders a live looping
   sample-frame per effect (reusing shared effect math) and a JS approximation per transition,
   always visible in the MediaBin Effects/Transitions tabs.
5. **Inspector tabs** — Video / Adjust Speed / Animation for a selected media clip.
6. **Multiple video/audio tracks** — add-track buttons in the timeline toolbar (model + export
   already supported overlays; this adds the UI + per-lane drop routing).
7. **Aspect ratio** — `ASPECT_PRESETS` (portrait/landscape/square/4:3/cinema) + `setCanvasSize`
   store action + a Toolbar dropdown. Preview + export both read `project.canvas`.
8. **Background removal (scaffold)** — `electron/main/background.ts`: optional `onnxruntime-node`
   + a once-downloaded U²-Net ONNX model; ffmpeg frames → per-frame matte → alpha → ProRes 4444.
   UI: "Background removal (beta)" in the Inspector Video tab. Graceful when runtime/model absent.
9. **Explanatory import errors** — unsupported/unreadable files now surface a specific reason
   (which type, or "couldn't be read") via a non-modal toast, listing supported formats.
10. **Track height modes** — CapCut-style short/default/tall selector in the timeline toolbar
    (`layoutStore.trackHeight`, persisted). Short = name bar only; tall = taller + thicker borders.
11. **Ruler lines** — the timeline scale is now classic major/minor tick lines (not boxes).
12. **Inspector project details** — when nothing is selected, the Inspector shows project name,
    file path, aspect ratio, resolution, frame rate, color space, duration, track/media counts,
    and proxy status.
13. **Proxy option** — a "Use preview proxies" toggle (Inspector project view, `layoutStore`)
    gates proxy generation on import.
14. **Speed tab redesign** — `SpeedPanel.tsx`: Standard/Curve/Velocity sub-tabs, tick-mark speed
    slider + stepper, duration slider, "Change audio pitch" toggle (stored as
    `MediaClip.changeAudioPitch`; export doesn't honor it yet), locked "Smooth slow-mo" row.
15. **Instant import** — assets appear after the probe; heavy work runs in the background.
16. **Media management (CapCut-derived)** — persistent content-keyed cache, remux-before-
    transcode, 720p proxies, seek-based filmstrips, missing-media relink, atomic save + `.bak` +
    lock, per-clip `sourceOverride`, working background removal. See "Media management
    (implemented)".
17. **Drag-and-drop effects and transitions (CapCut-derived)** — drag a card from the Effects or
    Transitions tab onto the timeline; the drop is previewed before release. See "Effects and
    transitions drag-and-drop (implemented)".

## Research: how CapCut manages media (reverse-engineered, 2026-11-03)

Source: CapCut for Mac installed at `/Applications/CapCut.app`, plus its real user data under
`~/Movies/CapCut/User Data/`. Methods: REA (`inspect_sqlite_database` on CapCut's media DBs),
strings from the shipped dylibs (`libVECreator`, `libvideoeditor`, `libcccreator`, `libVEConfig`),
and reading real draft files. REA's Hopper disassembly of `libvideoeditor.dylib` (84 MB) timed out,
so nothing below comes from decompiled control flow. **Observed** means seen directly in files or
DB rows. **Inferred** means deduced from strings, file names or source paths.

### 1. Media is referenced, never copied (observed)
- Importing records the **absolute original path** (e.g. `/Users/kng/Downloads/IMG_1226.MOV`).
  The file stays where it is. Nothing is copied into the project folder.
- A project ("draft") is a folder: `Projects/com.lveditor.draft/<name>/`. A global index,
  `root_meta_info.json`, lists every draft with its folder, JSON path, cover, timestamps and
  `draft_timeline_materials_size` (total bytes of referenced media).
- A missing file shows up as "material lost". A relink flow handles it (inferred from
  `Capability/Material/import/relink/relink_utils.cpp`, `RelinkMediaViewModel`,
  `NotifyRelinkMediasResult`). macOS sandbox access is kept with security-scoped bookmarks
  (`Config/com.lemon.lvoverseas.bookmark.plist`).

### 2. Two-level material model (observed)
1. **Media bin / library**: `draft_meta_info.json → draft_materials[]`, grouped by numeric `type`
   (0 = imported media, 18 = compound clips, i.e. `subdraft/<id>/sub_draft_config.json`). Each
   entry has `id` (uuid), `file_Path`, `metetype` (video/photo/music/none), `duration`,
   `width`/`height`, `import_time_ms`, `md5` (empty in practice) and `roughcut_time_range`.
   Bin folder structure is stored separately in `draft_virtual_store.json` as parent→child links.
2. **Timeline materials**: `draft_info.json → materials.{videos,audios,texts,speeds,canvases,…}`.
   Only media actually used on the timeline lives here. A `videos[]` entry has its own `id`,
   `path`, `width/height/duration/has_audio`, and `local_material_id` pointing back to the bin
   entry's id. It also has slots for derived files (`reverse_path`, `intensifies_path`,
   `cartoon_path`, `matting.mask_video_path`, `stable.matrix_path`) and per-material crop.
3. **Segments** (`tracks[].segments[]`) reference a material by `material_id` and list
   `extra_material_refs`, the ids of per-segment effect/speed/canvas/channel materials. Each has
   a `source_timerange` and `target_timerange`.
- All times are **integer microseconds**. Duration 25266666 µs ≈ 25.27 s. fps is a separate field.
- When processing bakes a new file (motion blur, reverse, matting), the timeline material's
  `path` is **swapped to the cache output**. Observed: `path = Cache/MotionBlurCache/<md5>_1.mp4`.
  The original stays in the bin.
- Safety: `draft_info.json` is written alongside `draft_info.json.bak` and `template-2.tmp`
  (atomic write + backup). A `.locked` file marks a draft that is open.

### 3. Global, content-keyed caches shared by all projects (observed)
Every derived artifact lives under `User Data/Cache/<kind>/`, keyed by an md5-style hash. It is
not stored per project, so it can be reused across drafts and deleted safely.
- `importcache3/mediainfo/<hash>.json`: probe results. Line 1 is a validity header
  `{"s":<file size>,"t":"<mtime>",...}`, so the key is path + size + mtime and the cache
  invalidates when the file changes. Line 2 is the full `veAVInfo` (codec, color primaries/trc,
  HDR/Dolby Vision, rotation, VFR, GOP/keyframe count, `supportHardwareDecode`, `recommendRemux`).
- `frameThumbnail/<hash>/<WxH>/<timestamp_us>.jpg`, plus an INI-style `info` file mapping each
  timestamp to `duration`/`request`/`rough`. Filmstrip frames are cached per resolution
  (`164x92` observed) and named by µs timestamp, so they are loaded lazily as you zoom.
- `audioWave/<hash>.waveDataV2`: binary peak data with the hash embedded in its header.
  262 MB on this machine, so waveforms are kept, not recomputed.
- `MotionBlurCache/`, `VideoAlgorithm/`, `stable/`, `SmartCrop/`: outputs of baked effects.
  Alpha comes as a sibling `*.mp4.alpha.mp4`.
- `prerender/`, `segmentPrerenderCache/<uuid>`: background **segment pre-rendering** of heavy
  timeline sections (matting, chroma key, adjust, filters, masks, effects) so playback stays
  smooth (`TESegmentPrerenderControl/Scheduler`, `prerender_task_scheduler.cpp`). Export can
  reuse these.
- `RemuxCache/`: lossless remux of problem containers (`recommend_remux_type`, `autoRemuxEnable`,
  `*.remux`). This is CapCut's cheap first fix before transcoding.
- `agencycache/`: **proxy media**. "agency" is ByteDance's translation of 代理 = proxy. Settings:
  `agencyModeEnable`, per-draft `draft_agency_config.json`
  (`is_auto_agency_enabled`, `video_resolution: 720`, `use_converter`), and `.agency`/
  `.agency_index` files. Export logs `Use agency = %d`, so export can choose proxy vs original.
- Cache hygiene (`Config/globalSetting`): `cacheDate=30` (choices 90/60/30/15 days) auto-cleans
  unused cache. There is a dedicated `agency_cache_cleanup_manager`. It collects
  "draft protection", the source hashes referenced by open/known drafts, so in-use proxies are
  never deleted, and it writes deletions atomically. Cache, proxy, remux and prerender folders
  can each be moved by the user.

### 4. Background media indexing (observed via REA)
`Cache/ILASDKDB/scan.db` (REA evidence
`ev_a34d9ac7…`, `ev_d43d6c07…`) holds an `asset` table (`asset_id` uuid, `width`, `height`,
`media_type`, `duration_ms`, GPS, `create_time_ms`, `source` = absolute path, `rotate_mode`,
`exif_create_time`). Analysis tables hang off it: `asset_cv_result`, `face`, `skeleton`, `color`,
`vlm`, `clip_result`, `audio_loudness`, `audio_events_result`, and others. `AFTER DELETE`
triggers cascade cleanup when an asset is removed. `mediasearch.db` (`ev_41e86663…`) adds an FTS
virtual table plus `media_uuid_map` and `media_video_frames` for searching media by content.
This feeds AI features (smart search, auto-cut). It is out of scope for freecut v1.

### Takeaways for freecut: status
All five recommendations below are now **implemented and verified** (2026-11-03). See "Media
management (implemented)" below for how each works and what was tested.
1. ~~Content-keyed persistent cache~~ ✅ `electron/main/cache.ts`.
2. ~~Missing-media relink~~ ✅ `electron/main/relink.ts` + `src/renderer/projectIO.ts`.
3. ~~Bin vs timeline separation~~ ✅ `MediaClip.sourceOverride` (bg removal now applies to a clip).
4. ~~Atomic project save + lock~~ ✅ `project:write` / `readProjectFile` in `electron/main/index.ts`.
5. ~~Remux before transcode + age-based cleanup~~ ✅ `proxy.ts` `planProxy`, `cleanCache`.

Corrections to the research above, found while implementing:
- **"Caches can't live in `userData`" is obsolete.** That came from `proxy.ts`, back when the
  `freecut-media://` handler used `net.fetch`, which couldn't read `userData`. `mediaProtocol.ts`
  was later rewritten to read with Node `fs`, which reads `userData` fine. The cache now lives at
  `<userData>/Cache/<kind>/`, which survives OS temp cleanup.
- **Filmstrip generation was the hidden import cost, not just the proxy.** The old sprite used
  ffmpeg's `thumbnail` filter, which decodes every frame. CapCut's per-timestamp frame cache
  suggests seeking instead, and switching to input-side `-ss` seeks made a 120 s 1080p sprite take
  about 0.9 s.
- The exact CapCut cache-key hash input is still unknown and doesn't matter for freecut: we use
  `sha1(kind:version:path:size:mtimeMs)`.

## Research: how CapCut's effects and transitions interact with the timeline (2026-11-04)

This covers the timeline side: dragging an effect or transition from the panel and what happens
when it lands on a clip or a cut. How each effect renders is covered in
`docs/capcut-effects-reimplementation.md`.

**Method.** Sources were:
- QML recovered from `libVECreator.dylib`. These are the same 2,041 files as `frontend.md`, kept in
  the session scratchpad and not committed.
- Log and metadata strings from the same library.
- `en.po` labels.
- The structure of local `draft_info.json` files.

Confidence:
- **Observed:** QML is read directly.
- **Strings:** C++ log text and method names only. The C++ was not decompiled (Hopper still can't
  load the library).
- **Inferred:** reasoning from names.

Nothing was tested in the running app.

### 1. One drag pipeline; the timeline decides the outcome (observed)
- **The card does no placement logic.** Every material card (media, effect, filter, transition,
  sticker) is a `CommonItemView`. It starts a Qt drag with:
  - `Drag.supportedActions: Qt.CopyAction` and `Drag.dragType: Drag.Automatic`.
  - `Drag.hotSpot` at bottom-centre (`width/2, height`).
  - `Drag.source` set to a C++ object from `viewModel.dragSource()`, which describes the resource.
    No URL or MIME string is used.
  - The drag starts after 5 px of movement. Touch mode uses a long press first.
  - On drag start the card calls `grabDragger(item, w, h)` to snapshot itself for the ghost.
- **Ghost window.** Outside the timeline, the snapshot follows the cursor in a frameless,
  click-through window (`DragFllowItem.qml`):
  - Cyan 2 px border, 8 px radius.
  - With more than one item, a second card is rotated 3° behind it and a count badge shows "99+"
    above 99.
- **One drop area for the whole timeline.** `MainTimeLine.qml` has a single `DropArea` that only
  forwards events to the canvas view-model:
  - `dragEnter(source, urls)` returns whether the drop is accepted. This is what refuses an invalid
    drop up front.
  - `dragPositionChanged(source, x, y)` returns the **snapped x**. The QML then places the
    follow-ghost at `snappedX - targetItemPoint.x`.
  - `dragDrop(source, x, y)` commits the drop. Finder files take a separate path,
    `dragDropOther(urls)`.
  - `dragExit()` cancels.
  - Near any edge, an auto-scroll timer runs.
- **No per-clip drop targets.** Clips have no `DropArea`. Hit-testing for "which clip or which cut
  am I over" happens in C++ from canvas coordinates. That keeps the decision in one place and
  keeps drag performance independent of clip count.

### 2. The ghost changes shape to show the drop result (observed)
`MainTimeLineFollowSegments.qml` is the in-timeline ghost. Its view-model switches between three
modes during a drag:

| Mode | Shown | When (inferred from names and logs) |
|---|---|---|
| Normal: `trackItemModel` rows | Coloured bars at the exact length and track they'd occupy. A transition bar is a small icon chip. | Dropping into empty track space creates new segment(s), e.g. an effect or filter on its own track. |
| `replaceMode` | The grabbed card image, rotated 8°, with a cyan "replace" badge | Media dragged over an existing clip; the drop replaces that clip's source. |
| `insertSubSegmentMode` | The grabbed card image, not rotated | An effect dragged **onto a clip**; the drop attaches the effect to that clip. |

Signals `enterReplaceMode_signal` and `enterInsertSubSegmentMode_signal` flip the mode while the
pointer moves. The user sees before releasing whether the drop will make a new layer, replace a
clip, or attach to a clip. Tooltip strings say the same: "Drag effect to the timeline" and "Drag
this effect to the clip you want to apply it to".

### 3. Effects: own track, or attached to a clip
- **Own track (strings and draft schema).** An effect dropped in empty space becomes a
  `segment_video_effect` on an effect track:
  - It has its own `target_timerange` and a `render_index`. Tracks with an effect count are
    `effect_track_cnt`.
  - It is moved, trimmed and split like any clip. `MainTimeLineSegmentEffect`,
    `...SegmentFilter` and `...SegmentPluginEffect` all extend the base `MainTimeLineSegment`.
  - It applies to everything rendered below it for its duration.
  - Filters behave the same way, as `segment_filter`.
- **Attached to a clip (observed).** Dropped on a clip, the effect goes into that segment's
  `video_effects` list, referenced through `extra_material_refs`, the same mechanism as
  speed/canvas/animation materials. The video clip then shows:
  - Header badges `Effect: <name> · edit` (multiple effects add a ▸ menu) and `Filter`
    (`needEffectIconBadge`, `needFilterBadge`).
  - Error badges `effectLost` / `filterLost` / `animationLost` when a resource file is missing.
- **Editing an attached effect (observed).** Clicking the badge opens
  `MainTimeLineSegmentVideoEffectEditing`:
  - It is a full `MainTimeLineSegment`, so it is trimmable and cuttable (`segmentCutEnabled`).
  - It is drawn over the clip with a 2 px border, only while selected, labelled
    `Effect: <name> - editing`.
  - So a clip-attached effect still has its own sub-range inside the clip, editable in place
    without a separate track.
- **Inspector.** Batch-selecting effects with different params shows "The selected effects have
  different parameters…" and disables batch editing.

### 4. Transitions belong to a cut, not a track (observed and strings)
- **Drop target.** A transition can only be dropped on a cut between two adjacent video or photo
  clips.
  - Log strings: `handle drop transition`, `droppped resource is not transition`, `drop
    transitioin but no video track`.
  - Agent-tool docs say transitions are addressed by the **left-side segment_id**, so the
    transition is stored on the outgoing clip.
  - In the minidraft schema, a `segment_video` has a single `transition {name, effect_id,
    duration}`.
  - Overlay tracks gained transitions later ("You can now add transitions to overlay clips").
- **Drawing (observed, `MainTimeLineSegmentTransition.qml`).**
  - It is a small segment centred on the cut, using `transition.svg` 18×18. The icon hides below
    20 px width.
  - Translucent white fill, `White1A` border. It sits above clips (z 6, or 7 when selected) and has
    trim handles.
  - Neighbouring clips widen to make room via `leftTransAnimaratio` / `rightTranAnimaratio`. Their
    in/out animation bars are measured against that widened width.
- **Clips too short (observed and strings).**
  - Error text: "Clips are too short for a transition. Create duplicate frames to add transition
    and maintain the original length of clips."
  - When accepted, `isOverlap` is set. Hatched `shadow_mask.png` regions labelled **"Duplicate
    frame"** fill the part of the transition that has no real source frames, each capped at half
    the transition's width.
  - Otherwise it fails with "Video too short. Apply transition effect to a longer video." (also logged
    as `seg_too_short`).
  - `splitMainTrackToInsertTransition` shows that a transition can also be placed mid-clip by
    splitting first.
- **Inspector (observed, `TransitionSettingPanelView.qml`).**
  - A Duration slider in seconds with 1 decimal, step `viewModel.stepSize` (fallback 0.1). The
    slider bounds come from `minDuration` / `maxDuration`, which are clamped by the neighbouring clip
    lengths (exact formula is in C++).
  - **Default 0.5 s.** Double-click or the group reset sets it back to 0.5.
  - Slider updates are throttled to 30 ms.
  - **Apply all** copies the transition to every cut on the track.
- **Missing resource.** A transition whose resource is gone shows "Transition loss" in place of the
  icon.
- **Downloads.** It shows a spinner while downloading and a red retry dot on failure.

### 5. Card behaviours in the effect and transition panels (observed, `OnlineEffectItemView.qml`)
- Hovering plays the animated cover (`image.playing`). `previewHovered(mouseX, width)` scrubs the
  effect preview by pointer x.
- The card shows a download arrow until the resource is downloaded. A favourite star appears on
  hover.
- A **"+" button (Add to track)** appears on hover once the resource is downloaded. It calls
  `importClicked()`, a click-to-add alternative to dragging. The target is inferred as the
  selected clip, or the playhead.

### Takeaways for freecut: status
Takeaways 1–4 are **implemented and verified** (2026-11-04). Takeaway 5 (effect tracks) is still
"Later". See "Effects and transitions drag-and-drop (implemented)" below for what differs from the
plan. The original recommendations follow.

freecut already has transitions (`Clip.transitionIn`, stored on the incoming clip) and clip effects
(`Clip.effects`). The Effects and Transitions tabs in `MediaBin.tsx` currently apply them
**only by click on the selected clip**. To match CapCut's interaction:

1. **One payload, one decision point.**
   - Add `EFFECT_DRAG_MIME` and `TRANSITION_DRAG_MIME` (JSON `{kind, type}`) next to
     `ASSET_DRAG_MIME`. Make the effect and transition cards `draggable`.
   - In `Timeline.tsx`, keep a single drop handler. Write a pure
     `resolveDrop(project, payload, timeSec, trackIndex)` that returns `{kind:'attach', clipId}`,
     `{kind:'transition', leftClipId, rightClipId}`, `{kind:'newTrack', start}`, or `null`.
   - Test it with vitest.
   - `onDragOver` calls it to set `dropEffect` ('none' rejects) and to pick the ghost style.
     `onDrop` calls it again and commits through one store action.
2. **Ghost states.** Mirror CapCut's three modes:
   - A bar on a new lane for effects dropped in empty space.
   - A clip highlight with a "+fx" chip for attach.
   - A cut-point marker for transitions.
   - Show the decision before release. Reject over audio tracks or non-adjacent clips.
3. **Transition hit zone.** While a transition payload is dragged, snap to the nearest cut on a
   video track within a pixel radius. CapCut's radius is in C++ and unknown; start at about 12 px.
   - New transitions default to **0.5 s**, the CapCut default; freecut currently uses 1 s.
   - Clamp to `min(leftDur, rightDur)`. Optionally offer a "Duplicate frame" freeze padding when
     clips are too short, rather than refusing.
4. **Attached-effect badges.** On clips with `effects.length`, show an `Effect: <name>` badge (▸ when
   more than one). Clicking it selects the clip and scrolls the Inspector to that effect. Show a lost
   badge if an effect type is unknown when loading an old project.
5. **Later: effect tracks.** An effect segment with its own time range that applies to everything
   below it is a model change: a new track type, plus preview and export compositing. Do this only
   after drag-to-attach works. Keep "+ / click applies to the selected clip" as the fallback, like
   CapCut's "Add to track" button.

Open questions (C++ only):
- The exact snap and hit radius for cuts.
- How `minDuration` / `maxDuration` are derived.
- Whether dropping an effect onto a clip that already has one adds to it or replaces it.
- Effect track `render_index` ordering rules.

## Effects and transitions drag-and-drop (implemented)

- **Decision point:** `src/shared/dropTargets.ts` `resolveDrop(project, payload, {trackId, time,
  pxPerSecond})`, pure and tested (`dropTargets.test.ts`). The Timeline calls it on every
  `dragover` (ghost + `dropEffect`) and again on `drop` (commit), so the preview always matches.
  It returns `attach`, `transition` or `reject` **with a reason** (not `null`), and the reason is
  shown next to the pointer.
- **Payload:** `EFFECT_DRAG_MIME` / `TRANSITION_DRAG_MIME` carry JSON `{type}`. Browsers hide
  drag data during `dragover`, so `src/renderer/dragPayload.ts` also records the active payload
  for the hover preview; the drop reads the real data. The drag image is anchored at the card's
  bottom-centre, like CapCut.
- **Effects:** attach only to media clips on video tracks (any video track), appended to the
  stack. The drop selects the clip and reveals the new effect in the Inspector. Empty space,
  audio and text tracks are rejected (no effect tracks yet, so there is no `newTrack` result).
- **Transitions:** main video track only (same rule as `canHaveTransition`). Snap to the nearest
  cut within `CUT_SNAP_PX = 12` px; with an existing overlap, the cut is its midpoint. Stored on
  the right clip's `transitionIn`. Duration keeps an existing transition's length, else 0.5 s,
  clamped to `min(left, right)`; below 0.1 s it's rejected. No "Duplicate frame" padding.
- **Store:** `setClipTransition(clipId, {type, duration})` sets both in one undo step (used by the
  drop and by click-to-apply, which now also defaults to 0.5 s). Fixed: `setTransition` used to
  reset the type to crossfade whenever the duration changed.
- **Ghosts (`Timeline.tsx`, CSS at the end of `styles.css`):** `.clip.drop-attach` + "+fx <name>"
  chip; `.cut-drop-marker` with "<name> · 0.5s"; `.track-row.drop-reject` + `.drop-reject-chip`.
  Cleared on `dragleave`, and on window `dragend`/`drop`.
- **Badges:** media clips with effects show `Effect: <first> +N` in the header (title lists all;
  ⚠ and amber if any type isn't in `EFFECT_CATALOG`). Clicking calls `focusEffect`: selects the
  clip, the Inspector switches to the Video tab, scrolls to `[data-effect-id]` and flashes it.
- **Click-to-apply is kept** as the fallback. Cards stay draggable even when no clip is selected.
- **Verified:** tsc, 90 vitest tests, `vite build`, and in the running app via the CDP driver
  with synthetic DragEvents: attach ghost + drop + badge + Inspector focus, reject chip over
  empty space (drop not accepted), transition rejected 2 s from a cut and snapped within 5 px,
  drop gives `wipeLeft` 0.5 s in one undo step. Screenshots `.dev-shots/dnd-0*.png`. A real
  mouse drag (OS drag session) was not exercised by the driver.

## Media management (implemented)

### Cache (`electron/main/cache.ts`)
- Location: `<userData>/Cache/{mediainfo,thumbnails,waveforms,proxies,remux,mattes}/`. One global
  cache shared by all projects. Deleting the folder never loses work; everything regenerates.
- Key: `sha1(kind : KIND_VERSION[kind] : path : size : mtimeMs)`. Editing or replacing a source
  invalidates its entries. Bump `KIND_VERSION` when an artifact's format or params change.
- Each entry has a `<key>.meta.json` sidecar (source path/size/mtime) used by cleanup.
- Writes are atomic (tmp + rename). Concurrent builds of one key are deduped (`dedupe`).
- Cleanup `cleanCache(maxAgeDays, protectedSources)`: entries unused for N days are removed,
  except those built from protected media or referenced directly (a clip's `sourceOverride`).
  "Draft protection" = asset paths + override paths read from the open project and the
  recents list (`protectedSourcesFor`). Runs once at launch with 30 days, like CapCut's
  `cacheDate=30`. Inspector → Project → Storage shows usage per kind, "Clear cache" (protected),
  and "Show in Finder".
- Producers on the cache: `probe.ts` (probe results; warm = ~0 ms), `thumbnails.ts`,
  `waveform.ts`, `proxy.ts`, `background.ts`.

### Proxies (`electron/main/proxy.ts`)
`planProxy(ext, vcodec, acodec)` picks the cheapest fix:
- `none`: browser-playable codecs in a browser-friendly container (also always for stills).
- `remux`: codecs fine, container not (e.g. `.mkv`/`.avi` with h264). Lossless `-c copy` +
  `faststart` takes milliseconds. A failed remux falls back to a transcode.
- `transcode`: undecodable codec (ProRes, DNxHD, AC-3, …), so a **720p** H.264 proxy (CapCut's
  default proxy resolution), much faster than full res.
The "Use preview proxies" toggle gates this, and turning it off now also clears existing proxies on
re-enrich. Export always reads the original.

### Fast import + background enrichment (`src/renderer/media.ts`)
`importAssets` returns after the probe only (~40–170 ms per file), so assets appear immediately.
`enrichAsset` then fills in proxy, filmstrip and waveform in the background via `patchAsset`
(no dirty flag, no undo entry). `refreshAsset` re-probes and re-enriches an existing asset. It
runs on project open and after relink, and also repairs old projects whose stored artifact paths
pointed into the previous temp-dir caches.

### Missing media + relink (`electron/main/relink.ts`, `src/renderer/projectIO.ts`)
- Every open path (Home, Open…, Recents) goes through `projectIO.loadOpenedProject`, which stats
  all asset paths (`media:findMissing`), sets `missingAssetIds`, and toasts a count.
- Offline UI: a red "Media offline / Locate…" overlay on bin cards, a striped red clip with an
  "Offline" tag on the timeline, and a "Media offline" frame in the preview (the element is skipped,
  so there's no misleading codec error).
- `locateMissing(assetId)`: the user picks one file. Its folder (and one level of subfolders) is
  then searched for the other missing files by basename, and a match is applied only when unique.
  `relinkAssets(oldPath→newPath)` rewrites asset paths and drops stale artifacts; clips keep their
  asset ids, so the timeline is untouched. Undoable.
- Preview element pools are keyed by clip id and now re-point `src` when the playable path changes
  (relink, a proxy arriving later). Previously a pooled `<video>` kept playing the stale file.

### Project file safety (`electron/main/index.ts`)
- Save: write `<file>.tmp` → copy the previous file to `<file>.bak` → rename. All saves go through
  `projectIO.saveProject`.
- Open: if the file is unreadable, fall back to `.bak` and tell the user.
- Advisory lock `<file>.lock` holds the PID. A lock held by a different *live* process triggers a
  warning toast. A dead-PID lock (from a crash) is silently taken over. It's removed on quit.

### Bin vs timeline: `MediaClip.sourceOverride` (`src/shared/types.ts`)
A clip can render from a baked stand-in instead of its asset, the way CapCut swaps a timeline
material's `path` while the bin keeps the original. `{ path, previewPath?, kind, hasAlpha }`.
- Export: `resolveSourceOverridesWithAudio` maps overridden clips to synthetic assets so per-asset
  ffmpeg input dedup still works. **Audio stays on the original file**, because bakes change
  pixels and may have no audio stream. A real export caught this; it's now a regression test.
- Preview plays `previewPath` (VP9+alpha WebM), since Chromium can't decode ProRes 4444.
- Cleanup protects override files directly.

### Background removal (`electron/main/background.ts`): now working end to end
- Model: `u2netp.onnx` (4.6 MB) from rembg's own GitHub release, replacing a 176 MB third-party
  mirror. Runtime: optional `onnxruntime-node` (v1.31 has prebuilt darwin-arm64 binaries and needs
  no compile; it must be installed in the app's own `node_modules`).
- Fixed while wiring: the matte was never scaled to the frame (now `scale2ref`), reassembly was
  hardcoded to 30 fps (now the source fps, NTSC-exact), stream-copied audio could fail in MOV (now
  PCM), and temp frames leaked (now removed in `finally`). Output is cached by source.
- The Inspector button applies the result as the clip's `sourceOverride`. "Restore original
  background" clears it.

### Verified (2026-11-03)
- Unit: 77 tests (`vitest.config.ts` now also runs `electron/**/*.test.ts`). New: `planProxy`,
  `resolveSourceOverrides`, override export inputs/audio, `relinkAssets`, `patchAsset`,
  `setClipSourceOverride`. The override tests fail with the fix reverted.
- Real ffmpeg (main modules run under tsx): probe cold 33–770 ms, warm 0–1 ms; sprite 0.15–0.95 s;
  mkv remux 12 ms; ProRes → 720p proxy 317 ms; protected cleanup kept only protected entries.
- Real export: an alpha ProRes override on Video 2 composites over Video 1. Pixel samples are red
  where the overlay is transparent and green where opaque, and both tracks' audio is present.
- Real bake: 48 frames @ 24 fps in ~5 s. Alpha is 0xff on the subject and 0x00 on the background,
  fps and duration are preserved, the WebM keeps alpha, and a cached re-bake takes 11 ms.
- In the app (CDP driver): import → remux + filmstrips → save twice (`.bak` created) → move the
  media folder → reopen (3 offline, UI flagged) → relink (0 missing, clips intact, artifacts
  regenerated) → corrupt file → reopen recovered from `.bak`.

See also `frontend.md` (CapCut UI teardown from the same research session, not yet acted on).

## Build / verify commands
- `npx tsc -p tsconfig.json --noEmit` — typecheck (passes clean).
- `npx vitest run` / `npm test` — unit tests (77 passing: shared types, ffmpegGraph, effects,
  media management, store, and main-process `proxy.test.ts`).
- Check `tsc` with its real exit code (`npx tsc ... ; echo $?`). Piping it into `head` hides
  failures.
- Main-process modules can be exercised against real ffmpeg without Electron by running them
  under `tsx` with a tsconfig `paths` entry that maps `electron` to a tiny stub exporting
  `app.getPath`. That's how the cache/proxy/sprite/bake numbers above were measured.
- `npx vite build` — builds renderer + main + preload bundles (all pass).
- Agent-driven UI verification: the CDP driver at `scripts/devDriver.mjs` (see
  `.claude/skills/run-freecut/SKILL.md`) — `launch`, `eval`, `screenshot`, `quit`. Screenshots in
  `.dev-shots/` (gitignored).

## Known limitations / good next steps
- **Captions** download the Whisper model (~136 MB) on first use; offline after that.
- **Background removal** requires `npm i onnxruntime-node` (optional, prebuilt arm64) and is
  CPU-only. It's per-frame (edges can flicker; temporal smoothing is the next refinement). The
  button shows bake progress. The result applies to the clip; put it on an upper track to
  composite.
- **Relink** auto-matches by unique basename only. Files renamed as well as moved need to be
  located one by one. There's no "relink by content hash" yet.
- **Project lock** is advisory (a warning, never a block), by design.
- **`changeAudioPitch`** is stored but export still uses pitch-preserving `atempo`.
- **Overlay video tracks** are contiguous per-track rolls (clips butt from 0); free positioning of
  an overlay clip at an arbitrary start isn't exposed yet (export already honors `clip.start`).
- **fontfile** paths in export are macOS system-font paths; a cross-platform font resolver (or
  bundled fonts) would make export font selection portable.

## Git
- Remote: `https://github.com/Kngq/Freecut.git` (origin). Branch `main`.
- Working tree should be committed & pushed after each feature chunk.

## Media drop ghost + timeline drag overlays (CapCut look)

Re-extracted CapCut's QML from `libVECreator.dylib` (rcc blobs, zlib) on 2026-11-12. The read was
`TimeLine/.../MainTimeLineFollowSegments.qml` (ghost) and the `DropArea` in `MainTimeLine.qml`.
- **Follow ghost** (`src/shared/mediaDrop.ts` `resolveMediaDrop`, tested): one resolver for hover
  and drop. Video tracks show the ghost at the ripple-insert cut. Audio snaps its start *or* end
  edge to clip edges, the playhead or 0 within 10 px (CapCut's radius is in C++, unknown).
  ⌘/Ctrl disables snapping. The drop commits at the ghost's start.
- **Visuals from the QML**: radius-4 block in the clip colour, an 18 px chip row
  (14 px chips, 10 px text, 4 px left inset, 8 px gap). Transition ghost = rounded block of
  transition length centred on the cut, 16×12 icon only when it fits. The playhead turns accent
  colour when snapped (`cursor.viewModel.adsorbed`). Edge auto-scroll uses a 20 px margin
  (`autoScrollMargin`).
- **Inferred, not observed:** the snap guide line through the tracks (CapCut draws it in C++,
  `kAdsorbLineHeight`). Finder files get no ghost; CapCut draws none either.
- **Not done:** replace mode (card rotated 8° with a badge, dropping media onto a clip swaps its
  source). freecut has no replace action yet.
- Verified with synthetic DragEvents (`.dev-shots/dnd-ghost-*.png`, `dnd-transition.png`). Note:
  after HMR, import app modules by the `?t=` URL from `performance` entries, or the driver gets a
  separate module instance.

## Transition blocks on the timeline (CapCut look)

From CapCut's `MainTimeLineSegmentTransition` QML: a transition is its own segment over the cut.
It is white at 35 % (`Transparency_White_035`) with a faint white border, an 18 px icon centred
when the block is at least 20 px wide, sits above the clips (z 6/7), and has trim handles.
- **Drawing only, the model is unchanged** (`src/shared/transitionBlocks.ts`, tested): the
  transition is still an overlap (right clip starts `d` early), so preview and export are
  untouched. Clips are drawn inset by d/2 on the transition side so they meet at the overlap's
  midpoint, and the block covers the overlap. Filmstrip and waveform are cropped to match.
- **Resize:** edge handles stretch the block symmetrically around the cut, clamped to
  [0.1 s, shorter clip], with a live readout. It commits on release via `setClipTransition`
  (one undo step). Clips reflow on release, not during the drag.
- **Click** selects the owning (right) clip, so the Inspector shows the transition, and
  highlights the block. The old `⤬` header badge is gone.
- **Differences from CapCut:** CapCut keeps total length fixed and shows "Repeat frame" masks
  when a clip lacks handle frames. freecut's overlap model shortens the timeline by `d` instead.
  The clip trim handles at a cut are covered by the block.

## UI font: TikTok Sans (stands in for CapCut Sans)
- CapCut's interface font is `CapCut Sans Text` (bundled in `CapCut.app/Contents/Resources/Font/SystemFont/CapCutSansText-*.otf`; QML uses `font.family: "CapCut Sans Text"` / "PingFang SC"). The file has no copyright or license fields, so it is not copied.
- It matches **TikTok Sans** (SIL OFL 1.1, google/fonts `ofl/tiktoksans`): at opsz 12 / wght 400 it has the same x-height (529) and cap height (705), covers the same 574 characters, and has the same stylistic sets ("Account spoofing", "Tailed l", "Slashed zero"…). Advance widths differ by about 19/1000 em on average (older spacing).
- Bundled as `src/renderer/assets/fonts/TikTokSans.ttf` (variable: opsz/wdth/wght/slnt) with `TikTokSans-OFL.txt`. `@font-face` + `font-optical-sizing: auto` in `styles.css`; buttons/inputs/selects now `font-family: inherit`.
- Not changed: text-on-video fonts (Preview/export font catalog). CapCut's default caption font `en.ttf` is Metropolis (Chris Simpson; open licensed), which could be added to the text font catalog.

## Auto captions (rebuilt)
- **Engine**: Whisper base (multilingual, `onnx-community/whisper-base_timestamped`) via `@huggingface/transformers` 3.7.6 on onnxruntime-node (prebuilt binaries, no install scripts needed). Runs in an Electron `utilityProcess` (`electron/main/captionWorker.ts`, a second vite main entry) so inference never blocks the main process. Model (~136 MB) downloads once to `<userData>/models/transformers`, then offline. Replaced the old whisper.cpp/Homebrew path (`transcribe.ts`, deleted).
- **Windowing**: transformers.js's built-in `chunk_length_s` drops most words when `return_timestamps: 'word'` (measured: 21 of ~280 words on 111 s). The worker windows audio itself (≤28 s, cut at the quietest 20 ms frame in the last 4 s) and offsets times; near-silent windows are skipped (Whisper hallucinates on silence). Measured ~25× real time on Apple silicon.
- **Flow**: panel → `captionSources(project, scope)` (main track / all tracks / selected clip; skips muted, frozen, reversed) → main extracts each clip's trimmed source range as 16 kHz f32le with ffmpeg → worker → words in source time → `captionLinesFor` maps through trim + speed curve (`timelineTimeForSource`) and `segmentWords` groups lines (sentence end, ≥0.6 s pause, max chars from canvas width/font size, ≤3.5 s, clause commas once half full; 0.4 s hold) → `setAutoCaptions` (one undo step).
- **Data**: captions are ordinary `TextClip`s on a "Captions" text track, marked by `caption: { words }` (clip-local word times, for future word-highlight templates). `TextClip.stroke {color,width}` added: preview `strokeText` (2× width, round joins) and export `drawtext borderw/bordercolor`.
- **Style**: `CaptionStyle` (font, size, colour, bold, outline, y) in `src/shared/captions.ts`. Default = bold white, black outline, y 0.8. Regenerating replaces all captions but keeps the current captions' style. Inspector: Outline controls for any text clip; "Apply style to all captions" on a caption. Templates should be presets of `CaptionStyle` (+ word-highlight options using `caption.words`).
- **UI**: MediaBin tab row now wheel-scrolls with edge fades (Captions was hidden past the edge of a narrow panel).
- **Verified**: in app with a `say`-generated talk clip: first run (incl. download) <28 s, cached run ~10 s for 16 s audio, 12 well-timed lines; apply-to-all, regenerate-keeps-style, undo. Export frame shows the outline. Tests: `captions.test.ts` (9), outline in `ffmpegGraph.test.ts`.
- **Known gaps**: editing a caption's text doesn't re-time its `words`; export ignores `bold` (pre-existing: drawtext uses the regular face); no line wrapping (lines are kept short instead); no SRT import/export yet; the model download has no checksum/pinning beyond the HF repo.

## Caption timing, templates and sliders (from CapCut)
**Sources (all local, read-only; nothing copied into the repo):** CapCut projects in `~/Movies/CapCut/User Data/Projects/com.lveditor.draft/*/draft_info.json` (captions live in nested `materials.drafts[].draft`; segments point at `text_templates` → `text_info_resources[].text_material_id` → `texts[]` with `words {start_time[], end_time[], text[]}` in ms, clip-relative); caption template + animation packages in the sandbox effect cache `~/Library/Containers/com.lemon.lvoverseas/Data/Movies/CapCut/User Data/Cache/effect/<id>/<md5>/`; the Trending list from a cached panel response in `Cache/ressdk_db/*/rp.db` (`http_cache`, panel `heycan`, category_key `trending`) inspected via a `.backup` snapshot (REA `inspect_sqlite_database` + sqlite3). Four uncached Trending templates were fetched from the item_urls in that listing into the session scratchpad only. CapCut's auto-captions are cloud ASR (`Cache/recognize` holds only uploaded m4a).

**Timing (how CapCut adjusts it):**
- Stored word times are raw ASR (40 ms grid). The caption engine (`modules/CaptionModule.lua`, `initCaptionInfo`) computes *packed* times before animating: overlaps pushed apart; a gap ≤ `timeSpace` (1000 ms) is shared `extendRight`/`extendLeft` (default 0.5/0.5; per-word templates call `splitPage(0, 1)` so a word stays lit until the next starts); a longer gap is only bridged towards its midpoint. Ported as `packWordTimes` (src/shared/captions.ts).
- Measured on 53 real captions: caption starts on its first word, ends on its last (no hold), boundaries on the 30 fps grid, 76% touch the next caption, max exactly 3.0 s, median 8 words / 40 chars (max 12 / 55).
- freecut now: line boundaries use packed times (lines meet across short pauses), `maxDuration` 3 s, snapped to `canvas.fps`; the 0.4 s hold is gone.

**Templates** (`src/shared/captionTemplates.ts`, 8 + Basic): Word by word (逐字出现), Outline pop (边框弹出), Word pop (逐字弹出黑体), Pink slider (cc粉色滑块), Word box (新_逐词边框), Cartoon pop (逐字弹出综艺体), Bold shadow (弹出-粗体阴影), Karaoke (useLetterColor family). Each comment lists the CapCut values used (content.json fill/keyword colour/canvas box/`max_units_per_line`/`keyframe_params`, effectStyle stroke+shadow stacks, animation Lua). Animation curves: `pop` = 3512850 `exp(-7t)·sin((t−0.075)·2π/0.3)+1`; `overshoot` = 3512851 AE keyframes 0→120% (f6.45)→100% (f12.1); `squash` = 160095677 scaleX 0.8→1 in 0.1 s. Page split = `wordCountPerPageLimit(n)`.
- Data: `TextClip.look` (`TextLook`: uppercase, weight, shadows[], pageBox, highlight {color | box, slide, scale}, unreadOpacity, wordsPerPage, wordsPerLine, animation, templateId). Store: `applyCaptionTemplate`, `setAutoCaptions(lines, templateId)`, apply-to-all copies `look`.
- Fonts: ZY Resolve/Elegant-Black/Steady/Vigour, Obelix Pro, Poffen are proprietary → bundled open stand-ins (Montserrat, Archivo incl. 125% width, Anton, Luckiest Guy, Fredoka, Rubik) in `src/renderer/assets/fonts` with licences; added to `FONT_CATALOG` (fontFile '' = bundled).
- Renderer: `src/renderer/textRender.ts` (`drawTextClip`/`drawTextLayer`) draws all text for the preview AND export. Edited caption text keeps word timing if the word count is unchanged, else spreads words evenly.
- Gallery: `CaptionTemplateTile` animates each template with the real renderer.

**Export:** text is no longer drawtext. Before ffmpeg, the renderer bakes every text clip into a transparent PNG sequence (`src/renderer/export/textOverlay.ts` → IPC `overlay:*` → `electron/main/textOverlay.ts`, blank/identical frames hard-linked) and `buildFfmpegPlan(project, { textOverlay })` overlays it (`overlay=0:0:format=auto:eof_action=pass`). Fixes bold/bundled fonts/outline parity. 16 s clip: bake ~2.5–5 s. drawtext remains as the fallback when no overlay is passed.

**Sliders** (`src/renderer/components/Slider.tsx`): CapCut `VESlider`/`VESpinBoxSlider` (rcc 00287/00289): 2 px track at 12% white, solid white fill (CSS var `--p`), 8×12 white pill handle; optional editable value box with unit. All range inputs use it; the speed panel's dashed duration slider keeps its triangle marker.

**Verified:** tests 126 pass (`captions.test.ts`, `textRender.test.ts`, overlay plan test); in app: gallery renders all templates with bundled fonts; Word box preview vs exported frame match; Word pop export shows the spring animation; Basic export is bold.
**Gaps:** CapCut's AI keyword highlighting (is_key) isn't reproduced (we highlight the spoken word); Flashback III (emoji + multicolour) not rebuilt; templates 0/2/5's own caption animations (7131927521469141505, 7314634238265922050) weren't available, so their motion is approximated.

## Clip context menu, multi-select, colour space, UI polish (2026-11-18)

- **Right-click menu on timeline clips** (`components/ClipContextMenu.tsx`), laid out like CapCut 9.5's
  `MainTimelineMenuModel::popupVideoSegmentMenu` (v2): Copy · Cut · Copy/paste attributes ▸ · Delete · Edit ▸
  (Freeze, Reverse, Mirror, Rotate, Crop) — Transcript · Separate audio · Extract audio — Group/Ungroup ·
  Create compound clip — Export selected clips · More clip actions ▸ (Deactivate/Activate, Replace clip,
  Trim start/end to playhead, Open file location). Right-click on empty timeline = Paste (as in CapCut).
  Submenus flip/shift to stay on screen.
- **CapCut UI reference** extracted with REA from /Applications/CapCut.app (Qt6/QML, strings in
  `Contents/Resources/po/en.po`, theme tokens in libFusionUI) plus `capcutcopy/User Data` (draft JSON).
  Used: accent #00C1CD (Brand_Primary_Default), control fill #3B3B3B, menu surface #303030 r8 p6 rows 28,
  text Pattern buttons in Bold/Underline/Italic order with a darker (#070709) active well, Case = Uppercase /
  Lowercase / Title case, colour-space options (CapCut has 709 SDR, 2020 SDR, 2100 HLG, 2100 PQ; we ship 709).
  Pure logic lives in `src/shared/clipOps.ts` (unit-tested in `clipOps.test.ts`); the store wraps it
  with undo + selection; async actions (render, dialogs, IPC) are in `src/renderer/clipActions.ts`.
- **Multi-select**: Cmd/Ctrl/Shift-click toggles; `selectedClipIds` + `selectionOf()` (the list is only
  trusted while it contains the primary `selectedClipId`). Groups (`clip.groupId`) select/copy/delete as a unit.
- **Shortcuts**: ⌘C/⌘X/⌘V, ⌥⌘C/⌥⌘V attributes, ⌘G / ⇧⌘G group, ⌥G compound, V deactivate, Q/W trim
  start/end to playhead, ⇧F freeze, ⌫ deletes the whole selection.
- **Deactivated clips** (`clip.disabled`): preview and export skip them; on the main roll the slot renders black
  so later clips keep their timing. Timeline draws them dimmed + hatched.
- **Crop** (`MediaClip.crop`, fractions of the source): crop dialog (`CropDialog.tsx`) with Free/Original/9:16/
  16:9/1:1/4:5/4:3; export applies `crop` on the trimmed frames before fit/scale; preview draws the same source rect.
  Verified pixel-exact against the source.
- **Export selected / compound clip**: render the project with every other clip deactivated, trimmed to the
  selection's span (`planToFfmpegArgs(..., range)`). Compound clips are saved under `<userData>/Compound clips/`
  and replace the selection with one clip (undo restores the originals). Extract audio writes
  `<userData>/Extracted audio/<name> (audio).m4a`.
- **Colour space**: project setting `canvas.colorSpace` ('rec709', the default and only option, in the Project
  inspector). Probe records each video's colour tags (`asset.color`; mediainfo cache bumped to v2). Export converts
  HDR HLG/PQ (e.g. iPhone) with zscale + Hable tone-map, tagged SD/Rec.2020-SDR with `colorspace`, does the final
  RGB→YUV with the Rec.709 matrix (swscale defaults to 601, which shifted text/overlay colours) and tags the file
  bt709/tv. Verified: Rec.709 source round-trips exactly, red text overlay stays (253,0,0); Hable picked over
  mobius/reinhard/clip by comparing real iPhone HLG frames with macOS Quick Look's own SDR rendering.
- **Text**: Pattern row (B / I / U toggles) and Case row (AA / aa / Aa, click again for "as typed"):
  `TextClip.italic/underline/textCase`, rendered by `textRender.ts` (so preview and export match).
- **UI**: dropdowns are filled boxes without an outline (custom chevron); property rows put the label on the left
  (`.field-row.prop-row`); clip names are regular-weight white; video clips use one blue (`--track-video`) for
  border, name strip and body; selection is a white frame. The transform keyframe editor was removed (old projects
  still play their keyframes; touching a transform slider replaces them with the static value).
- **Auto-captions "no speech" fix**: transformers.js 3.7.6 crops Whisper cross-attention with `num_frames`
  at 100 fps instead of 50, so word timestamps collapse to ~29.98 s on some >15 s clips (e.g. iPhone HLG
  IMG_1328) and were dropped as past the clip end. `captionWorker.ts` patches `_extract_token_timestamps`
  (halves num_frames like the Python impl), falls back to phrase timestamps when alignment still looks broken,
  and clamps word times. Known: "Detect automatically" still defaults to English inside transformers.js.
- Known pre-existing failure: `scripts/testExportKeyframes.ts` (keyframed overlay fade pixel check) fails with
  or without the new Rec.709 output step.
- **Timeline row order (CapCut layout)**: `src/shared/trackOrder.ts` `displayTracks()` shows text/caption
  tracks at the top (last-drawn highest), overlay video tracks, the main video track, then audio. Display only:
  `project.tracks` order still drives compositing. Text rows are compact 36px strips (`TEXT_ROW_HEIGHT`).
- **HDR thumbnails/proxies**: filmstrip + bin thumbnails (`thumbnails.ts`) and transcoded preview proxies
  (`proxy.ts`) now run the same `colorConversionFilters()` as export (HLG/PQ tone-mapped to Rec. 709; the
  zscale input tags are explicit so it works after a resize). Thumbnails decode to RGB with the Rec. 709 matrix.
  Cache versions bumped (thumbnails v3, proxies v2), so existing projects regenerate them on open.

## Inspector restructure, Animations, speed-curve graph, motion blur (2026-11-20)
- **Inspector**: no "Inspector" title or Start/Duration row. Video tab = collapsible sections (`Section` in Inspector.tsx, open state in localStorage `freecut.inspectorSections`): Transform (Scale, Position X/Y in px from centre with Y up, Rotate −180…180), Blend (Opacity), Motion blur, Audio, Effects, Remove background, Transition. Text clips use the same Transform/Blend sections. Fonts stepped down ~1px app-wide; rows have more vertical spacing.
- **Animations** (`src/shared/animations.ts`, tests): In / Out / Combo presets, sampled into ordinary transform keyframes by `animatedTransform()`. The preview uses `animatedTransformCached`; export bakes them in `buildFfmpegPlan`. Easing comes from CapCut's cached AE animation exports (`Cache/effect/*/LumiExportData.lua`): cubic-bezier (0.33,0,0,1) for scale, (1,0,0,1) for opacity. Out presets are In presets played backwards. Combo replaces In/Out. Store: `setClipAnimations`. Smoke test: `scripts/testExportAnimations.ts`.
- **Export geometry change**: main-track transforms are now an overlay onto a black canvas (`applyCanvasTransform`), not a scale≥1 crop. Scale below 1 and off-canvas positions now match the preview. Rotation works at any angle and keeps the full rotated bounding box. Overlay clips rotate with transparent corners. Order for the main track: rotate/flip → transform → effects. `piecewiseLinearExpr` drops collinear keyframes.
- **Speed**: the Velocity effects tab, the "3 uses" badge and the fake Smooth slow-mo row are removed. The Curve tab is a draggable log-scale graph (0.1x–4x) with CapCut presets (Montage, Hero, Bullet, Jump cut, Flash in/out). Control points are stored in `speedCurvePoints`, sampled into 16 constant-speed `speedKeyframes` (`src/shared/speedCurve.ts`).
- **Motion blur** (`electron/main/motionBlur.ts`, `src/shared/motionBlur.ts`, `MotionBlurSection.tsx`): CapCut-style offline bake (Blur, Blend, Direction, Times). Optical flow via `minterpolate` at ≤432 px across parallel segments, then `tmix`, then a motion-masked merge at full resolution. Stored as `sourceOverride` kind `motionBlur`, cached in `Cache/motionblur/`. Runs at about 1.6× real time for 1080p.

## Filters (2026-11-21)
- CapCut's filters are LUTs downloaded from its server on demand. They are not in CapCut.app or the user-data copy, and the names don't appear in the app, so REA can't extract them. The user chose original look-alikes instead.
- `src/shared/filters.ts` defines 15 grades in 4 categories (Featured: Clear II, Shadow, Umber, September sunset; Life: Taro, Light Green, Grey Orange, Gold Ivory, Fresh Lime; Retro: VHS; Movies: Blue Grey, Sicily, Dune 1, Love City, Bright Summer).
  - Each grade is a colour function plus optional sharpen / soften / grain / vignette, and has its own default intensity (Umber 40, Blue Grey 25).
  - `buildLut` turns a grade into a 33³ LUT with the intensity mixed in; the preview and export both use that same table.
- **Preview:** `src/renderer/filterRenderer.ts` is a WebGL2 pass using a 3D texture with trilinear sampling. It grades the clip's own pixels before they're placed on the canvas.
- **Export:** `clipFilterChain` in ffmpegGraph does an RGB round-trip with the 709 matrix in both directions, then `lut3d` (trilinear), then unsharp / gblur / noise / vignette. The plan now carries `files` (the .cube LUTs), which export.ts writes to `<userData>/Cache/luts`.
- **UI:** the left Filters tab (`FiltersPanel.tsx`) shows tiles graded on the selected clip's frame. Inspector → Video → Filter has an intensity slider and a remove button. Copy/paste attributes now carries the filter and animations. Store action: `setClipFilter`.
- **Colour fixes found along the way:**
  - Still images were converted to YUV with the 601 matrix; they now use 709.
  - The final output scale now states `in_color_matrix=bt709`.
  - The `freecut-media://` protocol sends `Access-Control-Allow-Origin: *`, and media elements load with `crossOrigin=anonymous`. Without both, the dev renderer can't read frames back for WebGL or canvas.
- **Test:** `scripts/testExportFilters.ts` checks each exported colour against the preview LUT; all 15 are within 6/255.

## Preview black flashes (2026-11-22)

Reversed clips and speed curves flashed black in the **preview** (export was always clean; `scripts/testExportNoBlackFrames.ts` checks 10 reverse/curve/split/freeze cases frame by frame).

Cause: a `<video>` has no drawable frame while seeking or before its first decode (readyState < 2), and the render loop simply skipped drawing, leaving black. Reverse playback is pure seeking; curves were seek-driven too; and every re-seek aborted the previous one, so frames rarely arrived.

Fixes in `Preview.tsx`:
- `frameFor()`: every good frame is snapshotted per clip (≤1280px, 16-entry LRU); the snapshot is drawn while the element is seeking/not ready, falling back to the latest held frame of the same asset. Also covers scrubbing, cuts between split pieces, freeze frames, proxy/src swaps and MediaBin preview.
- `syncMediaElement`: never seeks while a seek is in flight; seek threshold is ~half a frame (was 0.12s, which also made paused frame-stepping skip).
- Speed curves free-run at the current segment's rate (`clipSpeedAt` in shared/types.ts) instead of seeking.
- Reversed clips keep the element paused (seek-only); their audio is silent in preview (export uses areverse).
- Clips starting within 1.5s are preloaded and parked on their first frame.

Measured in the app (1080p, GOP 250): reversed 43% → 0% black frames, curve 7% → 0%; cuts, freeze, scrubbing 0%. Reverse preview runs ~16 new frames/s on long-GOP sources (seek-bound).

## Renamed to anycut; packaging and releases (2026-11-22)

- **Name:** user-facing strings, identifiers, localStorage keys, the media scheme (`anycut-media://`), the skill (`run-anycut`) and the env vars (`ANYCUT_DEBUG_PORT`) are all renamed. The repo folder and the `.fcproj` project extension are unchanged.
- **Migrations:**
  - Main: on first launch, `appData/freecut-editor` is moved to `appData/anycut`.
  - Renderer: `src/renderer/migrateStorage.ts` copies `freecut.*` localStorage keys to `anycut.*`.
- **Icons:** built from the user's mark.
  - `build/icon.png`: macOS grid with shadow.
  - `build/icon.icns`, `build/icon.ico`, `build/icon-full.png` (Linux).
  - `src/renderer/assets/logo.png`: Home sidebar and toolbar.
  - `public/favicon.png`.
- **Packaging (electron-builder, `build` key in package.json):**
  - ffmpeg / ffprobe / onnxruntime-node / sharp are `asarUnpack`ed.
  - `electron/main/binaries.ts` rewrites their paths to `app.asar.unpacked`. Use it instead of importing ffmpeg-static or ffprobe-static directly.
  - Only the target `${platform}/${arch}` ffprobe and onnxruntime binaries are packed (platform-level `files` lists replace the root list, which pulled in capcutcopy/ and made a 2.7 GB DMG).
  - macOS builds are ad-hoc signed (`identity: "-"`, hardenedRuntime off), not notarized.
- **Releases:** `.github/workflows/release.yml` triggers on a `v*` tag or a manual run.
  - Build jobs: macos-14 (arm64), macos-15-intel (x64), windows-latest, ubuntu-22.04.
  - A final publish job attaches fixed-name installers to the GitHub Release; the README links to `releases/latest/download/<file>`.
- **Verification:**
  - A local arm64 DMG builds (204 MB).
  - The packaged app was launched with `ANYCUT_SHOW_INACTIVE=1` (shows the window inactive, for agent smoke tests) over CDP. Probe, export (reverse + filter) and the background-removal runtime all work.
  - Captions were not exercised in the packaged build.

## Floating overlay tracks, frame stepping, timeline scrub (2026-11-22)

- **Floating overlays:** only the main (first) video track is the magnetic roll. `isMainVideoTrack()` is in projectStore.
  - `repackVideoTrack(project, track)` now keeps overlay-track clips at their own `start`: it sorts them by start, re-derives durations and clears `transitionIn`.
  - Add, move (`moveFreeClip` now accepts overlay video tracks, and main → overlay), trim-start, paste and freeze frame all honour that.
  - Bin drops onto an overlay land at the pointer, snapped (`snapFreeStart` in shared/mediaDrop.ts). Timeline clip drags on any free track snap the same way, with a snap line; ⌘/Ctrl disables snapping.
  - Export already composited overlays at `clip.start`.
- **Arrow keys:** ← / → step one frame (⇧ = 1 s), snapped to the frame grid; stepping pauses playback.
- **Following the playhead:** the timeline pages to keep the playhead visible while it plays or steps.
- **Label column:** track labels and the new `.ruler-corner` sit at z-index 12, and `.track-lane` is its own stacking context. Clips, ghosts and the playhead now pass under the label column.
- **Scrubbing:** the playhead handle is draggable (18×24 hit area). Dragging it, or the ruler, into 40 px of a lane edge auto-scrolls the timeline (up to 28 px/frame). The playhead stops at the end of the timeline content.

## Faster background removal on macOS (2026-11-22)

- **What changed:** on macOS, background removal runs on Apple's Vision framework (Neural Engine) instead of the ONNX models, through a small native helper.
  - Helper source: `native/matte/main.swift`. It is built to `native-bin/anycut-matte` by `scripts/buildNative.mjs`, which runs in `npm run dev` / `npm run build`.
  - It ships through electron-builder `mac.extraResources`.
- **Pipeline:** decoder ffmpeg (BGRA, long side 1280) → helper → JS (`smoothMatte`, progress) → encoder ffmpeg, which is unchanged.
- **Which Vision request each model uses:**
  - People: `VNGeneratePersonSegmentationRequest` at `.accurate`, through `VNSequenceRequestHandler` for temporal consistency (macOS 12+).
  - Any subject: `VNGenerateForegroundInstanceMaskRequest` (macOS 14+; older systems fall back to ISNet).
- **No downloads:** no model download is needed on the Mac; `backgroundStatus` reports both models ready.
- **Cache keys:** Vision bakes get a `-vision` cache-key suffix.
- **Fallback:** Windows / Linux, or a missing helper, use the ONNX path as before.
- **Measured on a 12 s 1080p clip (M5), whole bake including encoding:**
  - People: 33.5 s (MODNet) → 17.3 s.
  - Any subject: ~5 min (ISNet, ~870 ms/frame) → 7.6 s.
  - Packaged app verified.
- **Tried and rejected:**
  - CoreML / WebGPU execution providers for MODNet: CoreML only takes 117 of 242 nodes, so no gain; WebGPU is 2× slower.
  - Int8 / fp16 MODNet: ≤18% faster.
  - Parallel ORT sessions: no gain.
  - Smaller Vision input: no gain.
  - Two Vision helpers in parallel: 25% faster, not worth the frame-split complexity.
- **Mask quality:** not yet compared against MODNet on real footage of people (no non-personal test clip with a person available).

## Editing feel pass (2026-11-22)

**Timeline (Timeline.tsx)**
- The toolbar sits outside the scroll area (`.timeline-scroll`), and the ruler is `position: sticky; top: 0`. The playhead handle now lives in the ruler.
- **Zoom** is only ever changed by the user: ⌘/Ctrl+wheel (and pinch) zooms around the time under the pointer, or the zoom slider. Adding clips no longer snaps the zoom, and the min-zoom clamp effect is gone.
- **Clip drags** resolve a live `ClipDropTarget` (`resolveClipDrag`):
  - On the main track, the clips part to show the gap (`gapShift`, animated while `.timeline-body.parting`) and a ghost marks the slot.
  - Free tracks get a snapped ghost.
  - A video dropped on top of another video on an overlay track, or onto a text row, goes to a new overlay track: a `.new-track-ghost` insertion line, then `moveClipToNewTrack` / `addMediaClipToNewTrack` in the store.
  - Bin drags use the same ghost and gap logic.
- **Trim** follows the pointer's travel, not its absolute position:
  - A 3 px dead zone, snapping to edges and the playhead within 8 px (⌘ disables it), and one undo step.
  - It fixes the main-track start trim, which re-applied the whole drag on every move.
  - Handles are 12 px with a hover grip; audio clips can be trimmed too.
- **Audio clips** have a CapCut-style volume line: middle = 100%, top = 200%. The waveform scales with it, and the Inspector volume now goes to 200%. The preview plays volumes above 100% through a Web Audio gain node (`audioGain` in Preview.tsx).
- **Rectangle selection:** dragging on an empty lane selects (`setSelection`).
- **Media bin:** rectangle selection, ⇧/⌘-click to add to the selection, and Delete to remove. Dragging a selected item drags all of them (`activeAssetDragIds`), and they are dropped back to back.

**Keys**
- Space is handled in the capture phase and always plays/pauses, except in text fields. Key-up is suppressed so a focused button doesn't click.

**Captions**
- `electron/main/whisperModel.ts` downloads and size-verifies the Whisper files (temp file → rename, manifest last). The worker then loads only from that folder (`allowRemoteModels = false`).
- This fixes "Protobuf parsing failed" from a truncated encoder_model.onnx that transformers.js had cached: 49.7 of 82.5 MB.

**Preview (preview-agent work)**
- Click to select / drag to move / corner-scale in the preview, with centre snapping (`src/shared/transformEdit.ts`, `preview.css`).
- A Crop row in the Inspector plus a crop button in the preview.
- A full-screen button.
- Transitions crossfade the audio: equal power in preview, and `afade` in/out with `qsin` in export (`scripts/testExportTransitionAudio.ts`).
- **Follow-ups:**
  - ⌘/Ctrl+A selects all clips, or all media when the media pool has focus.
  - A dragged clip floats glued to the cursor (`.drag-float`); ghosts are grey and the gap animations were removed (no lag).
  - Fade handles: `MediaClip.fadeIn` / `fadeOut` (timeline seconds), set by the corner dots with a shaded triangle.
    - Preview multiplies opacity and volume by `clipFadeGain`.
    - Export uses `fade` (to black on the main track; `alpha=1` on overlays) plus linear `afade`.
    - Split keeps fade-in on the first half and fade-out on the second.
    - Covered by `scripts/testExportFades.ts`.
  - The export finish shows a success toast with "Show in Finder" (toasts gained `success` and an action button).

## Cuts in preview with phone 4K footage (2026-11-22)

- **Change kept:** videos larger than 1080p now get a 720p H.264 preview proxy (`planProxy` takes width/height), and all proxies use `-g 30`. This removed the decoder ramp-up drops after every cut with 4K HEVC (a 0.17 s frame gap plus 5 dropped frames → none) and makes seeking lighter. Export still reads the originals.
- **Still open:** a clip WITH an audio track freezes on its first frame for ~0.25-0.28 s after a cut, while play() waits for the audio output. Tried without success:
  - Pre-rolling the next clip early: this fixes the cut, but the frame-delivery behaviour then halves the displayed frame rate for ~1 s, through both `requestVideoFrameCallback` and unseen playback.
  - Pre-rolling at playbackRate 1/16: the stall moves to the rate change.
- **Likely real fix:** a WebCodecs decode path, or driving the timeline clock from the active element during playback. Measured with `scratchpad cut*.js` (canvas-hash change counts vs element currentTime).
