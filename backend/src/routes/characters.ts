import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateVoiceSample } from '../services/tts-generation.js'
import { generateImage } from '../services/image-generation.js'
import { buildCharacterDesignPrompt } from '../services/character-image-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { resolveGenerationConfigId } from './generationConfig.js'
import { isTkOverseasMode } from '../services/overseas-visual.js'
import { saveUploadedAssetImage } from '../utils/storage.js'
import { validateImageUpload } from '../utils/upload-validation.js'
import { serializeAssetAliases } from '../services/asset-aliases.js'

const app = new Hono()

// POST /characters/upload-image - create an episode-linked character from a local image
app.post('/upload-image', async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  const dramaId = Number(body.drama_id || body.dramaId)
  const episodeId = Number(body.episode_id || body.episodeId)
  const file = body.file
  if (!name) return badRequest(c, '请输入角色名称')
  if (!Number.isInteger(dramaId) || dramaId <= 0 || !Number.isInteger(episodeId) || episodeId <= 0) {
    return badRequest(c, 'drama_id and episode_id are required')
  }
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode || episode.deletedAt || episode.dramaId !== dramaId) return badRequest(c, 'Episode not found')
  if (!file || !(file instanceof File)) return badRequest(c, '请选择角色图片')

  const buffer = await file.arrayBuffer()
  const validation = validateImageUpload({ name: file.name, type: file.type, size: file.size, data: buffer })
  if (!validation.ok) return badRequest(c, validation.message)

  const imagePath = await saveUploadedAssetImage(buffer, 'characters')
  const ts = now()
  const result = db.insert(schema.characters).values({
    dramaId,
    name,
    aliases: serializeAssetAliases(name, body.aliases, body.alias, body.english_name, body.englishName),
    role: String(body.role || '角色').trim() || '角色',
    description: String(body.description || '').trim(),
    appearance: String(body.appearance || '').trim(),
    personality: String(body.personality || '').trim(),
    imageUrl: imagePath,
    localPath: imagePath,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const characterId = Number(result.lastInsertRowid)
  db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts }).run()
  const [character] = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).all()
  logTaskSuccess('CharacterImage', 'manual-create-upload', { characterId, episodeId, path: imagePath })
  return created(c, character)
})

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'aliases', 'role', 'description', 'appearance', 'personality', 'voiceStyle', 'voiceProvider', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  if ('aliases' in body || 'alias' in body || 'english_name' in body || 'englishName' in body) {
    const [current] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
    if (current) updates.aliases = serializeAssetAliases(
      body.name ?? current.name,
      body.aliases ?? body.alias,
      body.english_name ?? body.englishName,
      current.aliases,
    )
  }
  if ('voice_style' in body || 'voiceStyle' in body) {
    updates.voiceSampleUrl = null
  }
  db.update(schema.characters).set(updates).where(eq(schema.characters.id, id)).run()
  return success(c)
})

// DELETE /characters/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.update(schema.characters).set({ deletedAt: now() }).where(eq(schema.characters.id, id)).run()
  return success(c)
})

app.post('/:id/upload-image', async (c) => {
  const id = Number(c.req.param('id'))
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char || char.deletedAt) return badRequest(c, '角色不存在')

  const body = await c.req.parseBody()
  const file = body.file
  if (!file || !(file instanceof File)) return badRequest(c, '请选择角色图片')

  const buffer = await file.arrayBuffer()
  const validation = validateImageUpload({
    name: file.name,
    type: file.type,
    size: file.size,
    data: buffer,
  })
  if (!validation.ok) return badRequest(c, validation.message)

  const imagePath = await saveUploadedAssetImage(buffer, 'characters')
  db.update(schema.characters).set({
    imageUrl: imagePath,
    localPath: imagePath,
    volcCharacterAssetId: null,
    volcCharacterUri: null,
    volcCharacterLocalAssetId: null,
    volcCharacterSyncedAt: null,
    volcCharacterSyncStatus: null,
    volcCharacterSyncError: null,
    updatedAt: now(),
  }).where(eq(schema.characters.id, id)).run()

  logTaskSuccess('CharacterImage', 'upload', { characterId: id, path: imagePath })
  return success(c, { image_url: imagePath, local_path: imagePath })
})

// POST /characters/:id/generate-voice-sample — 生成角色音色试听
app.post('/:id/generate-voice-sample', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  if (!char.voiceStyle) return badRequest(c, '请先分配音色')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')
  if (!ep.dubbingEnabled) return badRequest(c, '当前集已关闭配音，请先在制作工作台开启配音')

  try {
    const configId = resolveGenerationConfigId(body.config_id ?? body.configId, ep.audioConfigId)
    const model = String(body.model || '').trim() || undefined
    logTaskStart('VoiceSample', 'generate', { characterId: id, characterName: char.name, episodeId: ep.id, voice: char.voiceStyle, configId, model })
    const audioPath = await generateVoiceSample(char.name, char.voiceStyle, configId, model)
    db.update(schema.characters)
      .set({ voiceSampleUrl: audioPath, updatedAt: now() })
      .where(eq(schema.characters.id, id)).run()
    logTaskSuccess('VoiceSample', 'generate', { characterId: id, path: audioPath, configId, model })
    return success(c, { voice_sample_url: audioPath })
  } catch (err: any) {
    logTaskError('VoiceSample', 'generate', { characterId: id, error: err.message })
    return badRequest(c, `TTS 生成失败: ${err.message}`)
  }
})

// POST /characters/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const configId = resolveGenerationConfigId(body.config_id, ep.imageConfigId)
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, char.dramaId)).all()
  const tkMode = isTkOverseasMode(body.breakdown_mode || body.breakdownMode || ep.breakdownMode)
  const prompt = buildCharacterDesignPrompt({ ...char, style: drama?.style, breakdownMode: tkMode ? 'tk_overseas' : null })
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId, configId })
    const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt, model: body.model, size: body.size, configId })
    logTaskSuccess('CharacterImage', 'generate', { characterId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('CharacterImage', 'generate', { characterId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /characters/batch-generate-images
app.post('/batch-generate-images', async (c) => {
  const body = await c.req.json()
  const ids: number[] = body.character_ids || []
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')
  const configId = resolveGenerationConfigId(body.config_id, ep.imageConfigId)
  const results: number[] = []
  for (const cid of ids) {
    const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, cid)).all()
    if (!char) continue
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, char.dramaId)).all()
    const tkMode = isTkOverseasMode(body.breakdown_mode || body.breakdownMode || ep.breakdownMode)
    const prompt = buildCharacterDesignPrompt({ ...char, style: drama?.style, breakdownMode: tkMode ? 'tk_overseas' : null })
    try {
      const genId = await generateImage({ characterId: cid, dramaId: char.dramaId, prompt, model: body.model, size: body.size, configId })
      results.push(genId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app
