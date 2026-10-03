import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export async function findAvailablePort(preferredPort = 5679) {
  const canListen = port => new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(Number(address?.port || 0) > 0))
    })
  })
  if (preferredPort > 0 && await canListen(preferredPort)) return preferredPort
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = Number(address?.port || 0)
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

export function replaceAsarWithUnpacked(filePath) {
  const marker = `${path.sep}app.asar${path.sep}`
  const replacement = `${path.sep}app.asar.unpacked${path.sep}`
  return filePath.includes(marker) ? filePath.replace(marker, replacement) : filePath
}

export function isExecutableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

export function applyBundledMediaEnvironment(env, media) {
  for (const [key, value] of [
    ['FFMPEG_PATH', media?.ffmpeg],
    ['FFPROBE_PATH', media?.ffprobe],
  ]) {
    const normalized = String(value || '').trim()
    if (normalized) env[key] = normalized
    else delete env[key]
  }
  return env
}
