import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { buildPropAssetPrompt } from '../services/prop-image-prompt.js'
import { resolveGenerationConfigId } from './generationConfig.js'
import { saveUploadedAssetImage } from '../utils/storage.js'
import { validateImageUpload } from '../utils/upload-validation.js'
import { withVisualStyleLock } from '../services/visual-style.js'
import { serializeAssetAliases } from '../services/asset-aliases.js'

const app = new Hono()

app.post('/upload-image', async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  const dramaId = Number(body.drama_id || body.dramaId)
  const episodeId = Number(body.episode_id || body.episodeId)
  const file = body.file
  if (!name) return badRequest(c, '请输入道具名称')
  if (!Number.isInteger(dramaId) || dramaId <= 0 || !Number.isInteger(episodeId) || episodeId <= 0) {
    return badRequest(c, 'drama_id and episode_id are required')
  }
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode || episode.deletedAt || episode.dramaId !== dramaId) return badRequest(c, 'Episode not found')
  if (!file || !(file instanceof File)) return badRequest(c, '请选择道具图片')
  const buffer = await file.arrayBuffer()
  const validation = validateImageUpload({ name: file.name, type: file.type, size: file.size, data: buffer })
  if (!validation.ok) return badRequest(c, validation.message)

  const imagePath = await saveUploadedAssetImage(buffer, 'props')
  const ts = now()
  const result = db.insert(schema.props).values({
    dramaId,
    name,
    aliases: serializeAssetAliases(name, body.aliases, body.alias, body.english_name, body.englishName),
    type: String(body.type || '道具').trim(),
    description: String(body.description || '').trim(),
    prompt: String(body.prompt || body.description || name).trim(),
    imageUrl: imagePath,
    localPath: imagePath,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const propId = Number(result.lastInsertRowid)
  db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: ts }).run()
  const [prop] = db.select().from(schema.props).where(eq(schema.props.id, propId)).all()
  return created(c, prop)
})

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const name = String(body.name || '').trim()
  const dramaId = Number(body.drama_id || body.dramaId)
  if (!name || !Number.isFinite(dramaId) || dramaId <= 0) return badRequest(c, 'name and drama_id are required')
  const ts = now()
  const result = db.insert(schema.props).values({
    dramaId,
    name,
    aliases: serializeAssetAliases(name, body.aliases, body.alias, body.english_name, body.englishName),
    type: String(body.type || '').trim(),
    description: String(body.description || '').trim(),
    prompt: String(body.prompt || body.description || name).trim(),
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const [prop] = db.select().from(schema.props).where(eq(schema.props.id, Number(result.lastInsertRowid))).all()
  return success(c, prop)
})

app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'aliases', 'type', 'description', 'prompt', 'imageUrl', 'localPath']) {
    const snake = key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)
    if (snake in body) updates[key] = body[snake]
    else if (key in body) updates[key] = body[key]
  }
  if ('aliases' in body || 'alias' in body || 'english_name' in body || 'englishName' in body) {
    const [current] = db.select().from(schema.props).where(eq(schema.props.id, id)).all()
    if (current) updates.aliases = serializeAssetAliases(
      body.name ?? current.name,
      body.aliases ?? body.alias,
      body.english_name ?? body.englishName,
      current.aliases,
    )
  }
  db.update(schema.props).set(updates).where(eq(schema.props.id, id)).run()
  return success(c)
})

app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.update(schema.props).set({ deletedAt: now() }).where(eq(schema.props.id, id)).run()
  return success(c)
})

app.post('/:id/upload-image', async (c) => {
  const id = Number(c.req.param('id'))
  const [prop] = db.select().from(schema.props).where(eq(schema.props.id, id)).all()
  if (!prop || prop.deletedAt) return badRequest(c, 'Prop not found')
  const body = await c.req.parseBody()
  const file = body.file
  if (!file || !(file instanceof File)) return badRequest(c, '请选择道具图片')
  const buffer = await file.arrayBuffer()
  const validation = validateImageUpload({ name: file.name, type: file.type, size: file.size, data: buffer })
  if (!validation.ok) return badRequest(c, validation.message)
  const imagePath = await saveUploadedAssetImage(buffer, 'props')
  db.update(schema.props).set({ imageUrl: imagePath, localPath: imagePath, updatedAt: now() }).where(eq(schema.props.id, id)).run()
  return success(c, { image_url: imagePath, local_path: imagePath })
})

app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [prop] = db.select().from(schema.props).where(eq(schema.props.id, id)).all()
  if (!prop || prop.deletedAt) return badRequest(c, 'Prop not found')
  const episodeId = Number(body.episode_id || body.episodeId)
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) return badRequest(c, 'Episode not found')
  if (episode.dramaId !== prop.dramaId) return badRequest(c, 'Prop does not belong to this episode project')
  const configId = resolveGenerationConfigId(body.config_id || body.configId, episode.imageConfigId)
  try {
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, prop.dramaId)).all()
    const prompt = withVisualStyleLock(buildPropAssetPrompt(prop), drama?.style, '道具资产图')
    const generationId = await generateImage({ propId: id, dramaId: prop.dramaId, prompt, model: body.model, size: body.size, configId })
    return success(c, { image_generation_id: generationId })
  } catch (error: any) {
    return badRequest(c, error.message)
  }
})

export default app
