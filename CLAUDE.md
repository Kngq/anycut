# anycut — agent rules

## The app must never take focus in dev
The user works in other windows while agents run anycut.
- In development (`!app.isPackaged`), `electron/main/index.ts` creates the window with `show: false` and calls `win.showInactive()` on `ready-to-show`. Packaged builds use `win.show()`. Keep it that way.
- Never add `app.focus()`, `win.focus()`, `app.dock.show()` or anything else that activates the app in dev.

## Testing goes through CDP/Playwright, never the user's screen
- Drive and screenshot the app with `scripts/devDriver.mjs` (CDP `Page.captureScreenshot`; see the `run-anycut` skill), or with Playwright's `_electron.launch()`.
- Never use `screencapture`, whole-screen screenshots, or OS-level clicks or keystrokes.
- Look for errors in the terminal output and the renderer console (via CDP), not by looking at the screen.
