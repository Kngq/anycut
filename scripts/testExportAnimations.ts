/**
 * Smoke test: Animation presets + free rotation through the real ffmpeg. Renders a primary-track
 * clip with Zoom in (In) + Slide left (Out), a rotated 30° primary clip, and an overlay clip with a
 * Pop In + rotation, then checks frame timing/geometry by sampling pixels.
 *   npx tsx scripts/testExportAnimations.ts
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { createEmptyProject, defaultTransform, type MediaAsset, type MediaClip } from '../src/shared/types'

const WORKDIR = process.env.ANYCUT_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'anycut-anim-'))
fs.mkdirSync(WORKDIR, { recursive: true })
const ff = (args: string[]) => spawnSync(ffmpegPath as string, args, { encoding: 'utf-8', maxBuffer: 1 << 26 })

function run(args: string[], label: string) {
  const res = ff(args)
  if (res.status !== 0) {
    console.error(`FAILED (${label}):\n`, res.stderr?.split('\n').slice(-25).join('\n'))
    process.exit(1)
  }
  console.log(`OK (${label})`)
}
function pixel(file: string, x: number, y: number, t: number): number[] {
  const raw = spawnSync(ffmpegPath as string, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  return [...raw.stdout.subarray(0, 3)]
}
const bright = (p: number[]) => p[0] + p[1] + p[2]

const src = path.join(WORKDIR, 'white.mp4')
run(['-y', '-f', 'lavfi', '-i', 'color=c=white:size=320x240:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], 'generate white source')

const p = createEmptyProject('anim')
p.canvas = { width: 320, height: 240, fps: 30 }
const asset: MediaAsset = { id: 'w', path: src, kind: 'video', name: 'w', duration: 6, width: 320, height: 240, hasAudio: false }
p.assets = [asset]
const [video] = p.tracks
const base = { kind: 'media' as const, assetId: 'w', volume: 0, muted: true, speed: 1, reversed: false, frozen: false }
const a: MediaClip = { ...base, id: 'a', trackId: video.id, start: 0, duration: 2, trimIn: 0, trimOut: 2, transform: defaultTransform(), animations: { in: { id: 'zoom_in', duration: 0.5 }, out: { id: 'slide_left_out', duration: 0.5 } } }
const b: MediaClip = { ...base, id: 'b', trackId: video.id, start: 2, duration: 2, trimIn: 2, trimOut: 4, transform: { ...defaultTransform(), rotation: 30, scale: 0.5 } }
const c: MediaClip = { ...base, id: 'c', trackId: video.id, start: 4, duration: 2, trimIn: 4, trimOut: 6, transform: defaultTransform(), animations: { combo: { id: 'slow_zoom_out', duration: 0 } } }
video.clips = [a, b, c]
const overlay = { id: 'ov', type: 'video' as const, clips: [] as MediaClip[], muted: false, hidden: false }
overlay.clips = [{ ...base, id: 'o', trackId: 'ov', start: 2, duration: 2, trimIn: 0, trimOut: 2, transform: { ...defaultTransform(), scale: 0.25, x: 0.2, y: 0.2, rotation: 45 }, animations: { in: { id: 'pop_in', duration: 0.5 } } }]
p.tracks.splice(1, 0, overlay as never)

const out = path.join(WORKDIR, 'anim.mp4')
const plan = buildFfmpegPlan(p)
run(['-y', ...planToFfmpegArgs(plan, out).slice(0)], 'export')

const checks: [string, boolean][] = []
// Zoom in: at t=0.05 the white frame is ~0.6x → the corner is black, the center white.
checks.push(['zoom in starts small (corner black)', bright(pixel(out, 5, 5, 0.05)) < 60])
checks.push(['zoom in center fading up', bright(pixel(out, 160, 120, 0.05)) > 100])
checks.push(['settled full frame at 1s', bright(pixel(out, 5, 5, 1.0)) > 700])
// Slide left out: near the end the frame has moved left → the right edge is black.
checks.push(['slide-left exit leaves right side black', bright(pixel(out, 300, 120, 1.8)) < 60])
// 30° rotated at 0.5x: center white, corner black, and the rotated corner pokes past the
// unrotated box edge.
checks.push(['rotated clip center white', bright(pixel(out, 160, 120, 3)) > 700])
checks.push(['rotated clip corner black', bright(pixel(out, 5, 5, 3)) < 60])
// Overlay (white on the rotated white clip area) at (64,48), visible after the pop.
checks.push(['overlay drawn after pop', bright(pixel(out, 64, 48, 3.0)) > 700])
// Combo slow zoom out: at 4.05 scale≈1.18 (full white), at 5.95 ≈1.0 (still full white).
checks.push(['combo keeps frame filled', bright(pixel(out, 3, 3, 5.9)) > 700])
const probe = spawnSync(String(ffmpegPath).replace(/ffmpeg$/, 'ffmpeg'), ['-i', out], { encoding: 'utf-8' }).stderr
const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe)
const secs = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0
checks.push([`duration ≈ 6s (got ${secs})`, Math.abs(secs - 6) < 0.1])
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}
console.log(`output: ${out}`)
process.exit(failed ? 1 : 0)
