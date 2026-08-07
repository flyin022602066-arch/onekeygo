import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import fs from 'fs'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'path'

import dramas from './routes/dramas.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import images from './routes/images.js'
import videos from './routes/videos.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import agentConfigs from './routes/agentConfigs.js'
import agent from './routes/agent.js'
import compose from './routes/compose.js'
import merge from './routes/merge.js'
import grid from './routes/grid.js'
import assets from './routes/assets.js'
import skills from './routes/skills.js'
import webhooks from './routes/webhooks.js'
import aiVoices from './routes/aiVoices.js'
import eggfansModels from './routes/eggfansModels.js'
import mijingModels from './routes/mijingModels.js'
import preferences from './routes/preferences.js'
import { requestLogger, errorHandler } from './middleware/logger.js'
import { appConfig } from './config.js'
import { notFound } from './utils/response.js'
import { resumePendingVideoPolls } from './services/video-generation.js'
import { resumeVideoSequences } from './services/video-sequence.js'
import { resumePendingImagePolls } from './services/image-generation.js'

const projectRoot = appConfig.projectRoot
fs.mkdirSync(appConfig.storage.localPath, { recursive: true })

const app = new Hono()

// Middleware
app.use('*', cors({
  origin: appConfig.server.corsOrigins,
  credentials: true,
}))
app.use('*', requestLogger)
app.use('*', errorHandler)
app.use('/api/*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  c.header('Pragma', 'no-cache')
  c.header('Expires', '0')
})

// Health check
app.get('/api/v1/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

// API routes
const api = new Hono()
api.route('/dramas', dramas)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/images', images)
api.route('/videos', videos)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/agent-configs', agentConfigs)
api.route('/agent', agent)
api.route('/compose', compose)
api.route('/merge', merge)
api.route('/grid', grid)
api.route('/assets', assets)
api.route('/skills', skills)
api.route('/ai-voices', aiVoices)
api.route('/eggfans/models', eggfansModels)
api.route('/mijing/models', mijingModels)
api.route('/preferences', preferences)

app.route('/api/v1', api)

// Webhook callbacks (Vidu, etc.) - outside /api/v1
app.route('/webhooks', webhooks)

app.all('/api/*', (c) => notFound(c, 'API route not found'))

// Serve static files (storage)
app.use('/static/*', serveStatic({
  root: appConfig.storage.localPath,
  rewriteRequestPath: requestPath => requestPath.replace(/^\/static\/?/, '/'),
}))

// Serve frontend (production build)
const frontendCandidates = [
  path.join(projectRoot, 'frontend', '.output', 'public'),
  path.join(projectRoot, 'frontend', 'dist'),
]
// Nuxt `build` creates `.output/public` without an HTML entry because the app
// is configured as a client-only SPA. Only serve a directory after `generate`
// has produced an actual entry document; otherwise API-only mode would make
// every browser route look like a backend 404.
const distPath = frontendCandidates.find(candidate => hasFrontendEntry(candidate))
if (distPath) {
  const spaFallback = fsPathExists(path.join(distPath, '200.html')) ? '200.html' : 'index.html'
  app.use('*', serveStatic({ root: distPath }))
  app.get('*', serveStatic({ root: distPath, path: spaFallback }))
}

const port = appConfig.server.port
console.log(`🚀 Eggfans TS server on http://${appConfig.server.host}:${port}`)
// 分镜拆解可能包含多轮长文本生成；Node 默认 300 秒会在上游仍在处理时提前断开请求。
serve({
  fetch: app.fetch,
  port,
  hostname: appConfig.server.host,
  serverOptions: {
    requestTimeout: 600_000,
    headersTimeout: 600_000,
  },
})
resumePendingVideoPolls('startup').catch((err) => {
  console.error('Failed to resume pending video polls:', err)
})
resumeVideoSequences('startup')
resumePendingImagePolls('startup').catch((err) => {
  console.error('Failed to resume pending image polls:', err)
})

function fsPathExists(targetPath: string) {
  return !!targetPath && fs.existsSync(targetPath)
}

function hasFrontendEntry(targetPath: string) {
  return fsPathExists(targetPath)
    && (fsPathExists(path.join(targetPath, 'index.html')) || fsPathExists(path.join(targetPath, '200.html')))
}
