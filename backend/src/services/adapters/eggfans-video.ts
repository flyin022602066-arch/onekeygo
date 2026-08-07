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
  resolveEggfansRoute,
  shouldUseOfficialVolcengineVideo,
  type EggfansRouteFamily,
} from '../eggfans/routing.js'

type VideoRequestFamily = 'alibailian' | 'unified' | 'openai' | 'minimax' | 'vidu'

export class EggfansVideoAdapter implements VideoProviderAdapter {
  provider = 'eggfans'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model
    if (shouldUseOfficialVolcengineVideo(model)) {
      throw new Error(`${model} must use the official VolcEngine Seedance 2.0 adapter, not Eggfans`)
    }

    const routeFamily = getEggfansRouteFamily(config, model)
    if (routeFamily === 'alibailian-video') {
      return this.buildAliBailianRequest(config, record, model)
    }

    if (routeFamily === 'unified-video') {
      if (isGrokVideoModel(model)) return this.buildGrokVideoRequest(config, record, model)
      return this.buildUnifiedVideoRequest(config, record, model)
    }

    if (routeFamily === 'minimax-video') {
      return this.buildMiniMaxVideoRequest(config, record, model)
    }

    if (routeFamily === 'vidu-video') {
      return this.buildViduVideoRequest(config, record, model)
    }

    return this.buildOpenAIVideoRequest(config, record, model)
  }

  parseGenerateResponse(result: any, config?: AIConfig, record?: VideoGenerationRecord): VideoGenResponse {
    const aliBailianTaskId = result.output?.task_id
    const taskId = aliBailianTaskId
      || result.data?.task_id
      || result.data?.id
      || result.id
      || result.task_id
    if (taskId) {
      const requestFamily = aliBailianTaskId ? 'alibailian' : getTaskIdFamily(config, record)
      return { isAsync: true, taskId: encodeTaskId(requestFamily, taskId) }
    }

    const videoUrl = this.extractVideoUrl(result)
    if (videoUrl) return { isAsync: false, videoUrl }

    throw new Error('No Eggfans video task id or video URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    if (taskId.startsWith('eggfans:unified:')) {
      const id = taskId.replace(/^eggfans:unified:/, '')
      return this.buildUnifiedPollRequest(config, id)
    }

    if (taskId.startsWith('eggfans:minimax:')) {
      const id = taskId.replace(/^eggfans:minimax:/, '')
      return this.buildMiniMaxPollRequest(config, id)
    }

    if (taskId.startsWith('eggfans:vidu:')) {
      const id = taskId.replace(/^eggfans:vidu:/, '')
      return this.buildViduPollRequest(config, id)
    }

    if (taskId.startsWith('video_') || taskId.startsWith('vid_')) {
      return {
        url: joinProviderUrl(config.baseUrl, '', `/v1/videos/${taskId}`),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${config.apiKey}` },
        body: undefined,
      }
    }

    const family = getTaskIdFamily(config)
    if (family === 'unified') return this.buildUnifiedPollRequest(config, taskId)
    if (family === 'minimax') return this.buildMiniMaxPollRequest(config, taskId)
    if (family === 'vidu') return this.buildViduPollRequest(config, taskId)

    return {
      url: joinProviderUrl(config.baseUrl, '', `/alibailian/api/v1/tasks/${taskId}`),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = result.output?.task_status
      || result.data?.status
      || result.status
      || result.state
      || result.task_status
      || result.base_resp?.status_msg
    if (['SUCCEEDED', 'succeeded', 'completed'].includes(status)) {
      return { status: 'completed', videoUrl: this.extractVideoUrl(result) || undefined }
    }
    if (['FAILED', 'failed', 'cancelled'].includes(status)) {
      return { status: 'failed', error: result.message || result.error?.message || 'Eggfans video generation failed' }
    }
    if (['PENDING', 'RUNNING', 'queued', 'in_progress', 'processing'].includes(status)) {
      return { status: 'processing' }
    }
    return { status: 'pending' }
  }

  extractVideoUrl(result: any): string | null {
    return result.output?.video_url
      || result.output?.results?.[0]?.url
      || result.data?.video_url
      || result.data?.url
      || result.data?.video?.url
      || result.data?.videos?.[0]?.url
      || result.data?.creations?.[0]?.url
      || result.data?.creations?.[0]?.video_url
      || result.data?.output?.video_url
      || result.data?.output?.results?.[0]?.url
      || result.video?.url
      || result.videos?.[0]?.url
      || result.creations?.[0]?.url
      || result.creations?.[0]?.video_url
      || result.video_url
      || result.url
      || null
  }

  private buildAliBailianRequest(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    const input: Record<string, unknown> = { prompt: record.prompt || '' }
    const media = this.buildMedia(record)
    if (media.length) input.media = media

    return {
      url: joinProviderUrl(config.baseUrl, '', config.endpoint || '/alibailian/api/v1/services/aigc/video-generation/video-synthesis'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: {
        model,
        input,
        parameters: {
          resolution: '720P',
          duration: normalizeDuration(record.duration),
          generate_audio: true,
          watermark: false,
        },
      },
    }
  }

  private buildOpenAIVideoRequest(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt || '',
      seconds: normalizeDuration(record.duration),
      size: record.aspectRatio || '16:9',
      generate_audio: true,
      watermark: false,
    }
    const images = this.buildMedia(record).map(item => item.url)
    if (images.length === 1) body.input_reference = images[0]
    if (images.length > 1) body.images = images

    return {
      url: joinProviderUrl(config.baseUrl, '', config.endpoint || '/v1/videos'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  private buildUnifiedVideoRequest(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt || '',
      duration: normalizeDuration(record.duration),
      aspect_ratio: record.aspectRatio || '16:9',
      enhance_prompt: true,
      enable_upsample: true,
      generate_audio: true,
      watermark: false,
    }

    const media = this.buildMedia(record).map(item => item.url)
    if (media.length) body.images = media

    return {
      url: joinProviderUrl(config.baseUrl, '', config.endpoint || '/v1/video/create'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  private buildGrokVideoRequest(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt || '',
      aspect_ratio: normalizeGrokAspectRatio(record.aspectRatio),
      size: '720P',
    }

    const images = this.buildGrokReferenceImages(record)
    if (images.length) body.images = images

    return {
      url: joinProviderUrl(config.baseUrl, '', config.endpoint || '/v1/video/create'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  private buildGrokReferenceImages(record: VideoGenerationRecord) {
    const media = this.buildMedia(record)
    if (media.length) return media.map(item => item.url).slice(0, 7)

    const fallback = [
      record.imageUrl,
      record.firstFrameUrl,
      record.lastFrameUrl,
    ]
      .map(url => String(url || '').trim())
      .filter((url, index, arr) => url && arr.indexOf(url) === index)

    return fallback.slice(0, 7)
  }

  private buildMiniMaxVideoRequest(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt || '',
      duration: normalizeDuration(record.duration),
      generate_audio: true,
      watermark: false,
    }
    const media = this.buildMedia(record).map(item => item.url)
    if (media[0]) body.first_frame_image = media[0]
    if (media[1]) body.last_frame_image = media[1]
    if (media.length > 2) body.images = media

    return {
      url: joinProviderUrl(config.baseUrl, '', config.endpoint || '/minimax/v1/video_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  private buildViduVideoRequest(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    const media = this.buildMedia(record).map(item => item.url)
    const endpoint = selectViduEndpoint(config, record, media)
    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt || '',
      generate_audio: true,
      watermark: false,
    }
    if (media.length) body.images = media
    if (record.duration) body.duration = normalizeDuration(record.duration)
    if (record.aspectRatio) body.aspect_ratio = record.aspectRatio

    return {
      url: joinProviderUrl(config.baseUrl, '', endpoint),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  private buildMedia(record: VideoGenerationRecord) {
    const media: Array<{ type: string; url: string }> = []
    if (record.referenceMode === 'single' && record.imageUrl) {
      media.push({ type: 'first_frame', url: record.imageUrl })
    }
    if (record.referenceMode === 'first_last') {
      if (record.firstFrameUrl) media.push({ type: 'first_frame', url: record.firstFrameUrl })
      if (record.lastFrameUrl) media.push({ type: 'last_frame', url: record.lastFrameUrl })
    }
    if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
      try {
        const refs = JSON.parse(record.referenceImageUrls)
        if (Array.isArray(refs)) {
          refs.filter((url): url is string => typeof url === 'string' && !!url)
            .slice(0, 9)
            .forEach(url => media.push({ type: 'reference_image', url }))
        }
      } catch {}
    }
    return media
  }

  private buildUnifiedPollRequest(config: AIConfig, id: string): ProviderRequest {
    const endpoint = config.queryEndpoint || '/v1/video/query'
    const url = joinProviderUrl(config.baseUrl, '', endpoint)
    const getUrl = new URL(url)
    getUrl.searchParams.set('id', id)
    return {
      url: getUrl.toString(),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  private buildMiniMaxPollRequest(config: AIConfig, id: string): ProviderRequest {
    const url = new URL(joinProviderUrl(config.baseUrl, '', config.queryEndpoint || '/minimax/v1/query/video_generation'))
    url.searchParams.set('task_id', id)
    return {
      url: url.toString(),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  private buildViduPollRequest(config: AIConfig, id: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '', `/ent/v2/tasks/${encodeURIComponent(id)}/creations`),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }
}

function inferEndpointTypes(model: string) {
  const normalized = model.toLowerCase()
  if (normalized.includes('happyhorse')) return ['happyhorse视频']
  if (normalized.includes('wan')) return ['wan视频生成']
  if (normalized.includes('hailuo') || normalized.includes('minimax')) return ['海螺视频生成']
  if (normalized.includes('vidu')) return ['vidu图生视频']
  if (normalized.includes('grok-video')) return ['grok视频']
  if (normalized.includes('veo_')) return ['openAI视频格式']
  if (normalized.includes('sora')) return ['openAI官方视频格式']
  if (normalized.includes('veo')) return ['视频统一格式']
  return ['openAI视频格式']
}

function isGrokVideoModel(model: string) {
  return model.toLowerCase().includes('grok-video')
}

function normalizeGrokAspectRatio(aspectRatio?: string | null) {
  const value = String(aspectRatio || '').trim()
  return ['2:3', '3:2', '1:1'].includes(value) ? value : '3:2'
}

function getEggfansRouteFamily(config: AIConfig, model: string): EggfansRouteFamily {
  const metadata = config.settings?.eggfans || {}
  if (metadata.routeFamily) return metadata.routeFamily
  const endpointTypes = Array.isArray(metadata.endpointTypes) && metadata.endpointTypes.length
    ? metadata.endpointTypes.map(String)
    : inferEndpointTypes(model)
  return resolveEggfansRoute('video', model, endpointTypes).family
}

function getTaskIdFamily(config?: AIConfig, record?: VideoGenerationRecord): VideoRequestFamily {
  if (!config) return 'openai'
  const model = record?.model || config.model
  const routeFamily = getEggfansRouteFamily(config, model)
  if (routeFamily === 'unified-video') return 'unified'
  if (routeFamily === 'minimax-video') return 'minimax'
  if (routeFamily === 'vidu-video') return 'vidu'
  if (routeFamily === 'alibailian-video') return 'alibailian'
  return 'openai'
}

function encodeTaskId(family: VideoRequestFamily, taskId: string) {
  if (family === 'unified') return `eggfans:unified:${taskId}`
  if (family === 'minimax') return `eggfans:minimax:${taskId}`
  if (family === 'vidu') return `eggfans:vidu:${taskId}`
  return taskId
}

function selectViduEndpoint(config: AIConfig, record: VideoGenerationRecord, media: string[]) {
  const endpoints = Array.isArray(config.settings?.eggfans?.endpoints)
    ? config.settings.eggfans.endpoints
    : []
  const canUseEndpoint = (type: string) => !endpoints.length || endpoints.some((endpoint: any) => endpoint?.type === type)
  if (record.referenceMode === 'first_last' && media.length >= 2 && canUseEndpoint('vidu首尾帧')) {
    return '/ent/v2/start-end2video'
  }
  if (record.referenceMode === 'multiple' && media.length && canUseEndpoint('vidu参考生视频')) {
    return '/ent/v2/reference2video'
  }
  if (media.length && canUseEndpoint('vidu图生视频')) return '/ent/v2/img2video'
  if (canUseEndpoint('vidu文生视频')) return '/ent/v2/text2video'
  return config.endpoint || (media.length ? '/ent/v2/img2video' : '/ent/v2/text2video')
}

function normalizeDuration(duration?: number | null) {
  const parsed = Math.round(Number(duration || 5))
  if (!Number.isFinite(parsed)) return 5
  return Math.min(12, Math.max(3, parsed))
}
