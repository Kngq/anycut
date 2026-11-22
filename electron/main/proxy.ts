import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { ffmpegPath } from './binaries'
import { colorConversionFilters, REC709_OUTPUT_ARGS } from '@shared/ffmpegGraph'
import { probeMedia } from './probe'
import { cacheKey, dedupe, entryPath, fileExists, stampSource, touchEntry, writeMeta } from './cache'

/**
 * Preview-only stand-ins for media Chromium can't play (CapCut calls these "agency" files, from
 * 代理 = proxy). Export never uses them; it always reads the original.
 *
 * Codecs Chromium's <video>/<audio> can actually decode (verified on this machine: h264 plays
 * directly, and hevc too via hardware-accelerated decode, though hevc support varies by
 * platform). Everything else (ProRes, DNxHD, Apple Intermediate Codec, ...) demuxes "fine" but
 * never produces a decodable frame: no error event, just videoWidth/videoHeight stuck at 0.
 *
 * Two tiers, cheapest first (mirrors CapCut's RemuxCache before agencycache):
 *  1. REMUX (`-c copy`, lossless, seconds): playable streams in a container Chromium won't open
 *     (.mkv/.avi with h264/aac). Just re-wraps the existing streams into MP4.
 *  2. TRANSCODE to a 720p H.264 proxy: the codec itself isn't decodable. CapCut defaults its proxies
 *     to 720p too. That's plenty for preview and several times faster to encode than full res.
 */
const SAFE_VIDEO_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'theora'])
const SAFE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'pcm_s16le', 'pcm_s24le', 'flac'])
/** Containers Chromium's media stack opens directly. */
const SAFE_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'])
/** Stills are drawn by <img>, never through <video>, so they never need a proxy. */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

const PROXY_HEIGHT = 720

export type ProxyPlan = 'none' | 'remux' | 'transcode'

/** Decides the cheapest way to make a source playable in the preview. Pure; unit-testable. */
export function planProxy(ext: string, videoCodec?: string, audioCodec?: string): ProxyPlan {
  const e = ext.toLowerCase()
  if (IMAGE_EXTS.has(e)) return 'none'
  const codecBad = (videoCodec && !SAFE_VIDEO_CODECS.has(videoCodec)) || (audioCodec && !SAFE_AUDIO_CODECS.has(audioCodec))
  if (codecBad) return 'transcode'
  if (!SAFE_CONTAINERS.has(e)) return 'remux'
  return 'none'
}

function extOf(p: string): string {
  const i = p.lastIndexOf('.')
  return i >= 0 ? p.slice(i) : ''
}

export async function ensurePreviewProxy(filePath: string, videoCodec?: string, audioCodec?: string): Promise<string | null> {
  if (!ffmpegPath) return null
  const plan = planProxy(extOf(filePath), videoCodec, audioCodec)
  if (plan === 'none') return null

  const src = await stampSource(filePath)
  if (!src) return null
  const kind = plan === 'remux' ? 'remux' : 'proxies'
  const key = cacheKey(kind, src)
  return dedupe(`${kind}:${key}`, () => buildProxy(filePath, plan, kind, key, src))
}

async function buildProxy(
  filePath: string,
  plan: Exclude<ProxyPlan, 'none'>,
  kind: 'remux' | 'proxies',
  key: string,
  src: NonNullable<Awaited<ReturnType<typeof stampSource>>>
): Promise<string | null> {
  const outPath = await entryPath(kind, key, '.mp4')
  if (await fileExists(outPath)) {
    void touchEntry(outPath)
    return outPath
  }

  const tmpPath = `${outPath}.tmp.mp4`
  const args =
    plan === 'remux'
      ? // Lossless: copy streams, move the moov atom up front so the preview can seek right away.
        ['-y', '-i', filePath, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', tmpPath]
      : [
          '-y',
          '-i',
          filePath,
          // Downscale to 720p (never upscale), keep aspect, even dimensions.
          '-vf',
          // HDR sources are tone-mapped like export, so the proxy (an 8-bit SDR file) isn't washed out.
          `scale=-2:'min(${PROXY_HEIGHT},ih)',${colorConversionFilters((await probeMedia(filePath))?.color)}null`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          ...REC709_OUTPUT_ARGS,
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          tmpPath
        ]
  try {
    await runFfmpeg(args)
    await fs.rename(tmpPath, outPath)
    await writeMeta(kind, key, src)
    return outPath
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {})
    // A remux can fail on oddball streams; fall back to a real transcode rather than giving up.
    if (plan === 'remux') {
      const tKey = cacheKey('proxies', src)
      return dedupe(`proxies:${tKey}`, () => buildProxy(filePath, 'transcode', 'proxies', tKey, src))
    }
    console.error('[anycut] preview proxy generation failed for', filePath, err)
    return null
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args)
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))))
  })
}
