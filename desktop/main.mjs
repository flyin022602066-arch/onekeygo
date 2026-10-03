import { app, BrowserWindow, dialog, Menu, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyBundledMediaEnvironment, findAvailablePort, replaceAsarWithUnpacked } from './runtime-utils.mjs'
import { createComfyUiWorkerManager } from './comfyui-worker.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
// Keep this project's bundled backend away from the other desktop project.
// An environment override is useful for parallel test instances.
const DEFAULT_PORT = Number(process.env.MIJING_BACKEND_PORT) || 45679
const HEALTH_TIMEOUT_MS = 90_000

// Keep the source development build isolated from the packaged app. Electron
// derives its single-instance lock from the userData directory, so sharing it
// makes `start-dev.bat` exit immediately whenever the installed app is open.
if (process.env.MIJING_DEV_MODE === '1') {
  app.setPath('userData', path.join(app.getPath('appData'), 'onekeygo-studio-desktop-dev'))
}

let mainWindow = null
let backendUrl = ''
let logFile = ''
let comfyUiManager = null
let isQuitting = false

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
  // The packaged app can outlive the shell that launched it. Forwarding
  // backend logs to a closed stdout/stderr pipe raises an uncaught EPIPE
  // (notably when the renderer is refreshed), so persist logs only to disk.
  for (const stream of [process.stdout, process.stderr]) {
    try {
      stream?.on?.('error', (error) => {
        if (error?.code !== 'EPIPE') return
      })
    } catch {
      // File logging below remains available even when a stream is absent.
    }
  }
  console.error = (...args) => {
    writeLog('error', args.map(String).join(' '))
  }
  console.warn = (...args) => {
    writeLog('warn', args.map(String).join(' '))
  }
  console.log = (...args) => {
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
    return isVisibleOnDisplay(candidate) ? candidate : { width, height, center: true }
  } catch {
    return { ...fallback, center: true }
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
  // The source launcher may use an isolated Electron userData directory so it
  // can run alongside an installed build.  Keep the project database and
  // uploaded media shared with the installed build when an explicit data root
  // is supplied by the launcher.
  const configuredDataRoot = String(process.env.MIJING_DATA_DIR || '').trim()
  const userRoot = configuredDataRoot ? path.resolve(configuredDataRoot) : app.getPath('userData')
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
  const port = await findAvailablePort(DEFAULT_PORT)
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
  // Clear inherited paths from an older portable build when its unpacked
  // binary no longer exists. The backend can then discover the current
  // resources copy or fall back to ffmpeg/ffprobe on PATH.
  applyBundledMediaEnvironment(process.env, media)

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
    // Show the native window immediately.  Waiting for ready-to-show can
    // leave the packaged app running with no visible window when Chromium
    // skips that event (for example after a GPU/display transition).
    show: true,
    title: 'eggfans',
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
  // A persisted monitor can disappear between launches.  Re-validate the
  // actual bounds after BrowserWindow creation and center on the primary
  // work area when necessary.
  if (!isVisibleOnDisplay(mainWindow.getBounds())) {
    mainWindow.center()
  }
  mainWindow.on('close', saveWindowState)
  let windowShown = false
  const showMainWindow = () => {
    if (windowShown || !mainWindow || mainWindow.isDestroyed()) return
    windowShown = true
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!isVisibleOnDisplay(mainWindow.getBounds())) mainWindow.center()
    mainWindow.show()
    mainWindow.focus()
    writeLog('info', `Main window shown: ${JSON.stringify(mainWindow.getBounds())}`)
  }
  // `ready-to-show` can be skipped by Electron when the renderer loads a
  // large static bundle or GPU compositing is delayed. Always show after the
  // document has finished loading, with a timeout fallback for slow machines.
  mainWindow.once('ready-to-show', showMainWindow)
  mainWindow.webContents.once('did-finish-load', showMainWindow)
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    writeLog('error', `Renderer failed to load (${errorCode}): ${errorDescription} ${validatedURL}`)
    showMainWindow()
  })
  mainWindow.on('show', () => writeLog('info', 'Main window show event fired'))
  mainWindow.on('hide', () => writeLog('warn', 'Main window hide event fired'))
  setTimeout(showMainWindow, 3000)
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
  const comfyLogPath = path.join(app.getPath('userData'), 'logs', 'comfyui-worker.log')
  comfyUiManager = createComfyUiWorkerManager({
    logPath: comfyLogPath,
    onEvent(event, detail) {
      if (event === 'ready') {
        writeLog('info', `MiniMax H3 Worker ready (${detail.baseUrl}, started=${detail.started})`)
      } else if (event === 'restarting') {
        writeLog('warn', `MiniMax H3 Worker automatic repair is restarting the app-owned Worker: ${detail.reason || 'health check failed'}`)
      } else {
        writeLog('info', `MiniMax H3 Worker self-check: ${event}`)
      }
    },
  })
  globalThis.__mijingEnsureComfyUiWorker = options => comfyUiManager.ensure(options)

  const devUrl = process.env.DESKTOP_DEV_URL
  backendUrl = process.env.DESKTOP_BACKEND_URL || ''
  if (!devUrl) backendUrl = await startBundledBackend(getRuntimeRoot())
  else await waitForHealth(backendUrl)
  createMainWindow(devUrl || backendUrl)

  comfyUiManager.ensure()
    .catch(error => {
      writeLog('warn', 'MiniMax H3 Worker failed to start; the app will continue.', error)
    })
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
    writeLog('error', 'Failed to start eggfans Studio.', error)
    dialog.showErrorBox('eggfans Studio 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  })
  app.on('before-quit', () => {
    isQuitting = true
    saveWindowState()
    comfyUiManager?.close()
    delete globalThis.__mijingEnsureComfyUiWorker
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && backendUrl) createMainWindow(backendUrl)
  })
}
