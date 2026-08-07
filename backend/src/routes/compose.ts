import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { composeStoryboard, normalizeComposeOptions } from '../services/ffmpeg-compose.js'
import { getStoryboardVideoSource, groupVideoGenerationsByStoryboard } from '../services/storyboard-video-source.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { toSnakeCase } from '../utils/transform.js'

const app = new Hono()

function getStoryboardsWithVideo(storyboards: Array<typeof schema.storyboards.$inferSelect>) {
  const ids = new Set(storyboards.map(sb => sb.id))
  const generations = db.select().from(schema.videoGenerations).all()
    .filter(row => row.storyboardId && ids.has(row.storyboardId))
  const grouped = groupVideoGenerationsByStoryboard(generations)
  return storyboards
    .map(sb => ({
      storyboard: sb,
      videoSource: getStoryboardVideoSource(sb, grouped.get(sb.id) || []),
    }))
    .filter(item => !!item.videoSource)
}

// POST /storyboards/:id/compose — 合成单个镜头
app.post('/storyboards/:id/compose', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await readJsonBody(c)
  const options = normalizeComposeOptions({
    audioMode: body.audio_mode || body.audioMode,
    subtitleMode: body.subtitle_mode || body.subtitleMode,
  })
  try {
    logTaskStart('ComposeAPI', 'single-compose', { storyboardId: id, ...options })
    const composedUrl = await composeStoryboard(id, options)
    logTaskSuccess('ComposeAPI', 'single-compose', { storyboardId: id, output: composedUrl, ...options })
    return success(c, { id, composed_video_url: composedUrl, audio_mode: options.audioMode })
  } catch (err: any) {
    logTaskError('ComposeAPI', 'single-compose', { storyboardId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /episodes/:id/compose-all — 批量合成全部镜头
app.post('/episodes/:id/compose-all', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJsonBody(c)
  const options = normalizeComposeOptions({
    audioMode: body.audio_mode || body.audioMode,
    subtitleMode: body.subtitle_mode || body.subtitleMode,
  })
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  if (storyboards.length === 0) return badRequest(c, 'No storyboards found')

  const withVideo = getStoryboardsWithVideo(storyboards)
  if (withVideo.length === 0) return badRequest(c, 'No storyboards have video yet')

  for (const item of withVideo) {
    db.update(schema.storyboards)
      .set({ status: 'compose_processing' })
      .where(eq(schema.storyboards.id, item.storyboard.id))
      .run()
  }

  ;(async () => {
    for (const { storyboard: sb } of withVideo) {
      try {
        await composeStoryboard(sb.id, options)
      } catch (err: any) {
        logTaskError('ComposeAPI', 'batch-item', { storyboardId: sb.id, episodeId, error: err.message, ...options })
      }
    }
    logTaskSuccess('ComposeAPI', 'batch-compose', { episodeId, total: withVideo.length, ...options })
  })()

  logTaskStart('ComposeAPI', 'batch-compose', { episodeId, total: withVideo.length, ...options })
  return success(c, {
    message: `Started composing ${withVideo.length} storyboards`,
    total: withVideo.length,
    audio_mode: options.audioMode,
  })
})

// GET /episodes/:id/compose-status — 查询批量合成状态
app.get('/episodes/:id/compose-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const withVideo = getStoryboardsWithVideo(storyboards)
  const completed = withVideo.filter(({ storyboard: sb }) => sb.status === 'compose_completed' && !!sb.composedVideoUrl)
  const failed = withVideo.filter(({ storyboard: sb }) => sb.status === 'compose_failed')
  const processing = withVideo.filter(({ storyboard: sb }) => sb.status === 'compose_processing')
  const idle = withVideo.filter(({ storyboard: sb }) => !sb.status || !String(sb.status).startsWith('compose_'))

  return success(c, {
    total: withVideo.length,
    completed: completed.length,
    failed: failed.length,
    processing: processing.length,
    idle: idle.length,
    items: withVideo.map(({ storyboard: sb, videoSource }) => toSnakeCase({
      id: sb.id,
      storyboardNumber: sb.storyboardNumber,
      status: sb.status || 'pending',
      composedVideoUrl: sb.composedVideoUrl,
      videoUrl: videoSource?.videoUrl || sb.videoUrl,
      videoSource: videoSource?.source || 'storyboard',
      videoGenerationId: videoSource?.generation?.id || null,
      errorMsg: sb.status === 'compose_failed' ? '视频合成失败，请检查视频素材或合成模式' : '',
    })),
  })
})

async function readJsonBody(c: any) {
  try {
    return await c.req.json()
  } catch {
    return {}
  }
}

export default app
