/**
 * Regression check for black/blank frames in export for clips whose time mapping isn't a plain
 * 1x forward play: reversed, speed curve (16 sampled segments), reversed + curve, flat speed,
 * freeze, and split pieces with transitions. testsrc2 never has a dark frame, so any frame whose
 * mean luma drops near black is a defect.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { sampleSpeedCurve, speedCurvePreset } from '../src/shared/speedCurve'
import { createEmptyProject, defaultTransform, effectiveDuration, type MediaAsset, type MediaClip } from '../src/shared/types'

const WORKDIR = process.env.ANYCUT_TEST_DIR || path.join(os.tmpdir(), 'anycut-export-noblack')
fs.mkdirSync(WORKDIR, { recursive: true })
const ff = ffmpegPath as string

function run(args: string[], label: string) {
  const res = spawnSync(ff, args, { encoding: 'utf-8' })
  if (res.status !== 0) {
    console.error(`FAILED (${label}):\n`, res.stderr?.split('\n').slice(-30).join('\n'))
    process.exit(1)
  }
  return res
}

const source = path.join(WORKDIR, 'source.mp4')
run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-g', '60', '-c:a', 'aac', '-pix_fmt', 'yuv420p', source], 'source')

const asset: MediaAsset = { id: 'a', path: source, kind: 'video', name: 'source.mp4', duration: 6, width: 320, height: 240, hasAudio: true }

function clipWith(id: string, patch: Partial<MediaClip>): MediaClip {
  const c: MediaClip = {
    id, kind: 'media', trackId: '', start: 0, duration: 0, assetId: 'a', trimIn: 0, trimOut: 6,
    volume: 1, muted: false, speed: 1, reversed: false, frozen: false, transform: defaultTransform(), ...patch
  }
  c.duration = c.frozen ? 1.5 : effectiveDuration(c)
  return c
}

const curve = (preset: string, trimIn = 0, trimOut = 6) => ({ speedKeyframes: sampleSpeedCurve(speedCurvePreset(preset)!.points, trimIn, trimOut), speedCurvePreset: preset as never })

const cases: Array<[string, MediaClip[]]> = [
  ['reversed', [clipWith('r', { reversed: true })]],
  ['curve-montage', [clipWith('c', curve('montage'))]],
  ['curve-bullet', [clipWith('c', curve('bullet'))]],
  ['curve-flashin', [clipWith('c', curve('flashin'))]],
  ['reversed+curve', [clipWith('rc', { reversed: true, ...curve('hero') })]],
  ['speed-2x', [clipWith('s', { speed: 2 })]],
  ['speed-0.5x', [clipWith('s', { speed: 0.5, trimOut: 3 })]],
  ['split-reversed', [clipWith('p1', { trimIn: 0, trimOut: 2.5, reversed: true }), clipWith('p2', { trimIn: 2.5, trimOut: 6, reversed: true })]],
  ['curve-then-reversed', [clipWith('c', curve('jumpcut', 0, 3)), clipWith('r', { trimIn: 3, trimOut: 6, reversed: true })]],
  ['freeze-between', [clipWith('a1', { trimOut: 2 }), clipWith('f', { frozen: true, trimIn: 2, trimOut: 2 }), clipWith('a2', { trimIn: 2, trimOut: 4 })]]
]

let failed = 0
for (const [name, clips] of cases) {
  const project = createEmptyProject('noblack-' + name)
  project.canvas = { width: 320, height: 240, fps: 30 }
  project.assets = [asset]
  const track = project.tracks.find((t) => t.type === 'video')!
  let start = 0
  for (const c of clips) {
    c.trackId = track.id
    c.start = start
    start += c.duration
  }
  track.clips = clips
  const out = path.join(WORKDIR, `${name}.mp4`)
  const plan = buildFfmpegPlan(project)
  run(planToFfmpegArgs(plan, out), `export ${name}`)
  const probe = spawnSync(ff, ['-i', out, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { encoding: 'utf-8' })
  const lumas = [...probe.stderr.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]))
  const dark = lumas.map((y, i) => [i, y] as const).filter(([, y]) => y < 40)
  const expectFrames = Math.round(start * 30)
  const okCount = Math.abs(lumas.length - expectFrames) <= 2
  if (dark.length || !okCount) {
    failed++
    console.log(`FAIL ${name}: ${lumas.length} frames (expected ~${expectFrames}), dark frames: ${dark.slice(0, 10).map(([i, y]) => `#${i}=${y.toFixed(0)}`).join(' ')}${dark.length > 10 ? ' …' : ''}`)
  } else {
    console.log(`ok   ${name}: ${lumas.length} frames, min luma ${Math.min(...lumas).toFixed(0)}`)
  }
}
if (failed) process.exit(1)
