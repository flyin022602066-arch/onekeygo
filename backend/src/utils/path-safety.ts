import path from 'path'

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function normalizeRelativeId(id: string): string {
  const trimmed = id.trim()
  if (trimmed.startsWith('/') || path.isAbsolute(trimmed)) throw new Error('Invalid path id')
  const normalized = trimmed.replace(/^\/+|\/+$/g, '')
  if (!normalized) throw new Error('Invalid path id')
  if (normalized.includes('\\') || path.isAbsolute(normalized)) throw new Error('Invalid path id')

  const segments = normalized.split('/')
  if (segments.some(segment => segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment))) {
    throw new Error('Invalid path id')
  }

  return segments.join('/')
}

export function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath)
  const relative = path.relative(root, target)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return target
  }
  throw new Error('Path escapes root')
}
