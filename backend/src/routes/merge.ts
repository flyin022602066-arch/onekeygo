import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { isMergeCurrent, mergeEpisodeVideos } from '../services/ffmpeg-merge.js'
import { copyStaticVideoToDesktop } from '../services/desktop-export.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// POST /episodes/:id/merge — 拼接全集视频
app.post('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  try {
    logTaskStart('MergeAPI', 'episode-merge', { episodeId, dramaId: ep.dramaId })
    const mergeId = await mergeEpisodeVideos(episodeId, ep.dramaId)
    logTaskSuccess('MergeAPI', 'episode-merge', { episodeId, mergeId })
    return success(c, { merge_id: mergeId, status: 'processing' })
  } catch (err: any) {
    logTaskError('MergeAPI', 'episode-merge', { episodeId, error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /episodes/:id/merge — 查询拼接状态
app.get('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()

  const latest = [...merges].sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0]
  if (!latest) return success(c, null)
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .filter(item => !item.deletedAt)
  const storyboardIds = new Set(storyboards.map(item => item.id))
  const generations = db.select().from(schema.videoGenerations).all()
    .filter(item => !item.deletedAt && item.storyboardId && storyboardIds.has(item.storyboardId))
  const isCurrent = isMergeCurrent(latest, storyboards, generations)
  return success(c, {
    ...toSnakeCase(latest),
    // Never let the client render/download an obsolete merge. The record is
    // kept for history, but its URL is hidden until a fresh merge completes.
    ...(isCurrent ? {} : { status: latest.status === 'processing' ? latest.status : 'stale', merged_url: null, mergedUrl: null }),
    is_current: isCurrent,
  })
})

// POST /episodes/:id/merge/export-desktop — 将最新成片保存到本机桌面
app.post('/episodes/:id/merge/export-desktop', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const merges = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .filter(item => !item.deletedAt)
  const storyboardIds = new Set(storyboards.map(item => item.id))
  const generations = db.select().from(schema.videoGenerations).all()
    .filter(item => !item.deletedAt && item.storyboardId && storyboardIds.has(item.storyboardId))
  const latest = [...merges].reverse().find(item => (
    item.status === 'completed' && item.mergedUrl && isMergeCurrent(item, storyboards, generations)
  ))
  if (!latest?.mergedUrl) return badRequest(c, '还没有可保存的成片，请先完成拼接')

  const [drama] = ep.dramaId
    ? db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()
    : []

  try {
    logTaskStart('MergeAPI', 'export-desktop', { episodeId, mergeId: latest.id })
    const result = copyStaticVideoToDesktop(latest.mergedUrl, {
      dramaTitle: drama?.title,
      episodeNumber: ep.episodeNumber,
      mergeId: latest.id,
    })
    logTaskSuccess('MergeAPI', 'export-desktop', { episodeId, mergeId: latest.id, fileName: result.fileName })
    return success(c, {
      ...result,
      merge_id: latest.id,
    })
  } catch (err: any) {
    logTaskError('MergeAPI', 'export-desktop', { episodeId, mergeId: latest.id, error: err.message })
    return badRequest(c, err.message)
  }
})

export default app
