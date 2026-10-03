import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(scriptDirectory, '..')
const projectRoot = path.resolve(desktopRoot, '..')
const runtimeRoot = path.join(desktopRoot, 'runtime')

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true })
  await fs.cp(source, destination, { recursive: true, force: true })
}

async function removeTestArtifacts(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test') {
        await fs.rm(entryPath, { recursive: true, force: true })
        continue
      }
      await removeTestArtifacts(entryPath)
      continue
    }
    if (/\.test\.[cm]?js$|\.spec\.[cm]?js$/i.test(entry.name)) await fs.rm(entryPath, { force: true })
  }
}

async function requireDirectory(directory, description) {
  try {
    const stat = await fs.stat(directory)
    if (!stat.isDirectory()) throw new Error()
  } catch {
    throw new Error(`${description} is missing: ${directory}`)
  }
}

async function rewriteRelativeImports(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await rewriteRelativeImports(entryPath)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    const source = await fs.readFile(entryPath, 'utf8')
    const rewritten = source.replace(/(from\s+|import\s*\(\s*)(['"])(\.\.?\/[^'"]+)\2/g, (match, prefix, quote, specifier) => {
      if (path.extname(specifier)) return match
      const candidate = path.resolve(path.dirname(entryPath), specifier)
      return (fileExists(`${candidate}.js`) ? `${prefix}${quote}${specifier}.js${quote}` : match)
    })
    if (rewritten !== source) await fs.writeFile(entryPath, rewritten, 'utf8')
  }
}

function fileExists(filePath) {
  try {
    return fsSync.statSync(filePath).isFile()
  } catch {
    return false
  }
}

await fs.rm(runtimeRoot, { recursive: true, force: true })
await requireDirectory(path.join(projectRoot, 'backend', 'dist'), 'Backend build output')
await requireDirectory(path.join(projectRoot, 'frontend', '.output', 'public'), 'Frontend static output')
await requireDirectory(path.join(projectRoot, 'skills'), 'Agent skills')

await copyDirectory(path.join(projectRoot, 'backend', 'dist'), path.join(runtimeRoot, 'backend', 'dist'))
await fs.copyFile(path.join(projectRoot, 'backend', 'package.json'), path.join(runtimeRoot, 'backend', 'package.json'))
await copyDirectory(path.join(projectRoot, 'frontend', '.output', 'public'), path.join(runtimeRoot, 'frontend', 'dist'))
for (const iconName of ['favicon.ico', 'favicon.png']) {
  const sourceIcon = path.join(projectRoot, 'frontend', 'public', iconName)
  if (fileExists(sourceIcon)) await fs.copyFile(sourceIcon, path.join(runtimeRoot, 'frontend', 'dist', iconName))
}
const appIcon = path.join(projectRoot, 'frontend', 'public', 'eggfans-logo.png')
if (fileExists(appIcon)) await fs.copyFile(appIcon, path.join(runtimeRoot, 'app-icon.png'))
await copyDirectory(path.join(projectRoot, 'configs'), path.join(runtimeRoot, 'configs'))
await copyDirectory(path.join(projectRoot, 'skills'), path.join(runtimeRoot, 'skills'))
await removeTestArtifacts(path.join(runtimeRoot, 'backend', 'dist'))
await rewriteRelativeImports(path.join(runtimeRoot, 'backend', 'dist'))

console.log(`Prepared desktop runtime at ${runtimeRoot}`)
