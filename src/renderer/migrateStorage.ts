/**
 * anycut was called freecut: carry its saved UI state (layout, recents, Inspector sections,
 * background-removal model) over to the renamed keys. Imported first in main.tsx, because the
 * stores read localStorage when their modules load.
 */
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith('freecut.')) continue
    const next = 'anycut.' + key.slice('freecut.'.length)
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key) ?? '')
  }
} catch {
  // Storage unavailable: nothing to migrate.
}
