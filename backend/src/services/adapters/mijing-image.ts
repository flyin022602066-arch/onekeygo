import type {
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
  ImageProviderAdapter,
  ProviderRequest,
} from './types'
import { joinProviderUrl } from './url'
import { MIJING_BASE_URL, resolveMijingStandardBaseUrl } from '../mijing/models.js'

export class MijingImageAdapter implements ImageProviderAdapter {
  provider = 'mijing'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = record.model || config.model
    const gptImage2 = isMijingGptImage2(model)
    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt || '',
      size: normalizeMijingImageSize(record.size, model),
      n: 1,
      response_format: 'url',
    }

    if (gptImage2) body.quality = 'high'

    const references = parseReferences(record.referenceImages)
    if (references.length === 1) body.image = references[0]
    if (references.length > 1) body.image = references

    return {
      url: joinMijingUrl(resolveMijingStandardBaseUrl(config.baseUrl || MIJING_BASE_URL), config.endpoint || '/v1/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const imageUrl = this.extractImageUrl(result)
    if (imageUrl) return { isAsync: false, imageUrl }

    const taskId = result.data?.provider_task_id
      || result.provider_task_id
      || result.task_id
      || result.id
      || result.data?.task_id
      || result.data?.id
      || result.data?.raw?.id
      || result.raw?.id
    if (taskId) return { isAsync: true, taskId: encodeMijingTaskId(taskId) }

    throw new Error('No Mijing image task id or image URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const id = decodeMijingTaskId(taskId)
    const template = config.queryEndpoint || '/v1/images/generations/{task_id}'
    const path = template.includes('{task_id}') || template.includes('{taskId}') || template.includes('{id}') || template.includes(':taskId')
      ? template
        .replace('{task_id}', encodeURIComponent(id))
        .replace('{taskId}', encodeURIComponent(id))
        .replace('{id}', encodeURIComponent(id))
        .replace(':taskId', encodeURIComponent(id))
      : `${template.replace(/\/+$/, '')}/${encodeURIComponent(id)}`
    return {
      url: joinMijingUrl(resolveMijingStandardBaseUrl(config.baseUrl || MIJING_BASE_URL), path),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = normalizeMijingStatus(result.status || result.data?.status || result.raw_status || result.data?.raw_status)
    if (status === 'completed') {
      return { status, imageUrl: this.extractImageUrl(result) || undefined }
    }
    if (status === 'failed') {
      return { status, error: extractMijingError(result) }
    }
    return { status }
  }

  extractImageUrl(result: any): string | null {
    return result.result_url
      || result.data?.result_url
      || result.data?.[0]?.url
      || result.data?.url
      || result.data?.image_url
      || result.output?.image_url
      || result.output?.results?.[0]?.url
      || result.image_url
      || result.url
      || result.raw?.data?.[0]?.url
      || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.data?.[0]?.b64_json || result.output?.b64_json || result.b64_json
    return b64 ? { data: b64, mimeType: 'image/png' } : null
  }
}

function normalizeMijingImageSize(size?: string | null, model?: string | null) {
  if (isMijingGptImage2(model)) {
    const normalized = String(size || '').trim().toUpperCase()
    return ['1K', '2K', '4K'].includes(normalized) ? normalized : '1K'
  }
  if (!size) return '1024x1024'
  if (size === '1920x1080') return '1280x720'
  if (size === '1080x1920') return '720x1280'
  if (size === '1792x1024') return '1280x720'
  if (size === '1024x1792') return '720x1280'
  return size
}

function isMijingGptImage2(model?: string | null) {
  return /^gpt-image-2$/i.test(String(model || '').trim())
}

function parseReferences(value?: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.map(item => String(item || '').trim()).filter(Boolean)
      : []
  } catch {
    return []
  }
}

function encodeMijingTaskId(taskId: string | number) {
  return `mijing:${String(taskId)}`
}

function decodeMijingTaskId(taskId: string) {
  return String(taskId || '').replace(/^mijing:/, '')
}

function normalizeMijingStatus(status: unknown): ImagePollResponse['status'] {
  const value = String(status || '').trim().toLowerCase()
  if (['success', 'succeeded', 'completed', 'complete', 'done'].includes(value)) return 'completed'
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(value)) return 'failed'
  if (['processing', 'running', 'in_progress'].includes(value)) return 'processing'
  return 'pending'
}

function extractMijingError(result: any) {
  const value = result?.error?.message
    || result?.error
    || result?.message
    || result?.data?.error?.message
    || result?.data?.error
    || result?.data?.message
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {}
  }
  return 'Mijing image generation failed'
}

function joinMijingUrl(baseUrl: string, path: string) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path}`
  try {
    const url = new URL(baseUrl || MIJING_BASE_URL)
    const basePath = url.pathname.replace(/\/+$/, '')
    const safePath = basePath.endsWith('/v1') && normalizedPath.startsWith('/v1/')
      ? normalizedPath.replace(/^\/v1/, '')
      : normalizedPath
    return joinProviderUrl(baseUrl || MIJING_BASE_URL, '', safePath)
  } catch {
    const normalizedBase = String(baseUrl || MIJING_BASE_URL).replace(/\/+$/, '')
    const safePath = normalizedBase.endsWith('/v1') && normalizedPath.startsWith('/v1/')
      ? normalizedPath.replace(/^\/v1/, '')
      : normalizedPath
    return joinProviderUrl(normalizedBase, '', safePath)
  }
}
