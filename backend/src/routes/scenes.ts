import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { resolveGenerationConfigId } from './generationConfig.js'
import { buildSceneAssetPrompt } from '../services/scene-image-prompt.js'
import { isTkOverseasMode } from '../services/overseas-visual.js'
import { saveUploadedAssetImage } from '../utils/storage.js'
import { validateImageUpload } from '../utils/upload-validation.js'
import { serializeAssetAliases } from '../services/asset-aliases.js'

const app = new Hono()

app.post('/upload-image', async (c) => {
  const body = await c.req.parseBody()
  const location = String(body.location || '').trim()
  const dramaId = Number(body.drama_id || body.dramaId)
  const episodeId = Number(body.episode_id || body.episodeId)
  const file = body.file
  if (!location) return badRequest(c, '请输入场景名称')
  if (!Number.isInteger(dramaId) || dramaId <= 0 || !Number.isInteger(episodeId) || episodeId <= 0) {
    return badRequest(c, 'drama_id and episode_id are required')
  }
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode || episode.deletedAt || episode.dramaId !== dramaId) return badRequest(c, 'Episode not found')
  if (!file || !(file instanceof File)) return badRequest(c, '请选择场景图片')
  const buffer = await file.arrayBuffer()
  const validation = validateImageUpload({ name: file.name, type: file.type, size: file.size, data: buffer })
  if (!validation.ok) return badRequest(c, validation.message)

  const imagePath = await saveUploadedAssetImage(buffer, 'scenes')
  const ts = now()
  const result = db.insert(schema.scenes).values({
    dramaId,
    episodeId,
    location,
    aliases: serializeAssetAliases(location, body.aliases, body.alias, body.english_name, body.englishName),
    time: String(body.time || '未指定').trim() || '未指定',
    prompt: String(body.prompt || location).trim(),
    imageUrl: imagePath,
    localPath: imagePath,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const sceneId = Number(result.lastInsertRowid)
  db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).run()
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId)).all()
  return created(c, scene)
})

// POST /scenes
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  const res = db.insert(schema.scenes).values({
    dramaId: body.drama_id,
    episodeId: body.episode_id,
    location: body.location,
    aliases: serializeAssetAliases(body.location, body.aliases, body.alias, body.english_name, body.englishName),
    time: body.time || '',
    prompt: body.prompt || body.location,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const [result] = db.select().from(schema.scenes)
    .where(eq(schema.scenes.id, Number(res.lastInsertRowid))).all()
  return created(c, result)
})

// PUT /scenes/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.location !== undefined) updates.location = body.location
  if (body.aliases !== undefined || body.alias !== undefined || body.english_name !== undefined || body.englishName !== undefined) {
    const [current] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
    if (current) updates.aliases = serializeAssetAliases(
      body.location ?? current.location,
      body.aliases ?? body.alias,
      body.english_name ?? body.englishName,
      current.aliases,
    )
  }
  if (body.time !== undefined) updates.time = body.time
  if (body.prompt !== undefined) updates.prompt = body.prompt
  db.update(schema.scenes).set(updates).where(eq(schema.scenes.id, id)).run()
  return success(c)
})

app.post('/:id/upload-image', async (c) => {
  const id = Number(c.req.param('id'))
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
  if (!scene || scene.deletedAt) return badRequest(c, 'Scene not found')
  const body = await c.req.parseBody()
  const file = body.file
  if (!file || !(file instanceof File)) return badRequest(c, '请选择场景图片')
  const buffer = await file.arrayBuffer()
  const validation = validateImageUpload({ name: file.name, type: file.type, size: file.size, data: buffer })
  if (!validation.ok) return badRequest(c, validation.message)
  const imagePath = await saveUploadedAssetImage(buffer, 'scenes')
  db.update(schema.scenes).set({ imageUrl: imagePath, localPath: imagePath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, id)).run()
  return success(c, { image_url: imagePath, local_path: imagePath })
})

// POST /scenes/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
  if (!scene) return badRequest(c, 'Scene not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const configId = resolveGenerationConfigId(body.config_id, ep.imageConfigId)
  const characterNames = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, scene.dramaId)).all()
    .filter(character => !character.deletedAt)
    .map(character => character.name)
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, scene.dramaId)).all()
  const tkMode = isTkOverseasMode(body.breakdown_mode || body.breakdownMode || ep.breakdownMode)
  const prompt = buildSceneAssetPrompt({
    location: scene.location,
    time: scene.time,
    prompt: scene.prompt,
    characterNames,
    style: drama?.style,
    breakdownMode: tkMode ? 'tk_overseas' : null,
  })
  try {
    logTaskStart('SceneImage', 'generate', { sceneId: id, episodeId: ep.id, dramaId: scene.dramaId, location: scene.location, configId })
    db.update(schema.scenes).set({ status: 'processing', updatedAt: now() }).where(eq(schema.scenes.id, id)).run()
    const genId = await generateImage({ sceneId: id, dramaId: scene.dramaId, prompt, model: body.model, size: body.size, configId })
    logTaskSuccess('SceneImage', 'generate', { sceneId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('SceneImage', 'generate', { sceneId: id, error: err.message })
    db.update(schema.scenes).set({ status: 'failed', updatedAt: now() }).where(eq(schema.scenes.id, id)).run()
    return badRequest(c, err.message)
  }
})

// DELETE /scenes/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
  if (!scene || scene.deletedAt) return badRequest(c, 'Scene not found')
  // Keep the same recoverable deletion semantics as characters/props. Existing
  // episode and storyboard references remain valid while GET endpoints hide it.
  db.update(schema.scenes).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.scenes.id, id)).run()
  return success(c)
})

export default app
