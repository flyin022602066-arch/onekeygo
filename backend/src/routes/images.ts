import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { ensureImagePolling, generateImage } from '../services/image-generation.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import {
  buildStoryboardImagePrompt,
  buildStoryboardImageReferences,
} from '../services/storyboard-image-request.js'
import { withVisualStyleLock } from '../services/visual-style.js'
import { resolveGenerationConfigId } from './generationConfig.js'
import { buildCharacterDesignPrompt } from '../services/character-image-prompt.js'
import { buildSceneAssetPrompt } from '../services/scene-image-prompt.js'
import { buildPropAssetPrompt } from '../services/prop-image-prompt.js'
import { isTkOverseasMode } from '../services/overseas-visual.js'

const app = new Hono()

// POST /images — Generate image
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')

  try {
    let configId = resolveGenerationConfigId(body.config_id)
    let prompt = body.prompt
    let referenceImages = asStringArray(body.reference_images)
    let resolvedDramaId = Number(body.drama_id || 0) || undefined
    let visualStyle: string | null = null
    let breakdownMode: string | null = String(body.breakdown_mode || body.breakdownMode || '').trim() || null
    if (resolvedDramaId) {
      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, resolvedDramaId)).all()
      visualStyle = drama?.style || null
    }
    if (body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        configId = resolveGenerationConfigId(body.config_id, ep?.imageConfigId)
        resolvedDramaId = ep?.dramaId || resolvedDramaId
        if (resolvedDramaId) {
          const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, resolvedDramaId)).all()
          visualStyle = drama?.style || visualStyle
        }
        breakdownMode = breakdownMode || ep?.breakdownMode || null
        const scene = sb.sceneId
          ? db.select().from(schema.scenes).where(eq(schema.scenes.id, sb.sceneId)).all()[0] || null
          : null
        const characterIds = db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
          .all()
          .map(link => link.characterId)
        const characters = db.select().from(schema.characters).all()
          .filter(char => characterIds.includes(char.id) && !char.deletedAt)
        const refs = buildStoryboardImageReferences({
          frameType: body.frame_type,
          storyboard: sb,
          scene,
          characters,
          requestReferences: referenceImages,
        })
        prompt = buildStoryboardImagePrompt({
          basePrompt: body.prompt,
          visualStyle,
          frameType: body.frame_type,
          storyboard: sb,
          scene,
          characters,
          references: refs,
          breakdownMode,
        })
        referenceImages = refs.map(ref => ref.url)
      }
    } else if (visualStyle) {
      prompt = withVisualStyleLock(prompt, visualStyle, '图片最终出图')
    }

    logTaskStart('ImageAPI', 'generate', {
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      propId: body.prop_id,
      dramaId: resolvedDramaId,
      frameType: body.frame_type,
    })
    logTaskPayload('ImageAPI', 'request body', {
      ...body,
      prompt,
      reference_images: referenceImages,
    })
    const id = await generateImage({
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      propId: body.prop_id,
      prompt,
      model: body.model,
      size: body.size,
      referenceImages,
      frameType: body.frame_type,
      configId,
    })

    const [record] = db.select().from(schema.imageGenerations)
      .where(eq(schema.imageGenerations.id, id)).all()
    logTaskSuccess('ImageAPI', 'generate', { generationId: id, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('ImageAPI', 'generate', { error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /images/:id/retry — Retry a failed generation, optionally with the current image model
app.post('/:id/retry', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [record] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  if (!record) return badRequest(c, '图片任务不存在')
  if (record.status !== 'failed') return badRequest(c, '只有失败的图片任务可以重试')

  try {
    const [storyboard] = record.storyboardId
      ? db.select().from(schema.storyboards).where(eq(schema.storyboards.id, record.storyboardId)).all()
      : []
    const episode = body?.episode_id || body?.episodeId
      ? db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id || body.episodeId))).all()[0]
      : storyboard
      ? db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all()[0]
      : record.sceneId || record.characterId || record.propId
        ? db.select().from(schema.episodes).all().find(item => item.dramaId === record.dramaId)
        : undefined
    const [drama] = record.dramaId
      ? db.select().from(schema.dramas).where(eq(schema.dramas.id, record.dramaId)).all()
      : []
    const current = await rebuildCurrentImageRetryInput(record, storyboard, episode, drama)
    const referenceImages = current.referenceImages
    const retrySelection = resolveImageRetrySelection(
      record,
      db.select().from(schema.aiServiceConfigs).all(),
      body?.config_id ?? body?.configId ?? episode?.imageConfigId,
      body?.model,
    )

    const generationId = await generateImage({
      storyboardId: record.storyboardId || undefined,
      dramaId: record.dramaId || undefined,
      sceneId: record.sceneId || undefined,
      characterId: record.characterId || undefined,
      propId: record.propId || undefined,
      prompt: current.prompt,
      model: retrySelection.model,
      size: body?.size || record.size || undefined,
      referenceImages,
      frameType: record.frameType || undefined,
      configId: retrySelection.configId,
    })
    if (record.sceneId) {
      db.update(schema.scenes)
        .set({ status: 'processing', updatedAt: now() })
        .where(eq(schema.scenes.id, record.sceneId)).run()
    }
    const [retry] = db.select().from(schema.imageGenerations)
      .where(eq(schema.imageGenerations.id, generationId)).all()
    return success(c, retry)
  } catch (err: any) {
    return badRequest(c, `图片重试失败：${err.message}`)
  }
})

// GET /images/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  ensureImagePolling(row, 'api-get')
  const [latest] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  return success(c, latest || null)
})

// GET /images — List by storyboard_id or drama_id
app.get('/', async (c) => {
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  let rows = db.select().from(schema.imageGenerations).all()

  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))
  rows.forEach(row => ensureImagePolling(row, 'api-list'))
  rows = db.select().from(schema.imageGenerations).all()
    .filter(row => !storyboardId || row.storyboardId === Number(storyboardId))
    .filter(row => !dramaId || row.dramaId === Number(dramaId))

  return success(c, rows)
})

// DELETE /images/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).run()
  return success(c)
})

function asStringArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : [trimmed]
    } catch {
      return [trimmed]
    }
  }
  return []
}

async function rebuildCurrentImageRetryInput(
  record: typeof schema.imageGenerations.$inferSelect,
  storyboard?: typeof schema.storyboards.$inferSelect,
  episode?: typeof schema.episodes.$inferSelect,
  drama?: typeof schema.dramas.$inferSelect,
) {
  if (record.characterId) {
    const [character] = db.select().from(schema.characters).where(eq(schema.characters.id, record.characterId)).all()
    if (character) {
      return {
        prompt: buildCharacterDesignPrompt({
          ...character,
          style: drama?.style,
          breakdownMode: isTkOverseasMode(episode?.breakdownMode) ? 'tk_overseas' : null,
        }),
        referenceImages: parseReferenceImages(character.referenceImages),
      }
    }
  }

  if (record.sceneId) {
    const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, record.sceneId)).all()
    if (scene) {
      const characterNames = db.select().from(schema.characters).all()
        .filter(character => character.dramaId === scene.dramaId && !character.deletedAt)
        .map(character => character.name)
      return {
        prompt: buildSceneAssetPrompt({
          location: scene.location,
          time: scene.time,
          prompt: scene.prompt,
          characterNames,
          style: drama?.style,
          breakdownMode: isTkOverseasMode(episode?.breakdownMode) ? 'tk_overseas' : null,
        }),
        referenceImages: [],
      }
    }
  }

  if (record.propId) {
    const [prop] = db.select().from(schema.props).where(eq(schema.props.id, record.propId)).all()
    if (prop) {
      return {
        prompt: withVisualStyleLock(buildPropAssetPrompt(prop), drama?.style, '道具资产图'),
        referenceImages: [],
      }
    }
  }

  if (record.storyboardId && storyboard) {
    const scene = storyboard.sceneId
      ? db.select().from(schema.scenes).where(eq(schema.scenes.id, storyboard.sceneId)).all()[0]
      : null
    const characterIds = db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboard.id)).all()
      .map(link => link.characterId)
    const characters = db.select().from(schema.characters).all()
      .filter(character => characterIds.includes(character.id) && !character.deletedAt)
    const references = buildStoryboardImageReferences({
      frameType: record.frameType,
      storyboard,
      scene,
      characters,
      requestReferences: parseReferenceImages(storyboard.referenceImages),
    })
    return {
      prompt: buildStoryboardImagePrompt({
        basePrompt: storyboard.imagePrompt || storyboard.description || '',
        visualStyle: drama?.style,
        frameType: record.frameType,
        storyboard,
        scene,
        characters,
        references,
        breakdownMode: episode?.breakdownMode,
      }),
      referenceImages: references.map(reference => reference.url),
    }
  }

  return { prompt: record.prompt || '', referenceImages: parseReferenceImages(record.referenceImages) }
}

function parseReferenceImages(value?: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function parseConfigModels(value?: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map(item => String(item || '').trim()).filter(Boolean)
    if (typeof parsed === 'string') return [parsed.trim()].filter(Boolean)
  } catch {
    return String(value).split(',').map(item => item.trim()).filter(Boolean)
  }
  return []
}

type ImageRetryConfig = Pick<
  typeof schema.aiServiceConfigs.$inferSelect,
  'id' | 'serviceType' | 'provider' | 'model' | 'priority' | 'isDefault' | 'isActive'
>

export function resolveImageRetrySelection(
  record: Pick<typeof schema.imageGenerations.$inferSelect, 'provider' | 'model'>,
  configs: ImageRetryConfig[],
  requestedConfigId?: unknown,
  requestedModel?: unknown,
) {
  const configId = resolveGenerationConfigId(requestedConfigId)
  const model = String(requestedModel || '').trim()
  const hasOverride = !!configId || !!model

  if (configId) {
    const config = configs.find(item => item.id === configId)
    if (!config || !config.isActive) throw new Error('图片配置不存在或未启用')
    if (config.serviceType !== 'image') throw new Error('重试图片任务只能使用图片配置')
    if (model && !parseConfigModels(config.model).includes(model)) {
      throw new Error(`模型 ${model} 不属于当前图片配置`)
    }
    return { configId: config.id, model: model || undefined }
  }

  const activeImageConfigs = configs
    .filter(item => item.isActive && item.serviceType === 'image')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || Number(b.isDefault || false) - Number(a.isDefault || false))

  if (model) {
    const config = activeImageConfigs.find(item => parseConfigModels(item.model).includes(model))
    if (!config) throw new Error(`找不到模型 ${model} 对应的可用图片配置`)
    return { configId: config.id, model }
  }

  const legacyConfig = activeImageConfigs
    .filter(config => String(config.provider || '').trim().toLowerCase() === String(record.provider || '').trim().toLowerCase())
    .find(config => parseConfigModels(config.model).includes(String(record.model || '').trim()))
  if (!legacyConfig) throw new Error('找不到原图片模型对应的可用配置，请先在设置中选择图片模型')

  return {
    configId: legacyConfig.id,
    // Keep the legacy retry contract when no override was supplied.
    model: hasOverride ? undefined : String(record.model || '').trim() || undefined,
  }
}

export default app
