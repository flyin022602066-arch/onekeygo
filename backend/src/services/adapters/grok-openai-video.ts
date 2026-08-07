import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { joinProviderUrl } from './url'

/**
 * xAI Imagine 视频的 OpenAI 兼容适配器。
 *
 * 该通道故意独立于 Eggfans、谜镜和火山：它使用 xAI 的
 * /v1/videos/generations + /v1/videos/{request_id} 契约，参考图只传
 * data URL 或公网 URL，不生成火山 Asset URI。
 */
export class GrokOpenAIVideoAdapter implements VideoProviderAdapter {
  provider = 'grok_openai'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || 'grok-imagine-video'
    const references = collectReferences(record)
    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt || '',
      duration: normalizeDuration(record.duration),
      aspect_ratio: normalizeAspectRatio(record.aspectRatio),
      resolution: normalizeResolution(config.settings?.grokOpenai?.defaults?.resolution),
    }

    if (references.length === 1 && record.referenceMode === 'single') {
      body.image = { url: references[0] }
    } else if (references.length) {
      body.reference_images = references.map(url => ({ url }))
    }

    return {
      url: joinGrokUrl(config.baseUrl, config.endpoint || '/v1/videos/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const videoUrl = this.extractVideoUrl(result)
    if (videoUrl && !extractTaskId(result)) return { isAsync: false, videoUrl }

    const taskId = extractTaskId(result)
    if (taskId) return { isAsync: true, taskId: encodeTaskId(taskId) }
    if (videoUrl) return { isAsync: false, videoUrl }
    throw new Error('No Grok Imagine video request_id or video URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const id = decodeTaskId(taskId)
    const template = config.queryEndpoint || '/v1/videos/{id}'
    const path = template.includes('{id}') || template.includes('{task_id}') || template.includes('{taskId}')
      ? template
        .replace('{id}', encodeURIComponent(id))
        .replace('{task_id}', encodeURIComponent(id))
        .replace('{taskId}', encodeURIComponent(id))
      : `${template.replace(/\/+$/, '')}/${encodeURIComponent(id)}`

    return {
      url: joinGrokUrl(config.baseUrl, path),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = String(result.status || result.data?.status || result.state || '').toLowerCase()
    if (['done', 'completed', 'succeeded', 'success'].includes(status)) {
      return { status: 'completed', videoUrl: this.extractVideoUrl(result) || undefined }
    }
    if (['failed', 'expired', 'cancelled', 'canceled', 'error'].includes(status)) {
      return { status: 'failed', error: extractError(result) }
    }
    if (['queued', 'pending', 'processing', 'running', 'in_progress'].includes(status)) {
      return { status: 'processing' }
    }
    return { status: 'pending' }
  }

  extractVideoUrl(result: any): string | null {
    return result.video?.url
      || result.data?.video?.url
      || result.data?.video_url
      || result.data?.url
      || result.video_url
      || result.url
      || null
  }
}

function collectReferences(record: VideoGenerationRecord) {
  const refs: string[] = []
  const push = (value: unknown) => {
    const url = String(value || '').trim()
    if (url && !refs.includes(url)) refs.push(url)
  }

  if (record.referenceMode === 'single') push(record.imageUrl)
  if (record.referenceMode === 'first_last') {
    push(record.firstFrameUrl)
    push(record.lastFrameUrl)
  }
  if (record.referenceMode === 'first_frame_multiple') {
    push(record.firstFrameUrl)
    parseReferenceList(record.referenceImageUrls).forEach(push)
  }
  if (record.referenceMode === 'multiple') parseReferenceList(record.referenceImageUrls).forEach(push)

  // Keep manually edited/legacy records usable even when reference_mode was lost.
  if (!refs.length) {
    push(record.imageUrl)
    push(record.firstFrameUrl)
    push(record.lastFrameUrl)
    parseReferenceList(record.referenceImageUrls).forEach(push)
  }
  return refs.slice(0, 7)
}

function parseReferenceList(value?: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function extractTaskId(result: any) {
  return String(result.request_id || result.requestId || result.data?.request_id || result.id || result.task_id || '').trim()
}

function encodeTaskId(id: string) {
  return `grok-openai:${id}`
}

function decodeTaskId(value: string) {
  return String(value || '').replace(/^grok-openai:/, '')
}

function joinGrokUrl(baseUrl: string, path: string) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${path}`
  if (/\/v1$/i.test(base) && /^\/v1(?:\/|$)/i.test(normalizedPath)) {
    return joinProviderUrl(base, '', normalizedPath.slice(3))
  }
  return joinProviderUrl(base, '', normalizedPath)
}

function extractError(result: any) {
  return result.error?.message
    || result.data?.error?.message
    || result.message
    || result.error
    || 'Grok Imagine video generation failed'
}

function normalizeDuration(value?: number | null) {
  const parsed = Math.round(Number(value || 5))
  if (!Number.isFinite(parsed)) return 5
  return Math.min(15, Math.max(1, parsed))
}

function normalizeAspectRatio(value?: string | null) {
  const normalized = String(value || '').trim()
  return ['16:9', '9:16', '1:1', '4:3', '3:4'].includes(normalized) ? normalized : '16:9'
}

function normalizeResolution(value?: string | null) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['480p', '720p'].includes(normalized) ? normalized : '720p'
}
