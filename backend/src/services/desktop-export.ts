import fs from 'fs'
import os from 'os'
import path from 'path'
import { appConfig } from '../config.js'

type CopyOptions = {
  storageRoot?: string
  desktopDir?: string
  now?: Date
}

type ExportNameParts = {
  dramaTitle?: string | null
  episodeNumber?: number | null
  mergeId?: number | null
  storyboardNumber?: number | null
  videoGenerationId?: number | null
}

export function copyStaticVideoToDesktop(
  staticPath: string,
  nameParts: ExportNameParts = {},
  options: CopyOptions = {},
) {
  const sourcePath = resolveStaticVideoPath(staticPath, options.storageRoot)
  if (!fs.existsSync(sourcePath)) {
    throw new Error('成片文件不存在，请重新拼接后再保存到桌面')
  }

  const desktopDir = options.desktopDir || path.join(os.homedir(), 'Desktop')
  fs.mkdirSync(desktopDir, { recursive: true })

  const filename = buildDesktopVideoFilename(nameParts, path.extname(sourcePath), options.now)
  const targetPath = uniqueTargetPath(path.join(desktopDir, filename))
  fs.copyFileSync(sourcePath, targetPath)

  return {
    desktopPath: targetPath,
    fileName: path.basename(targetPath),
  }
}

export function resolveStaticVideoPath(staticPath: string, storageRoot = appConfig.storage.localPath) {
  const raw = String(staticPath || '').trim().replace(/^\/+/, '')
  if (!raw.startsWith('static/')) {
    throw new Error('当前成片不是本地文件，无法直接保存到桌面')
  }

  const relativePath = raw.slice('static/'.length)
  if (!relativePath || relativePath.includes('\0')) {
    throw new Error('成片路径无效')
  }

  const root = path.resolve(storageRoot)
  const sourcePath = path.resolve(root, relativePath)
  if (sourcePath !== root && !sourcePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('成片路径越界，已拒绝保存')
  }

  return sourcePath
}

export function buildDesktopVideoFilename(
  parts: ExportNameParts = {},
  sourceExt = '.mp4',
  now = new Date(),
) {
  const title = sanitizeFilenamePart(parts.dramaTitle || 'Eggfans短剧')
  const episode = parts.episodeNumber ? `第${parts.episodeNumber}集` : ''
  const item = parts.storyboardNumber
    ? `镜头${parts.storyboardNumber}`
    : parts.mergeId
      ? `成片${parts.mergeId}`
      : '成片'
  const generation = parts.videoGenerationId ? `视频${parts.videoGenerationId}` : ''
  const stamp = formatTimestamp(now)
  const ext = normalizeVideoExt(sourceExt)

  return [title, episode, item, generation, stamp].filter(Boolean).join('-') + ext
}

export function pickExportableStoryboardVideo<T extends {
  id?: number | null
  status?: string | null
  localPath?: string | null
  videoUrl?: string | null
}>(rows: T[], preferredId?: number | null): T | null {
  const latest = rows
    .filter(row => !('deletedAt' in row) || !(row as any).deletedAt)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0]
  const completed = latest && String(latest.status || '').toLowerCase() === 'completed' ? [latest] : []
  if (!completed.length) return null

  const preferred = preferredId
    ? completed.find(row => Number(row.id || 0) === Number(preferredId))
    : null
  if (preferred && getLocalVideoPath(preferred)) return preferred

  return completed.find(row => !!getLocalVideoPath(row)) || preferred || completed[0] || null
}

export function getLocalVideoPath(row: { localPath?: string | null; videoUrl?: string | null }) {
  const localPath = String(row.localPath || '').trim()
  if (localPath) return localPath
  const videoUrl = String(row.videoUrl || '').trim()
  return videoUrl.startsWith('static/') ? videoUrl : ''
}

function uniqueTargetPath(targetPath: string) {
  if (!fs.existsSync(targetPath)) return targetPath
  const dir = path.dirname(targetPath)
  const ext = path.extname(targetPath)
  const base = path.basename(targetPath, ext)
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(dir, `${base}-${i}${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error('桌面同名文件过多，请清理后重试')
}

function sanitizeFilenamePart(value: string) {
  const clean = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (clean || 'Eggfans短剧').slice(0, 60)
}

function normalizeVideoExt(ext: string) {
  const clean = String(ext || '').toLowerCase()
  if (/^\.[a-z0-9]{1,8}$/.test(clean)) return clean
  return '.mp4'
}

function formatTimestamp(now: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
  ].join('')
}
