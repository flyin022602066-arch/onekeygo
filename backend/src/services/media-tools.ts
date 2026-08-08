import ffmpeg from 'fluent-ffmpeg'

export function resolveMediaBinary(value: string | undefined, fallback: string) {
  const normalized = value?.trim()
  return normalized || fallback
}

export const FFMPEG_BINARY = resolveMediaBinary(process.env.FFMPEG_PATH, 'ffmpeg')
export const FFPROBE_BINARY = resolveMediaBinary(process.env.FFPROBE_PATH, 'ffprobe')

export function configureMediaTools() {
  ffmpeg.setFfmpegPath(FFMPEG_BINARY)
  ffmpeg.setFfprobePath(FFPROBE_BINARY)
}
