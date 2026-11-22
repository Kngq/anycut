import type { Project, Track } from './types'

/**
 * Timeline rows top to bottom, laid out like CapCut: layers that draw on top sit higher.
 * Text and caption tracks first (the last one in the project draws on top, so it is shown
 * highest), then overlay video tracks (same rule), then the main video track, then audio.
 * This only changes how rows are shown. `project.tracks` order still decides compositing
 * (first video track = main track, later tracks of a type draw over earlier ones).
 */
export function displayTracks(project: Pick<Project, 'tracks'>): Track[] {
  const video = project.tracks.filter((t) => t.type === 'video')
  const text = project.tracks.filter((t) => t.type === 'text')
  const audio = project.tracks.filter((t) => t.type === 'audio')
  return [...[...text].reverse(), ...video.slice(1).reverse(), ...video.slice(0, 1), ...audio]
}
