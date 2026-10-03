import type { AIConfig } from './adapters/types.js'

export const COMFYUI_MEMORY_RELEASE_TIMEOUT_MS = 15_000
export const COMFYUI_MEMORY_RELEASE_POLL_MS = 250
const COMFYUI_MEMORY_RELEASE_MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024
const COMFYUI_MEMORY_RELEASE_MIN_FREE_RATIO = 0.75

export interface ComfyUiMemoryReleaseOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  pollIntervalMs?: number
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function memoryStats(payload: any) {
  const device = Array.isArray(payload?.devices) ? payload.devices[0] : null
  const total = Number(device?.vram_total)
  const free = Number(device?.vram_free)
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) {
    throw new Error('ComfyUI /system_stats did not return usable VRAM data')
  }
  return { total, free, requiredFree: Math.max(total * COMFYUI_MEMORY_RELEASE_MIN_FREE_RATIO, total - COMFYUI_MEMORY_RELEASE_MIN_FREE_BYTES) }
}

export async function releaseComfyUiMemory(
  config: Pick<AIConfig, 'baseUrl'>,
  options: ComfyUiMemoryReleaseOptions = {},
) {
  const baseUrl = String(config.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl || fetch
  const response = await fetchImpl(`${baseUrl}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
    signal: AbortSignal.timeout(options.timeoutMs ?? COMFYUI_MEMORY_RELEASE_TIMEOUT_MS),
  })

  if (!response.ok) {
    let body = ''
    try {
      body = (await response.text()).slice(0, 500)
    } catch {
      body = ''
    }
    throw new Error(`ComfyUI memory release failed ${response.status}${body ? `: ${body}` : ''}`)
  }

  const timeoutMs = Math.max(0, options.timeoutMs ?? COMFYUI_MEMORY_RELEASE_TIMEOUT_MS)
  const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? COMFYUI_MEMORY_RELEASE_POLL_MS)
  const deadline = Date.now() + timeoutMs
  let observedStats = false
  let polls = 0
  let lastStats: ReturnType<typeof memoryStats> | undefined

  while (Date.now() < deadline) {
    const statsResponse = await fetchImpl(`${baseUrl}/system_stats`, {
      signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
    }).catch((error) => {
      throw new Error(`ComfyUI /system_stats request failed: ${String(error?.message || error)}`)
    })

    if (!statsResponse.ok) throw new Error(`ComfyUI /system_stats failed ${statsResponse.status}`)

    const stats = memoryStats(await statsResponse.json())
    lastStats = stats
    observedStats = true
    polls += 1
    if (stats.free >= stats.requiredFree) return { ...stats, polls }

    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }

  if (observedStats) {
    throw new Error(`ComfyUI memory release timed out: ${lastStats?.free || 0} bytes free, ${lastStats?.requiredFree || 0} required`)
  }

  throw new Error('ComfyUI memory release completed without a VRAM reading')
}
