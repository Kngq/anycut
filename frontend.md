# CapCut desktop frontend: teardown and how to rebuild it in freecut

Reverse-engineered from CapCut for Mac (`/Applications/CapCut.app`) on 2026-11-03. Companion to
the media-management section in `handoff.md`.

**Scope.** This file covers the interaction design: how the UI is laid out and how it responds
to the user. It does not cover branding or art. Rebuild the *behaviour* in freecut's own React UI
and visual style. Don't copy CapCut assets, icons or strings.

## How this was found (and how sure we are)

- **The UI is Qt 6 Quick (QML), driven by C++ view-models.** No QML ships as loose files: the
  `Resources/qml` folder holds only stock Qt modules. All app QML is compiled into
  `Frameworks/libVECreator.dylib` as Qt resources (rcc), partly plain text and partly
  zlib-compressed.
- **Recovery.** I wrote an rcc parser that matches the names table by `qt_hash`, walks the
  resource trees and inflates the data. It found 26 resource sets and **2,041 named QML files**,
  e.g. `TimeLine/segment/MainTimeLineSegment.qml`. FusionUI, CapCut's design-system library, came
  from `libFusionUI.dylib`. English labels came from `Resources/po/en.po`. Default keymaps came
  from `~/Movies/CapCut/User Data/Config/Shortcut/*.json`.
- **Tools.** The scratch tools are in the session scratchpad (`tools/rcc_extract.py`,
  `tools/tr.py`); extracted sources are in `rcc/`. They are not committed: they hold CapCut's
  code and are reference material only.
- **Confidence levels.** "Observed" below means read in QML or config. Much of the logic lives in
  C++ view-models (`timeLineCanvas.viewModel.*`, `CommandMgr`), which REA couldn't decompile:
  Hopper timed out on the 500 MB+ libraries. Where behaviour sits behind a view-model call, this
  doc names the call and describes the *visible* behaviour, marked "inferred". Nothing was
  observed at runtime: no screenshots were taken and the app was not driven.

---

## 1. Architecture pattern (worth copying)

| CapCut | freecut equivalent |
|---|---|
| QML view per panel. Every interactive item gets a `viewModel` (C++ `QObject`) and calls into it: `viewModel.dragSegmentStarted()`, `cutLeftFinished(x)`, `clickSeekByPos(x)`. Views hold almost no state. | React component + Zustand store actions. Keep components dumb and put gesture *results* in store actions (`moveClip`, `trimClipLeft`, `seek`). |
| **CommandMgr**: every user action is a named command (`cutoff`, `del`, `freeze`, `mark`, …) with a shortcut list, `enabled`, `visible` and `preempted` flags. Toolbar buttons, context menus and shortcuts all dispatch the same command id. | Add a `commands.ts` registry: `{ id, label, shortcuts[], enabled(state), run(state) }`. Toolbar, menus and the key handler all read from it. Today `App.tsx` hard-codes its keys. |
| **Toolbar is data-driven**: `ToolBarButtonModel / ComboModel / SliderModel / SwitchModel`, with `viewModel.currentLeftButtonList` as a list of command ids. | Render the toolbar from an array of command ids. This makes later user customisation trivial. |
| **Keymaps are JSON** presets (CapCut default, Final Cut Pro X, Premiere Pro, 3 custom slots). The user picks one in settings (`keymapSettings: currentKeymapIndex`). | Ship `keymaps/capcut-like.json` + `fcpx.json`. Let the user switch. |
| Panels are **DockWidgets** with stable names (`material`, `player`, `setting`, `timeline`, `textEditor`, `agentEditor`). They can float into their own window. Layout is persisted. | freecut already has resizable panels with persisted sizes (`layoutStore`). Floating panels are optional and low priority. |
| Shortcut gating: a shortcut fires only if `enabled && visible && !preempted && editShortcutEnabled && !maskVisible && !OOBE`. In practice keys are disabled while a text field, modal or brush tool has focus. | One global `keydown` handler that bails out when `document.activeElement` is an input/textarea/contenteditable or a modal is open. |

Note: Qt's `Ctrl` in keymaps means **⌘ on macOS**. In the tables below, read `Ctrl` as `Mod`
(⌘ on mac, Ctrl elsewhere).

---

## 2. Editor layout (observed: `SceneManager/editor_mode/view/EditorLayout.qml`)

```
┌───────────── title bar: draft name · export button ─────────────┐
│ ┌─ material ─┐ ┌────── player ──────┐ ┌──── setting ────┐       │
│ │ media bin, │ │  canvas (fit to    │ │ inspector for   │       │  ← top region, min height 240
│ │ text, fx,  │ │  draft ratio)      │ │ selection, or   │       │
│ │ transitions│ │  ─ control bar ─   │ │ project config  │       │
│ └────────────┘ └────────────────────┘ └─────────────────┘       │
│ ═════════════ vertical split handle (8px) ═════════════════════ │
│ ┌──────────────────────── timeline ───────────────────────────┐ │
│ │ toolbar (32px) · ruler · tracks …                           │ │  ← bottom region
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

- **Build order** in `Component.onCompleted`: material at bottom of the top area, then player to
  its right, then setting (inspector) to its right. The timeline goes below the whole top area.
- **The player takes the spare width** (`SplitView.fillWidth: true`). The side panels keep
  their width when the window grows.
- **Vertical split keeps its ratio on window resize.** It stores `functionPaneHeight` and
  `timeLineHeight` after each manual drag, then on `onHeightChanged` recomputes
  `timeline = max(ratio * (H - 8), timelineMin)` and gives the rest to the top area.
- **Minimum window width** = sum of the docked panels' minimum widths (floating panels excluded)
  + 16.
- **Implementation for freecut:** freecut already has this 3-over-1 layout. Add the
  ratio-preserving resize, and enforce per-panel minimum widths that add up to the window
  minimum.

---

## 3. Timeline (observed: `TimeLine/main/MainTimeLine.qml`, `segment/MainTimeLineSegment.qml`, `track/*`)

### 3.1 Toolbar (`TimeLine/toolbar/MainTimeLineToolBar.qml`), 32 px tall
- **Left** (data-driven list): a pointer-mode switch, **Select (V) / Split (C)**, which in
  `MainTimeLineSelectMode` also includes *Select leftward* (`A`) and *Select rightward*
  (`Shift+A`). Then edit commands. The list comes from C++ at runtime; the likely set is undo,
  redo, split, delete, freeze, reverse, mirror, rotate, crop (inferred: these labels exist in
  `en.po`, but the exact order wasn't read).
- **Centre**: draft name with a rename affordance.
- **Right**: record audio · **Linkage** (link attached items to main-track clips, `Ctrl+L`) ·
  **Preview axis** (hover-skim toggle, `Shift+P`) · **Zoom to fit** (`Shift+Z`) ·
  **zoom-out button, zoom slider (96 px), zoom-in button**.
- **Tooltips** are always `label + shortcut text` (`itemData.text + VEShortcut.textOf(shortcut)`).
  Copy this: discoverability for free.

### 3.2 Wheel / trackpad semantics (observed, `onWheel` at MainTimeLine.qml:862)
| Input | Result |
|---|---|
| mouse wheel (no modifier) | vertical track scroll (`scrollTrackV`), delta × 0.2 |
| `Alt` + wheel, or a horizontal wheel | horizontal scroll (`scrollTrackH`), clamped to `[0, contentWidth - width]` |
| `Ctrl/⌘` + wheel | zoom (`scrollTrackScale`). One step per notch via `adjustAccuracyByWheel(delta > 0)` |
| trackpad two-finger | free pan. Direction is whichever axis has the larger delta |
| trackpad pinch | zoom via `PinchArea`. Ignored until `|scale - startScale| > 0.3`, so small jitters don't zoom |

- **Trackpad detection:** on mac, `wheel.device.type === TouchPad`. On Windows, "no modifiers
  and angleDelta not a multiple of 120" means trackpad.
- **Zoom anchors on the playhead (inferred).** CapCut keeps the playhead fixed on screen while
  zooming.
- **In the browser:** use `WheelEvent.ctrlKey` (a pinch arrives as ctrl+wheel in Chromium) and
  `deltaMode === 0` with small deltas as the trackpad heuristic.

### 3.3 Ruler and playhead
- **The ruler is a separate item above the tracks.** Its tick density follows `zoomPixelSize`.
  When zoomed past 1 s per unit (`zoomPixelSize > kRulerPixelSize1s`), a **one-frame-wide
  highlight band** appears at the playhead in the ruler. That's a nice touch for frame-accurate
  work.
- **Press/drag/release anywhere on the ruler** moves the playhead
  (`cursorPressed/PositionChanged/Released`) and seeks continuously.
- **Clicking empty track space** (no drag) seeks to that x *and* clears the selection
  (`clickSeekByPos` + `unselectSegments`). It also selects the track under the cursor
  (`singleSelectedTrack`).
- **Preview axis (hover-skim)**: when enabled, a second, thin line follows the mouse and the
  player shows that frame without moving the real playhead. A click then commits that time
  (`getPreviewDuration()` → `clickSeekByTime`). Toggle it from the toolbar or with `Shift+P`.

### 3.4 Selection
- **Click a clip** selects it (`viewModel.clicked(modifiers)`). **Ctrl/⌘-click** adds to the
  selection.
- **Box select:** drag on empty track space draws a rubber-band rectangle. Without Ctrl/⌘ the
  previous selection is cleared first. The box **auto-scrolls the timeline** when dragged near
  an edge (`selectedBoxScrollTimer`).
- **Selection outline:** a selected clip shows a 1 px top/bottom border plus **trim handles
  outside the clip's left and right edges**. Corner radius goes from 4 to 0 when selected, so
  the handles sit flush.
- **Hover:** a track background lightens slightly on hover (`hoverdTrack` → ~4 % white). When a
  track is selected or highlighted it gets 1 px highlight lines top and bottom.

### 3.5 Moving clips (observed, `MainTimeLineSegment.qml:790-935`)
1. On **press**, record the press point. Don't start a drag yet.
2. A drag starts only after the pointer moves **more than 6 px** in x or y
   (`dragSegmentStarted`). This keeps clicks from becoming accidental 1-frame moves.
3. During the drag, positions are sent in window coordinates (`dragSegmentPositionChanged`).
   The C++ side resolves the target track, snapping and insertion.
4. On release, call `dragSegmentFinished`. A **cancel** (focus loss, Esc) finishes the drag *at
   the original press point*, which amounts to undoing the move.
5. **Double-click** opens the clip's detail editing; it is guarded so it isn't also treated as a
   click.
6. **Right-click, or long-press on touch**, opens the context menu.
7. **Snapping ("Auto snapping", key `S`)** snaps to clip edges, the playhead and markers.
   Holding **Ctrl/⌘ while dragging temporarily disables snapping** (`disableAlignment:
   Ctrl_hold`).
8. **Main track magnet** (`Shift+Backspace` toggles `mainTrackAdsorb`): the main video track
   stays gap-free (ripple). Moving or deleting there closes gaps. Overlay tracks remain
   free-position.

### 3.6 Trimming (observed)
- **Handles:** each selected clip has a left and right handle, 3 px visible
  (`rangeSlierWidth`, or 10 px in the "wider slider" variant). The hot zone is 6 px inside the
  clip edge. The cursor turns into a horizontal resize cursor over a handle.
- **Gesture:** press calls `cutLeftStarted` / `cutRightStarted`; move calls
  `cut{Left,Right}PositionInNullChanged(x)`; release calls `cut{Left,Right}Finished(x)`.
- **Junction between two clips:** a special hot zone straddles the boundary
  (`rangeSliderLeftNoBorder` with `x = root.x - 0.2`), so you can grab the cut between adjacent
  clips even when neither is selected. A **300 ms `doubleClickTimer`** after a trim swallows the
  second click of a double-click.
- **Keyboard trims:** **`Q` = delete everything left of the playhead within the selected clip**
  (`cutLeft`). **`W` = delete everything right** (`cutRight`). `Ctrl/⌘+K` splits at the playhead
  (`cutoff`). `Ctrl/⌘+Shift+K` splits all tracks (`batchCut`).

### 3.7 Clip appearance (observed)
- **Video clips:** a filmstrip of cached frames (the cache shows 164×92 px JPEGs, i.e. 82×46 pt
  at 2×) with the name and duration overlaid. Audio clips show a waveform.
- **Other clip types use flat colours:** filters `#47418B`, plugin effects `#6B7BC9`, transitions
  as translucent white.
- **Missing media:** the clip turns indigo/red with an error tint (`fileLost`).
- **Hidden track:** clips get an 80 % black overlay. **Locked track:** a diagonal stripe tile
  over the track.
- **Quick-edit accent:** cyan **`#00C1CD`** for hover borders and trim handles in the "quick
  edit" mode. Use one accent colour consistently for selection, handles and playhead.
- **Keyframes** are drawn as small diamonds on the clip. Hovering a keyframe takes priority over
  starting a clip drag (`hoverHasKeyframe` → `mouse.accepted = false`). **Shift+click on the
  clip adds a keyframe** (`addKeyframe: Shift+LeftMouseButton`).

### 3.8 Dropping media onto the timeline (observed, `MainTimeLine.qml:2088`)
- **One `DropArea`** covers the whole timeline. Two cases:
  - *Internal* drag from the media bin (`supportedActions === CopyAction`, `drag.source` set)
    calls `dragEnter(source)` → `dragPositionChanged(source, x, y)` → `dragDrop(source, x, y)`.
  - *External* files from Finder (`drag.urls`) call `dragDropOther(urls)`, which imports and then
    places them.
- **Ghost preview:** while hovering, a **"follow segments"** ghost (sized to the clip duration at
  the current zoom) tracks the pointer and **snaps** (`dragPositionChanged` returns an `adsorbX`).
  The target track highlights.
- **Edge auto-scroll** during the drag (`dropScrollTimer`).
- **Main-track drops insert and ripple; overlay drops can create a new track** above or below
  the existing ones (inferred from the `bottomAdsorb` area at the bottom of the canvas).

---

## 4. Media panel (observed: `MaterialPanel/media/LocalMediaImport.qml`, `MediaInfoView.qml`)

- **Empty state:** a big drop zone reading "Import video, audio, and image files" with a single
  Import button (`Ctrl/⌘+I`).
- **Header row:** view mode **Grid / List**, **Sort** (by name, import time, …), **Filter**
  (All / video / audio / image), **New folder**, and a search box.
- **Folders and breadcrumb:** media can be grouped into folders (see `draft_virtual_store.json`
  in handoff.md), with a breadcrumb bar for navigation.
- **Drag files from Finder onto the panel** to import. The `DropArea` first checks the file
  extensions (`checkSuffix`), so an invalid drag shows "not allowed" *before* the drop.
- **Card (grid item):** thumbnail **120×80, radius 8**, with the duration label at
  bottom-right (text with a shadow for legibility).
  - An **"Added" badge** at top-left once the asset is used on the timeline (`isAdded`). Very
    useful; cheap to build.
  - An import **progress ring** (24 px) while probing or copying.
  - **Error states written onto the card itself:** "Media not found", "File damaged",
    "Format not supported", "Access unavailable".
- **Drag** a card onto the timeline to add it (observed, §3.8). Also inferred, not read in QML:
  **click** shows it in the player as a source preview, **hovering** scrubs inside the
  thumbnail, and a "+" button adds the clip at the playhead.
- **Right-click menu:** Delete · Rename · Open file location · New folder from selection ·
  Create new timeline from selection · Link media (relink) · Turn on/off proxy · Export clips ·
  Split scene (AI).

---

## 5. Player (observed: `Player/view/Player.qml`, `ControlItem.qml`, `PlayerSeekBar.qml`)

- **Canvas** is letterboxed to the draft ratio:
  `w = containerRatio > ratio ? H * ratio : W; h = w / ratio`, centred on black. freecut does
  this already.
- **Optional rulers and guides.** Horizontal and vertical player rulers (`Ctrl+Alt+R`),
  reference lines (`Ctrl+;`), and a safe-area overlay button. Selecting a clip shows an **edit
  panel** with transform handles directly on the canvas (move/scale/rotate). Mask and brush
  tools draw here too.
- **Control bar** (`ControlItem`, 62 px area, 28 px row), left to right:
  - **Timecode** `current / total`, formatted `HH:MM:SS:FF` and laid out with a fixed width
    (`getTextRect("00:00:00:00")`) so it doesn't jitter.
  - An audio meter toggle.
  - **Play/pause** centred (28 px).
  - Right group: safe-area / social-media preview · **playback quality** badge (proxy vs full)
    · **zoom** (popup with −/slider/+; `Alt+Shift+-/=`, fit `Alt+Shift+Z`) · **aspect ratio**
    badge (opens the ratio menu, 180 px) · divider · **full screen**.
- **Header row:** status text (e.g. "There are dropped frames" / "Video lags a lot"),
  prerender status, playback speed. Show performance problems inline instead of in dialogs.
- **Seek bar** (mini players / previews): 2 px track, accent-coloured fill, 8 px dot. The hit
  area is padded by half the dot. Press seeks immediately; release commits with
  `isReleaseClicked`.
- **Transport keys:**
  - `Space` play/pause.
  - **J / K / L** shuttle: reverse, pause, forward. Repeated J or L speeds up (inferred, standard
    NLE behaviour).
  - `←/→` one frame; `Shift+←/→` large step.
  - `↑/↓` previous/next cut point.
  - `Home/End` first/last frame.
  - `` ` `` full screen.

---

## 6. Inspector (observed: `FunctionPanel/**`, `core/view/PanelSettingCommonView.qml`, `common/misc/PanelSettingsGroup.qml`)

- **Contextual panel.** It shows `DraftInspectorProjectConfig` when nothing is selected
  (freecut has this), otherwise the inspector for the selection type: video, audio, text,
  sticker, effect, filter, transition, adjust, and **multiple selection**.
- **Title bar with a tab control** (e.g. Video → Basic / Remove BG / Mask / … · Animation · Speed
  · Adjust). Content sits in a flickable column with an optional bottom control bar ("Apply to
  all").
- **Every setting group shares one header pattern** (`PanelSettingsGroup`), 22 px high:
  `[optional enable checkbox] Title (i) … [keyframe ◇] [Apply to all] [reset ↺]`.
  - The **keyframe diamond** adds or removes a keyframe for that property at the playhead. When
    one group in a panel has a keyframe button and another doesn't, the other is padded
    (`alignKeyFrame`) so the right-hand buttons line up.
  - The **reset** button greys out when the value is already default (`enableReset`).
  - Sub-tabs, sliders and toggles follow freecut's existing Speed tab redesign.
- **Shift+drag on a number field** adjusts it faster (`fastAdjustSpinBox:
  Shift+LeftMouseButton`).

---

## 7. Home screen (observed: `HomeScene/Views/drafts/*`)

- **Project grid** of cards: cover image, name, duration and size, plus a cloud/export status
  badge. Grid/List toggle.
- **Card menu:** Rename · Duplicate · Delete · Select (multi) · Upload/Download (cloud).
- **Delete moves to Trash.** The Trash view offers Restore · Delete · Delete all, with columns
  Name / Size / Move time / **Days remaining**. Items are purged after N days.
- **Recommendation for freecut:** add Duplicate and Rename to `Home.tsx` cards. Deleting a
  project should move the `.fcproj` to the OS trash (`shell.trashItem`) instead of building a
  Trash UI.

---

## 8. Default keymap (observed: `Config/Shortcut/Custom1.json`; FCPX preset differences in brackets)

| Area | Action → key |
|---|---|
| Project | New `Ctrl+N` · Import `Ctrl+I` · Export `Ctrl+M` [`Ctrl+E`] · Close `Ctrl+W` · Back to home `Ctrl+Alt+Q` |
| Edit | Undo `Ctrl+Z` · Redo `Ctrl+Shift+Z` · Copy/Cut/Paste `Ctrl+C/X/V` · Select all `Ctrl+A` · Delete `Backspace`/`Del` |
| Cut | Split at playhead `Ctrl+K` [`Ctrl+B`] · Split all tracks `Ctrl+Shift+K` · Delete left of playhead `Q` · Delete right `W` · Split speed segment `Shift+B` |
| Tools | Select `V` [`A`] · Blade `C` [`B`] · Select leftward `A` · Select rightward `Shift+A` |
| Timeline toggles | Snapping `S` [`N`] · Main-track magnet `Shift+Backspace` [`P`] · Linkage `Ctrl+L` · Preview axis `Shift+P` [`S`] · Hide/show clip `Shift+E` [`V`] · Detach/attach audio `Ctrl+Shift+L` |
| Zoom | Timeline zoom `+`/`=` and `-` [`Ctrl+±`] · Fit `Shift+Z` · `Ctrl+Wheel` zoom · `Alt+Wheel` horizontal · `Wheel` vertical |
| Navigate | Frame `←/→` · Big step `Shift+←/→` · Prev/next cut `↑/↓` · Start/end `Home/End` · Play `Space` · J/K/L shuttle |
| Range | In `I` · Out `O` · Range from clip `Shift+X` · Clear range `Alt+X` |
| Markers | Add marker `M` · Alternate colour `Alt+M` · Next/prev marker `Shift+M` / `Alt+Shift+M` · Beat marker `Ctrl+J` |
| Grouping | Group `Ctrl+G` · Ungroup `Ctrl+Shift+G` · Compound clip `Alt+G` · Break compound `Alt+Shift+G` |
| Attributes | Copy attributes `Ctrl+Alt+C` · Paste attributes `Ctrl+Alt+V` |
| Keyframes | Add keyframe `Shift+Alt+K` · Expand keyframe lane `Alt+K` · Shift+click on clip |
| Player | Zoom `Alt+Shift+±` · Fit `Alt+Shift+Z` · Rulers `Ctrl+Alt+R` · Guides `Ctrl+;` · Full screen `` ` `` · Volume `Ctrl+,` / `Ctrl+.` |
| Misc | Speed control `Ctrl+R` · Freeze frame (toolbar) · `Tab` switch panel focus · `Esc` close dialog |

A few things are worth matching exactly, because CapCut users will try them first:
`Space`, `Ctrl+K` (not freecut's current `Ctrl+B`), `Q/W`, `←/→`, `↑/↓`, `S`, `M`, `+/-`,
`Ctrl+Wheel`. Keep freecut's existing `Ctrl+B` as an alias.

---

## 9. Reimplementation plan for freecut (ordered by user impact)

Each step names the files it touches. ✅ means freecut already has it.

1. **Command registry + keymap** — new `src/renderer/commands.ts` and
   `src/shared/keymaps/*.json`.
   - Move `App.tsx`'s hard-coded keys into the registry.
   - Add `Ctrl+K`, `Q`, `W`, `←/→`, `Shift+←/→`, `↑/↓`, `Home/End`, `J/K/L`, `S`, `M`, `+/-`,
     `I/O`.
   - Make the global handler ignore keys while an input is focused.
   - Make toolbar tooltips `"Label (key)"`, generated from the registry.
2. **Timeline wheel/zoom semantics** in `Timeline.tsx`.
   - Plain wheel scrolls vertically, `Alt`/shift-wheel scrolls horizontally, `Ctrl/⌘`+wheel and
     pinch zoom (pinch arrives as `ctrlKey`).
   - Zoom anchored on the playhead (or the cursor). Add a "zoom to fit" button and `Shift+Z`.
   - Add −/+ buttons around the existing zoom slider.
3. **Drag threshold + cancel** in `Timeline.tsx` clip drag.
   - Start a move only after more than 6 px. Esc during a drag restores the original position.
   - Ctrl/⌘ held during a drag disables snapping.
4. **Snapping** — a pure function in `src/shared/` (unit-testable).
   - Candidate times: clip edges on all tracks, playhead, markers. The threshold is in *pixels*
     (≈8 px ÷ pxPerSecond), so it feels the same at every zoom.
   - Show a vertical snap guide line. Toggle with `S`; show the state in the timeline toolbar.
5. **Trim handles**: visible only on the selected clip, drawn just outside its edges, with a
   resize cursor and a hot zone of about 6 px. Also allow grabbing the junction between two
   adjacent clips.
6. **Main-track magnet**: the primary video track stays gap-free. Delete, trim and move ripple
   on that track only. Toggle with `Shift+Backspace` and a toolbar switch. freecut's primary
   track already butts clips from 0, so this mostly means a toggle and gap rules.
7. **Drop ghost**: while dragging from the media bin, render a translucent ghost clip at the
   snapped drop time, sized by asset duration × pxPerSecond. Highlight the target lane.
   Auto-scroll near the edges. External file drops onto the timeline should import and then
   place.
8. **Box selection + multi-select**: rubber band on empty space, Ctrl/⌘-click to toggle, and the
   inspector "multiple selection" view (common props only).
9. **Click empty track space** seeks and clears the selection. Clicking or dragging on the ruler
   scrubs. Show a one-frame band on the ruler when zoomed in. *(Mostly ✅; add the frame band.)*
10. **Hover-skim ("preview axis")**: optional toggle. A thin line follows the mouse and the
    preview renders that time without moving the playhead; a click commits. Reuse the
    `previewAssetId` / preview rendering path.
11. **Media cards**: an "Added" badge when the asset is used, duration bottom-right, hover-scrub
    inside the thumbnail, a "+" add-at-playhead button. Error text drawn on the card for missing
    or unsupported files (ties into handoff.md's relink item). Add Grid/List and Sort/Filter
    menus.
12. **Player control bar**: fixed-width timecode `HH:MM:SS:FF`, a quality badge (Proxy/Full,
    bound to `useProxies`), an aspect badge that opens the existing ratio menu, a zoom popup,
    full screen. Show dropped-frame warnings inline in the player header. *(Partly ✅.)*
13. **Inspector group header**: one `SettingGroup` component (`title · (i) · ◇ keyframe · reset`)
    used everywhere. Reset greys out at default; keyframe buttons line up across groups.
14. **Context menus** on clips (split, delete, copy/paste attributes, detach audio, reverse,
    freeze) and on media (rename, reveal in Finder, relink, delete). All entries come from the
    command registry.
15. **Layout polish**: ratio-preserving vertical split, minimum panel widths, persisted sizes
    (✅). Floating panels are optional.

### Verification for each step
- Unit-test the pure parts in `src/shared/`: snapping, ripple, keymap parsing (vitest).
- Drive the real app with `scripts/devDriver.mjs` (skill `run-freecut`): synthesize
  wheel/drag/key events via CDP and screenshot before and after.
- Gesture details that matter (6 px threshold, Esc-cancel, Ctrl-disables-snap) deserve a
  scripted CDP check each, because they regress silently.

## Open questions (not verified)
- **Snap threshold value, zoom-step table, track heights.** These live in C++ constants
  (`VECConstKeys`, `kRulerPixelSize*`) that weren't decompiled.
- **Exact ripple rules on the main track** for multi-clip moves. These are inside the
  `dragSegment*` view-model.
- **Hover-scrub in media cards.** Inferred from the view-model API and CapCut's known behaviour,
  not read in QML.
- **Runtime confirmation.** A recorded runtime session (REA `capture_native_ui_scenario`, or
  screen recording while driving CapCut) would confirm the gesture details above. It wasn't done
  here.
