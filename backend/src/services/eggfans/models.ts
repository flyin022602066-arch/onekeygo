import { logTaskWarn } from '../../utils/task-logger.js'
import {
  resolveEggfansRoute,
  type EggfansRouteFamily,
} from './routing.js'

export type EggfansServiceType = 'text' | 'image' | 'video' | 'audio'

export interface EggfansPricingModel {
  model_name: string
  description?: string
  tags?: string
  model_type?: string
  vendor_id?: number
  quota_type?: number
  model_ratio?: number
  model_price?: number
  completion_ratio?: number
  enable_groups?: string[]
  supported_endpoint_types?: string[]
  sort_order?: number
}

export interface EggfansPricingResponse {
  success?: boolean
  auto_groups?: string[]
  data?: EggfansPricingModel[]
  supported_endpoint?: unknown
  vendors?: unknown
}

export interface EggfansEndpointDoc {
  type: string
  path: string
  method: string
}

export interface EggfansTransmissionParameters {
  requestShape: string
  requiredFields: string[]
  optionalFields: string[]
  imageField?: string
  durationField?: string
  aspectRatioField?: string
  sizeField?: string
  qualityField?: string
  defaults?: Record<string, unknown>
  pollMethod?: string
}

export interface NormalizedEggfansModel {
  name: string
  description: string
  serviceType: EggfansServiceType
  modelType: string
  tags: string[]
  endpointTypes: string[]
  endpoints: EggfansEndpointDoc[]
  routeFamily?: EggfansRouteFamily
  primaryEndpointType?: string
  endpointPath?: string
  endpointMethod?: string
  queryEndpointPath?: string
  queryEndpointMethod?: string
  transmissionParameters?: EggfansTransmissionParameters
  groups: string[]
  vendorId?: number
  quotaType?: number
  ratio: number
  price: number
  completionRatio: number
  sortOrder: number
}

export const EGGFANS_PRICING_URL = 'https://api.eggfans.org/api/pricing_new'
const CACHE_MS = 10 * 60 * 1000

let cachedAt = 0
let cachedModels: NormalizedEggfansModel[] = []

export async function getEggfansModels(fetchImpl: typeof fetch = fetch): Promise<NormalizedEggfansModel[]> {
  if (cachedModels.length && Date.now() - cachedAt < CACHE_MS) return cachedModels

  let resp: Response | null = null
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const requestUrl = `${EGGFANS_PRICING_URL}?_=${Date.now()}-${attempt}`
      const requestInit = {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mijing-Studio/2.0',
        },
        signal: AbortSignal.timeout(20_000),
      }
      try {
        resp = await fetchImpl(requestUrl, requestInit)
      } catch (error) {
        // Electron's embedded Node fetch can intermittently reset this host's
        // TLS connection. Fall back to the native https client for GETs.
        if (fetchImpl !== fetch) throw error
        resp = await fetchEggfansHttps(requestUrl, requestInit.headers)
      }
      if (resp.ok) break
      if (resp.status < 500 || attempt === 2) break
    } catch (error) {
      lastError = error
      if (attempt === 2) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)))
  }
  if (!resp) throw lastError instanceof Error ? lastError : new Error('Eggfans pricing fetch failed')
  if (!resp.ok) throw new Error(`Eggfans pricing fetch failed: ${resp.status}`)

  const payload = await resp.json() as EggfansPricingResponse
  cachedModels = normalizeEggfansCatalog(payload)
  cachedAt = Date.now()
  return cachedModels
}

function fetchEggfansHttps(url: string, headers: Record<string, string>): Promise<Response> {
  if (isElectronRuntime()) {
    return fetchEggfansElectronNet(url, headers).catch(() => fetchEggfansNodeHttps(url, headers))
  }
  return fetchEggfansNodeHttps(url, headers)
}

function isElectronRuntime() {
  return !!(process.versions as Record<string, string | undefined>).electron
}

function fetchEggfansElectronNet(url: string, headers: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    // Keep the backend package runnable under plain Node (tests/server mode)
    // while using Chromium's network stack in the packaged Electron app.
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>
    dynamicImport('electron').then(({ net }: { net: any }) => {
      const request = net.request({ method: 'GET', url })
      for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        callback()
      }
      request.on('response', (response: any) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer | Uint8Array | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        response.on('end', () => finish(() => resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode || 500,
          headers: response.headers || {},
        }))))
        response.on('error', (error: unknown) => finish(() => reject(error)))
      })
      request.on('error', (error: unknown) => finish(() => reject(error)))
      request.setTimeout?.(20_000, () => request.abort())
      request.end()
    }).catch(error => reject(error))
  })
}

function fetchEggfansNodeHttps(url: string, headers: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, servername: 'api.eggfans.org' }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode || 500,
        headers: response.headers as Record<string, string>,
      })))
    })
    request.setTimeout(20_000, () => request.destroy(new Error('Eggfans pricing request timed out')))
    request.on('error', reject)
  })
}

export function clearEggfansModelCache() {
  cachedAt = 0
  cachedModels = []
}

export function normalizeEggfansCatalog(payload: EggfansPricingResponse): NormalizedEggfansModel[] {
  const rows = Array.isArray(payload.data) ? payload.data : []
  const endpointMap = parseSupportedEndpointMap(payload.supported_endpoint)
  return rows
    .map(row => normalizeModel(row, endpointMap))
    .filter((model): model is NormalizedEggfansModel => !!model)
    .sort((a, b) => b.sortOrder - a.sortOrder || a.name.localeCompare(b.name))
}

export function filterEggfansModels(models: NormalizedEggfansModel[], serviceType?: string) {
  if (!serviceType) return models
  return models.filter(model => model.serviceType === serviceType)
}

function normalizeModel(row: EggfansPricingModel, endpointMap: Map<string, EggfansEndpointDoc>): NormalizedEggfansModel | null {
  const name = String(row.model_name || '').trim()
  if (!name) return null

  const tags = splitList(row.tags)
  const endpointTypes = Array.isArray(row.supported_endpoint_types)
    ? row.supported_endpoint_types.map(String).filter(Boolean)
    : []
  const serviceType = deriveServiceType(row.model_type || '', tags, endpointTypes)
  if (!serviceType) {
    logTaskWarn('EggfansModels', 'unsupported-model-type', {
      model: name,
      modelType: row.model_type,
      endpointTypes,
      tags,
    })
    return null
  }

  const endpoints = endpointTypes
    .map(type => endpointMap.get(type) || null)
    .filter((endpoint): endpoint is EggfansEndpointDoc => !!endpoint)
  const route = getRoute(serviceType, name, endpointTypes)
  const primaryEndpointType = selectPrimaryEndpointType(endpointTypes, route?.family)
  const primaryEndpoint = endpoints.find(endpoint => endpoint.type === primaryEndpointType) || endpoints[0]
  const endpointOverride = endpointOverrideForModel(serviceType, name)
  const queryEndpoint = route?.family ? queryEndpointForFamily(route.family) : undefined

  return {
    name,
    description: String(row.description || ''),
    serviceType,
    modelType: String(row.model_type || ''),
    tags,
    endpointTypes,
    endpoints,
    routeFamily: route?.family,
    primaryEndpointType: endpointOverride?.type || primaryEndpointType,
    endpointPath: endpointOverride?.path || normalizePath(primaryEndpoint?.path),
    endpointMethod: endpointOverride?.method || primaryEndpoint?.method,
    queryEndpointPath: queryEndpoint?.path,
    queryEndpointMethod: queryEndpoint?.method,
    transmissionParameters: route?.family ? transmissionParametersForModel(serviceType, name, route.family, endpointTypes) : undefined,
    groups: Array.isArray(row.enable_groups) ? row.enable_groups.map(String) : [],
    vendorId: row.vendor_id,
    quotaType: row.quota_type,
    ratio: Number(row.model_ratio || 0),
    price: Number(row.model_price || 0),
    completionRatio: Number(row.completion_ratio || 0),
    sortOrder: Number(row.sort_order || 0),
  }
}

function endpointOverrideForModel(serviceType: EggfansServiceType, name: string) {
  if (serviceType === 'image' && /^gpt-image-2(?:-all|-c)?$/i.test(String(name).trim())) {
    return { type: 'openai编辑图片', path: '/v1/images/edits', method: 'POST' }
  }
  return null
}

function parseSupportedEndpointMap(value: unknown) {
  const entries = new Map<string, EggfansEndpointDoc>()
  if (!value || typeof value !== 'object') return entries

  for (const [type, raw] of Object.entries(value as Record<string, any>)) {
    const path = normalizePath(raw?.path)
    const method = String(raw?.method || 'POST').toUpperCase()
    if (!path) continue
    entries.set(type, { type, path, method })
  }
  return entries
}

function getRoute(serviceType: EggfansServiceType, name: string, endpointTypes: string[]) {
  try {
    return resolveEggfansRoute(serviceType, name, endpointTypes)
  } catch {
    return null
  }
}

function selectPrimaryEndpointType(endpointTypes: string[], family?: EggfansRouteFamily) {
  const priorities: Record<string, string[]> = {
    'openai-chat': ['openai'],
    'openai-image': ['image-generation', 'images-generations', 'openai编辑图片', 'openai'],
    'alibailian-video': ['happyhorse视频', 'wan视频生成'],
    'unified-video': ['视频统一格式', 'grok视频'],
    'openai-video': ['openAI官方视频格式', 'openAI视频格式', 'grok视频openai格式'],
    'minimax-video': ['海螺视频生成'],
    'vidu-video': ['vidu图生视频', 'vidu首尾帧', 'vidu参考生视频', 'vidu文生视频'],
    'minimax-sync-tts': ['同步语音'],
    'openai-tts': ['openai'],
    'gemini-tts': ['GeminiTTS'],
  }
  const preferred = family ? priorities[family] || [] : []
  return preferred.find(type => endpointTypes.includes(type)) || endpointTypes[0]
}

function queryEndpointForFamily(family: EggfansRouteFamily) {
  const queryMap: Partial<Record<EggfansRouteFamily, { path: string; method: string }>> = {
    'alibailian-video': { path: '/alibailian/api/v1/tasks/{task_id}', method: 'GET' },
    'unified-video': { path: '/v1/video/query', method: 'GET' },
    'openai-video': { path: '/v1/videos/{id}', method: 'GET' },
    'minimax-video': { path: '/minimax/v1/query/video_generation', method: 'GET' },
    'vidu-video': { path: '/ent/v2/tasks/{id}/creations', method: 'GET' },
  }
  return queryMap[family]
}

function transmissionParametersForModel(
  serviceType: EggfansServiceType,
  modelName: string,
  family: EggfansRouteFamily,
  endpointTypes: string[],
): EggfansTransmissionParameters {
  if (serviceType === 'video' && modelName.toLowerCase().includes('grok-video')) {
    return {
      requestShape: 'Eggfans Grok video create',
      requiredFields: ['model', 'prompt'],
      optionalFields: ['images', 'aspect_ratio', 'size'],
      imageField: 'images[]',
      aspectRatioField: 'aspect_ratio',
      pollMethod: 'GET /v1/video/query?id={task_id}',
    }
  }

  if (serviceType === 'image' && /^gpt-image-2(?:-all|-c)?$/i.test(String(modelName).trim())) {
    return {
      ...transmissionParametersForFamily(family, endpointTypes),
      sizeField: 'size',
      qualityField: 'quality',
      defaults: { size: '1K', quality: 'high' },
    }
  }

  return transmissionParametersForFamily(family, endpointTypes)
}

function transmissionParametersForFamily(family: EggfansRouteFamily, endpointTypes: string[]): EggfansTransmissionParameters {
  const viduEndpointNote = endpointTypes.length > 1 ? `; endpoints: ${endpointTypes.join(',')}` : ''
  const table: Record<EggfansRouteFamily, EggfansTransmissionParameters> = {
    'openai-chat': {
      requestShape: 'OpenAI chat completions',
      requiredFields: ['model', 'messages'],
      optionalFields: ['temperature', 'max_tokens', 'stream'],
    },
    'openai-image': {
      requestShape: 'OpenAI images edits/generations',
      requiredFields: ['image', 'model', 'prompt'],
      optionalFields: ['mask', 'n', 'quality', 'size', 'background', 'moderation'],
      imageField: 'multipart image[]',
    },
    'alibailian-video': {
      requestShape: 'AliBailian video synthesis',
      requiredFields: ['model', 'input.prompt'],
      optionalFields: ['input.media', 'parameters.resolution', 'parameters.aspect_ratio', 'parameters.duration', 'parameters.generate_audio', 'parameters.watermark'],
      imageField: 'input.media[].url',
      durationField: 'parameters.duration',
      pollMethod: 'GET /alibailian/api/v1/tasks/{task_id}',
    },
    'unified-video': {
      requestShape: 'Eggfans unified video create',
      requiredFields: ['model', 'prompt'],
      optionalFields: ['images', 'aspect_ratio', 'duration', 'enhance_prompt', 'enable_upsample', 'generate_audio', 'watermark'],
      imageField: 'images[]',
      durationField: 'duration',
      aspectRatioField: 'aspect_ratio',
      pollMethod: 'GET /v1/video/query?id={task_id}',
    },
    'openai-video': {
      requestShape: 'OpenAI-compatible videos',
      requiredFields: ['model', 'prompt'],
      optionalFields: ['seconds', 'size', 'input_reference', 'images', 'generate_audio', 'watermark'],
      imageField: 'input_reference/images[]',
      durationField: 'seconds',
      aspectRatioField: 'size',
      pollMethod: 'GET /v1/videos/{id}',
    },
    'minimax-video': {
      requestShape: 'MiniMax/Hailuo video generation',
      requiredFields: ['model', 'prompt'],
      optionalFields: ['duration', 'first_frame_image', 'last_frame_image', 'images', 'generate_audio', 'watermark'],
      imageField: 'first_frame_image/last_frame_image/images[]',
      durationField: 'duration',
      pollMethod: 'GET /minimax/v1/query/video_generation?task_id={task_id}',
    },
    'vidu-video': {
      requestShape: `Vidu video generation${viduEndpointNote}`,
      requiredFields: ['model', 'prompt'],
      optionalFields: ['images', 'duration', 'aspect_ratio', 'resolution', 'generate_audio', 'watermark'],
      imageField: 'images[]',
      durationField: 'duration',
      aspectRatioField: 'aspect_ratio',
      pollMethod: 'GET /ent/v2/tasks/{id}/creations',
    },
    'minimax-sync-tts': {
      requestShape: 'MiniMax sync TTS',
      requiredFields: ['model', 'text'],
      optionalFields: ['voice_id', 'speed', 'vol', 'pitch'],
    },
    'openai-tts': {
      requestShape: 'OpenAI audio speech',
      requiredFields: ['model', 'input', 'voice'],
      optionalFields: ['response_format', 'speed'],
    },
    'gemini-tts': {
      requestShape: 'Gemini TTS generateContent',
      requiredFields: ['model', 'contents'],
      optionalFields: ['generationConfig'],
    },
  }
  return table[family]
}

function normalizePath(path?: string) {
  if (!path) return undefined
  return `/${String(path).replace(/^\/+/, '')}`
}

function deriveServiceType(modelType: string, tags: string[], endpointTypes: string[]): EggfansServiceType | null {
  const modelTypeText = modelType.toLowerCase()
  const tagText = tags.join(',').toLowerCase()
  const endpointText = endpointTypes.join(',').toLowerCase()

  if (['文本', '对话', 'text', 'chat'].some(value => modelTypeText === value || modelTypeText.includes(value))) return 'text'
  if (['图像', '图片', 'image'].some(value => modelTypeText === value || modelTypeText.includes(value))) return 'image'
  if (modelType === '音视频' && tagText.includes('音频')) return 'audio'
  if (modelType === '音视频' && tagText.includes('视频')) return 'video'
  if (endpointText.includes('tts') || endpointText.includes('语音') || tagText.includes('音频')) return 'audio'
  if (endpointText.includes('video') || endpointText.includes('视频') || endpointText.includes('瑙嗛') || tagText.includes('视频') || tagText.includes('瑙嗛')) return 'video'
  if (endpointText.includes('image') || endpointText.includes('图像') || endpointText.includes('图片') || endpointText.includes('鍥惧儚') || tagText.includes('绘画') || tagText.includes('缁樼敾')) return 'image'
  if (endpointText.includes('openai') && (modelTypeText.includes('text') || tagText.includes('对话') || tagText.includes('瀵硅瘽'))) return 'text'
  return null
}

function splitList(value?: string) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}
import https from 'node:https'
