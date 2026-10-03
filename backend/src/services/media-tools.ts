import ffmpeg from 'fluent-ffmpeg'
import fs from 'node:fs'
import path from 'node:path'

export function resolveMediaBinary(value: string | undefined, fallback: string) {
  const normalized = value?.trim()
  return normalized || fallback
}

/**
 * Desktop builds inject an absolute path to the unpacked static binary. Older
 * builds can leave that path in the environment after an update, even when
 * the file no longer exists. Prefer the current Electron resources copy and
 * finally the system command instead of failing tail-frame post-processing
 * with ENOENT.
 */
export function resolveRuntimeMediaBinary(value: string | undefined, fallback: string, bundledName: string) {
  const normalized = value?.trim()
  if (normalized && fs.existsSync(normalized)) return normalized

  const resourcesRoot = String((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || '').trim()
  if (resourcesRoot) {
    const bundled = path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', bundledName)
    if (fs.existsSync(bundled)) return bundled
  }

  return fallback
}

export function getFfmpegBinary() {
  return resolveRuntimeMediaBinary(process.env.FFMPEG_PATH, 'ffmpeg', path.join('ffmpeg-static', 'ffmpeg.exe'))
}

export function getFfprobeBinary() {
  return resolveRuntimeMediaBinary(process.env.FFPROBE_PATH, 'ffprobe', path.join('ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'))
}

export const FFMPEG_BINARY = getFfmpegBinary()
export const FFPROBE_BINARY = getFfprobeBinary()

export function configureMediaTools() {
  ffmpeg.setFfmpegPath(getFfmpegBinary())
  ffmpeg.setFfprobePath(getFfprobeBinary())
}
