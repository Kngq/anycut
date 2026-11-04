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
  isPlaying, pxPerSecond, previewAssetId) and all mutation actions.
- `src/renderer/state/layoutStore.ts` — persisted view prefs: panel sizes, `trackHeight`
  (short/default/tall via `TRACK_HEIGHTS`), `useProxies`.
- `src/renderer/state/toastStore.ts` — non-modal notification stack (`Toasts.tsx`).
- `src/renderer/components/` — `Timeline.tsx`, `Preview.tsx`, `Inspector.tsx`, `MediaBin.tsx`,
  `Toolbar.tsx`, `Home.tsx`, `EffectPreview.tsx`, `CaptionsPanel.tsx`, `BackgroundRemovalButton.tsx`.
- `electron/main/` — `export.ts`, `proxy.ts`, `probe.ts`, `thumbnails.ts`, `waveform.ts`,
  `transcribe.ts` (captions), `background.ts` (bg removal), `mediaProtocol.ts`.

## Current feature state (all implemented & verified)

Core (pre-existing): media import, trim/split/delete/merge, speed (constant + curve), reverse,
freeze frame, keyframe animation, crossfade+more transitions on the primary video track, overlay
video tracks + multi audio tracks in export, text overlays, MP4 export, resizable panels, proxy
transcoding for codecs Chromium can't decode, filmstrip thumbnails + waveforms, media grid,
standalone media preview, MM:SS ruler, aspect-ratio-aware preview.

Recently added (this track of work — all on `main`, pushed to github.com/Kngq/Freecut):
1. **Font selection for text** — `FONT_CATALOG`; `TextClip.fontFamily`; threaded into the preview
   `ctx.font` and the ffmpeg `drawtext fontfile=`. Dropdown in the Inspector text editor.
2. **Auto-captions (local)** — `electron/main/transcribe.ts`: whisper.cpp (`whisper-cli` from PATH/
   Homebrew) + a once-downloaded GGML model (`ggml-base.en.bin`) in `userData/whisper/`. ffmpeg
   extracts 16kHz WAV → `whisper-cli -oj` → parsed segments → `addCaptionClips` adds subtitle-style
   text clips. UI: MediaBin "Captions" tab (`CaptionsPanel.tsx`). Graceful when binary/model absent.
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

### Takeaways for freecut
- freecut already follows the same core idea: reference by absolute path (`MediaAsset.path`) and
  keep a separate preview-only file (`previewPath`, the equivalent of CapCut's agency proxy).
- Worth adopting, in order of value:
  1. **Content-keyed persistent cache** for probe/thumbnail/waveform/proxy, keyed on
     `hash(path + size + mtime)` with the header stored for validation. Today these go to
     `os.tmpdir()/freecut-*` (see `proxy.ts` for why not `userData`), which the OS can wipe.
     A dedicated app cache dir outside `userData` would keep the fetch workaround.
  2. **Missing-media relink**: on project load, stat each asset path, mark missing ones, and
     offer "locate file". Optionally auto-relink siblings in the same new folder.
  3. **Bin vs timeline separation**: keep `assets` (bin) distinct from per-clip derived paths,
     so a baked result (e.g. background-removal ProRes) replaces only the clip's source, as
     CapCut swaps `materials.videos[].path`. This is the missing wiring for bg removal.
  4. **Atomic project save** (write tmp → rename, keep `.bak`) and a lock file.
  5. **Remux before transcode** for container-only problems (`ffmpeg -c copy`), plus age-based
     cache cleanup that skips files referenced by recent projects.
- Not verified: the exact hash input for cache keys (md5 of the path alone doesn't match
  the observed keys) and relink matching heuristics. Both would need decompiling `libVECreator`
  once Hopper/Ghidra can load it.

## Build / verify commands
- `npx tsc -p tsconfig.json --noEmit` — typecheck (passes clean).
- `npx vitest run` / `npm test` — unit tests (63 passing: shared types, ffmpegGraph, effects, store).
- `npx vite build` — builds renderer + main + preload bundles (all pass).
- Agent-driven UI verification: the CDP driver at `scripts/devDriver.mjs` (see
  `.claude/skills/run-freecut/SKILL.md`) — `launch`, `eval`, `screenshot`, `quit`. Screenshots in
  `.dev-shots/` (gitignored).

## Known limitations / good next steps
- **Captions** require `brew install whisper-cpp` (binary not bundled); once installed, the model
  downloads on first use. Consider bundling `@remotion/install-whisper-cpp` to auto-fetch the binary.
- **Background removal** requires `npm i onnxruntime-node` (optional, prebuilt arm64). The pipeline
  is per-frame (temporal flicker possible) and outputs a ProRes 4444 `.mov` path — the
  import-as-overlay wiring (swap the clip to the matted result) is still a TODO.
- **Overlay video tracks** are contiguous per-track rolls (clips butt from 0); free positioning of
  an overlay clip at an arbitrary start isn't exposed yet (export already honors `clip.start`).
- **fontfile** paths in export are macOS system-font paths; a cross-platform font resolver (or
  bundled fonts) would make export font selection portable.

## Git
- Remote: `https://github.com/Kngq/Freecut.git` (origin). Branch `main`.
- Working tree should be committed & pushed after each feature chunk.
