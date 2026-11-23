// Makes sure the ffmpeg that ships in the installers is legally redistributable.
//
// ffmpeg-static's macOS binaries are built with --enable-nonfree ("not legally redistributable"),
// so on macOS this replaces node_modules/ffmpeg-static/ffmpeg with Martin Riedl's static GPLv3
// build (https://ffmpeg.martin-riedl.de, no nonfree parts), pinned by URL and SHA-256. On every
// platform it then checks `ffmpeg -L` and fails if the binary still reports nonfree parts, so a
// release can never ship one. Runs before packaging (`npm run dist`, the release workflow).
//
// Usage: node scripts/fetchFfmpeg.mjs [--arch arm64|x64]
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argArch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : process.arch

/** ffmpeg 9.1, static, GPLv3 (--enable-gpl --enable-version3, no --enable-nonfree). */
const MAC_BUILDS = {
  arm64: {
    url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1795207104_9.1/ffmpeg.zip',
    sha256: '1f66e9a690a7f1c9e60b012379f8869c11818d1797f45b21dbb2f2564ba61ae1'
  },
  x64: {
    url: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1795212433_9.1/ffmpeg.zip',
    sha256: '35b3d82cccc2c1d644d49d15f5e57eb913a08ef68f798042c90eecec62c51f1e'
  }
}

const ffmpegBin = path.join(root, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
if (!fs.existsSync(ffmpegBin)) {
  console.error(`[fetchFfmpeg] ${ffmpegBin} is missing; run npm install first`)
  process.exit(1)
}

if (process.platform === 'darwin') {
  const build = MAC_BUILDS[argArch]
  if (!build) {
    console.error(`[fetchFfmpeg] no macOS ffmpeg pinned for arch "${argArch}"`)
    process.exit(1)
  }
  const marker = path.join(root, 'node_modules', 'ffmpeg-static', `.anycut-gpl-${build.sha256.slice(0, 12)}`)
  if (!fs.existsSync(marker)) {
    const res = await fetch(build.url)
    if (!res.ok) {
      console.error(`[fetchFfmpeg] download failed: HTTP ${res.status} ${build.url}`)
      process.exit(1)
    }
    const zip = Buffer.from(await res.arrayBuffer())
    const sum = crypto.createHash('sha256').update(zip).digest('hex')
    if (sum !== build.sha256) {
      console.error(`[fetchFfmpeg] checksum mismatch for ${build.url}: got ${sum}, expected ${build.sha256}`)
      process.exit(1)
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anycut-ffmpeg-'))
    fs.writeFileSync(path.join(tmp, 'ffmpeg.zip'), zip)
    execFileSync('unzip', ['-oq', path.join(tmp, 'ffmpeg.zip'), '-d', tmp])
    fs.copyFileSync(path.join(tmp, 'ffmpeg'), ffmpegBin)
    fs.chmodSync(ffmpegBin, 0o755)
    fs.rmSync(tmp, { recursive: true, force: true })
    for (const f of fs.readdirSync(path.dirname(marker))) if (f.startsWith('.anycut-gpl-')) fs.rmSync(path.join(path.dirname(marker), f))
    fs.writeFileSync(marker, `${build.url}\n`)
    console.log(`[fetchFfmpeg] installed GPLv3 ffmpeg (${argArch}) from ${build.url}`)
  }
}

// Every platform: never package an ffmpeg that isn't redistributable. (An arm64 Mac can check an
// x64 build through Rosetta.)
const runner = process.platform === 'darwin' && argArch === 'x64' && process.arch === 'arm64' ? ['arch', ['-x86_64', ffmpegBin, '-hide_banner', '-L']] : [ffmpegBin, ['-hide_banner', '-L']]
const license = execFileSync(runner[0], runner[1], { encoding: 'utf8' })
if (/nonfree|not legally redistributable/i.test(license)) {
  console.error('[fetchFfmpeg] the bundled ffmpeg has nonfree parts and is not redistributable; refusing to package it')
  process.exit(1)
}
console.log(`[fetchFfmpeg] ffmpeg license OK: ${license.split('\n')[0].trim()}`)
