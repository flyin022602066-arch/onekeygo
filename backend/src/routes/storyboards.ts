import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { generateTTSSequence } from '../services/tts-generation.js'
import { buildDialogueTTSSegments, parseDialogueForTTS } from '../services/dialogue-tts.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { resolveGenerationConfigId } from './generationConfig.js'
import {
  haveStoryboardGenerationInputsChanged,
  invalidateStoryboardGenerations,
  cancelStaleVideoSequenceRuns,
  storyboardGenerationResetValues,
} from '../services/storyboard-generation-invalidation.js'
import { withVisualStyleLock } from '../services/visual-style.js'
import { withTkOverseasVisualLock } from '../services/overseas-visual.js'

const app = new Hono()

function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()

  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    }).run()
  }
}

function getStoryboardCharacterIds(storyboardId: number) {
  return db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
    .map(link => link.characterId)
}

function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined) {
  const [episode] = db.select({ dramaId: schema.episodes.dramaId })
    .from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId)).all()
  const episodeSceneIds = new Set(
    db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
      .map(link => link.sceneId),
  )
  const episodeCharacterIds = new Set(
    db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      .map(link => link.characterId),
  )
  if (episode) {
    for (const scene of db.select({ id: schema.scenes.id, deletedAt: schema.scenes.deletedAt })
      .from(schema.scenes)
      .where(eq(schema.scenes.dramaId, episode.dramaId)).all()) {
      if (!scene.deletedAt) episodeSceneIds.add(scene.id)
    }
    for (const character of db.select({ id: schema.characters.id, deletedAt: schema.characters.deletedAt })
      .from(schema.characters)
      .where(eq(schema.characters.dramaId, episode.dramaId)).all()) {
      if (!character.deletedAt) episodeCharacterIds.add(character.id)
    }
  }

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error('scene_id 必须来自当前集已关联场景')
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error('character_ids 必须来自当前集已关联角色')
  }
}

// POST /storyboards
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  logTaskStart('StoryboardAPI', 'create', {
    episodeId: body.episode_id,
    shotNumber: body.storyboard_number || 1,
    sceneId: body.scene_id,
    characterIds: body.character_ids,
  })
  logTaskPayload('StoryboardAPI', 'create body', body)
  validateStoryboardBindings(body.episode_id, body.scene_id, body.character_ids)
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, body.episode_id)).all()
  const [drama] = episode
    ? db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).all()
    : []
  const res = db.insert(schema.storyboards).values({
    episodeId: body.episode_id,
    storyboardNumber: body.storyboard_number || 1,
    title: body.title,
    description: body.description,
    action: body.action,
    dialogue: body.dialogue,
    shotType: body.shot_type,
    angle: body.angle,
    movement: body.movement,
    location: body.location,
    time: body.time,
    result: body.result,
    atmosphere: body.atmosphere,
    imagePrompt: body.image_prompt == null
      ? null
      : withTkOverseasVisualLock(withVisualStyleLock(body.image_prompt, drama?.style, '分镜静态画面'), episode?.breakdownMode, '分镜静态画面'),
    videoPrompt: body.video_prompt == null
      ? null
      : withTkOverseasVisualLock(withVisualStyleLock(body.video_prompt, drama?.style, '分镜动态画面'), episode?.breakdownMode, '分镜动态画面'),
    bgmPrompt: body.bgm_prompt,
    soundEffect: body.sound_effect,
    sceneId: body.scene_id,
    duration: body.duration || 5,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  syncStoryboardCharacters(Number(res.lastInsertRowid), body.character_ids || [])
  cancelStaleVideoSequenceRuns(Number(body.episode_id), ts)
  const [result] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, Number(res.lastInsertRowid))).all()
  logTaskSuccess('StoryboardAPI', 'create', {
    storyboardId: result.id,
    episodeId: result.episodeId,
    shotNumber: result.storyboardNumber,
  })
  return created(c, {
    ...toSnakeCase(result),
    character_ids: getStoryboardCharacterIds(result.id),
  })
})

// PUT /storyboards/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!storyboard) return badRequest(c, '镜头不存在')
  logTaskStart('StoryboardAPI', 'update', {
    storyboardId: id,
    episodeId: storyboard.episodeId,
    fields: Object.keys(body),
  })
  logTaskPayload('StoryboardAPI', 'update body', body)

  const fieldMap: Record<string, string> = {
    title: 'title', description: 'description', shot_type: 'shotType',
    angle: 'angle', movement: 'movement', action: 'action',
    dialogue: 'dialogue', duration: 'duration', video_prompt: 'videoPrompt',
    image_prompt: 'imagePrompt', scene_id: 'sceneId', location: 'location',
    time: 'time', atmosphere: 'atmosphere', result: 'result',
    bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect',
  }

  const ts = now()
  const updates: Record<string, any> = { updatedAt: ts }
  for (const [snakeKey, camelKey] of Object.entries(fieldMap)) {
    if (snakeKey in body) updates[camelKey] = body[snakeKey]
  }
  if ('image_prompt' in body || 'video_prompt' in body) {
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all()
    const [drama] = episode
      ? db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).all()
      : []
    if ('image_prompt' in body) updates.imagePrompt = withTkOverseasVisualLock(
      withVisualStyleLock(body.image_prompt, drama?.style, '分镜静态画面'),
      episode?.breakdownMode,
      '分镜静态画面',
    )
    if ('video_prompt' in body) updates.videoPrompt = withTkOverseasVisualLock(
      withVisualStyleLock(body.video_prompt, drama?.style, '分镜动态画面'),
      episode?.breakdownMode,
      '分镜动态画面',
    )
  }

  const currentCharacterIds = getStoryboardCharacterIds(id)
  const nextCharacterIds = 'character_ids' in body ? body.character_ids || [] : currentCharacterIds
  validateStoryboardBindings(
    storyboard.episodeId,
    'scene_id' in body ? body.scene_id : storyboard.sceneId,
    nextCharacterIds,
  )

  const generationInputsChanged = haveStoryboardGenerationInputsChanged(
    storyboard,
    { ...storyboard, ...updates },
    currentCharacterIds,
    nextCharacterIds,
  )
  if (generationInputsChanged) {
    invalidateStoryboardGenerations(id, ts)
    cancelStaleVideoSequenceRuns(storyboard.episodeId, ts)
    Object.assign(updates, storyboardGenerationResetValues(ts))
    db.update(schema.episodes)
      .set({ videoUrl: null, updatedAt: ts })
      .where(eq(schema.episodes.id, storyboard.episodeId)).run()
  }
  db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id)).run()
  if ('character_ids' in body) syncStoryboardCharacters(id, body.character_ids || [])
  logTaskSuccess('StoryboardAPI', 'update', {
    storyboardId: id,
    updatedFields: Object.keys(updates),
    characterIds: body.character_ids,
  })
  return success(c)
})

// POST /storyboards/:id/generate-tts
app.post('/:id/generate-tts', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!sb) return badRequest(c, '镜头不存在')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  if (!ep?.dubbingEnabled) return badRequest(c, '当前集已关闭配音，请先在制作工作台开启配音')
  const parsedDialogue = parseDialogueForTTS(sb.dialogue)
  if (parsedDialogue.ignorable) return badRequest(c, '该镜头没有可生成的对白或旁白')
  const chars = ep
    ? db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all()
    : []
  const ttsSegments = buildDialogueTTSSegments(sb.dialogue, chars)
  if (!ttsSegments.length) return badRequest(c, '未提取到可合成的文本')
  logTaskStart('StoryboardAPI', 'generate-tts', {
    storyboardId: id,
    episodeId: sb.episodeId,
    dialoguePreview: (sb.dialogue || '').slice(0, 40),
    segmentCount: ttsSegments.length,
  })
  logTaskPayload('StoryboardAPI', 'generate-tts input', {
    storyboardId: id,
    episodeId: sb.episodeId,
    dialogue: sb.dialogue,
    segments: ttsSegments,
  })

  const pureDialogue = parsedDialogue.pureText
  if (!pureDialogue) return badRequest(c, '未提取到可合成的文本')

  try {
    const configId = resolveGenerationConfigId(body.config_id ?? body.configId, ep?.audioConfigId)
    const model = String(body.model || '').trim() || undefined
    const audioPath = await generateTTSSequence({ segments: ttsSegments, configId, model })
    db.update(schema.storyboards)
      .set({ ttsAudioUrl: audioPath, updatedAt: now() })
      .where(eq(schema.storyboards.id, id))
      .run()

    logTaskSuccess('StoryboardAPI', 'generate-tts', {
      storyboardId: id,
      voices: ttsSegments.map(segment => `${segment.speaker || '旁白'}:${segment.voice}`),
      path: audioPath,
      configId,
      model,
      textLength: pureDialogue.length,
    })
    return success(c, {
      tts_audio_url: audioPath,
      voice_id: ttsSegments[0]?.voice || 'alloy',
      voice_ids: ttsSegments.map(segment => segment.voice),
      segments: ttsSegments,
      text: pureDialogue,
    })
  } catch (err: any) {
    logTaskError('StoryboardAPI', 'generate-tts', {
      storyboardId: id,
      voices: ttsSegments.map(segment => segment.voice),
      error: err.message,
    })
    return badRequest(c, err.message)
  }
})

// DELETE /storyboards/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  logTaskStart('StoryboardAPI', 'delete', { storyboardId: id })
  db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id)).run()
  const [deletedStoryboard] = db.select({ episodeId: schema.storyboards.episodeId })
    .from(schema.storyboards)
    .where(eq(schema.storyboards.id, id)).all()
  db.delete(schema.storyboards).where(eq(schema.storyboards.id, id)).run()
  if (deletedStoryboard?.episodeId) cancelStaleVideoSequenceRuns(deletedStoryboard.episodeId, now())
  logTaskSuccess('StoryboardAPI', 'delete', { storyboardId: id })
  return success(c)
})

export default app
