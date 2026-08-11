import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { generateVoiceSample } from '../services/tts-generation.js'
import { generateImage } from '../services/image-generation.js'
import { buildCharacterDesignPrompt } from '../services/character-image-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { resolveGenerationConfigId } from './generationConfig.js'
import { isTkOverseasMode } from '../services/overseas-visual.js'
import { saveUploadedFileWithExtension } from '../utils/storage.js'
import { validateImageUpload } from '../utils/upload-validation.js'

const app = new Hono()

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'role', 'description', 'appearance', 'personality', 'voiceStyle', 'voiceProvider', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
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

  const imagePath = await saveUploadedFileWithExtension(buffer, 'characters', validation.extension)
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
