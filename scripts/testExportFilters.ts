/** Smoke test: every Filter exports through ffmpeg's lut3d with the same colours the preview's
 *  LUT computes (shared/filters.ts gradeColor), proving the Rec. 709 RGB round-trip is right.
 *  npx tsx scripts/testExportFilters.ts */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { FILTER_CATALOG, gradeColor } from '../src/shared/filters'
import { createEmptyProject, defaultTransform, type MediaClip } from '../src/shared/types'

const dir = process.env.ANYCUT_TEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'anycut-filters-'))
fs.mkdirSync(dir, { recursive: true })
const ff = (args: string[]) => spawnSync(ffmpegPath as string, args, { maxBuffer: 1 << 26 })
const SRC_RGB: [number, number, number] = [196, 132, 98]
// A flat skin-tone PNG (decoded as RGB, so no matrix guesswork on the input side).
const png = path.join(dir, 'flat.png')
ff(['-y', '-f', 'lavfi', '-i', `color=c=0x${SRC_RGB.map((v) => v.toString(16).padStart(2, '0')).join('')}:size=320x240`, '-frames:v', '1', png])

// The real decoded pixel (lavfi's colour source rounds through YUV).
const srcPx = [...ff(['-v', 'error', '-i', png, '-vf', 'crop=2:2:100:100,format=rgb24', '-f', 'rawvideo', '-']).stdout.subarray(0, 3)]

let failed = 0
for (const def of FILTER_CATALOG) {
  const p = createEmptyProject('f')
  p.canvas = { width: 320, height: 240, fps: 30 }
  p.assets = [{ id: 'i', path: png, kind: 'image', name: 'i', duration: 0, width: 320, height: 240, hasAudio: false }]
  const v = p.tracks.find((t) => t.type === 'video')!
  const clip: MediaClip = { id: 'c', kind: 'media', trackId: v.id, start: 0, duration: 1, assetId: 'i', trimIn: 0, trimOut: 1, volume: 0, muted: true, speed: 1, reversed: false, frozen: false, transform: defaultTransform(), filter: { id: def.id, intensity: 1 } }
  v.clips = [clip]
  const plan = buildFfmpegPlan(p, { lutDir: dir })
  for (const f of plan.files ?? []) fs.writeFileSync(f.path, f.content)
  const out = path.join(dir, `${def.id}.mp4`)
  const r = ff(['-y', ...planToFfmpegArgs(plan, out)])
  if (r.status !== 0) {
    console.log(`FAIL ${def.id}: ffmpeg\n${r.stderr.toString().split('\n').slice(-8).join('\n')}`)
    failed++
    continue
  }
  // Average a central 16x16 block (grain averages out) and decode with the 709 matrix.
  const raw = ff(['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-vf', 'crop=16:16:152:112,scale=1:1:flags=area:in_color_matrix=bt709:in_range=tv,format=rgb24', '-f', 'rawvideo', '-']).stdout
  const got = [...raw.subarray(0, 3)]
  const want = gradeColor(def, [srcPx[0] / 255, srcPx[1] / 255, srcPx[2] / 255], 1).map((x) => Math.round(x * 255))
  const err = Math.max(...got.map((g, i) => Math.abs(g - want[i])))
  const ok = err <= 8
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${def.label.padEnd(18)} want ${want.join(',').padEnd(12)} got ${got.join(',').padEnd(12)} (max err ${err})`)
}
process.exit(failed ? 1 : 0)
