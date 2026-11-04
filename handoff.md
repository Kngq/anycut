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
  `probe.ts`, `thumbnails.ts`, `waveform.ts`, `relink.ts` (missing-media), `transcribe.ts`
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
14. **Speed tab redesign** — `SpeedPanel.tsx`: Standard/Curve/Velocity sub-tabs, tick-mark speed
    slider + stepper, duration slider, "Change audio pitch" toggle (stored as
    `MediaClip.changeAudioPitch`; export doesn't honor it yet), locked "Smooth slow-mo" row.
15. **Instant import** — assets appear after the probe; heavy work runs in the background.
16. **Media management (CapCut-derived)** — persistent content-keyed cache, remux-before-
    transcode, 720p proxies, seek-based filmstrips, missing-media relink, atomic save + `.bak` +
    lock, per-clip `sourceOverride`, working background removal. See "Media management
    (implemented)".

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
- **Captions** require `brew install whisper-cpp` (binary not bundled); once installed, the model
  downloads on first use. Consider bundling `@remotion/install-whisper-cpp` to auto-fetch the binary.
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
