import { describe, expect, it, vi } from 'vitest'

// proxy.ts imports electron indirectly via cache.ts; stub it so the pure planner can be tested.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { planProxy } = await import('./proxy')

describe('planProxy (cheapest way to make a source previewable)', () => {
  it('needs nothing for browser-playable codecs in a browser-friendly container', () => {
    expect(planProxy('.mp4', 'h264', 'aac')).toBe('none')
    expect(planProxy('.MOV', 'hevc', 'aac')).toBe('none')
    expect(planProxy('.webm', 'vp9', 'opus')).toBe('none')
  })

  it('remuxes (lossless) when the codecs are fine but the container is not', () => {
    expect(planProxy('.mkv', 'h264', 'aac')).toBe('remux')
    expect(planProxy('.avi', 'mpeg4', 'mp3')).toBe('remux')
  })

  it('transcodes when the video or audio codec itself is undecodable', () => {
    expect(planProxy('.mov', 'prores', 'pcm_s16le')).toBe('transcode')
    expect(planProxy('.mkv', 'h264', 'ac3')).toBe('transcode')
  })

  it('never proxies still images', () => {
    expect(planProxy('.png')).toBe('none')
    expect(planProxy('.JPG')).toBe('none')
  })
})
