/**
 * AI 服务抽象层 — 从数据库配置中获取 provider 和 API key
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'
import { maskSecret } from '../utils/secrets.js'
import { resolveMijingStandardBaseUrl } from './mijing/models.js'
import { getEffectiveProviderPriority } from './provider-defaults.js'

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

export const DEFAULT_TEXT_STREAM_IDLE_TIMEOUT_MS = 60_000

/**
 * Migrate the former Eggfans API hostname to the current gateway hostname.
 * Only the exact legacy API host is rewritten; custom hosts and paths remain
 * unchanged so user-supplied provider endpoints are preserved.
 */
export function normalizeEggfansBaseUrl(baseUrl: string) {
  return String(baseUrl || '').trim().replace(/^https:\/\/api\.eggfans\.com(?=\/|$)/i, 'https://api.eggfans.org')
}

/** Timeout for an idle text SSE stream, not for the complete generation. */
export function getTextProviderStreamIdleTimeoutMs(config?: Pick<AIConfig, 'settings'> | null) {
  const settings = config?.settings || {}
  const mijingSettings = settings.mijing && typeof settings.mijing === 'object' ? settings.mijing : {}
  const configured = Number(
    settings.stream_idle_timeout_ms
      ?? settings.streamIdleTimeoutMs
      ?? mijingSettings.stream_idle_timeout_ms
      ?? mijingSettings.streamIdleTimeoutMs,
  )
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TEXT_STREAM_IDLE_TIMEOUT_MS
  return Math.min(Math.max(Math.round(configured), 1_000), 600_000)
}

export function getTextProviderBaseUrl(config: AIConfig) {
  const provider = config.provider.toLowerCase()

  if (provider === 'mijing') {
    // A tenant API key may be scoped to the configured Mijing gateway.
    // Do not silently switch its host between configuration testing and use.
    return joinProviderUrl(resolveMijingStandardBaseUrl(config.baseUrl), '/v1', '')
  }

  if (provider === 'openai' || provider === 'openrouter' || provider === 'chatfire' || provider === 'eggfans') {
    const baseUrl = provider === 'eggfans' ? normalizeEggfansBaseUrl(config.baseUrl) : config.baseUrl
    return joinProviderUrl(baseUrl, '/v1', '')
  }

  if (provider === 'autodl_comfyui') {
    return config.baseUrl
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
    .sort((a, b) => {
      const priorityDiff = getEffectiveProviderPriority(
        serviceType as 'text' | 'image' | 'video' | 'audio',
        b.provider,
        b.priority,
      ) - getEffectiveProviderPriority(
        serviceType as 'text' | 'image' | 'video' | 'audio',
        a.provider,
        a.priority,
      )
      return priorityDiff || Number(b.id) - Number(a.id)
    }) // 高优先级优先；未设置优先级时谜镜默认优先

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
    priority: getEffectiveProviderPriority(
      serviceType as 'text' | 'image' | 'video' | 'audio',
      active.provider,
      active.priority,
    ),
  })
  return {
    id: active.id,
    serviceType: active.serviceType as ServiceType,
    provider: active.provider || '',
    baseUrl: active.provider?.toLowerCase() === 'eggfans'
      ? normalizeEggfansBaseUrl(active.baseUrl)
      : active.baseUrl,
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
    baseUrl: row.provider?.toLowerCase() === 'eggfans'
      ? normalizeEggfansBaseUrl(row.baseUrl)
      : row.baseUrl,
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
