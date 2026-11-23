/**
 * Export smoke test for clip fade handles (fadeIn / fadeOut): picture fades from/to black on the
 * main track, sound fades with it, and the clip length is unchanged.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { createEmptyProject, defaultTransform, type MediaAsset, type MediaClip } from '../src/shared/types'

const ff = ffmpegPath as string
const dir = process.env.ANYCUT_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'anycut-fades-'))
const run = (args: string[]) => {
  const r = spawnSync(ff, args, { encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stderr.split('\n').slice(-15).join('\n'))
  return r
}
const src = path.join(dir, 'src.mp4')
run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src])

const project = createEmptyProject('fades')
project.canvas = { width: 320, height: 240, fps: 30 }
const asset: MediaAsset = { id: 'a', path: src, kind: 'video', name: 'src.mp4', duration: 4, width: 320, height: 240, hasAudio: true }
project.assets = [asset]
const track = project.tracks.find((t) => t.type === 'video')!
const clip: MediaClip = { id: 'c', kind: 'media', trackId: track.id, start: 0, duration: 4, assetId: 'a', trimIn: 0, trimOut: 4, volume: 1, muted: false, speed: 1, reversed: false, frozen: false, transform: defaultTransform(), fadeIn: 1, fadeOut: 1 }
track.clips = [clip]
const out = path.join(dir, 'out.mp4')
run(planToFfmpegArgs(buildFfmpegPlan(project), out))

const lumas = [...run(['-i', out, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']).stderr.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]))
const level = (ss: number) => Number(/mean_volume: (-?[\d.]+) dB/.exec(run(['-ss', String(ss), '-t', '0.2', '-i', out, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).stderr)?.[1])
const checks: [string, boolean][] = [
  [`frame count ${lumas.length} ≈ 120`, Math.abs(lumas.length - 120) <= 2],
  [`first frame black (Y ${lumas[0]?.toFixed(0)})`, lumas[0] < 25],
  [`half-way into fade-in (Y ${lumas[15]?.toFixed(0)}) between`, lumas[15] > lumas[0] + 10 && lumas[15] < lumas[60] - 10],
  [`middle full (Y ${lumas[60]?.toFixed(0)})`, lumas[60] > 100],
  [`last frame black (Y ${lumas[lumas.length - 1]?.toFixed(0)})`, lumas[lumas.length - 1] < 25],
  [`audio quiet at start (${level(0).toFixed(1)} dB) vs middle (${level(1.9).toFixed(1)} dB)`, level(0) < level(1.9) - 10],
  [`audio quiet at end (${level(3.8).toFixed(1)} dB)`, level(3.8) < level(1.9) - 10]
]
let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed++
}
process.exit(failed ? 1 : 0)
