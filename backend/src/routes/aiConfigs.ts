import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'
import { sanitizeAiConfigForClient } from '../utils/secrets.js'
import {
  getEggfansModels,
  type NormalizedEggfansModel,
} from '../services/eggfans/models.js'
import {
  MIJING_BASE_URL,
  type NormalizedMijingModel,
} from '../services/mijing/models.js'
import { getConfigById } from '../services/ai.js'

const app = new Hono()

const EGGFANS_BASE_URL = 'https://api.eggfans.com'
const EGGFANS_IMAGE_HOST_UPLOAD_URL = 'https://imageproxy.zhongzhuan.chat/api/upload'
const OFFICIAL_VOLCENGINE_BASE_URL = 'https://ark.cn-beijing.volces.com'
export const OFFICIAL_SEEDANCE_2_MODEL = 'doubao-seedance-2-0-260128'
type PresetServiceType = 'text' | 'image' | 'video' | 'audio'

const EGGFANS_PRESET_SERVICES: Array<{
  serviceType: PresetServiceType
  label: string
  provider: string
  baseUrl: string
  model: string
  priority: number
}> = [
  { serviceType: 'text', label: '文本', provider: 'eggfans', baseUrl: EGGFANS_BASE_URL, model: 'gpt-5.5', priority: getPresetPriority('text', 'eggfans') },
  { serviceType: 'image', label: '图片', provider: 'eggfans', baseUrl: EGGFANS_BASE_URL, model: 'gpt-image-2-c', priority: getPresetPriority('image', 'eggfans') },
  { serviceType: 'video', label: '视频', provider: 'eggfans', baseUrl: EGGFANS_BASE_URL, model: 'grok-video-3-10s', priority: getPresetPriority('video', 'eggfans') },
  { serviceType: 'audio', label: '音频', provider: 'eggfans', baseUrl: EGGFANS_BASE_URL, model: 'speech-2.8-hd', priority: getPresetPriority('audio', 'eggfans') },
] as const

const OFFICIAL_SEEDANCE_PRESET = {
  serviceType: 'video',
  label: 'Seedance 2.0 官方视频',
  provider: 'volcengine',
  baseUrl: OFFICIAL_VOLCENGINE_BASE_URL,
  model: OFFICIAL_SEEDANCE_2_MODEL,
  priority: getPresetPriority('video', 'volcengine'),
} as const

const EGGFANS_AGENT_DEFAULTS = [
  { agentType: 'script_rewriter', name: '剧本改写' },
  { agentType: 'extractor', name: '角色场景提取' },
  { agentType: 'storyboard_breaker', name: '分镜拆解' },
  { agentType: 'voice_assigner', name: '音色分配' },
  { agentType: 'grid_prompt_generator', name: '图片提示词生成' },
] as const

const EGGFANS_AGENT_MODEL = ''

export function getPresetPriority(serviceType: PresetServiceType, provider: string) {
  const normalizedProvider = provider.toLowerCase()
  if (serviceType === 'video' && normalizedProvider === 'volcengine') return 108
  if (serviceType === 'video' && normalizedProvider === 'eggfans') return 98
  if (serviceType === 'text') return 100
  if (serviceType === 'image') return 99
  if (serviceType === 'audio') return 97
  return 0
}

export function resolveOfficialSeedanceApiKey(seedanceApiKey: unknown, eggfansApiKey: unknown) {
  const key = String(seedanceApiKey || '').trim()
  const eggfans = String(eggfansApiKey || '').trim()
  return key && key !== eggfans ? key : ''
}

function parseModels(model?: string | null): string[] {
  return model ? JSON.parse(model) : []
}

function toClientConfig(row: typeof schema.aiServiceConfigs.$inferSelect) {
  return sanitizeAiConfigForClient({
    ...toSnakeCase(row),
    model: parseModels(row.model),
    settings: parseSettings(row.settings),
  })
}

async function upsertPresetConfig(preset: {
  serviceType: PresetServiceType
  provider: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  priority: number
  updatedAt: string
}) {
  const metadata = preset.provider === 'eggfans'
    ? buildEggfansConfigMetadata(preset.serviceType, preset.model, await getEggfansModels())
    : preset.provider === 'volcengine' && preset.serviceType === 'video' && preset.model === OFFICIAL_SEEDANCE_2_MODEL
      ? buildOfficialSeedanceConfigMetadata(preset.model)
    : {}
  const [existing] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, preset.serviceType))
    .all()
    .filter(row => row.provider === preset.provider && parseModels(row.model).includes(preset.model))

  const values = {
    serviceType: preset.serviceType,
    provider: preset.provider,
    name: preset.name,
    baseUrl: preset.baseUrl,
    apiKey: preset.apiKey || existing?.apiKey || '',
    model: JSON.stringify([preset.model]),
    ...metadata,
    priority: preset.priority,
    // Reapplying the preset updates endpoint/model metadata but must not
    // silently undo a user's explicit enable/disable choice.
    isActive: existing?.isActive ?? true,
    updatedAt: preset.updatedAt,
  }

  if (existing) {
    db.update(schema.aiServiceConfigs).set(values).where(eq(schema.aiServiceConfigs.id, existing.id)).run()
    return
  }

  db.insert(schema.aiServiceConfigs).values({
    ...values,
    createdAt: preset.updatedAt,
  }).run()
}

function parseSettings(value?: string | null) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function sanitizeSettings(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, any>
}

function serializeSettings(value: unknown) {
  const settings = sanitizeSettings(value)
  return settings ? JSON.stringify(settings) : null
}

function parsePresetModelOverrides(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const overrides: Partial<Record<PresetServiceType, string>> = {}
  for (const type of ['text', 'image', 'video', 'audio'] as const) {
    const model = String((value as Record<string, unknown>)[type] || '').trim()
    if (model) overrides[type] = model
  }
  return overrides
}

function buildEggfansConfigMetadata(
  serviceType: PresetServiceType,
  modelName: string,
  models: NormalizedEggfansModel[],
) {
  const model = models.find(item => item.serviceType === serviceType && item.name === modelName)
  if (!model) return {}
  return {
    endpoint: model.endpointPath || null,
    queryEndpoint: model.queryEndpointPath || null,
    settings: JSON.stringify({
      eggfans: {
        modelName: model.name,
        serviceType: model.serviceType,
        modelType: model.modelType,
        tags: model.tags,
        endpointTypes: model.endpointTypes,
        endpoints: model.endpoints,
        routeFamily: model.routeFamily,
        primaryEndpointType: model.primaryEndpointType,
        endpointMethod: model.endpointMethod,
        queryEndpointMethod: model.queryEndpointMethod,
        transmissionParameters: model.transmissionParameters,
        price: model.price,
        quotaType: model.quotaType,
        vendorId: model.vendorId,
      },
    }),
  }
}

export function buildMijingConfigMetadata(
  serviceType: string,
  modelName: string,
  models: NormalizedMijingModel[],
) {
  const model = models.find(item => item.serviceType === serviceType && item.name === modelName)
  if (!model) return {}
  return {
    endpoint: model.endpointPath || null,
    queryEndpoint: model.queryEndpointPath || null,
    settings: JSON.stringify({
      mijing: {
        modelName: model.name,
        displayName: model.displayName,
        serviceType: model.serviceType,
        modelType: model.modelType,
        endpointMethod: model.endpointMethod,
        queryEndpointMethod: model.queryEndpointMethod,
        extraJson: model.extraJson,
        transmissionParameters: model.transmissionParameters,
        defaults: model.serviceType === 'video'
          ? {
            watermark: false,
            generate_audio: true,
            resolution: '720p',
          }
        : model.serviceType === 'image' && /^gpt-image-2$/i.test(model.name)
            ? {
              size: '1K',
              quality: 'high',
            }
          : undefined,
      },
    }),
  }
}

export function buildOfficialSeedanceConfigMetadata(modelName = OFFICIAL_SEEDANCE_2_MODEL) {
  return {
    endpoint: '/api/v3/contents/generations/tasks',
    queryEndpoint: '/api/v3/contents/generations/tasks/{task_id}',
    settings: JSON.stringify({
      seedance: {
        official: true,
        provider: 'volcengine',
        modelName,
        requestPath: '/api/v3/contents/generations/tasks',
        queryPath: '/api/v3/contents/generations/tasks/{task_id}',
        transmissionParameters: {
          requestShape: 'VolcEngine Seedance 2.0 content generation task',
          requiredFields: ['model', 'content'],
          optionalFields: ['duration', 'ratio', 'generate_audio', 'watermark'],
        },
        defaults: {
          generate_audio: true,
          watermark: false,
          ratio: 'adaptive',
        },
        duration: {
          min: 4,
          max: 12,
          default: 5,
        },
        referenceMode: 'Use uploaded Volc asset IDs in prompt text with @asset://...',
      },
    }),
  }
}

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function geminiHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
    headers['x-goog-api-key'] = apiKey
  }
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function viduHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Token ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

export function buildProbe(
  serviceType: string,
  provider: string,
  baseUrl: string,
  model?: string,
  apiKey?: string,
  endpoint?: string | null,
) {
  const p = provider.toLowerCase()
  const m = model || ''

  if (serviceType === 'asset' || p === 'volcengine_asset' || p === 'shanhe_volc_asset') {
    return {
      method: 'GET',
      url: buildAssetGroupListUrl(baseUrl),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (serviceType === 'image_host' || p === 'eggfans_image_host') {
    return {
      method: 'POST',
      url: baseUrl || EGGFANS_IMAGE_HOST_UPLOAD_URL,
      headers: bearerHeaders(apiKey),
      body: buildImageHostProbeBody(),
    }
  }

  if (p === 'gemini') {
    const url = new URL(joinProviderUrl(baseUrl, '/v1beta', `/models/${m || 'gemini-2.5-flash'}:generateContent`))
    if (apiKey) url.searchParams.set('key', apiKey)
    return { method: 'POST', url: url.toString(), headers: geminiHeaders(apiKey, true), body: {} }
  }

  if (p === 'mijing') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl || MIJING_BASE_URL, '/v1', '/aimodels'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'openai' || p === 'openrouter' || p === 'chatfire' || p === 'eggfans') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'ali') {
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v1', serviceType === 'video'
        ? '/services/aigc/video-generation/video-synthesis'
        : '/services/aigc/image-generation/generation'),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'volcengine') {
    const path = serviceType === 'video'
      ? '/contents/generations/tasks'
      : '/images/generations'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v3', path),
      headers: bearerHeaders(apiKey, true),
      body: buildVolcengineProbeBody(serviceType, m),
    }
  }

  if (p === 'minimax') {
    const path = serviceType === 'audio'
      ? '/t2a_v2'
      : serviceType === 'video'
        ? '/video_generation'
        : '/image_generation'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/v1', path),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'vidu') {
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '', '/ent/v2/img2video'),
      headers: viduHeaders(apiKey, true),
      body: {},
    }
  }

  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '', m ? `/${m}` : '/'),
    headers: bearerHeaders(apiKey),
    body: undefined,
  }
}

function buildAssetGroupListUrl(baseUrl: string) {
  const url = new URL(joinProviderUrl(baseUrl, '/v1', '/assets/groups'))
  url.searchParams.set('page', '1')
  url.searchParams.set('page_size', '1')
  return url.toString()
}

function buildMediaProbeBody(serviceType: string, model: string) {
  const body: Record<string, unknown> = {}
  if (model) body.model = model
  if (serviceType === 'image') body.prompt = ''
  if (serviceType === 'video') body.prompt = ''
  if (serviceType === 'audio') body.input = ''
  return body
}

function buildImageHostProbeBody() {
  const form = new FormData()
  const png1x1 = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x00, 0x01,
    0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ])
  form.append('file', new File([png1x1], 'eggfans-image-host-probe.png', { type: 'image/png' }))
  return form
}

function buildVolcengineProbeBody(serviceType: string, model: string) {
  const body: Record<string, unknown> = {}
  if (model) body.model = model
  if (serviceType === 'video') {
    // Intentionally incomplete: validates key/model/path without starting a paid task.
    body.content = []
    body.generate_audio = true
    body.watermark = false
  } else {
    body.prompt = ''
  }
  return body
}

function previewProbeBody(body: unknown) {
  if (body instanceof FormData) return '[multipart/form-data]'
  if (!body || typeof body !== 'object') return ''
  try {
    return JSON.stringify(body)
  } catch {
    return ''
  }
}

export function isParameterValidationResponse(status: number, text: string) {
  if (status >= 200 && status < 300) return true
  if ([401, 403, 404].includes(status)) return false
  if (status < 400 || status >= 500) return false
  const normalized = text.toLowerCase()
  return [
    'prompt is required',
    'input is required',
    'content',
    'model',
    'missing',
    'required',
    'invalid_request',
    'invalid parameter',
    '参数',
    '必填',
  ].some(marker => normalized.includes(marker))
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = db.select().from(schema.aiServiceConfigs).all()
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(toClientConfig)
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, 'service_type and provider are required')
  }

  const res = db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: body.base_url || '',
    apiKey: body.api_key || '',
    model: JSON.stringify(body.model || []),
    endpoint: body.endpoint || null,
    queryEndpoint: body.query_endpoint || null,
    settings: serializeSettings(body.settings),
    priority: body.priority || 0,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [row] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, Number(res.lastInsertRowid))).all()

  return created(c, {
    ...toClientConfig(row),
  })
})

// POST /ai-configs/eggfans-preset
app.post('/eggfans-preset', async (c) => {
  const body = await c.req.json()
  const apiKey = String(body.api_key || '').trim()
  const seedanceApiKey = resolveOfficialSeedanceApiKey(body.seedance_api_key, apiKey)
  if (!apiKey) return badRequest(c, 'api_key is required')

  const ts = now()
  const modelOverrides = parsePresetModelOverrides(body.models)
  const services = EGGFANS_PRESET_SERVICES.map(preset => ({
    ...preset,
    model: modelOverrides[preset.serviceType] || preset.model,
  }))

  for (const preset of services) {
    await upsertPresetConfig({
      ...preset,
      name: `Eggfans ${preset.label}服务`,
      apiKey,
      updatedAt: ts,
    })
  }

  await upsertPresetConfig({
    ...OFFICIAL_SEEDANCE_PRESET,
    name: OFFICIAL_SEEDANCE_PRESET.label,
    apiKey: seedanceApiKey,
    updatedAt: ts,
  })

  for (const agent of EGGFANS_AGENT_DEFAULTS) {
    const [existing] = db.select().from(schema.agentConfigs).where(eq(schema.agentConfigs.agentType, agent.agentType)).all()
    const maxTokens = agent.agentType === 'storyboard_breaker' ? 12000 : 4096
    const maxIterations = agent.agentType === 'storyboard_breaker' ? 20 : 10
    const values = {
      name: agent.name,
      model: '',
      maxTokens,
      maxIterations,
      isActive: true,
      updatedAt: ts,
    }

    if (existing) {
      db.update(schema.agentConfigs).set(values).where(eq(schema.agentConfigs.id, existing.id)).run()
    } else {
      db.insert(schema.agentConfigs).values({
        agentType: agent.agentType,
        description: '',
        model: '',
        name: agent.name,
        systemPrompt: '',
        temperature: 0.7,
        maxTokens,
        maxIterations,
        isActive: true,
        createdAt: ts,
        updatedAt: ts,
      }).run()
    }
  }

  const configs = db.select().from(schema.aiServiceConfigs).all().map(toClientConfig)
  const agents = db.select().from(schema.agentConfigs).all().map(row => toSnakeCase(row))
  logTaskSuccess('AIConfig', 'eggfans-preset-applied', {
    serviceCount: services.length,
    agentCount: EGGFANS_AGENT_DEFAULTS.length,
    seedanceOfficial: true,
  })

  return success(c, {
    configs,
    agents,
    agent_model: '',
    preset_models: Object.fromEntries(services.map(item => [item.serviceType, item.model])),
    seedance_provider: OFFICIAL_SEEDANCE_PRESET.provider,
    seedance_base_url: OFFICIAL_SEEDANCE_PRESET.baseUrl,
    seedance_model: OFFICIAL_SEEDANCE_PRESET.model,
  })
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  const body = await c.req.json()
  let serviceType = body.service_type
  let provider = body.provider
  let baseUrl = body.base_url
  let apiKey = body.api_key
  let model = Array.isArray(body.model) ? body.model[0] : body.model

  if (body.id && !apiKey) {
    const [row] = db.select().from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.id, Number(body.id))).all()
    if (!row) return notFound(c)
    const resolvedConfig = getConfigById(Number(body.id))
    serviceType = serviceType || row.serviceType
    provider = provider || row.provider
    baseUrl = baseUrl || row.baseUrl
    apiKey = resolvedConfig?.apiKey || row.apiKey
    model = model || parseModels(row.model)[0]
    body.endpoint = body.endpoint || row.endpoint
  }

  if (!serviceType || !provider || !baseUrl) {
    return badRequest(c, 'service_type, provider and base_url are required')
  }

  const probe = buildProbe(serviceType, provider, baseUrl, model, apiKey, body.endpoint)
  const probeUrl = redactUrl(probe.url)

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType,
    provider,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const resp = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body instanceof FormData ? probe.body : probe.body ? JSON.stringify(probe.body) : undefined,
    })
    const text = await resp.text()
    const reachable = resp.ok
    const parameterAwareResponse = !resp.ok && !!probe.body && isParameterValidationResponse(resp.status, text)
    const passed = reachable || parameterAwareResponse
    const payload = {
      ok: resp.ok,
      reachable: passed,
      status: resp.status,
      status_text: resp.statusText,
      method: probe.method,
      url: probeUrl,
      request_preview: previewProbeBody(probe.body),
      message: buildProbeMessage(resp.status, resp.ok, parameterAwareResponse, text, String(provider || ''), String(model || '')),
      response_preview: text.slice(0, 240),
    }
    if (passed) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    logTaskError('AIConfig', 'probe-failed', {
      provider,
      url: probeUrl,
      error: error.message,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      request_preview: previewProbeBody(probe.body),
      message: error.message || '请求失败',
      response_preview: '',
    })
  }
})

function buildProbeMessage(
  status: number,
  ok: boolean,
  parameterAwareResponse: boolean,
  text: string,
  provider: string,
  model: string,
) {
  if (ok) return '端点可访问，认证与路径正常'
  const lowerProvider = provider.toLowerCase()
  const normalized = text.toLowerCase()
  if (status === 401 || normalized.includes('authenticationerror')) {
    return lowerProvider === 'volcengine'
      ? '火山认证失败：请确认填写的是火山方舟 API Key，不是 Eggfans 聚合站 Key'
      : '认证失败：请检查 API Key 格式和所属服务商'
  }
  if (status === 403) return '认证通过但没有权限：请检查账号是否已开通该模型或权限策略'
  if (status === 404) {
    if (lowerProvider === 'volcengine' && normalized.includes('invalidendpointormodel')) {
      return `火山模型不可用：${model || '当前模型'} 不存在或账号未开通，请在火山方舟确认模型 ID`
    }
    return '端点不存在：请检查 Base URL、路径前缀和模型端点'
  }
  if (parameterAwareResponse) return '端点已响应，认证/模型/路径基本正常；当前失败来自测试请求缺少生成内容'
  return '端点未按预期响应，请检查 Base URL、API Key、模型权限和代理前缀'
}

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id)).all()
  if (!row) return notFound(c)
  return success(c, {
    ...toClientConfig(row),
  })
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }

  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  if ('api_key' in body && String(body.api_key || '').trim()) updates.apiKey = String(body.api_key).trim()
  if ('model' in body) updates.model = JSON.stringify(body.model)
  if ('endpoint' in body) updates.endpoint = body.endpoint || null
  if ('query_endpoint' in body) updates.queryEndpoint = body.query_endpoint || null
  if ('settings' in body) updates.settings = serializeSettings(body.settings)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active

  db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id)).run()
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id)).run()
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = db.select().from(schema.aiServiceProviders).all()
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
