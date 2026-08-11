import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { success } from '../utils/response.js'
import { db, schema } from '../db/index.js'
import { getConfigById } from '../services/ai.js'
import {
  MIJING_BASE_URL,
  clearMijingModelCache,
  filterMijingModels,
  getMijingModels,
  type NormalizedMijingModel,
} from '../services/mijing/models.js'

type Loader = (apiKey?: string, baseUrl?: string) => Promise<NormalizedMijingModel[]>

export function createMijingModelsRoute(
  loadModels: Loader = (apiKey, baseUrl) => getMijingModels(apiKey, baseUrl),
) {
  const app = new Hono()

  app.get('/', async (c) => {
    const serviceType = c.req.query('service_type')
    const baseUrl = c.req.query('base_url') || MIJING_BASE_URL
    if (['1', 'true', 'yes'].includes(String(c.req.query('refresh') || '').toLowerCase())) {
      clearMijingModelCache()
    }
    const apiKey = getRequestApiKey(c.req.query('api_key'), c.req.query('config_id'), serviceType)
    const models = filterMijingModels(await loadModels(apiKey, baseUrl), serviceType)
    return success(c, { models })
  })

  return app
}

export default createMijingModelsRoute()

function getRequestApiKey(rawApiKey?: string, rawConfigId?: string, serviceType?: string) {
  const apiKey = String(rawApiKey || '').trim()
  if (apiKey) return apiKey

  const configId = Number(rawConfigId || 0)
  if (configId > 0) return getConfigById(configId)?.apiKey || ''

  const rows = db.select().from(schema.aiServiceConfigs)
    .where(and(
      eq(schema.aiServiceConfigs.provider, 'mijing'),
      eq(schema.aiServiceConfigs.serviceType, serviceType || 'text'),
    ))
    .all()
    .filter(row => row.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))

  if (!rows[0]) return ''
  return getConfigById(rows[0].id)?.apiKey || rows[0].apiKey || ''
}
