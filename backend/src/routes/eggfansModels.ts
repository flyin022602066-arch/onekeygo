import { Hono } from 'hono'
import { success } from '../utils/response.js'
import {
  filterEggfansModels,
  getEggfansModels,
  type NormalizedEggfansModel,
} from '../services/eggfans/models.js'
import { resolveEggfansRoute } from '../services/eggfans/routing.js'

type Loader = () => Promise<NormalizedEggfansModel[]>

export function createEggfansModelsRoute(loadModels: Loader = () => getEggfansModels()) {
  const app = new Hono()

  app.get('/', async (c) => {
    const serviceType = c.req.query('service_type')
    const models = filterEggfansModels(await loadModels(), serviceType)
      .filter(isSelectableEggfansModel)
    return success(c, { models })
  })

  return app
}

export default createEggfansModelsRoute()

function isSelectableEggfansModel(model: NormalizedEggfansModel) {
  try {
    const route = resolveEggfansRoute(model.serviceType, model.name, model.endpointTypes)
    return [
      'openai-chat',
      'openai-image',
      'alibailian-video',
      'unified-video',
      'openai-video',
      'minimax-video',
      'vidu-video',
      'minimax-sync-tts',
      'openai-tts',
      'gemini-tts',
    ].includes(route.family)
  } catch {
    return false
  }
}
