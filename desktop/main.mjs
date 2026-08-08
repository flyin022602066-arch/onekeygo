import { app, BrowserWindow, dialog, Menu, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findAvailablePort, replaceAsarWithUnpacked } from './runtime-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const DEFAULT_PORT = 5679
const HEALTH_TIMEOUT_MS = 90_000
let mainWindow = null
let backendUrl = ''
let logFile = ''

function writeLog(level, message, error) {
  if (!logFile) return
  const detail = error instanceof Error ? `${error.stack || error.message}` : error ? String(error) : ''
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${detail ? `\n${detail}` : ''}\n`
  try {
    fs.appendFileSync(logFile, line, 'utf8')
  } catch {
    // Logging must never prevent the app from starting or closing.
  }
}

function initializeLogging() {
  const logsDirectory = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logsDirectory, { recursive: true })
  logFile = path.join(logsDirectory, 'desktop.log')
  const originalConsole = { error: console.error, warn: console.warn, log: console.log }
  console.error = (...args) => {
    originalConsole.error(...args)
    writeLog('error', args.map(String).join(' '))
  }
  console.warn = (...args) => {
    originalConsole.warn(...args)
    writeLog('warn', args.map(String).join(' '))
  }
  console.log = (...args) => {
    originalConsole.log(...args)
    writeLog('info', args.map(String).join(' '))
  }
}

function getRuntimeRoot() {
  return path.join(app.getAppPath(), 'runtime')
}

function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function isVisibleOnDisplay(state) {
  if (!state || !Number.isFinite(state.x) || !Number.isFinite(state.y)) return false
  return screen.getAllDisplays().some(display => {
    const bounds = display.workArea
    return state.x < bounds.x + bounds.width && state.x + state.width > bounds.x
      && state.y < bounds.y + bounds.height && state.y + state.height > bounds.y
  })
}

function loadWindowState() {
  const fallback = { width: 1440, height: 920 }
  try {
    const state = JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf8'))
    const width = Math.max(1100, Math.min(3840, Number(state.width) || fallback.width))
    const height = Math.max(720, Math.min(2160, Number(state.height) || fallback.height))
    const candidate = { width, height, x: Number(state.x), y: Number(state.y) }
    return isVisibleOnDisplay(candidate) ? candidate : { width, height }
  } catch {
    return fallback
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized()) return
  const bounds = mainWindow.getBounds()
  fs.mkdirSync(path.dirname(getWindowStatePath()), { recursive: true })
  fs.writeFileSync(getWindowStatePath(), JSON.stringify(bounds, null, 2), 'utf8')
}

async function waitForHealth(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(2500) })
      if (response.ok) return
      lastError = new Error(`Health check returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Backend did not become ready: ${lastError?.message || 'timeout'}`)
}

function resolveBundledMediaPaths() {
  try {
    const ffmpegPath = replaceAsarWithUnpacked(require('ffmpeg-static'))
    const ffprobePath = replaceAsarWithUnpacked(require('ffprobe-static').path)
    return {
      ffmpeg: fs.existsSync(ffmpegPath) ? ffmpegPath : '',
      ffprobe: fs.existsSync(ffprobePath) ? ffprobePath : '',
    }
  } catch (error) {
    writeLog('warn', 'Bundled FFmpeg was not found; system PATH will be used.', error)
    return { ffmpeg: '', ffprobe: '' }
  }
}

function ensureUserDataLayout(runtimeRoot) {
  const userRoot = app.getPath('userData')
  const configRoot = path.join(userRoot, 'configs')
  const dataRoot = path.join(userRoot, 'data')
  const configPath = path.join(configRoot, 'config.yaml')
  fs.mkdirSync(configRoot, { recursive: true })
  fs.mkdirSync(path.join(dataRoot, 'static'), { recursive: true })
  if (!fs.existsSync(configPath)) {
    const examplePath = path.join(runtimeRoot, 'configs', 'config.example.yaml')
    fs.copyFileSync(examplePath, configPath)
  }
  return { userRoot, configPath, databasePath: path.join(dataRoot, 'eggfans_drama.db'), storagePath: path.join(dataRoot, 'static') }
}

async function startBundledBackend(runtimeRoot) {
  const storage = ensureUserDataLayout(runtimeRoot)
  const port = await findAvailablePort()
  const media = resolveBundledMediaPaths()
  process.env.NODE_ENV = 'production'
  process.env.CONFIG_PATH = storage.configPath
  process.env.DB_PATH = storage.databasePath
  process.env.STORAGE_PATH = storage.storagePath
  process.env.STORAGE_BASE_URL = `http://127.0.0.1:${port}/static`
  process.env.PORT = String(port)
  process.env.HOST = '127.0.0.1'
  process.env.CORS_ORIGINS = `http://127.0.0.1:${port}`
  process.env.SKILLS_PATH = path.join(runtimeRoot, 'skills')
  if (media.ffmpeg) process.env.FFMPEG_PATH = media.ffmpeg
  if (media.ffprobe) process.env.FFPROBE_PATH = media.ffprobe

  const backendEntry = path.join(runtimeRoot, 'backend', 'dist', 'index.js')
  if (!fs.existsSync(backendEntry)) throw new Error(`Bundled backend entry is missing: ${backendEntry}`)
  await import(pathToFileURL(backendEntry).href)
  backendUrl = `http://127.0.0.1:${port}`
  await waitForHealth(backendUrl)
  return backendUrl
}

function createApplicationMenu() {
  const template = [
    {
      label: 'File',
      submenu: [{ role: 'quit', label: 'Exit' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'resetZoom', label: 'Reset Zoom' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toggle Full Screen' },
      ],
    },
    {
      label: 'Help',
      submenu: [{
        label: 'Open Data Folder',
        click: () => shell.openPath(app.getPath('userData')),
      }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createMainWindow(url) {
  const state = loadWindowState()
  const iconPath = path.join(getRuntimeRoot(), 'app-icon.png')
  mainWindow = new BrowserWindow({
    ...state,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: '谜镜',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#101114',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  mainWindow.on('close', saveWindowState)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    try {
      const target = new URL(targetUrl)
      const allowed = backendUrl && target.origin === backendUrl
      if (!allowed && /^https?:$/i.test(target.protocol)) shell.openExternal(targetUrl)
    } catch (error) {
      writeLog('warn', `Rejected malformed external URL: ${targetUrl}`, error)
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (backendUrl && targetUrl.startsWith(backendUrl)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(targetUrl)) shell.openExternal(targetUrl)
  })
  mainWindow.loadURL(url)
}

async function start() {
  initializeLogging()
  createApplicationMenu()
  const devUrl = process.env.DESKTOP_DEV_URL
  backendUrl = process.env.DESKTOP_BACKEND_URL || ''
  if (!devUrl) backendUrl = await startBundledBackend(getRuntimeRoot())
  else await waitForHealth(backendUrl)
  createMainWindow(devUrl || backendUrl)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.whenReady().then(start).catch(error => {
    writeLog('error', 'Failed to start 谜镜 Studio.', error)
    dialog.showErrorBox('谜镜 Studio 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  })
  app.on('before-quit', saveWindowState)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && backendUrl) createMainWindow(backendUrl)
  })
}
