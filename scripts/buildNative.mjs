// Builds the native helpers (macOS only): native/matte → native-bin/anycut-matte, the Apple Vision
// background-removal helper. A no-op on other platforms, or when the binary is newer than its
// source. Runs as part of `npm run build` / `npm run dev`; electron-builder ships native-bin/ on mac.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin') process.exit(0)

const src = path.join(root, 'native/matte/main.swift')
const out = path.join(root, 'native-bin/anycut-matte')
const mtime = (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0)
if (mtime(out) > mtime(src)) process.exit(0)

fs.mkdirSync(path.dirname(out), { recursive: true })
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
try {
  execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos12.0`, src, '-o', out], { stdio: 'inherit' })
  console.log(`built ${path.relative(root, out)} (${arch})`)
} catch (err) {
  // Background removal falls back to the ONNX models without it; don't fail the whole build.
  console.warn('[buildNative] could not build anycut-matte (Xcode command line tools missing?):', err.message)
}
