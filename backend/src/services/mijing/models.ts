export type MijingServiceType = 'text' | 'image' | 'video'

export interface MijingAimodel {
  name?: string
  display_name?: string
  displayName?: string
  type?: string
  model_type?: string
  modelType?: string
  description?: string
  extra_json?: unknown
  extraJson?: unknown
}

export interface MijingModelsResponse {
  success?: boolean
  data?: MijingAimodel[] | { models?: MijingAimodel[]; items?: MijingAimodel[] }
  models?: MijingAimodel[]
  items?: MijingAimodel[]
}

export interface MijingTransmissionParameters {
  requestShape: string
  requiredFields: string[]
  optionalFields: string[]
  imageField?: string
  sizeField?: string
  qualityField?: string
  defaults?: Record<string, unknown>
  durationField?: string
  aspectRatioField?: string
  pollMethod?: string
}

export interface NormalizedMijingModel {
  name: string
  displayName: string
  description: string
  serviceType: MijingServiceType
  modelType: string
  endpointPath: string
  endpointMethod: string
  queryEndpointPath?: string
  queryEndpointMethod?: string
  extraJson: Record<string, unknown> | null
  transmissionParameters: MijingTransmissionParameters
}

// api.mjing.cc is documented as a test environment. Use the production
// gateway for newly created configurations, while still respecting any
// explicitly saved legacy gateway.
export const MIJING_BASE_URL = 'https://api.magine.work'
export const MIJING_CREATION_BASE_URL = MIJING_BASE_URL
export const MIJING_CREATION_VIDEO_MODEL = 'seedance2.0创作版'

/**
 * Keep the gateway selected in the saved config. Some tenant API keys are
 * scoped to a specific Mijing gateway, so rewriting a configured URL would
 * make a successful configuration test fail at
 * runtime with an authentication error.
 */
export function resolveMijingStandardBaseUrl(baseUrl?: string | null) {
  const configured = String(baseUrl || '').trim().replace(/\/+$/, '')
  return configured || MIJING_BASE_URL
}
const CACHE_MS = 10 * 60 * 1000

let cachedKey = ''
let cachedAt = 0
let cachedModels: NormalizedMijingModel[] = []

export async function getMijingModels(
  apiKey = '',
  baseUrl = MIJING_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedMijingModel[]> {
  const cacheKey = `${baseUrl}|${apiKey ? 'auth' : 'anon'}`
  if (cachedModels.length && cachedKey === cacheKey && Date.now() - cachedAt < CACHE_MS) return cachedModels

  const resp = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/aimodels`, {
    method: 'GET',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  })
  if (!resp.ok) throw new Error(`Mijing models fetch failed: ${resp.status}`)

  const payload = await resp.json() as MijingModelsResponse
  cachedModels = normalizeMijingCatalog(payload)
  cachedAt = Date.now()
  cachedKey = cacheKey
  return cachedModels
}

export function clearMijingModelCache() {
  cachedAt = 0
  cachedKey = ''
  cachedModels = []
}

export function normalizeMijingCatalog(payload: MijingModelsResponse): NormalizedMijingModel[] {
  return extractRows(payload)
    .map(normalizeModel)
    .filter((model): model is NormalizedMijingModel => !!model)
    .sort((a, b) => serviceOrder(a.serviceType) - serviceOrder(b.serviceType) || a.name.localeCompare(b.name))
}

export function filterMijingModels(models: NormalizedMijingModel[], serviceType?: string) {
  if (!serviceType) return models
  return models.filter(model => model.serviceType === serviceType)
}

function extractRows(payload: MijingModelsResponse) {
  if (Array.isArray(payload)) return payload as MijingAimodel[]
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.data?.models)) return payload.data.models
  if (Array.isArray(payload.data?.items)) return payload.data.items
  if (Array.isArray(payload.models)) return payload.models
  if (Array.isArray(payload.items)) return payload.items
  return []
}

function normalizeModel(row: MijingAimodel): NormalizedMijingModel | null {
  const name = String(row.name || '').trim()
  if (!name) return null

  const serviceType = normalizeServiceType(row.type || row.model_type || row.modelType)
  if (!serviceType) return null

  const endpoints = endpointsForServiceType(serviceType)
  return {
    name,
    displayName: String(row.display_name || row.displayName || name),
    description: String(row.description || ''),
    serviceType,
    modelType: String(row.model_type || row.modelType || row.type || ''),
    endpointPath: endpoints.create.path,
    endpointMethod: endpoints.create.method,
    queryEndpointPath: endpoints.query?.path,
    queryEndpointMethod: endpoints.query?.method,
    extraJson: parseExtraJson(row.extra_json ?? row.extraJson),
    transmissionParameters: transmissionParametersForServiceType(serviceType, name),
  }
}

function normalizeServiceType(value: unknown): MijingServiceType | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (['chat', 'text', 'llm', 'conversation'].includes(normalized)) return 'text'
  if (['image', 'img', 'picture'].includes(normalized)) return 'image'
  if (['video', 'media'].includes(normalized)) return 'video'
  return null
}

function endpointsForServiceType(serviceType: MijingServiceType) {
  if (serviceType === 'text') {
    return { create: { path: '/v1/chat/completions', method: 'POST' } }
  }
  if (serviceType === 'image') {
    return {
      create: { path: '/v1/images/generations', method: 'POST' },
      query: { path: '/v1/images/generations/{task_id}', method: 'GET' },
    }
  }
  return {
    create: { path: '/v1/video/generations', method: 'POST' },
    query: { path: '/v1/video/generations/{task_id}', method: 'GET' },
  }
}

function transmissionParametersForServiceType(
  serviceType: MijingServiceType,
  modelName: string,
): MijingTransmissionParameters {
  if (serviceType === 'text') {
    return {
      requestShape: 'OpenAI chat completions',
      requiredFields: ['model', 'messages'],
      optionalFields: ['temperature', 'max_tokens', 'stream'],
    }
  }

  if (serviceType === 'image') {
    const isGptImage2 = /^gpt-image-2$/i.test(modelName)
    const isGptImage2All = /^gpt-image-2-all$/i.test(modelName)
    return {
      requestShape: 'Mijing images generations',
      requiredFields: ['model', 'prompt'],
      optionalFields: ['image', 'size', 'quality', 'n', 'response_format'],
      imageField: 'image',
      sizeField: 'size',
      qualityField: 'quality',
      defaults: isGptImage2
        ? { size: '1K', quality: 'high' }
        : isGptImage2All
          ? { size: '3840x2160', quality: 'high' }
          : undefined,
      pollMethod: 'GET /v1/images/generations/{task_id}',
    }
  }

  return {
    requestShape: isMijingSeedanceCreation(modelName)
      ? 'Mijing Seedance 2.0 creation video generations'
      : 'Mijing video generations',
    requiredFields: ['model', 'prompt'],
    optionalFields: [
      'image_url',
      'image_end_url',
      'image_role',
      'reference_image_urls',
      'reference_video_urls',
      'reference_audio_urls',
      'duration',
      'ratio',
      'watermark',
      'generate_audio',
      'resolution',
      'camera_fixed',
      'prompt_extend',
      'seed',
      'return_last_frame',
    ],
    imageField: 'image_url/reference_image_urls[]',
    durationField: 'duration',
    aspectRatioField: 'ratio',
    pollMethod: 'GET /v1/video/generations/{task_id}',
  }
}

function isMijingSeedanceCreation(modelName: string) {
  const normalized = modelName.toLowerCase()
  return normalized.includes('seedance') || normalized.includes('seedance2.0') || modelName.includes('创作版')
}

function parseExtraJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function serviceOrder(serviceType: MijingServiceType) {
  if (serviceType === 'text') return 0
  if (serviceType === 'image') return 1
  return 2
}
