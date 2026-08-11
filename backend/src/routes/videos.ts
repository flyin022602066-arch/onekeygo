import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest } from '../utils/response.js'
import { ensureVideoLocalCopy, ensureVideoPolling, generateVideo, previewVideoPrompt } from '../services/video-generation.js'
import { copyStaticVideoToDesktop, getLocalVideoPath, pickExportableStoryboardVideo } from '../services/desktop-export.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { resolveGenerationConfigId } from './generationConfig.js'
import {
  cancelVideoSequence,
  getEpisodeVideoSequence,
  getVideoSequence,
  retryVideoSequence,
  startVideoSequence,
} from '../services/video-sequence.js'

const app = new Hono()

// POST /videos/sequential — 谜镜专用串行生成
app.post('/sequential', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const episodeId = Number(body.episode_id || body.episodeId)
  const dramaId = Number(body.drama_id || body.dramaId)
  if (!Number.isFinite(episodeId) || episodeId <= 0 || !Number.isFinite(dramaId) || dramaId <= 0) {
    return badRequest(c, 'episode_id and drama_id are required')
  }
  try {
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
    if (!episode) return badRequest(c, '当前集不存在')
    if (episode.dramaId !== dramaId) return badRequest(c, '当前集不属于指定短剧')
    const configId = resolveGenerationConfigId(body.config_id, episode.videoConfigId)
    const sequence = await startVideoSequence({
      dramaId,
      episodeId,
      configId,
      model: body.model,
      aspectRatio: body.aspect_ratio,
    })
    return created(c, sequence)
  } catch (err: any) {
    logTaskError('VideoAPI', 'sequential-start', { episodeId, dramaId, error: err.message })
    return badRequest(c, err.message)
  }
})

app.get('/sequential/episode/:episodeId', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  return success(c, getEpisodeVideoSequence(episodeId))
})

app.get('/sequential/:runId', async (c) => {
  const runId = Number(c.req.param('runId'))
  return success(c, getVideoSequence(runId))
})

app.post('/sequential/:runId/retry', async (c) => {
  const runId = Number(c.req.param('runId'))
  try {
    return success(c, retryVideoSequence(runId))
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

app.post('/sequential/:runId/cancel', async (c) => {
  const runId = Number(c.req.param('runId'))
  return success(c, cancelVideoSequence(runId))
})

// POST /videos — Generate video
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')

  try {
    let configId = resolveGenerationConfigId(body.config_id)
    if (body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        configId = resolveGenerationConfigId(body.config_id, ep?.videoConfigId)
      }
    }

    logTaskStart('VideoAPI', 'generate', {
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      referenceMode: body.reference_mode,
      duration: body.duration,
      aspectRatio: body.aspect_ratio,
    })
    logTaskPayload('VideoAPI', 'request body', body)
    const id = await generateVideo({
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      prompt: body.prompt,
      model: body.model,
      referenceMode: body.reference_mode,
      imageUrl: body.image_url,
      firstFrameUrl: body.first_frame_url,
      lastFrameUrl: body.last_frame_url,
      referenceImageUrls: body.reference_image_urls,
      duration: body.duration,
      aspectRatio: body.aspect_ratio,
      configId,
      promptIsFinal: body.prompt_is_final === true,
    })

    const [record] = db.select().from(schema.videoGenerations)
      .where(eq(schema.videoGenerations.id, id)).all()
    logTaskSuccess('VideoAPI', 'generate', { generationId: id, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('VideoAPI', 'generate', { error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /videos/preview-prompt — 预览实际传给视频模型的提示词，不创建视频生成任务
app.post('/preview-prompt', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')

  try {
    let configId = resolveGenerationConfigId(body.config_id)
    if (body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        configId = resolveGenerationConfigId(body.config_id, ep?.videoConfigId)
      }
    }

    const result = await previewVideoPrompt({
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      prompt: body.prompt,
      model: body.model,
      referenceMode: body.reference_mode,
      imageUrl: body.image_url,
      firstFrameUrl: body.first_frame_url,
      lastFrameUrl: body.last_frame_url,
      referenceImageUrls: body.reference_image_urls,
      duration: body.duration,
      aspectRatio: body.aspect_ratio,
      configId,
      promptIsFinal: body.prompt_is_final === true,
    })

    return success(c, result)
  } catch (err: any) {
    logTaskError('VideoAPI', 'preview-prompt', { error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /videos/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.videoGenerations)
    .where(eq(schema.videoGenerations.id, id)).all()
  ensureVideoPolling(row, 'api-get')
  return success(c, row || null)
})

// POST /videos/:id/export-desktop — 将单个镜头视频保存到本机桌面
app.post('/:id/export-desktop', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.videoGenerations)
    .where(eq(schema.videoGenerations.id, id)).all()
  if (!row) return badRequest(c, '视频生成记录不存在')
  if (row.status !== 'completed') return badRequest(c, '视频还未生成完成')

  let exportRow = row
  let localVideoPath = getLocalVideoPath(row)
  let fallbackUsed = false
  let cacheError = ''

  logTaskStart('VideoAPI', 'export-desktop', { generationId: id, storyboardId: row.storyboardId })
  if (!localVideoPath && row.videoUrl) {
    try {
      localVideoPath = await ensureVideoLocalCopy(row.id) || ''
    } catch (err: any) {
      cacheError = err.message || '远程视频缓存失败'
      logTaskWarn('VideoAPI', 'export-cache-failed', {
        generationId: id,
        storyboardId: row.storyboardId,
        error: cacheError,
      })
    }
  }

  if (!localVideoPath && row.storyboardId) {
    const candidates = db.select().from(schema.videoGenerations)
      .where(eq(schema.videoGenerations.storyboardId, row.storyboardId)).all()
    const fallback = pickExportableStoryboardVideo(candidates, row.id)
    if (fallback && Number(fallback.id) !== row.id) {
      exportRow = fallback
      localVideoPath = getLocalVideoPath(fallback)
      fallbackUsed = true
    }
  }
  if (!localVideoPath) {
    return badRequest(c, cacheError
      ? `当前镜头视频远程地址不可下载，且没有可用本地缓存：${cacheError}`
      : '当前镜头视频还没有本地文件，请先等待本地缓存完成或重新生成')
  }

  const [storyboard] = exportRow.storyboardId
    ? db.select().from(schema.storyboards).where(eq(schema.storyboards.id, exportRow.storyboardId)).all()
    : []
  const [episode] = storyboard?.episodeId
    ? db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all()
    : []
  const [drama] = exportRow.dramaId
    ? db.select().from(schema.dramas).where(eq(schema.dramas.id, exportRow.dramaId)).all()
    : episode?.dramaId
      ? db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).all()
      : []

  try {
    const result = copyStaticVideoToDesktop(localVideoPath, {
      dramaTitle: drama?.title,
      episodeNumber: episode?.episodeNumber,
      storyboardNumber: storyboard?.storyboardNumber || exportRow.storyboardId,
      videoGenerationId: exportRow.id,
    })
    logTaskSuccess('VideoAPI', 'export-desktop', {
      generationId: exportRow.id,
      requestedGenerationId: id,
      storyboardId: exportRow.storyboardId,
      fileName: result.fileName,
      fallbackUsed,
    })
    return success(c, {
      ...result,
      video_generation_id: exportRow.id,
      requested_video_generation_id: id,
      storyboard_id: exportRow.storyboardId,
      fallback_used: fallbackUsed,
    })
  } catch (err: any) {
    logTaskError('VideoAPI', 'export-desktop', { generationId: id, storyboardId: row.storyboardId, error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /videos — List by storyboard_id or drama_id
app.get('/', async (c) => {
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  let rows = db.select().from(schema.videoGenerations).all()
    .filter(row => !row.deletedAt)

  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))
  rows.forEach(row => ensureVideoPolling(row, 'api-list'))

  return success(c, rows)
})

// DELETE /videos/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).run()
  return success(c)
})

export default app
