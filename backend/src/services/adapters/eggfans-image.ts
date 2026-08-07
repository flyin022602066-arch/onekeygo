import type {
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
  ImageProviderAdapter,
  ProviderRequest,
} from './types'
import { joinProviderUrl } from './url'

export class EggfansImageAdapter implements ImageProviderAdapter {
  provider = 'eggfans'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const references = parseReferences(record.referenceImages)
    const model = record.model || config.model
    if (usesImageEdits(model, references)) {
      const body = buildImageEditsFormData({
        model,
        prompt: record.prompt || '',
        size: normalizeImageEditSize(record.size, model),
        quality: getImageQuality(model),
        moderation: getImageModeration(model),
        references,
      })
      return {
        url: joinProviderUrl(config.baseUrl, '/v1', '/images/edits'),
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
        rawBody: true,
      }
    }

    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt,
      size: normalizeImageSize(record.size, model),
      quality: getImageQuality(model),
      n: 1,
      response_format: 'url',
      watermark: false,
    }

    if (references.length) body.image = references
    const moderation = getImageModeration(model)
    if (moderation) body.moderation = moderation

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
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

    const taskId = result.task_id || result.id || result.output?.task_id
    if (taskId) return { isAsync: true, taskId }

    const b64 = this.extractImageBase64(result)
    if (b64) return { isAsync: false, imageUrl: undefined }

    throw new Error('No Eggfans image URL or task id in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/images/task/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = result.status || result.output?.task_status
    if (status === 'completed' || status === 'SUCCEEDED' || status === 'succeeded') {
      return { status: 'completed', imageUrl: this.extractImageUrl(result) || undefined }
    }
    if (status === 'failed' || status === 'FAILED') {
      return { status: 'failed', error: result.error?.message || result.message || 'Eggfans image generation failed' }
    }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url
      || result.output?.image_url
      || result.output?.results?.[0]?.url
      || result.image_url
      || result.url
      || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.data?.[0]?.b64_json || result.output?.b64_json
    return b64 ? { data: b64, mimeType: 'image/png' } : null
  }
}

function normalizeImageSize(size?: string | null, model?: string | null) {
  if (isGptImage2(model)) return normalizeGptImageSize(size, model)
  if (!size) return '1024x1024'
  if (size === '1920x1080') return '1792x1024'
  if (size === '1080x1920') return '1024x1792'
  return size
}

function normalizeImageEditSize(size?: string | null, model?: string | null) {
  return isGptImage2C(model) ? normalizeGptImage2CSize(size) : '1K'
}

function normalizeGptImageSize(size?: string | null, model?: string | null) {
  return isGptImage2C(model) ? normalizeGptImage2CSize(size) : '1K'
}

function usesImageEdits(model: string | null | undefined, references: string[]) {
  return isGptImage2(model) && references.length > 0
}

function isGptImage2(model: string | null | undefined) {
  return !!model && /^gpt-image-2(?:-all|-c)?$/i.test(String(model).trim())
}

function isGptImage2C(model: string | null | undefined) {
  return !!model && /^gpt-image-2-c$/i.test(String(model).trim())
}

const GPT_IMAGE_2C_SIZES = new Set([
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '1152x2048',
  '3840x2160',
  '2160x3840',
  'auto',
])

function normalizeGptImage2CSize(size?: string | null) {
  const value = String(size || '').trim()
  return GPT_IMAGE_2C_SIZES.has(value) ? value : '3840x2160'
}

function getImageModeration(model: string | null | undefined) {
  return isGptImage2(model) ? 'low' : null
}

function getImageQuality(model: string | null | undefined) {
  return isGptImage2(model) ? 'high' : undefined
}

function ensureMultipleOf16(size: string) {
  const match = String(size || '').match(/^(\d+)x(\d+)$/)
  if (!match) return size
  const width = Math.max(16, Math.ceil(Number(match[1]) / 16) * 16)
  const height = Math.max(16, Math.ceil(Number(match[2]) / 16) * 16)
  return `${width}x${height}`
}

function buildImageEditsFormData(params: {
  model: string
  prompt: string
  size: string
  quality?: string
  moderation: string | null
  references: string[]
}) {
  const form = new FormData()
  for (const [idx, image] of params.references.slice(0, 15).entries()) {
    const file = dataUrlToFile(image, `reference-${idx + 1}.jpg`)
    if (file) form.append('image', file)
  }
  form.append('prompt', params.prompt)
  form.append('model', params.model)
  form.append('n', '1')
  form.append('size', params.size)
  if (params.quality) form.append('quality', params.quality)
  if (params.moderation) form.append('moderation', params.moderation)
  return form
}

function dataUrlToFile(dataUrl: string, fallbackName: string) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  const mimeType = match[1] || 'image/jpeg'
  const bytes = Buffer.from(match[2], 'base64')
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
  return new File([bytes], fallbackName.replace(/\.[^.]+$/, `.${ext}`), { type: mimeType })
}

function parseReferences(value?: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && item) : []
  } catch {
    return []
  }
}
