/**
 * Paths to the bundled ffmpeg / ffprobe executables. The *-static packages report a path inside
 * node_modules; in a packaged build that's inside app.asar, which can't be executed, so the
 * binaries ship unpacked (electron-builder `asarUnpack`) and the path is rewritten to
 * app.asar.unpacked.
 */
import ffmpegStatic from 'ffmpeg-static'
// @ts-expect-error - no types published
import ffprobeStatic from 'ffprobe-static'

const unpacked = (p: string) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

export const ffmpegPath: string | null = ffmpegStatic ? unpacked(ffmpegStatic as unknown as string) : null
export const ffprobePath: string = unpacked((ffprobeStatic as { path: string }).path)
