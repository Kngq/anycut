/** Smoke test: Speed > "Change audio pitch". A 440 Hz tone at 2x must export at ~880 Hz with
 *  the toggle on (asetrate) and stay ~440 Hz with it off (atempo).  npx tsx scripts/testExportPitch.ts */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { createEmptyProject, defaultTransform, type MediaClip } from '../src/shared/types'

const dir = process.env.ANYCUT_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'anycut-pitch-'))
fs.mkdirSync(dir, { recursive: true })
const ff = (args: string[]) => spawnSync(ffmpegPath as string, args, { maxBuffer: 1 << 28 })
const src = path.join(dir, 'tone.mp4')
ff(['-y', '-f', 'lavfi', '-i', 'color=c=gray:size=160x120:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest', src])

function exportAt(changeAudioPitch: boolean): number {
  const p = createEmptyProject('pitch')
  p.canvas = { width: 160, height: 120, fps: 30 }
  p.assets = [{ id: 't', path: src, kind: 'video', name: 't', duration: 4, width: 160, height: 120, hasAudio: true }]
  const v = p.tracks.find((t) => t.type === 'video')!
  const clip: MediaClip = { id: 'c', kind: 'media', trackId: v.id, start: 0, duration: 2, assetId: 't', trimIn: 0, trimOut: 4, volume: 1, muted: false, speed: 2, reversed: false, frozen: false, transform: defaultTransform(), changeAudioPitch }
  v.clips = [clip]
  const out = path.join(dir, `out-${changeAudioPitch}.mp4`)
  const r = ff(['-y', ...planToFfmpegArgs(buildFfmpegPlan(p), out)])
  if (r.status !== 0) throw new Error(r.stderr.toString().split('\n').slice(-15).join('\n'))
  const pcm = ff(['-v', 'error', '-ss', '0.3', '-t', '1', '-i', out, '-ac', '1', '-ar', '48000', '-f', 's16le', '-']).stdout
  let crossings = 0
  let prev = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i)
    if (prev < 0 && v >= 0) crossings++
    prev = v
  }
  return crossings / (pcm.length / 2 / 48000)
}

const on = exportAt(true)
const off = exportAt(false)
console.log(`pitch on: ${on.toFixed(0)} Hz, pitch off: ${off.toFixed(0)} Hz`)
const ok = Math.abs(on - 880) < 30 && Math.abs(off - 440) < 20
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
