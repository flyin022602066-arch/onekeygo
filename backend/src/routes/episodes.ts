import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, notFound, badRequest, now } from '../utils/response.js'
import { toSnakeCaseArray, toSnakeCase } from '../utils/transform.js'
import { getStoryboardVideoSource, groupVideoGenerationsByStoryboard } from '../services/storyboard-video-source.js'

const app = new Hono()

function inheritDramaAssets(episodeId: number, dramaId: number, createdAt: string) {
  const characters = db.select({ id: schema.characters.id, deletedAt: schema.characters.deletedAt })
    .from(schema.characters).where(eq(schema.characters.dramaId, dramaId)).all()
  for (const character of characters) {
    if (!character.deletedAt) db.insert(schema.episodeCharacters).values({ episodeId, characterId: character.id, createdAt }).run()
  }

  const scenes = db.select({ id: schema.scenes.id, deletedAt: schema.scenes.deletedAt })
    .from(schema.scenes).where(eq(schema.scenes.dramaId, dramaId)).all()
  for (const scene of scenes) {
    if (!scene.deletedAt) db.insert(schema.episodeScenes).values({ episodeId, sceneId: scene.id, createdAt }).run()
  }

  const props = db.select({ id: schema.props.id, deletedAt: schema.props.deletedAt })
    .from(schema.props).where(eq(schema.props.dramaId, dramaId)).all()
  for (const prop of props) {
    if (!prop.deletedAt) db.insert(schema.episodeProps).values({ episodeId, propId: prop.id, createdAt }).run()
  }
}

// POST /episodes — Create a new episode
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id required')
  if (!body.image_config_id || !body.video_config_id) {
    return badRequest(c, 'image_config_id and video_config_id are required')
  }
  const dubbingEnabled = body.dubbing_enabled === true || body.dubbing_enabled === 1 || body.dubbingEnabled === true
  const breakdownMode = String(body.breakdown_mode || body.breakdownMode || 'standard').trim() || 'standard'
  const breakdownLanguage = String(body.breakdown_language || body.breakdownLanguage || 'zh').trim().toLowerCase() === 'en' ? 'en' : 'zh'
  if (dubbingEnabled && !body.audio_config_id) {
    return badRequest(c, 'audio_config_id is required when dubbing is enabled')
  }
  const ts = now()

  // Get next episode number
  const existing = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, body.drama_id))
    .orderBy(schema.episodes.episodeNumber).all()
  const nextNum = existing.length ? Math.max(...existing.map(e => e.episodeNumber)) + 1 : 1

  const res = db.insert(schema.episodes).values({
    dramaId: body.drama_id,
    episodeNumber: nextNum,
    title: body.title || `第${nextNum}集`,
    imageConfigId: body.image_config_id,
    videoConfigId: body.video_config_id,
    audioConfigId: body.audio_config_id || null,
    dubbingEnabled,
    breakdownMode,
    breakdownLanguage,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [ep] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, Number(res.lastInsertRowid))).all()
  inheritDramaAssets(ep.id, ep.dramaId, ts)
  return success(c, {
    id: ep.id,
    episode_number: ep.episodeNumber,
    title: ep.title,
    image_config_id: ep.imageConfigId,
    video_config_id: ep.videoConfigId,
    audio_config_id: ep.audioConfigId,
    dubbing_enabled: ep.dubbingEnabled,
    breakdown_mode: ep.breakdownMode || 'standard',
    breakdown_language: ep.breakdownLanguage || 'zh',
  })
})

// PUT /episodes/:id - Update episode fields
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).all()
  if (!episode) return notFound(c, 'Episode not found')

  const allowed = ['content', 'script_content', 'title', 'description', 'status', 'dubbing_enabled', 'breakdown_mode', 'breakdown_language']
  const updates: Record<string, any> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }
  if (Object.keys(updates).length === 0) return badRequest(c, 'no valid fields')

  // Map snake_case to camelCase for drizzle
  const drizzleUpdates: Record<string, any> = { updatedAt: now() }
  if ('content' in updates) drizzleUpdates.content = updates.content
  if ('script_content' in updates) drizzleUpdates.scriptContent = updates.script_content
  if ('title' in updates) drizzleUpdates.title = updates.title
  if ('description' in updates) drizzleUpdates.description = updates.description
  if ('status' in updates) drizzleUpdates.status = updates.status
  if ('dubbing_enabled' in updates) {
    const enabled = updates.dubbing_enabled === true || updates.dubbing_enabled === 1
    if (enabled && !episode.audioConfigId) return badRequest(c, '开启配音前请先为本集配置音频服务')
    drizzleUpdates.dubbingEnabled = enabled
  }
  if ('breakdown_mode' in updates) {
    const mode = String(updates.breakdown_mode || 'standard').trim()
    drizzleUpdates.breakdownMode = mode === 'minimax_local_8s_zh' || mode === 'minimax_local_8s_en' ? 'minimax_local_8s' : (mode || 'standard')
  }
  if ('breakdown_language' in updates) {
    drizzleUpdates.breakdownLanguage = String(updates.breakdown_language || 'zh').trim().toLowerCase() === 'en' ? 'en' : 'zh'
  }

  await db.update(schema.episodes).set(drizzleUpdates).where(eq(schema.episodes.id, id))
  return success(c)
})

// GET /episodes/:id/characters — characters linked to this episode
app.get('/:id/characters', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) return notFound(c, 'Episode not found')
  const result = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, episode.dramaId)).all()
    .filter(ch => !ch.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/scenes — scenes linked to this episode
app.get('/:id/scenes', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) return notFound(c, 'Episode not found')
  const result = db.select().from(schema.scenes)
    .where(eq(schema.scenes.dramaId, episode.dramaId)).all()
    .filter(sc => !sc.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/props — props linked to this episode
app.get('/:id/props', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) return notFound(c, 'Episode not found')
  const result = db.select().from(schema.props)
    .where(eq(schema.props.dramaId, episode.dramaId)).all()
    .filter(prop => !prop.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:episode_id/storyboards
app.get('/:episode_id/storyboards', async (c) => {
  const episodeId = Number(c.req.param('episode_id'))
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .filter(row => !row.deletedAt)
  const links = db.select().from(schema.storyboardCharacters).all()
  const charIdsByStoryboard = new Map<number, number[]>()
  for (const link of links) {
    const arr = charIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.characterId)
    charIdsByStoryboard.set(link.storyboardId, arr)
  }

  const episodeCharIds = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
    .map(link => link.characterId)
  const allChars = db.select().from(schema.characters).all()
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)

  return success(c, rows.map((row) => ({
    ...toSnakeCase(row),
    character_ids: charIdsByStoryboard.get(row.id) || [],
    characters: allChars
      .filter(ch => (charIdsByStoryboard.get(row.id) || []).includes(ch.id))
      .map(ch => toSnakeCase(ch)),
  })))
})

// GET /episodes/:id/pipeline-status — 流水线进度
app.get('/:id/pipeline-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return notFound(c, 'Episode not found')

  const chars = db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all()
  const scenes = db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, ep.dramaId)).all()
  const sbs = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
    .filter(sb => !sb.deletedAt)
  const merges = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.episodeId, episodeId)).all()
  const storyboardIds = new Set(sbs.map(sb => sb.id))
  const videoGenerations = db.select().from(schema.videoGenerations).all()
    .filter(row => !row.deletedAt && row.storyboardId && storyboardIds.has(row.storyboardId))
  const videoGenerationsByStoryboard = groupVideoGenerationsByStoryboard(videoGenerations)

  const charsWithVoice = chars.filter(c => c.voiceStyle)
  const charsWithSample = chars.filter(c => c.voiceSampleUrl)
  const sbsWithImage = sbs.filter(s => s.composedImage)
  const sbsWithVideo = sbs.filter(s => getStoryboardVideoSource(s, videoGenerationsByStoryboard.get(s.id) || []))
  const sbsComposed = sbs.filter(s => s.composedVideoUrl)
  const latestMerge = merges[merges.length - 1]

  function stepStatus(done: boolean, partial?: boolean) {
    if (done) return 'done'
    if (partial) return 'partial'
    return 'pending'
  }

  return success(c, {
    episode_id: episodeId,
    dubbing_enabled: !!ep.dubbingEnabled,
    steps: {
      script_rewrite: { status: ep.scriptContent ? 'done' : (ep.content ? 'ready' : 'pending') },
      extract_characters: { status: stepStatus(chars.length > 0), count: chars.length },
      extract_scenes: { status: stepStatus(scenes.length > 0), count: scenes.length },
      assign_voices: ep.dubbingEnabled
        ? { status: stepStatus(charsWithVoice.length === chars.length && chars.length > 0, charsWithVoice.length > 0), assigned: charsWithVoice.length, total: chars.length }
        : { status: 'skipped', assigned: 0, total: chars.length },
      generate_voice_samples: ep.dubbingEnabled
        ? { status: stepStatus(charsWithSample.length === charsWithVoice.length && charsWithVoice.length > 0, charsWithSample.length > 0), completed: charsWithSample.length, total: charsWithVoice.length }
        : { status: 'skipped', completed: 0, total: 0 },
      extract_storyboards: { status: stepStatus(sbs.length > 0), count: sbs.length },
      generate_images: { status: stepStatus(sbsWithImage.length === sbs.length && sbs.length > 0, sbsWithImage.length > 0), completed: sbsWithImage.length, total: sbs.length },
      generate_videos: { status: stepStatus(sbsWithVideo.length === sbs.length && sbs.length > 0, sbsWithVideo.length > 0), completed: sbsWithVideo.length, total: sbs.length },
      compose_shots: { status: stepStatus(sbsComposed.length === sbs.length && sbs.length > 0, sbsComposed.length > 0), completed: sbsComposed.length, total: sbs.length },
      merge_episode: { status: latestMerge?.status === 'completed' ? 'done' : (latestMerge ? latestMerge.status : 'pending'), merged_url: latestMerge?.mergedUrl },
    },
  })
})

export default app
