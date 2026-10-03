import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'

const DEFAULT_WORKFLOW_ID = 'minimax_h3_image_audio_to_video_v2_15s'
const LEGACY_WORKFLOW_ID = 'minimax_h3_lightx2v_no_pic'
const DEFAULT_DURATION = 5
const DEFAULT_RESOLUTION = '768p竖'

/**
 * AutoDL's hosted ComfyUI workflow API.
 *
 * This is deliberately a separate adapter from the local `comfyui` adapter.
 * AutoDL accepts a workflow id and the workflow's exposed JSON inputs, while
 * the local adapter submits a complete ComfyUI prompt graph to `/prompt`.
 * Keeping the contracts separate prevents local H3 settings (LoRA, VRAM,
 * latent paths, etc.) from leaking into a hosted request.
 */
export class AutoDlComfyUiVideoAdapter implements VideoProviderAdapter {
  provider = 'autodl_comfyui'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const settings = config.settings?.autodlComfyui || {}
    const configuredWorkflowId = String(
      settings.workflowId
      || record.model
      || settings.workflow_id
      || config.model
      || DEFAULT_WORKFLOW_ID,
    ).trim()
    const workflowId = configuredWorkflowId === LEGACY_WORKFLOW_ID
      ? DEFAULT_WORKFLOW_ID
      : configuredWorkflowId
    if (!workflowId) throw new Error('AutoDL ComfyUI 未配置 workflow_id')

    const body: Record<string, unknown> = isPlainObject(settings.extraParams)
      ? { ...settings.extraParams }
      : {}
    // The documented workflow has a fixed, flat input contract.  Write the
    // reserved fields after extraParams so stale JSON cannot override them.
    const prompt = String(record.prompt || '')
    if (!prompt.trim() || prompt.length > 10000) {
      throw new Error('AutoDL MiniMax H3 的 prompt 必须为 1-10000 个字符')
    }
    body.prompt = prompt
    body.duration = normalizeDuration(record.duration, settings.duration)
    body.resolution = normalizeResolution(settings.resolution || resolutionForAspect(record.aspectRatio))
    const seed = normalizeSeed(record.seed ?? settings.seed)
    if (seed !== undefined) body.seed = seed

    const refs = parseReferenceList(record.referenceImageUrls)
    if (String(record.referenceMode || '').trim().toLowerCase() === 'multiple' && !refs.length) {
      throw new Error('AutoDL MiniMax H3 R2V 缺少有序参考图')
    }
    const max = normalizeMaxReferences(settings.maxReferenceImages)
    refs.slice(0, max).forEach((url, index) => { body[`ref_image_${index}`] = url })

    const audios = parseReferenceList(record.referenceAudioUrls || settings.referenceAudioUrls || settings.reference_audio_urls)
    audios.slice(0, 3).forEach((url, index) => { body[`ref_audio_${index}`] = url })

    const endpoint = String(settings.createPath || settings.create_path || config.endpoint || '').trim()
      || '/api/v1/comfyui/comfyui_workflow/{workflow_id}'
    return {
      url: buildAutoDlUrl(config.baseUrl, endpoint.replace('{workflow_id}', encodeURIComponent(workflowId))),
      method: 'POST',
      headers: autoDlHeaders(config.apiKey, true),
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const data = result?.data && typeof result.data === 'object' ? result.data : result
    const code = String(result?.code || result?.status || '').trim().toLowerCase()
    if (code && !['success', 'ok', 'queued', 'running', 'pending'].includes(code)) {
      throw new Error(`AutoDL ComfyUI 提交失败：${extractError(result)}`)
    }
    const taskStatus = String(data?.status || '').trim().toLowerCase()
    if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(taskStatus)) {
      throw new Error(`AutoDL ComfyUI 提交失败：${extractError(result)}`)
    }
    const taskId = String(data?.task_id || data?.taskId || result?.task_id || result?.taskId || '').trim()
    if (!taskId) {
      const message = String(result?.msg || result?.message || '').trim()
      throw new Error(`AutoDL ComfyUI 未返回 task_id${message ? `：${message}` : ''}`)
    }
    const immediate = extractVideoUrl(result)
    return immediate
      ? { isAsync: false, videoUrl: immediate }
      : { isAsync: true, taskId: `autodl_comfyui:${taskId}` }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const id = String(taskId || '').replace(/^autodl_comfyui:/, '')
    const settings = config.settings?.autodlComfyui || {}
    const endpoint = String(settings.resultPath || settings.result_path || config.queryEndpoint || '').trim()
      || '/api/v1/comfyui/comfyui_workflow/result/{task_id}'
    return {
      url: buildAutoDlUrl(config.baseUrl, endpoint.replace('{task_id}', encodeURIComponent(id)).replace('{taskId}', encodeURIComponent(id))),
      method: 'GET',
      headers: autoDlHeaders(config.apiKey),
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const data = result?.data && typeof result.data === 'object' ? result.data : result
    const status = String(data?.status || result?.status || '').trim().toLowerCase()
    const code = String(result?.code || '').trim().toLowerCase()
    if (code && !['success', 'ok'].includes(code) && !status) {
      return { status: 'failed', error: extractError(result) }
    }
    if (['success', 'succeeded', 'completed', 'done'].includes(status)) {
      const videoUrl = extractVideoUrl(result)
      return videoUrl
        ? { status: 'completed', videoUrl }
        : { status: 'failed', error: 'AutoDL 任务已完成但 results 中没有视频地址' }
    }
    if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) {
      return { status: 'failed', error: extractError(result) }
    }
    if (['queued', 'pending', 'running', 'processing', 'in_progress'].includes(status)) {
      return { status: 'processing' }
    }
    // An empty/partial response is transient during task creation.  A
    // non-empty provider error without a status, however, must not leave the
    // Studio polling forever.
    if (code && !['success', 'ok'].includes(code)) {
      return { status: 'failed', error: extractError(result) }
    }
    return { status: 'pending' }
  }

  extractVideoUrl(result: any): string | null {
    return extractVideoUrl(result)
  }
}

function autoDlHeaders(token?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (String(token || '').trim()) headers.Authorization = String(token).trim()
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function buildAutoDlUrl(baseUrl: string, path: string) {
  const base = String(baseUrl || 'https://autodl.art').trim().replace(/\/+$/, '')
  const normalized = String(path || '').startsWith('/') ? String(path) : `/${path}`
  // Users commonly paste https://autodl.art/api/v1 from the docs. Avoid
  // duplicating that prefix when the adapter's default path is used.
  if (/\/api\/v1$/i.test(base) && /^\/api\/v1(?:\/|$)/i.test(normalized)) {
    return `${base}${normalized.slice('/api/v1'.length)}`
  }
  return `${base}${normalized}`
}

function parseReferenceList(value?: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.map(item => String(item || '').trim()).filter(Boolean)
      : typeof parsed === 'string' && parsed.trim() ? [parsed.trim()] : []
  } catch {
    return []
  }
}

function extractVideoUrl(result: any): string | null {
  const data = result?.data && typeof result.data === 'object' ? result.data : result
  const candidates: unknown[] = [
    data?.video_url,
    data?.videoUrl,
    data?.url,
    data?.video?.url,
    result?.video_url,
    result?.videoUrl,
    data?.download_url,
    data?.downloadUrl,
    data?.uri,
    result?.url,
    result?.download_url,
    result?.downloadUrl,
    result?.uri,
  ]
  const results = Array.isArray(data?.results)
    ? data.results
    : data?.results && typeof data.results === 'object'
      ? Object.values(data.results)
      : []
  for (const item of results) {
    if (typeof item === 'string') candidates.push(item)
    else if (item && typeof item === 'object') candidates.push(
      item.video_url,
      item.videoUrl,
      item.url,
      item.download_url,
      item.downloadUrl,
      item.uri,
      item.video?.url,
      item.file_url,
      item.fileUrl,
      item.file?.url,
      item.file?.download_url,
    )
  }
  return candidates.map(value => String(value || '').trim()).find(value => /^https?:\/\//i.test(value)) || null
}

function extractError(result: any) {
  const data = result?.data && typeof result.data === 'object' ? result.data : result
  return String(data?.error || data?.message || result?.msg || result?.message || 'AutoDL ComfyUI 任务失败')
}

function normalizeDuration(value: unknown, fallback: unknown) {
  const parsed = Number(value ?? fallback ?? DEFAULT_DURATION)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(15, Math.round(parsed))) : DEFAULT_DURATION
}

function normalizeResolution(value: unknown) {
  const normalized = String(value || '').trim()
  return ['480p竖', '768p竖', '480p横', '768p横'].includes(normalized) ? normalized : DEFAULT_RESOLUTION
}

function normalizeSeed(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) return undefined
  return parsed
}

function normalizeMaxReferences(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(9, Math.round(parsed))) : 9
}

function resolutionForAspect(aspectRatio?: string | null) {
  const normalized = String(aspectRatio || '').trim()
  if (normalized === '9:16') return '768p竖'
  if (normalized === '16:9') return '768p横'
  return DEFAULT_RESOLUTION
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
