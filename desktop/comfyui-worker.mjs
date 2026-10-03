import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188'
const DEFAULT_WORKSPACE = 'D:\\ComfyUI-aki-v1.4\\ComfyUI-aki-v1.4'

function existingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function existingDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory()
  } catch {
    return false
  }
}

export function resolveComfyUiInstallation(env = process.env) {
  if (String(env.MIJING_AUTO_START_COMFYUI || '').trim().toLowerCase() === '0') return null

  const configuredWorkspace = String(
    env.MIJING_COMFYUI_WORKSPACE || env.COMFYUI_WORKSPACE || '',
  ).trim()
  const candidates = [configuredWorkspace, DEFAULT_WORKSPACE]
    .filter(Boolean)
    .map(candidate => path.resolve(candidate))
    .filter((candidate, index, all) => all.indexOf(candidate) === index)

  for (const workspace of candidates) {
    if (!existingDirectory(workspace) || !existingFile(path.join(workspace, 'main.py'))) continue
    const configuredPython = String(env.MIJING_COMFYUI_PYTHON || '').trim()
    const pythonCandidates = [
      configuredPython,
      path.join(workspace, '.ext', 'python.exe'),
      path.join(workspace, 'python', 'python.exe'),
      path.join(workspace, 'python', 'pythonw.exe'),
    ].filter(Boolean)
    const python = pythonCandidates.find(existingFile)
    if (python) return { workspace, python }
  }
  return null
}

export async function isComfyUiReady(baseUrl = DEFAULT_COMFY_URL, timeoutMs = 1500) {
  try {
    const response = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/system_stats`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

export function buildComfyUiLaunchArgs(baseUrl = DEFAULT_COMFY_URL, args = []) {
  const url = new URL(baseUrl)
  const port = Number(url.port || 8188)
  const host = url.hostname || '127.0.0.1'
  const defaults = [
    ['--listen', host],
    ['--port', String(port)],
    ['--disable-auto-launch'],
    ['--preview-method', 'auto'],
  ]
  const supplied = Array.isArray(args) ? args.map(value => String(value)) : []
  const suppliedFlags = new Set(supplied.filter(value => value.startsWith('--')))
  return [
    'main.py',
    ...defaults.flatMap(parts => suppliedFlags.has(parts[0]) ? [] : parts),
    ...supplied,
  ]
}

export function launchComfyUi({ installation, baseUrl = DEFAULT_COMFY_URL, logPath, args = [] }) {
  if (!installation) throw new Error('MiniMax H3 Worker 的 ComfyUI 安装路径不存在')
  try { ensureBundledH3Nodes(installation) } catch (error) { console.warn('Optional H3 refinement node unavailable:', error.message) }
  const logHandle = logPath ? fs.openSync(logPath, 'a') : 'ignore'
  const child = spawn(
    installation.python,
    buildComfyUiLaunchArgs(baseUrl, args),
    {
      cwd: installation.workspace,
      windowsHide: true,
      detached: false,
      env: {
        ...process.env,
        PYTORCH_CUDA_ALLOC_CONF: String(process.env.PYTORCH_CUDA_ALLOC_CONF || '').trim()
          || 'expandable_segments:True',
      },
      stdio: ['ignore', logHandle, logHandle],
    },
  )
  child.once('close', () => {
    if (typeof logHandle === 'number') {
      try { fs.closeSync(logHandle) } catch { /* already closed */ }
    }
  })
  return child
}

export function ensureBundledH3Nodes(installation, sourceDirectory = fileURLToPath(new URL('./comfyui-nodes/mijing_h3_safe', import.meta.url))) {
  const workspace = fs.realpathSync(installation.workspace)
  const customNodes = path.join(workspace, 'custom_nodes')
  fs.mkdirSync(customNodes, { recursive: true })
  if (fs.realpathSync(customNodes) !== customNodes) throw new Error('Refusing redirected custom_nodes directory')
  const destination = path.join(customNodes, 'mijing_studio_h3_safe')
  fs.mkdirSync(destination, { recursive: true })
  if (fs.realpathSync(destination) !== destination) throw new Error('Refusing redirected H3 node directory')
  const source = fs.readFileSync(path.join(sourceDirectory, '__init__.py'))
  const target = path.join(destination, '__init__.py')
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Refusing redirected H3 node file')
    const existing = fs.readFileSync(target)
    if (existing.equals(source)) return { changed: false, path: target }
    fs.copyFileSync(target, `${target}.backup-${Date.now()}`, fs.constants.COPYFILE_EXCL)
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, source, { flag: 'wx' })
  fs.renameSync(temporary, target)
  return { changed: true, path: target }
}

export async function waitForComfyUi(baseUrl = DEFAULT_COMFY_URL, timeoutMs = 120_000, child = null) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isComfyUiReady(baseUrl)) return true
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      const detail = child.exitCode !== null
        ? `退出码 ${child.exitCode}`
        : `信号 ${child.signalCode}`
      throw new Error(`MiniMax H3 Worker 启动过程中提前退出（${detail}）`)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

export async function ensureComfyUiWorker({
  baseUrl = DEFAULT_COMFY_URL,
  logPath,
  startupTimeoutMs = 120_000,
  startupAttempts = 2,
  retryDelayMs = 1_000,
  env = process.env,
} = {}) {
  if (await isComfyUiReady(baseUrl)) {
    return { ready: true, started: false, owned: false, baseUrl }
  }

  const installation = resolveComfyUiInstallation(env)
  if (!installation) {
    return { ready: false, started: false, owned: false, baseUrl, reason: 'installation-not-found' }
  }

  const attempts = Math.max(1, Number(startupAttempts) || 1)
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const child = launchComfyUi({ installation, baseUrl, logPath })
    try {
      const ready = await waitForComfyUi(baseUrl, startupTimeoutMs, child)
      if (ready) return { ready: true, started: true, owned: true, baseUrl, child, installation }
      lastError = new Error(`MiniMax H3 Worker 启动超时（${baseUrl}）`)
    } catch (error) {
      lastError = error
    }
    try { child.kill() } catch { /* process may have exited */ }
    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(retryDelayMs) || 0)))
    }
  }
  throw lastError || new Error(`MiniMax H3 Worker 启动失败（${baseUrl}）`)
}

export function stopComfyUiWorker(runtime) {
  const child = runtime?.child
  if (!runtime?.owned || !child || child.killed) return false
  try {
    child.kill()
    return true
  } catch {
    return false
  }
}

/**
 * Own the local Worker lifecycle for the desktop process. All callers share
 * one in-flight startup promise, preventing two repair attempts from racing
 * for port 8188. A Worker not launched by this app is never terminated.
 */
export function createComfyUiWorkerManager({
  logPath,
  startupTimeoutMs = 120_000,
  ensureWorker = ensureComfyUiWorker,
  stopWorker = stopComfyUiWorker,
  readyCheck = isComfyUiReady,
  onEvent = () => {},
} = {}) {
  let runtime = null
  let pending = null
  let closed = false

  const ensure = async ({
    baseUrl = DEFAULT_COMFY_URL,
    forceRestart = false,
    reason = '',
  } = {}) => {
    if (closed) throw new Error('MiniMax H3 Worker 管理器已关闭')
    if (pending) return pending

    pending = (async () => {
      onEvent('checking', { baseUrl, forceRestart, reason })
      const alreadyReady = await readyCheck(baseUrl)
      const restartingOwnedWorker = forceRestart && runtime?.owned
      if (restartingOwnedWorker) {
        onEvent('restarting', { baseUrl, reason })
        stopWorker(runtime)
        runtime = null
      }

      if (alreadyReady && !forceRestart) {
        const current = runtime?.baseUrl === baseUrl
          ? runtime
          : { ready: true, started: false, owned: false, baseUrl }
        runtime = current
        onEvent('ready', current)
        return current
      }

      // A healthy Worker not launched by this app must remain untouched. A
      // forced repair only restarts a process owned by this manager; otherwise
      // the existing external Worker is already the safest usable runtime.
      if (alreadyReady && forceRestart && !restartingOwnedWorker) {
        const current = { ready: true, started: false, owned: false, baseUrl }
        runtime = current
        onEvent('ready', current)
        return current
      }

      const next = await ensureWorker({ baseUrl, logPath, startupTimeoutMs })
      if (!next?.ready) {
        const detail = next?.reason === 'installation-not-found'
          ? '未找到 D:\\ComfyUI-aki-v1.4\\ComfyUI-aki-v1.4、main.py 或内置 Python'
          : String(next?.reason || '未知原因')
        const logHint = logPath ? `；请查看日志：${logPath}` : ''
        throw new Error(`MiniMax H3 Worker 自动启动失败：${detail}${logHint}`)
      }
      if (closed) {
        stopWorker(next)
        throw new Error('软件正在退出，已停止 MiniMax H3 Worker')
      }
      runtime = next
      onEvent('ready', next)
      return next
    })()

    try {
      return await pending
    } finally {
      pending = null
    }
  }

  const close = () => {
    closed = true
    const stopped = stopWorker(runtime)
    runtime = null
    return stopped
  }

  return {
    ensure,
    close,
    getRuntime: () => runtime,
  }
}

export const comfyUiDefaults = {
  baseUrl: DEFAULT_COMFY_URL,
  workspace: DEFAULT_WORKSPACE,
}
