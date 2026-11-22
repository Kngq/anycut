import { describe, expect, it } from 'vitest'
import { displayTracks } from './trackOrder'
import type { Track, TrackType } from './types'

const t = (id: string, type: TrackType): Track => ({ id, type, name: id, clips: [], muted: false, hidden: false })

describe('displayTracks', () => {
  it('puts text and captions above the video, overlays above the main track, audio below', () => {
    const tracks = [t('v1', 'video'), t('a1', 'audio'), t('t1', 'text'), t('v2', 'video'), t('a2', 'audio'), t('cap', 'text')]
    expect(displayTracks({ tracks }).map((x) => x.id)).toEqual(['cap', 't1', 'v2', 'v1', 'a1', 'a2'])
  })
  it('keeps every track exactly once', () => {
    const tracks = [t('a1', 'audio'), t('v1', 'video')]
    expect(displayTracks({ tracks }).map((x) => x.id)).toEqual(['v1', 'a1'])
  })
})
