/**
 * AI 服务抽象层 — 从数据库配置中获取 provider 和 API key
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'
import { maskSecret } from '../utils/secrets.js'
import { resolveMijingStandardBaseUrl } from './mijing/models.js'

export type ServiceType = 'text' | 'image' | 'video' | 'audio' | 'asset' | 'image_host'

export interface AIConfig {
  id?: number
  serviceType?: ServiceType
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  endpoint?: string | null
  queryEndpoint?: string | null
  settings?: Record<string, any> | null
}

export function getTextProviderBaseUrl(config: AIConfig) {
  const provider = config.provider.toLowerCase()

  if (provider === 'mijing') {
    // Mijing uses separate gateways: api.mjing.cc serves the OpenAI-compatible
    // text/image APIs, while api.magine.work is the Seedance creation gateway.
    // A video base URL must never be reused for storyboard text requests.
    return joinProviderUrl(resolveMijingStandardBaseUrl(config.baseUrl), '/v1', '')
  }

  if (provider === 'openai' || provider === 'openrouter' || provider === 'chatfire' || provider === 'eggfans') {
    return joinProviderUrl(config.baseUrl, '/v1', '')
  }

  if (provider === 'volcengine') {
    return joinProviderUrl(config.baseUrl, '/api/v3', '')
  }

  if (provider === 'ali') {
    return joinProviderUrl(config.baseUrl, '/api/v1', '')
  }

  return config.baseUrl
}

export function getActiveConfig(serviceType: ServiceType): AIConfig | null {
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, serviceType))
    .all()
    .filter(r => r.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)) // 高优先级优先

  const active = rows[0]
  if (!active) {
    logTaskWarn('AIConfig', 'active-config-missing', { serviceType })
    return null
  }

  const models = active.model ? JSON.parse(active.model) : []
  const settings = parseSettings(active.settings)
  logTaskProgress('AIConfig', 'active-config-selected', {
    serviceType,
    configId: active.id,
    provider: active.provider,
    model: models[0] || '',
    priority: active.priority,
  })
  return {
    id: active.id,
    serviceType: active.serviceType as ServiceType,
    provider: active.provider || '',
    baseUrl: active.baseUrl,
    apiKey: resolveConfigApiKey(active),
    model: models[0] || '',
    endpoint: active.endpoint || null,
    queryEndpoint: active.queryEndpoint || null,
    settings,
  }
}

export function getTextConfig(): AIConfig {
  const config = getActiveConfig('text')
  if (!config) throw new Error('No active text AI config')
  return config
}

export function getAudioConfig(): AIConfig {
  const config = getActiveConfig('audio')
  if (!config) throw new Error('No active audio AI config — 请在设置中添加音频服务')
  return config
}

export function getAudioConfigById(id?: number | null): AIConfig {
  if (id) {
    const config = getConfigById(id)
    if (config) return config
  }
  return getAudioConfig()
}

export function getConfigById(id: number): AIConfig | null {
  const [row] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, id)).all()
  if (!row || !row.isActive) {
    logTaskWarn('AIConfig', 'config-by-id-missing', { configId: id })
    return null
  }
  const models = row.model ? JSON.parse(row.model) : []
  const settings = parseSettings(row.settings)
  logTaskProgress('AIConfig', 'config-by-id-selected', {
    configId: id,
    provider: row.provider,
    model: models[0] || '',
    serviceType: row.serviceType,
  })
  return {
    id: row.id,
    serviceType: row.serviceType as ServiceType,
    provider: row.provider || '',
    baseUrl: row.baseUrl,
    apiKey: resolveConfigApiKey(row),
    model: models[0] || '',
    endpoint: row.endpoint || null,
    queryEndpoint: row.queryEndpoint || null,
    settings,
  }
}

function resolveConfigApiKey(row: typeof schema.aiServiceConfigs.$inferSelect): string {
  const ownKey = String(row.apiKey || '').trim()
  if (ownKey) return ownKey

  const provider = String(row.provider || '').trim()
  const baseUrl = String(row.baseUrl || '').trim()
  if (!provider || !baseUrl) return ''

  const fallback = db.select().from(schema.aiServiceConfigs).all()
    .filter(candidate => candidate.id !== row.id &&
      candidate.isActive &&
      candidate.provider === provider &&
      candidate.baseUrl === baseUrl &&
      !!String(candidate.apiKey || '').trim())
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]

  const fallbackKey = String(fallback?.apiKey || '').trim()
  if (fallbackKey) {
    logTaskProgress('AIConfig', 'api-key-fallback-selected', {
      configId: row.id,
      provider,
      baseUrl,
      fallbackConfigId: fallback?.id,
      key: maskSecret(fallbackKey),
    })
  }
  return fallbackKey
}

function parseSettings(value?: string | null): Record<string, any> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
