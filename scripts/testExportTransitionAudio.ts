/** Smoke test: audio across a main-roll transition. Two clips with different sine tones
 *  (440 Hz, 880 Hz), 3 s each, joined by a 1 s crossfade, must export as 5 s of video AND 5 s of
 *  audio with no silent gap or dip at the transition: the outgoing tone fades out while the
 *  incoming one fades in (equal power), so the loudness stays level throughout.
 *    npx tsx scripts/testExportTransitionAudio.ts */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { createEmptyProject, defaultTransform, type MediaAsset, type MediaClip } from '../src/shared/types'

const WORKDIR = process.env.ANYCUT_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'anycut-xfade-audio-'))
fs.mkdirSync(WORKDIR, { recursive: true })
const ff = ffmpegPath as string

function run(args: string[], label: string): string {
  const res = spawnSync(ff, args, { encoding: 'utf-8' })
  if (res.status !== 0) {
    console.error(`FAILED (${label}):\n`, res.stderr?.split('\n').slice(-30).join('\n'))
    process.exit(1)
  }
  return res.stderr + res.stdout
}

function tone(file: string, color: string, freq: number) {
  run(
    ['-y', '-f', 'lavfi', '-i', `color=c=${color}:size=320x240:rate=30:duration=3`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=3:sample_rate=48000`, '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest', file],
    `generate ${path.basename(file)}`
  )
}
const fileA = path.join(WORKDIR, 'toneA.mp4')
const fileB = path.join(WORKDIR, 'toneB.mp4')
tone(fileA, 'red', 440)
tone(fileB, 'blue', 880)

const project = createEmptyProject('transition-audio')
project.canvas = { width: 320, height: 240, fps: 30 }
const assetA: MediaAsset = { id: 'a', path: fileA, kind: 'video', name: 'toneA.mp4', duration: 3, width: 320, height: 240, hasAudio: true }
const assetB: MediaAsset = { id: 'b', path: fileB, kind: 'video', name: 'toneB.mp4', duration: 3, width: 320, height: 240, hasAudio: true }
project.assets = [assetA, assetB]
const track = project.tracks.find((t) => t.type === 'video')!
const common = { kind: 'media', trackId: track.id, duration: 3, trimIn: 0, trimOut: 3, volume: 1, muted: false, speed: 1, reversed: false, frozen: false, transform: defaultTransform() } as const
const c1: MediaClip = { ...common, id: 'c1', start: 0, assetId: 'a' }
// Repacked position: 3 s - 1 s crossfade.
const c2: MediaClip = { ...common, id: 'c2', start: 2, assetId: 'b', transitionIn: { type: 'crossfade', duration: 1 } }
track.clips = [c1, c2]

const plan = buildFfmpegPlan(project)
console.log('filter_complex:\n', plan.filterComplex)
const out = path.join(WORKDIR, 'out.mp4')
run(planToFfmpegArgs(plan, out), 'export')

/** Duration (s) of one stream type, decoded fully (not trusting container metadata). */
function streamDuration(kind: 'v' | 'a'): number {
  const log = run(['-i', out, '-map', `0:${kind}`, '-f', 'null', '-'], `decode ${kind}`)
  const times = [...log.matchAll(/time=(\d+):(\d+):([\d.]+)/g)]
  const m = times[times.length - 1]
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}
const vDur = streamDuration('v')
const aDur = streamDuration('a')
console.log(`video ${vDur.toFixed(3)} s, audio ${aDur.toFixed(3)} s (expected 5)`)
if (Math.abs(vDur - 5) > 0.1) throw new Error(`video duration ${vDur} != 5`)
if (Math.abs(aDur - vDur) > 0.1) throw new Error(`audio duration ${aDur} doesn't match video ${vDur}`)

/** RMS level (dB) of the audio in 0.1 s windows, optionally band-passed around one tone. */
function rmsWindows(band?: number): number[] {
  const bp = band ? `bandpass=f=${band}:width_type=q:w=8,` : ''
  const log = run(['-i', out, '-vn', '-af', `aresample=48000,${bp}asetnsamples=n=4800:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, '-f', 'null', '-'], 'rms')
  return [...log.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === '-inf' ? -200 : Number(m[1])))
}
const all = rmsWindows()
const lo440 = rmsWindows(440)
const hi880 = rmsWindows(880)
// Skip the first/last window (AAC priming / tail).
const inner = all.slice(1, -1)
const max = Math.max(...inner)
const min = Math.min(...inner)
console.log(`overall RMS per 0.1 s: min ${min.toFixed(1)} dB, max ${max.toFixed(1)} dB over ${inner.length} windows`)
console.log('around the transition (1.5..3.5 s):', all.slice(15, 36).map((v) => v.toFixed(1)).join(' '))
// A gap/cut shows as a dip; both clips at full volume (no crossfade) as a +3 dB bump.
if (max - min > 1.5) throw new Error(`audio level varies by ${(max - min).toFixed(1)} dB (gap, cut or un-faded overlap at the transition?)`)

const at = (arr: number[], s: number) => arr[Math.round(s * 10)]
console.log(`440 Hz band: 1.0s ${at(lo440, 1).toFixed(1)}, 2.5s ${at(lo440, 2.5).toFixed(1)}, 4.0s ${at(lo440, 4).toFixed(1)} dB`)
console.log(`880 Hz band: 1.0s ${at(hi880, 1).toFixed(1)}, 2.5s ${at(hi880, 2.5).toFixed(1)}, 4.0s ${at(hi880, 4).toFixed(1)} dB`)
// Mid-transition both tones are audible (about -3 dB each, equal power); outside it only one.
if (!(at(lo440, 2.5) > at(lo440, 1) - 6 && at(hi880, 2.5) > at(hi880, 4) - 6)) throw new Error('both tones should be audible mid-transition')
if (!(at(lo440, 4) < at(lo440, 1) - 20)) throw new Error('outgoing tone still audible after the transition')
if (!(at(hi880, 1) < at(hi880, 4) - 20)) throw new Error('incoming tone audible before the transition')
console.log('PASS')
