import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { joinProviderUrl } from './url'
import {
  MIJING_BASE_URL,
  MIJING_CREATION_BASE_URL,
  MIJING_CREATION_VIDEO_MODEL,
} from '../mijing/models.js'

export class MijingVideoAdapter implements VideoProviderAdapter {
  provider = 'mijing'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model
    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt || '',
      duration: normalizeMijingDuration(record.duration),
      ratio: normalizeRatio(record.aspectRatio),
      watermark: false,
      generate_audio: true,
      resolution: normalizeResolution(config.settings?.mijing?.defaults?.resolution),
    }

    const media = buildReferenceImages(record)
    if (record.referenceMode === 'first_last' && media.length >= 2) {
      body.image_url = media[0]
      body.image_end_url = media[1]
      body.image_role = 'first_last_frames'
    } else if (record.referenceMode === 'first_frame_multiple' && media.length >= 1) {
      // 创作版的首帧模式与多参考模式互斥；串行模式把承接帧固定放在多参考列表首位。
      body.reference_image_urls = media.slice(0, 9)
    } else if (media.length === 1) {
      body.image_url = media[0]
      body.image_role = 'reference_image'
      body.reference_image_urls = media
    } else if (media.length > 1) {
      body.reference_image_urls = media.slice(0, 9)
    }

    return {
      url: joinMijingUrl(resolveMijingVideoBaseUrl(config.baseUrl, model), config.endpoint || '/v1/video/generations'),
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
    if (videoUrl) return { isAsync: false, videoUrl }

    const taskId = extractTaskId(result)
    if (taskId) return { isAsync: true, taskId: encodeMijingTaskId(taskId) }

    throw new Error('No Mijing video task id or video URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const id = decodeMijingTaskId(taskId)
    const model = config.model
    const template = config.queryEndpoint || '/v1/video/generations/{task_id}'
    const path = template.includes('{task_id}') || template.includes('{taskId}') || template.includes('{id}') || template.includes(':taskId')
      ? template
        .replace('{task_id}', encodeURIComponent(id))
        .replace('{taskId}', encodeURIComponent(id))
        .replace('{id}', encodeURIComponent(id))
        .replace(':taskId', encodeURIComponent(id))
      : `${template.replace(/\/+$/, '')}/${encodeURIComponent(id)}`
    return {
      url: joinMijingUrl(resolveMijingVideoBaseUrl(config.baseUrl, model), path),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = normalizeMijingStatus(
      result.status
        || result.data?.status
        || result.data?.raw?.status
        || result.raw?.status
        || result.task_status
        || result.data?.task_status,
    )
    if (status === 'completed') return { status, videoUrl: this.extractVideoUrl(result) || undefined }
    if (status === 'failed') {
      return {
        status,
        error: result.error?.message
          || result.data?.error?.message
          || result.data?.error
          || result.message
          || 'Mijing video generation failed',
      }
    }
    return { status }
  }

  extractVideoUrl(result: any): string | null {
    return result.data?.result_url
      || result.data?.video_url
      || result.data?.url
      || result.data?.output?.result_url
      || result.data?.output?.video_url
      || result.data?.output?.url
      || result.data?.output?.results?.[0]?.url
      || result.data?.raw?.result_url
      || result.data?.raw?.video_url
      || result.data?.raw?.url
      || result.data?.raw?.output?.result_url
      || result.data?.raw?.output?.video_url
      || result.output?.result_url
      || result.output?.video_url
      || result.output?.url
      || result.output?.results?.[0]?.url
      || result.raw?.result_url
      || result.raw?.video_url
      || result.raw?.url
      || result.raw?.output?.result_url
      || result.raw?.output?.video_url
      || result.result_url
      || result.video_url
      || result.url
      || null
  }
}

export function resolveMijingVideoBaseUrl(baseUrl: string | null | undefined, model: string | null | undefined) {
  const configured = String(baseUrl || '').trim()
  // api.mjing.cc is the legacy video gateway. The current Mijing video
  // gateway documented for the same models is api.magine.work.
  if (!configured || /^https:\/\/api\.mjing\.cc(?:\/v1)?\/?$/i.test(configured)) {
    return MIJING_CREATION_BASE_URL
  }
  return configured || MIJING_BASE_URL
}

function buildReferenceImages(record: VideoGenerationRecord) {
  if (record.referenceMode === 'first_last') {
    return uniqueUrls([record.firstFrameUrl, record.lastFrameUrl])
  }

  if (record.referenceMode === 'multiple' || record.referenceMode === 'first_frame_multiple') {
    const parsed = parseReferenceList(record.referenceImageUrls)
    if (record.referenceMode === 'first_frame_multiple') {
      return uniqueUrls([record.firstFrameUrl, ...parsed]).slice(0, 9)
    }
    if (parsed.length) return parsed.slice(0, 9)
  }

  return uniqueUrls([record.imageUrl, record.firstFrameUrl, record.lastFrameUrl]).slice(0, 9)
}

function parseReferenceList(value?: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? uniqueUrls(parsed.map(item => String(item || '')))
      : []
  } catch {
    return []
  }
}

function uniqueUrls(values: Array<string | null | undefined>) {
  return values
    .map(value => String(value || '').trim())
    .filter((value, index, array) => !!value && array.indexOf(value) === index)
}

function extractTaskId(result: any) {
  return result.data?.provider_task_id
    || result.provider_task_id
    || result.data?.task_id
    || result.task_id
    || result.data?.id
    || result.id
    || result.data?.raw?.id
    || result.raw?.id
    || null
}

function encodeMijingTaskId(taskId: string | number) {
  return `mijing:video:${String(taskId)}`
}

function decodeMijingTaskId(taskId: string) {
  return String(taskId || '').replace(/^mijing:video:/, '').replace(/^mijing:/, '')
}

function normalizeMijingStatus(status: unknown): VideoPollResponse['status'] {
  const value = String(status || '').trim().toLowerCase()
  if (['success', 'succeeded', 'completed', 'complete', 'done'].includes(value)) return 'completed'
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(value)) return 'failed'
  if (['processing', 'running', 'in_progress'].includes(value)) return 'processing'
  return 'pending'
}

function normalizeMijingDuration(duration?: number | null) {
  const parsed = Math.round(Number(duration || 5))
  if (!Number.isFinite(parsed)) return 5
  return Math.min(30, Math.max(1, parsed))
}

function normalizeRatio(aspectRatio?: string | null) {
  const value = String(aspectRatio || '').trim()
  return value || '16:9'
}

function normalizeResolution(value?: unknown) {
  const resolution = String(value || '720p').trim().toLowerCase()
  if (['480p', '720p', '1080p', '4k'].includes(resolution)) return resolution
  return '720p'
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
