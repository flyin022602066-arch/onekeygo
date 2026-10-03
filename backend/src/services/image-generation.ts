import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadAssetImage, downloadFile, readImageAsCompressedDataUrl, saveBase64AssetImage, saveBase64Image } from '../utils/storage.js'
import { getImageAdapter } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import {
  syncVolcCharacterAssetForCharacter,
  syncVolcPropAssetForProp,
  syncVolcSceneAssetForScene,
} from './volc-asset-sync.js'
import { isLatestGeneration } from './generation-freshness.js'
import { fetchProvider } from '../utils/provider-fetch.js'
import { canResumeBackgroundTasks } from '../utils/background-resume.js'

const RESUMABLE_IMAGE_STATUSES = new Set(['pending', 'processing', 'queued', 'running'])
const activeImagePollers = new Set<number>()
const scheduledImageGenerations = new Set<number>()
const providerImageQueues = new Map<string, Promise<void>>()
const MAX_TRANSIENT_RETRIES = 1
const TRANSIENT_RETRY_DELAY_MS = 12_000
type ImageGenerationRow = typeof schema.imageGenerations.$inferSelect
type AIConfigRow = typeof schema.aiServiceConfigs.$inferSelect
type StaleGenerationRecord = Pick<ImageGenerationRow, 'status' | 'taskId' | 'createdAt' | 'updatedAt'>

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  propId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  const ts = now()
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('image')
  if (!config) throw new Error('No active image AI config')

  clearCurrentImageTarget(params, ts)

  const res = db.insert(schema.imageGenerations).values({
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    prompt: params.prompt,
    model: params.model || config.model,
    provider: config.provider,
    size: params.size || '1920x1080',
    frameType: params.frameType,
    referenceImages: params.referenceImages ? JSON.stringify(params.referenceImages) : null,
    status: shouldSerializeImageProvider(config.provider) ? 'queued' : 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  logTaskStart('ImageTask', 'enqueue', {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id: lastId,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })
  scheduleImageGeneration(lastId, config)
  return lastId
}

function scheduleImageGeneration(id: number, config: AIConfig, reason = 'generate') {
  if (scheduledImageGenerations.has(id) || activeImagePollers.has(id)) return false
  scheduledImageGenerations.add(id)

  const run = async () => {
    scheduledImageGenerations.delete(id)
    if (activeImagePollers.has(id)) return
    activeImagePollers.add(id)
    try {
      await processImageGeneration(id, config)
    } catch (err: any) {
      logTaskError('ImageTask', 'process-crashed', { id, provider: config.provider, reason, error: err?.message || String(err) })
      markImageGenerationFailed(id, `图片任务异常：${err?.message || String(err)}`)
    } finally {
      activeImagePollers.delete(id)
    }
  }

  if (!shouldSerializeImageProvider(config.provider)) {
    void run()
    return true
  }

  const queueKey = imageProviderQueueKey(config)
  const previous = providerImageQueues.get(queueKey) || Promise.resolve()
  const current = previous.catch(() => undefined).then(run)
  providerImageQueues.set(queueKey, current)
  void current.finally(() => {
    if (providerImageQueues.get(queueKey) === current) providerImageQueues.delete(queueKey)
  })
  logTaskProgress('ImageTask', 'queued', { id, provider: config.provider, reason })
  return true
}

async function processImageGeneration(id: number, config: AIConfig, retryAttempt = 0) {
  const adapter = getImageAdapter(config.provider)

  try {
    const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
    const record = rows[0]
    if (!record) return
    db.update(schema.imageGenerations)
      .set({ status: 'processing', errorMsg: null, updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
    logTaskProgress('ImageTask', 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
      frameType: record.frameType,
    })

    // 使用 Adapter 构建请求
    const resolvedReferenceImages = await normalizeReferenceImages(record.referenceImages)
    const { url, method, headers, body, rawBody } = adapter.buildGenerateRequest(config, {
      id: record.id,
      model: record.model,
      prompt: record.prompt,
      size: record.size,
      frameType: record.frameType,
      referenceImages: resolvedReferenceImages ? JSON.stringify(resolvedReferenceImages) : null,
    })
    logTaskProgress('ImageTask', 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })
    logTaskPayload('ImageTask', 'request payload', {
      id,
      method,
      url,
      headers,
      body: summarizeRequestBody(body),
    })

    const resp = await fetchProvider(url, {
      method,
      headers,
      body: rawBody ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    })

    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`)
    const result = await resp.json() as any
    logTaskPayload('ImageTask', 'response payload', {
      id,
      provider: config.provider,
      result,
    })

    const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

    if (!isAsync && imageUrl) {
      logTaskProgress('ImageTask', 'sync-complete', { id, imageUrl })
      // 同步模式：直接下载图片
      await handleImageComplete(id, config.provider, imageUrl)
      return
    }

    if (!isAsync && !imageUrl) {
      // 同步模式但无 URL（Gemini 等返回 base64）
      const b64 = adapter.extractImageBase64(result)
      if (b64) {
        logTaskProgress('ImageTask', 'sync-base64-complete', { id, mimeType: b64.mimeType })
        await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
        return
      }
      throw new Error('No image URL or base64 data in response')
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.imageGenerations)
      .set({ taskId, status: 'processing', updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
    logTaskProgress('ImageTask', 'poll-start', { id, taskId, provider: config.provider })
    await pollImageTask(id, config, taskId!, retryAttempt)
  } catch (err: any) {
    const message = err?.message || String(err)
    if (await retryTransientImageGeneration(id, config, message, retryAttempt)) return
    const formatted = formatImageProviderFailure(config.provider, message, retryAttempt)
    logTaskError('ImageTask', 'process', { id, provider: config.provider, error: formatted })
    markImageGenerationFailed(id, formatted)
  }
}

export function isResumableImageGeneration(
  record: Pick<ImageGenerationRow, 'status' | 'taskId' | 'provider'> | null | undefined,
) {
  if (!record) return false
  const status = String(record.status || '').trim().toLowerCase()
  const taskId = String(record.taskId || '').trim()
  return !!taskId && RESUMABLE_IMAGE_STATUSES.has(status)
}

export function isStaleUnrecoverableImageGeneration(
  record: StaleGenerationRecord | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = 15 * 60 * 1000,
) {
  if (!record) return false
  const status = String(record.status || '').trim().toLowerCase()
  if (!RESUMABLE_IMAGE_STATUSES.has(status)) return false
  if (status === 'queued') return false
  if (String(record.taskId || '').trim()) return false

  const timestamp = Date.parse(String(record.updatedAt || record.createdAt || ''))
  if (!Number.isFinite(timestamp)) return false
  return nowMs - timestamp >= maxAgeMs
}

export function ensureImagePolling(
  record: Pick<ImageGenerationRow, 'id' | 'provider' | 'model' | 'status' | 'taskId' | 'createdAt' | 'updatedAt'> | null | undefined,
  reason = 'api',
) {
  if (!canResumeBackgroundTasks(reason)) return false
  if (isStaleUnrecoverableImageGeneration(record)) {
    db.update(schema.imageGenerations)
      .set({
        status: 'failed',
        errorMsg: '任务长时间处于处理中但缺少可轮询任务 ID，已自动标记失败，请重新生成',
        updatedAt: now(),
      })
      .where(eq(schema.imageGenerations.id, record!.id))
      .run()
    logTaskWarn('ImageTask', 'stale-unrecoverable-marked-failed', {
      id: record?.id,
      provider: record?.provider,
      model: record?.model,
      reason,
    })
    return false
  }
  if (!isResumableImageGeneration(record)) return false
  if (!record?.id || !record.taskId) return false
  if (activeImagePollers.has(record.id) || scheduledImageGenerations.has(record.id)) return false

  const config = resolveImagePollingConfig(record)
  if (!config) {
    logTaskWarn('ImageTask', 'poll-resume-config-missing', {
      id: record.id,
      provider: record.provider,
      model: record.model,
      reason,
    })
    return false
  }

  return startImagePoller(record.id, config, record.taskId, reason)
}

export async function resumePendingImagePolls(reason = 'startup') {
  const rows = db.select().from(schema.imageGenerations).all()
  let resumed = 0
  for (const row of rows) {
    if (String(row.status || '').trim().toLowerCase() === 'queued' && !String(row.taskId || '').trim()) {
      const config = resolveImagePollingConfig(row)
      if (config && scheduleImageGeneration(row.id, config, reason)) resumed += 1
      continue
    }
    if (ensureImagePolling(row, reason)) resumed += 1
  }
  logTaskProgress('ImageTask', 'poll-resume-scan', { reason, resumed })
  return resumed
}

function startImagePoller(id: number, config: AIConfig, taskId: string, reason = 'generate') {
  if (!taskId) return false
  if (activeImagePollers.has(id) || scheduledImageGenerations.has(id)) return false
  if (shouldSerializeImageProvider(config.provider)) {
    return scheduleExistingImagePoll(id, config, taskId, reason)
  }
  activeImagePollers.add(id)
  logTaskProgress('ImageTask', 'poller-start', { id, taskId, provider: config.provider, reason })
  pollImageTask(id, config, taskId, 0)
    .catch((err: any) => {
      logTaskError('ImageTask', 'poller-crashed', {
        id,
        taskId,
        provider: config.provider,
        error: err?.message || String(err),
      })
      markImageGenerationFailed(id, `轮询异常：${err?.message || String(err)}`)
    })
    .finally(() => {
      activeImagePollers.delete(id)
    })
  return true
}

function scheduleExistingImagePoll(id: number, config: AIConfig, taskId: string, reason: string) {
  scheduledImageGenerations.add(id)
  const run = async () => {
    scheduledImageGenerations.delete(id)
    if (activeImagePollers.has(id)) return
    activeImagePollers.add(id)
    try {
      logTaskProgress('ImageTask', 'poller-start', { id, taskId, provider: config.provider, reason })
      await pollImageTask(id, config, taskId, 0)
    } catch (err: any) {
      logTaskError('ImageTask', 'poller-crashed', {
        id,
        taskId,
        provider: config.provider,
        error: err?.message || String(err),
      })
      markImageGenerationFailed(id, `轮询异常：${err?.message || String(err)}`)
    } finally {
      activeImagePollers.delete(id)
    }
  }
  const queueKey = imageProviderQueueKey(config)
  const previous = providerImageQueues.get(queueKey) || Promise.resolve()
  const current = previous.catch(() => undefined).then(run)
  providerImageQueues.set(queueKey, current)
  void current.finally(() => {
    if (providerImageQueues.get(queueKey) === current) providerImageQueues.delete(queueKey)
  })
  logTaskProgress('ImageTask', 'poller-queued', { id, taskId, provider: config.provider, reason })
  return true
}

function resolveImagePollingConfig(
  record: Pick<ImageGenerationRow, 'provider' | 'model'>,
): AIConfig | null {
  const provider = String(record.provider || '').trim().toLowerCase()
  if (!provider) return null
  const targetModel = String(record.model || '').trim()
  const configs = db.select().from(schema.aiServiceConfigs).all()
    .filter(row => row.isActive && row.serviceType === 'image' && String(row.provider || '').trim().toLowerCase() === provider)
    .sort(sortConfigRows)
  const modelMatched = configs.find(row => targetModel && parseConfigModels(row.model).includes(targetModel))
  const selected = modelMatched || configs[0]
  if (!selected) return null
  return aiConfigFromRow(selected, targetModel)
}

function aiConfigFromRow(row: AIConfigRow, preferredModel?: string): AIConfig {
  const models = parseConfigModels(row.model)
  return {
    provider: row.provider || '',
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    model: preferredModel || models[0] || '',
    endpoint: row.endpoint || null,
    queryEndpoint: row.queryEndpoint || null,
    settings: parseConfigSettings(row.settings),
  }
}

function sortConfigRows(a: AIConfigRow, b: AIConfigRow) {
  const priorityDiff = (b.priority || 0) - (a.priority || 0)
  if (priorityDiff) return priorityDiff
  return Number(b.isDefault || false) - Number(a.isDefault || false)
}

function parseConfigModels(value?: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map(item => String(item || '').trim()).filter(Boolean)
    if (typeof parsed === 'string') return [parsed].filter(Boolean)
  } catch {
    const raw = String(value || '').trim()
    if (raw) return [raw]
  }
  return []
}

function parseConfigSettings(value?: string | null): Record<string, any> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function summarizeRequestBody(body: unknown) {
  if (body instanceof FormData) {
    const summary: Record<string, unknown> = {}
    let imageCount = 0
    for (const [key, value] of body.entries() as IterableIterator<[string, any]>) {
      if (key === 'image') {
        imageCount += 1
        continue
      }
      if (typeof value === 'string') summary[key] = value
      else if (value && typeof value === 'object' && 'name' in value) summary[key] = { name: value.name, type: value.type, size: value.size }
      else if (value && typeof value === 'object' && 'size' in value) summary[key] = { type: value.type, size: value.size }
      else summary[key] = String(value)
    }
    if (imageCount) summary.image = `${imageCount} file(s)`
    return summary
  }
  return body
}

async function normalizeReferenceImages(raw: string | null | undefined): Promise<string[]> {
  if (!raw) return []
  let refs: string[] = []
  try {
    refs = JSON.parse(raw)
  } catch {
    refs = []
  }

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  return normalized.filter((item): item is string => !!item).slice(0, 6)
}

async function pollImageTask(id: number, config: AIConfig, taskId: string, retryAttempt = 0) {
  const adapter = getImageAdapter(config.provider)
  const startedAt = Date.now()
  const maxDurationMs = 600_000

  for (let i = 0; i < 120; i++) {
    if (Date.now() - startedAt >= maxDurationMs) {
      logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: 'Polling exceeded 10 minutes' })
      markImageGenerationFailed(id, '图片生成超时：上游在 10 分钟内未返回结果，请重新生成')
      return
    }
    await new Promise(r => setTimeout(r, 5000))
    if (Date.now() - startedAt >= maxDurationMs) {
      logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: 'Polling exceeded 10 minutes' })
      markImageGenerationFailed(id, '图片生成超时：上游在 10 分钟内未返回结果，请重新生成')
      return
    }
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress('ImageTask', 'poll-request', {
        id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = Math.max(1_000, maxDurationMs - (Date.now() - startedAt))
      const resp = await fetchProvider(url, {
        method,
        headers,
        signal: AbortSignal.timeout(remainingMs),
      })
      if (!resp.ok) {
        const errorBody = await resp.text()
        logTaskWarn('ImageTask', 'poll-http-error', {
          id,
          taskId,
          provider: config.provider,
          attempt: i + 1,
          status: resp.status,
          body: errorBody.slice(0, 500),
        })
        const providerError = `HTTP ${resp.status}: ${errorBody}`
        if (isRetryableImageProviderFailure(config.provider, providerError)) {
          if (await retryTransientImageGeneration(id, config, providerError, retryAttempt)) return
          markImageGenerationFailed(id, formatImageProviderFailure(config.provider, providerError, retryAttempt))
          return
        }
        if (shouldFailImagePollImmediately(resp.status)) {
          markImageGenerationFailed(id, `轮询失败 ${resp.status}: ${errorBody}`)
          return
        }
        continue
      }
      const result = await resp.json() as any

      const pollResp = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed' && pollResp.imageUrl) {
        logTaskSuccess('ImageTask', 'poll-complete', { id, taskId, imageUrl: pollResp.imageUrl })
        await handleImageComplete(id, config.provider, pollResp.imageUrl)
        return
      }
      if (pollResp.status === 'completed' && adapter.provider === 'gemini') {
        // Gemini 可能返回 base64
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskSuccess('ImageTask', 'poll-base64-complete', { id, taskId, mimeType: b64.mimeType })
          await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
          return
        }
      }
      if (pollResp.status === 'completed') {
        markImageGenerationFailed(id, '图片上游已完成任务，但响应中没有可下载的图片地址')
        return
      }
      if (pollResp.status === 'failed') {
        const message = pollResp.error || 'Generation failed'
        if (await retryTransientImageGeneration(id, config, message, retryAttempt)) return
        const formatted = formatImageProviderFailure(config.provider, message, retryAttempt)
        logTaskError('ImageTask', 'poll-failed', { id, taskId, error: formatted })
        markImageGenerationFailed(id, formatted)
        return
      }
    } catch (err: any) {
      if (i === 119 || Date.now() - startedAt >= maxDurationMs) {
        logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: err.message })
        markImageGenerationFailed(id, `图片生成超时：${err.message}`)
        return
      }
      logTaskWarn('ImageTask', 'poll-retry', { id, taskId, attempt: i + 1, error: err.message })
    }
  }
}

function shouldSerializeImageProvider(provider: string | null | undefined) {
  return String(provider || '').trim().toLowerCase() === 'mijing'
}

function imageProviderQueueKey(config: AIConfig) {
  return `${String(config.provider || '').trim().toLowerCase()}|${String(config.baseUrl || '').replace(/\/+$/, '')}`
}

export function isRetryableImageProviderFailure(provider: string | null | undefined, error: unknown) {
  if (!shouldSerializeImageProvider(provider)) return false
  const message = String(error || '').toLowerCase()
  return message.includes('负载已饱和')
    || message.includes('负载饱和')
    || message.includes('upstream load')
    || /api error (429|502|503|504)\b/.test(message)
    || /http (429|502|503|504)\b/.test(message)
}

async function retryTransientImageGeneration(
  id: number,
  config: AIConfig,
  error: string,
  retryAttempt: number,
) {
  if (retryAttempt >= MAX_TRANSIENT_RETRIES || !isRetryableImageProviderFailure(config.provider, error)) return false
  const nextAttempt = retryAttempt + 1
  logTaskWarn('ImageTask', 'transient-retry-scheduled', {
    id,
    provider: config.provider,
    retryAttempt: nextAttempt,
    delayMs: TRANSIENT_RETRY_DELAY_MS,
    error,
  })
  db.update(schema.imageGenerations)
    .set({
      status: 'queued',
      taskId: null,
      errorMsg: `谜镜图片上游繁忙，${TRANSIENT_RETRY_DELAY_MS / 1000} 秒后自动重试（${nextAttempt}/${MAX_TRANSIENT_RETRIES}）`,
      updatedAt: now(),
    })
    .where(eq(schema.imageGenerations.id, id))
    .run()
  await new Promise(resolve => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS))
  await processImageGeneration(id, config, nextAttempt)
  return true
}

export function formatImageProviderFailure(provider: string | null | undefined, error: unknown, retryAttempt = 0) {
  const message = String(error || '图片生成失败').trim()
  if (isRetryableImageProviderFailure(provider, message)) {
    const retryText = retryAttempt > 0 ? `，已自动重试 ${retryAttempt} 次仍未恢复` : ''
    return `谜镜图片上游当前负载已饱和${retryText}；请求参数和模型配置已正常提交，请稍后重新生成。原始错误：${message}`
  }
  return message
}

function markImageGenerationFailed(id: number, errorMsg: string) {
  const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  db.update(schema.imageGenerations)
    .set({ status: 'failed', errorMsg, completedAt: null, updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
  if (record?.sceneId && recordIsLatestForTarget(record)) {
    db.update(schema.scenes)
      .set({ status: 'failed', updatedAt: now() })
      .where(eq(schema.scenes.id, record.sceneId))
      .run()
  }
}

export function shouldFailImagePollImmediately(status: number) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

async function handleImageComplete(id: number, provider: string, imageUrl: string) {
  const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  const record = rows[0]
  const isAsset = !!(record?.characterId || record?.sceneId || record?.propId)
  const localPath = isAsset ? await downloadAssetImage(imageUrl, 'images') : await downloadFile(imageUrl, 'images')

  db.update(schema.imageGenerations)
    .set({ imageUrl, localPath, status: 'processing', errorMsg: null, completedAt: null, updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
  logTaskSuccess('ImageTask', 'downloaded', { id, provider, localPath })

  if (!record || !recordIsLatestForTarget(record)) {
    markImageGenerationCompleted(id)
    logTaskProgress('ImageTask', 'complete-business-update-ignored', { id, provider, reason: 'newer-generation-exists' })
    return
  }

  // 更新关联表
  if (record?.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId)).run()
  }
  if (record?.characterId) {
    db.update(schema.characters).set({ imageUrl: localPath, localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId)).run()
    await syncCompletedCharacterImageToVolc(record.characterId, id)
  }
  if (record?.sceneId) {
    db.update(schema.scenes).set({ imageUrl: localPath, localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId)).run()
  }
  if (record?.propId) {
    db.update(schema.props).set({ imageUrl: localPath, localPath, updatedAt: now() }).where(eq(schema.props.id, record.propId)).run()
  }
  if (!await syncCompletedSemanticImageToVolc(record, id)) return
  markImageGenerationCompleted(id)
}

async function handleImageCompleteBase64(id: number, provider: string, base64Data: string, mimeType: string) {
  const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  const record = rows[0]
  const isAsset = !!(record?.characterId || record?.sceneId || record?.propId)
  const localPath = isAsset ? await saveBase64AssetImage(base64Data, 'images') : await saveBase64Image(base64Data, mimeType, 'images')

  db.update(schema.imageGenerations)
    .set({ localPath, status: 'processing', errorMsg: null, completedAt: null, updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
  logTaskSuccess('ImageTask', 'saved-base64', { id, provider, mimeType, localPath })

  if (!record || !recordIsLatestForTarget(record)) {
    markImageGenerationCompleted(id)
    logTaskProgress('ImageTask', 'complete-business-update-ignored', { id, provider, reason: 'newer-generation-exists' })
    return
  }

  // 更新关联表
  if (record?.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId)).run()
  }
  if (record?.characterId) {
    db.update(schema.characters).set({ imageUrl: localPath, localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId)).run()
    await syncCompletedCharacterImageToVolc(record.characterId, id)
  }
  if (record?.sceneId) {
    db.update(schema.scenes).set({ imageUrl: localPath, localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId)).run()
  }
  if (record?.propId) {
    db.update(schema.props).set({ imageUrl: localPath, localPath, updatedAt: now() }).where(eq(schema.props.id, record.propId)).run()
  }
  if (!await syncCompletedSemanticImageToVolc(record, id)) return
  markImageGenerationCompleted(id)
}

function markImageGenerationCompleted(id: number) {
  db.update(schema.imageGenerations)
    .set({ status: 'completed', errorMsg: null, completedAt: now(), updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
}

function clearCurrentImageTarget(params: GenerateImageParams, updatedAt: string) {
  if (params.characterId) {
    db.update(schema.characters)
      .set({ imageUrl: null, updatedAt })
      .where(eq(schema.characters.id, params.characterId))
      .run()
    return
  }
  if (params.sceneId) {
    db.update(schema.scenes)
      .set({ imageUrl: null, status: 'processing', updatedAt })
      .where(eq(schema.scenes.id, params.sceneId))
      .run()
    return
  }
  if (params.propId) {
    db.update(schema.props).set({ imageUrl: null, updatedAt }).where(eq(schema.props.id, params.propId)).run()
    return
  }
  if (!params.storyboardId) return
  const update: Record<string, any> = { updatedAt }
  if (params.frameType === 'first_frame') update.firstFrameImage = null
  else if (params.frameType === 'last_frame') update.lastFrameImage = null
  else if (!String(params.frameType || '').startsWith('grid_')) update.composedImage = null
  db.update(schema.storyboards).set(update).where(eq(schema.storyboards.id, params.storyboardId)).run()
}

function recordIsLatestForTarget(record: ImageGenerationRow) {
  let rows = db.select().from(schema.imageGenerations).all()
  if (record.characterId) {
    rows = rows.filter(item => item.characterId === record.characterId)
  } else if (record.sceneId) {
    rows = rows.filter(item => item.sceneId === record.sceneId)
  } else if (record.propId) {
    rows = rows.filter(item => item.propId === record.propId)
  } else if (record.storyboardId) {
    rows = rows.filter(item => item.storyboardId === record.storyboardId && (item.frameType || '') === (record.frameType || ''))
  } else {
    return true
  }
  return isLatestGeneration(rows, record.id)
}

async function syncCompletedCharacterImageToVolc(characterId: number, imageGenerationId: number) {
  try {
    const asset = await syncVolcCharacterAssetForCharacter(characterId)
    logTaskSuccess('ImageTask', 'character-volc-asset-synced', {
      id: imageGenerationId,
      characterId,
      providerAssetId: asset.providerAssetId,
      assetUri: asset.assetUri,
    })
  } catch (err) {
    logTaskWarn('ImageTask', 'character-volc-asset-sync-failed', {
      id: imageGenerationId,
      characterId,
      error: err instanceof Error ? err.message : String(err || 'unknown error'),
    })
  }
}

type SemanticImageGenerationRecord = Pick<ImageGenerationRow, 'sceneId' | 'propId'>

export async function syncCompletedSemanticImageToVolc(
  record: SemanticImageGenerationRecord,
  imageGenerationId: number,
  syncScene: typeof syncVolcSceneAssetForScene = syncVolcSceneAssetForScene,
  syncProp: typeof syncVolcPropAssetForProp = syncVolcPropAssetForProp,
) {
  if (record.sceneId) {
    try {
      const asset = await syncScene(record.sceneId)
      logTaskSuccess('ImageTask', 'scene-volc-asset-synced', {
        id: imageGenerationId,
        sceneId: record.sceneId,
        providerAssetId: asset.providerAssetId,
        assetUri: asset.assetUri,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || 'unknown error')
      const errorMsg = `场景图片已生成，但自动上传火山素材库失败：${message}`
      logTaskWarn('ImageTask', 'scene-volc-asset-sync-failed', { id: imageGenerationId, sceneId: record.sceneId, error: message })
      markImageGenerationFailed(imageGenerationId, errorMsg)
      return false
    }
  }
  if (record.propId) {
    try {
      const asset = await syncProp(record.propId)
      logTaskSuccess('ImageTask', 'prop-volc-asset-synced', {
        id: imageGenerationId,
        propId: record.propId,
        providerAssetId: asset.providerAssetId,
        assetUri: asset.assetUri,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || 'unknown error')
      const errorMsg = `道具图片已生成，但自动上传火山素材库失败：${message}`
      logTaskWarn('ImageTask', 'prop-volc-asset-sync-failed', { id: imageGenerationId, propId: record.propId, error: message })
      markImageGenerationFailed(imageGenerationId, errorMsg)
      return false
    }
  }
  return true
}
