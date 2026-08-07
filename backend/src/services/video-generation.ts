import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, readImageAsCompressedDataUrl } from '../utils/storage.js'
import { getVideoAdapter } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { ensurePublicImageUrl, syncVolcCharacterAssetForCharacter, syncVolcImageAsset } from './volc-asset-sync.js'
import type { PublicImageUploadOptions, PublicImageUrlResult, SyncedVolcAsset, VolcAssetReferenceInput } from './volc-asset-sync.js'
import { withVisualStyleLock } from './visual-style.js'
import { withTkOverseasVisualLock } from './overseas-visual.js'
import { appendStoryboardDialoguePrompt } from './video-dialogue-prompt.js'
import { isLatestGeneration } from './generation-freshness.js'

const VIDEO_DOWNLOAD_TIMEOUT_MS = 45000
const VIDEO_REQUEST_TIMEOUT_MS = 120_000
const VIDEO_POLL_REQUEST_TIMEOUT_MS = 65_000
const VIDEO_POLL_INTERVAL_MS = 10000
const VIDEO_POLL_MAX_ATTEMPTS = 300
const RESUMABLE_VIDEO_STATUSES = new Set(['pending', 'processing', 'queued', 'running'])
const activeVideoPollers = new Set<number>()

type VideoGenerationRow = typeof schema.videoGenerations.$inferSelect
type AIConfigRow = typeof schema.aiServiceConfigs.$inferSelect
type StaleVideoGenerationRecord = Pick<VideoGenerationRow, 'status' | 'taskId' | 'createdAt' | 'updatedAt' | 'provider'>

type VideoPollOptions = {
  initialDelayMs?: number
  intervalMs?: number
  maxAttempts?: number
}

export interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  duration?: number
  aspectRatio?: string
  configId?: number
  promptIsFinal?: boolean
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  const ts = now()
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('video')
  if (!config) throw new Error('No active video AI config')
  const visualContext = resolveVideoProjectVisualContext(params.storyboardId, params.dramaId)
  const finalPrompt = appendStoryboardDialoguePrompt(
    applyVideoVisualStyleLock(params.prompt, visualContext.style, visualContext.breakdownMode),
    params.storyboardId,
    visualContext.breakdownMode,
  )

  const res = db.insert(schema.videoGenerations).values({
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    prompt: finalPrompt,
    model: params.model || config.model,
    provider: config.provider,
    referenceMode: params.referenceMode || 'none',
    promptIsFinal: params.promptIsFinal === true,
    imageUrl: params.imageUrl,
    firstFrameUrl: params.firstFrameUrl,
    lastFrameUrl: params.lastFrameUrl,
    referenceImageUrls: params.referenceImageUrls ? JSON.stringify(params.referenceImageUrls) : null,
    duration: params.duration || 5,
    aspectRatio: params.aspectRatio || '16:9',
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  if (params.storyboardId) {
    db.update(schema.storyboards)
      .set({ videoUrl: null, composedVideoUrl: null, status: 'pending', updatedAt: ts })
      .where(eq(schema.storyboards.id, params.storyboardId))
      .run()
  }
  logTaskStart('VideoTask', 'enqueue', {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    referenceMode: params.referenceMode || 'none',
    duration: params.duration || 5,
  })
  logTaskPayload('VideoTask', 'enqueue params', {
    id: lastId,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })
  processVideoGeneration(lastId, config).catch(err => {
    logTaskError('VideoTask', 'process', { id: lastId, error: err.message })
    console.error(`Video generation ${lastId} failed:`, err)
  })
  return lastId
}

async function processVideoGeneration(id: number, config: AIConfig) {
  const adapter = getVideoAdapter(config.provider)

  try {
    const rows = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
    const record = rows[0]
    if (!record) return
    const visualContext = resolveVideoProjectVisualContext(record.storyboardId, record.dramaId)
    const requestRecord = {
      ...record,
      prompt: appendStoryboardDialoguePrompt(
        applyVideoVisualStyleLock(
          String(record.prompt || ''),
          visualContext.style,
          visualContext.breakdownMode,
        ),
        record.storyboardId,
        visualContext.breakdownMode,
      ),
    }
    logTaskProgress('VideoTask', 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      referenceMode: record.referenceMode,
    })

    const preparedRecord = config.provider === 'volcengine'
      ? await prepareVolcengineSeedanceRecord(requestRecord)
      : config.provider === 'eggfans'
        ? await preparePublicVideoReferenceRecord(requestRecord)
        : config.provider === 'mijing'
          ? await prepareMijingVideoReferenceRecord(requestRecord)
        : {
          imageUrl: await normalizeVideoReferenceUrl(record.imageUrl),
          firstFrameUrl: await normalizeVideoReferenceUrl(record.firstFrameUrl),
          lastFrameUrl: await normalizeVideoReferenceUrl(record.lastFrameUrl),
          referenceImageUrls: await normalizeVideoReferenceUrls(record.referenceImageUrls),
          prompt: String(requestRecord.prompt || ''),
          referenceMode: record.referenceMode || 'none',
        }

    persistPreparedVideoRequest(id, preparedRecord, record.promptIsFinal)

    // 使用 Adapter 构建请求
    const { url, method, headers, body } = adapter.buildGenerateRequest(config, {
      id: record.id,
      model: record.model,
      prompt: preparedRecord.prompt,
      referenceMode: preparedRecord.referenceMode || record.referenceMode,
      imageUrl: preparedRecord.imageUrl,
      firstFrameUrl: preparedRecord.firstFrameUrl,
      lastFrameUrl: preparedRecord.lastFrameUrl,
      referenceImageUrls: preparedRecord.referenceImageUrls ? JSON.stringify(preparedRecord.referenceImageUrls) : null,
      duration: record.duration,
      aspectRatio: record.aspectRatio,
    })
    logTaskProgress('VideoTask', 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
      referenceMode: record.referenceMode,
    })
    logTaskPayload('VideoTask', 'request payload', {
      id,
      method,
      url,
      headers,
      body,
    })

    const resp = await fetch(url, buildVideoFetchInit(method, headers, body, VIDEO_REQUEST_TIMEOUT_MS))

    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`)
    const result = await resp.json() as any

    const { isAsync, taskId, videoUrl } = adapter.parseGenerateResponse(result, config, {
      id: record.id,
      model: record.model,
      prompt: preparedRecord.prompt,
      referenceMode: preparedRecord.referenceMode || record.referenceMode,
      imageUrl: preparedRecord.imageUrl,
      firstFrameUrl: preparedRecord.firstFrameUrl,
      lastFrameUrl: preparedRecord.lastFrameUrl,
      referenceImageUrls: preparedRecord.referenceImageUrls ? JSON.stringify(preparedRecord.referenceImageUrls) : null,
      duration: record.duration,
      aspectRatio: record.aspectRatio,
    })

    if (!isAsync && videoUrl) {
      logTaskProgress('VideoTask', 'sync-complete', { id, videoUrl })
      // 同步模式
      await handleVideoComplete(id, videoUrl, record.duration, record.storyboardId)
      return
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.videoGenerations)
      .set({ taskId, status: 'processing', updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
    logTaskProgress('VideoTask', 'poll-start', { id, taskId, provider: config.provider })

    // Vidu 没有轮询端点，跳过轮询（依赖 Webhook 回调）
    if (adapter.provider === 'vidu') {
      logTaskProgress('VideoTask', 'webhook-wait', { id, taskId, provider: adapter.provider })
      return
    }

    startVideoPoller(id, config, taskId!, record.storyboardId)
  } catch (err: any) {
    logTaskError('VideoTask', 'process', { id, provider: config.provider, error: err.message })
    db.update(schema.videoGenerations)
      .set({ status: 'failed', errorMsg: err.message, updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
  }
}

async function prepareMijingVideoReferenceRecord(record: VideoPromptRecord): Promise<PreparedVideoReferenceRecord> {
  if (record.referenceMode !== 'first_frame_multiple') {
    return {
      imageUrl: await normalizeMijingReference(record.imageUrl, `镜头${record.storyboardId || record.id}-参考图`),
      firstFrameUrl: await normalizeMijingReference(record.firstFrameUrl, `镜头${record.storyboardId || record.id}-首帧`),
      lastFrameUrl: await normalizeMijingReference(record.lastFrameUrl, `镜头${record.storyboardId || record.id}-尾帧`),
      referenceImageUrls: await normalizeMijingReferences(record.referenceImageUrls, `镜头${record.storyboardId || record.id}-参考资产`),
      prompt: String(record.prompt || ''),
      referenceMode: record.referenceMode || 'none',
    }
  }

  const firstFrameUrl = await requireMijingReference(record.firstFrameUrl, `镜头${record.storyboardId || record.id}-首帧`)
  const parsed = parseReferenceImageUrls(record.referenceImageUrls)
  const references: string[] = []
  for (const [index, url] of parsed.entries()) {
    const reference = await normalizeMijingReference(url, `镜头${record.storyboardId || record.id}-参考资产${index + 1}`)
    if (reference && reference !== firstFrameUrl && !references.includes(reference)) references.push(reference)
  }
  return {
    imageUrl: null,
    firstFrameUrl,
    lastFrameUrl: null,
    referenceImageUrls: references.slice(0, 8),
    prompt: String(record.prompt || ''),
    referenceMode: 'first_frame_multiple',
  }
}

async function normalizeMijingReferences(value: string | null | undefined, name: string) {
  const parsed = parseReferenceImageUrls(value)
  const references: string[] = []
  for (const [index, reference] of parsed.entries()) {
    const normalized = await normalizeMijingReference(reference, `${name}${index + 1}`)
    if (normalized && !references.includes(normalized)) references.push(normalized)
  }
  return references
}

async function normalizeMijingReference(value: string | null | undefined, name: string) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (isVolcAssetUri(raw)) return normalizeVolcAssetUri(raw)
  return await ensureMijingPublicReference(raw, name)
}

async function requireMijingReference(value: string | null | undefined, name: string) {
  const reference = await normalizeMijingReference(value, name)
  if (!reference) throw new Error(`${name}缺少图片地址`)
  return reference
}

function isVolcAssetUri(value: string) {
  return /^(?:@)?asset:\/\//i.test(String(value || '').trim())
    || /^Asset:\/\//.test(String(value || '').trim())
}

export function normalizeVolcAssetUri(value: string) {
  const raw = String(value || '').trim().replace(/^@+/, '')
  const assetId = raw.replace(/^asset:\/\//i, '')
  if (!assetId) throw new Error('火山素材引用缺少资产 ID')
  return `Asset://${assetId}`
}

async function ensureMijingPublicReference(value: string | null | undefined, name: string) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error(`${name}缺少图片地址`)
  const uploaded = await ensurePublicImageUrl(raw, name)
  return uploaded.url
}

function parseReferenceImageUrls(value: string | null | undefined) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : []
  } catch {
    throw new Error('谜镜串行参考图列表解析失败')
  }
}

function persistPreparedVideoRequest(
  id: number,
  preparedRecord: PreparedVideoReferenceRecord,
  originalPromptIsFinal?: boolean | number | null,
) {
  db.update(schema.videoGenerations)
    .set({
      prompt: preparedRecord.prompt,
      finalPrompt: preparedRecord.prompt,
      promptIsFinal: originalPromptIsFinal === true || originalPromptIsFinal === 1,
      referenceMode: preparedRecord.referenceMode,
      imageUrl: preparedRecord.imageUrl,
      firstFrameUrl: preparedRecord.firstFrameUrl,
      lastFrameUrl: preparedRecord.lastFrameUrl,
      referenceImageUrls: preparedRecord.referenceImageUrls.length
        ? JSON.stringify(preparedRecord.referenceImageUrls)
        : null,
      updatedAt: now(),
    })
    .where(eq(schema.videoGenerations.id, id))
    .run()
}

export function isResumableVideoGeneration(
  record: Pick<VideoGenerationRow, 'status' | 'taskId' | 'provider' | 'deletedAt'> | null | undefined,
) {
  if (!record) return false
  if (record.deletedAt) return false
  const provider = String(record.provider || '').trim().toLowerCase()
  const status = String(record.status || '').trim().toLowerCase()
  const taskId = String(record.taskId || '').trim()
  return !!taskId && provider !== 'vidu' && RESUMABLE_VIDEO_STATUSES.has(status)
}

export function isStaleUnrecoverableVideoGeneration(
  record: StaleVideoGenerationRecord | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = 15 * 60 * 1000,
) {
  if (!record) return false
  const provider = String(record.provider || '').trim().toLowerCase()
  if (provider === 'vidu') return false
  const status = String(record.status || '').trim().toLowerCase()
  if (!RESUMABLE_VIDEO_STATUSES.has(status)) return false
  if (String(record.taskId || '').trim()) return false

  const timestamp = Date.parse(String(record.updatedAt || record.createdAt || ''))
  if (!Number.isFinite(timestamp)) return false
  return nowMs - timestamp >= maxAgeMs
}

export function buildVideoFetchInit(
  method: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs = VIDEO_REQUEST_TIMEOUT_MS,
): RequestInit {
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  return init
}

export function ensureVideoPolling(
  record: Pick<VideoGenerationRow, 'id' | 'storyboardId' | 'provider' | 'model' | 'status' | 'taskId' | 'createdAt' | 'updatedAt' | 'deletedAt'> | null | undefined,
  reason = 'api',
) {
  if (isStaleUnrecoverableVideoGeneration(record)) {
    db.update(schema.videoGenerations)
      .set({
        status: 'failed',
        errorMsg: '任务长时间处于处理中但缺少可轮询任务 ID，已自动标记失败，请重新生成',
        updatedAt: now(),
      })
      .where(eq(schema.videoGenerations.id, record!.id))
      .run()
    logTaskWarn('VideoTask', 'stale-unrecoverable-marked-failed', {
      id: record?.id,
      provider: record?.provider,
      model: record?.model,
      reason,
    })
    return false
  }
  if (!isResumableVideoGeneration(record)) return false
  if (!record?.id || !record.taskId) return false
  if (activeVideoPollers.has(record.id)) return false

  const config = resolveVideoPollingConfig(record)
  if (!config) {
    logTaskWarn('VideoTask', 'poll-resume-config-missing', {
      id: record.id,
      provider: record.provider,
      model: record.model,
      reason,
    })
    return false
  }

  return startVideoPoller(record.id, config, record.taskId, record.storyboardId, {
    initialDelayMs: 0,
  }, reason)
}

export async function resumePendingVideoPolls(reason = 'startup') {
  const rows = db.select().from(schema.videoGenerations).all()
  let resumed = 0
  for (const row of rows) {
    if (ensureVideoPolling(row, reason)) resumed += 1
  }
  logTaskProgress('VideoTask', 'poll-resume-scan', { reason, resumed })
  return resumed
}

function startVideoPoller(
  id: number,
  config: AIConfig,
  taskId: string,
  storyboardId?: number | null,
  options: VideoPollOptions = {},
  reason = 'generate',
) {
  if (!taskId) return false
  if (activeVideoPollers.has(id)) return false

  activeVideoPollers.add(id)
  logTaskProgress('VideoTask', 'poller-start', {
    id,
    taskId,
    provider: config.provider,
    reason,
  })

  pollVideoTask(id, config, taskId, storyboardId, options)
    .catch((err: any) => {
      logTaskError('VideoTask', 'poller-crashed', {
        id,
        taskId,
        provider: config.provider,
        error: err?.message || String(err),
      })
      db.update(schema.videoGenerations)
        .set({ status: 'failed', errorMsg: `轮询异常：${err?.message || String(err)}`, updatedAt: now() })
        .where(eq(schema.videoGenerations.id, id))
        .run()
    })
    .finally(() => {
      activeVideoPollers.delete(id)
    })

  return true
}

function resolveVideoPollingConfig(
  record: Pick<VideoGenerationRow, 'provider' | 'model'>,
): AIConfig | null {
  const provider = String(record.provider || '').trim().toLowerCase()
  if (!provider) return null

  const targetModel = String(record.model || '').trim()
  const configs = db.select().from(schema.aiServiceConfigs).all()
    .filter(row => row.isActive && row.serviceType === 'video' && String(row.provider || '').trim().toLowerCase() === provider)
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

type VideoPromptRecord = Pick<
  typeof schema.videoGenerations.$inferSelect,
  'id' | 'storyboardId' | 'dramaId' | 'prompt' | 'promptIsFinal' | 'model' | 'referenceMode' | 'imageUrl' | 'firstFrameUrl' | 'lastFrameUrl' | 'referenceImageUrls'
>

type PreparedVolcengineRecord = {
  prompt: string
  imageUrl: null
  firstFrameUrl: null
  lastFrameUrl: null
  referenceImageUrls: string[]
  referenceMode?: string
  assetIds: string[]
  assetCount: number
  syncedAssetCount: number
}

type PreparedVideoReferenceRecord = {
  prompt: string
  imageUrl: string | null
  firstFrameUrl: string | null
  lastFrameUrl: string | null
  referenceImageUrls: string[]
  referenceMode?: string
}

type PublicVideoReferenceContext = {
  sceneImages: Array<{ name: string; url: string }>
  characterImages: Array<{ name: string; url: string; characterId?: number; asset?: SyncedVolcAsset }>
}

type EnsurePublicVideoReference = (
  url: string,
  name: string,
  options?: PublicImageUploadOptions,
) => Promise<PublicImageUrlResult>

const GROK_VIDEO_MAX_REFERENCE_IMAGES = 7

const ensurePublicVideoReference: EnsurePublicVideoReference = (url, name, options) => {
  return ensurePublicImageUrl(url, name, undefined, undefined, options)
}

type PrepareVolcPromptOptions = {
  persistFinalPrompt?: boolean
}

export async function previewVideoPrompt(params: GenerateVideoParams) {
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('video')
  if (!config) throw new Error('No active video AI config')

  const model = params.model || config.model
  const referenceMode = params.referenceMode || 'none'
  const visualContext = resolveVideoProjectVisualContext(params.storyboardId, params.dramaId)
  const prompt = appendStoryboardDialoguePrompt(
    applyVideoVisualStyleLock(
      params.prompt,
      visualContext.style,
      visualContext.breakdownMode,
    ),
    params.storyboardId,
    visualContext.breakdownMode,
  )
  if (config.provider !== 'volcengine') {
    const prepared = config.provider === 'eggfans'
      ? await preparePublicVideoReferenceRecord({
        id: 0,
        storyboardId: params.storyboardId || null,
        dramaId: params.dramaId || null,
        prompt,
        promptIsFinal: params.promptIsFinal === true,
        model,
        referenceMode,
        imageUrl: params.imageUrl || null,
        firstFrameUrl: params.firstFrameUrl || null,
        lastFrameUrl: params.lastFrameUrl || null,
        referenceImageUrls: params.referenceImageUrls ? JSON.stringify(params.referenceImageUrls) : null,
      })
      : {
        prompt,
        referenceImageUrls: params.referenceImageUrls || [],
      }
    return {
      provider: config.provider,
      model,
      reference_mode: referenceMode,
      prompt: prepared.prompt,
      final_prompt: prepared.prompt,
      prompt_is_final: params.promptIsFinal === true,
      asset_count: prepared.referenceImageUrls.length,
      synced_asset_count: prepared.referenceImageUrls.length,
      asset_ids: [],
      reference_image_urls: prepared.referenceImageUrls,
      reference_kind: 'public_image_url',
    }
  }

  const prepared = await prepareVolcengineSeedanceRecord({
    id: 0,
    storyboardId: params.storyboardId || null,
    dramaId: params.dramaId || null,
    prompt,
    promptIsFinal: params.promptIsFinal === true,
    model,
    referenceMode,
    imageUrl: params.imageUrl || null,
    firstFrameUrl: params.firstFrameUrl || null,
    lastFrameUrl: params.lastFrameUrl || null,
    referenceImageUrls: params.referenceImageUrls ? JSON.stringify(params.referenceImageUrls) : null,
  }, { persistFinalPrompt: false })

  return {
    provider: config.provider,
    model,
    reference_mode: referenceMode,
    prompt: prepared.prompt,
    final_prompt: prepared.prompt,
    prompt_is_final: params.promptIsFinal === true,
    asset_count: prepared.assetCount,
    synced_asset_count: prepared.syncedAssetCount,
    asset_ids: prepared.assetIds,
    reference_kind: 'volc_asset',
  }
}

export function applyVideoVisualStyleLock(
  prompt: string,
  visualStyle?: string | null,
  breakdownMode?: string | null,
) {
  const styleLocked = visualStyle
    ? withVisualStyleLock(prompt, visualStyle, '视频最终生成')
    : String(prompt || '').trim()
  return withTkOverseasVisualLock(styleLocked, breakdownMode, '视频最终生成')
}

function resolveVideoProjectVisualContext(storyboardId?: number | null, dramaId?: number | null) {
  const resolvedStoryboardId = Number(storyboardId || 0)
  if (resolvedStoryboardId > 0) {
    const [storyboard] = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.id, resolvedStoryboardId)).all()
    if (storyboard) {
      const [episode] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, storyboard.episodeId)).all()
      if (episode) {
        const [drama] = db.select().from(schema.dramas)
          .where(eq(schema.dramas.id, episode.dramaId)).all()
        return { style: drama?.style || null, breakdownMode: episode.breakdownMode || null }
      }
    }
  }

  const resolvedDramaId = Number(dramaId || 0)
  if (resolvedDramaId > 0) {
    const [drama] = db.select().from(schema.dramas)
      .where(eq(schema.dramas.id, resolvedDramaId)).all()
    return { style: drama?.style || null, breakdownMode: null }
  }
  return { style: null, breakdownMode: null }
}

async function prepareVolcengineSeedanceRecord(
  record: VideoPromptRecord,
  options: PrepareVolcPromptOptions = {},
): Promise<PreparedVolcengineRecord> {
  const basePrompt = record.promptIsFinal
    ? sanitizeVolcFinalPrompt(String(record.prompt || ''))
    : String(record.prompt || '')

  const refs = collectVideoReferences(record)
  if (!refs.length) {
    return {
      prompt: basePrompt,
      imageUrl: null,
      firstFrameUrl: null,
      lastFrameUrl: null,
      referenceImageUrls: [],
      assetIds: [],
      assetCount: 0,
      syncedAssetCount: 0,
    }
  }

  const context = getVideoAssetContext(record)
  const synced = await syncRequiredVolcReferences(refs, record, context)
  const storyboardPrompt = prependVolcStoryboardAssetSequence(basePrompt, synced)
  const promptRefs = filterVolcSemanticReferencesByPromptRoles(storyboardPrompt, synced)
  const finalPrompt = buildVolcFinalPrompt(storyboardPrompt, synced)

  if (options.persistFinalPrompt !== false && record.id) {
    db.update(schema.videoGenerations)
      .set({ finalPrompt, updatedAt: now() })
      .where(eq(schema.videoGenerations.id, record.id))
      .run()
  }

  logTaskProgress('VideoTask', 'volc-assets-ready', {
    id: record.id,
    storyboardId: record.storyboardId,
    assetCount: promptRefs.length,
    syncedAssetCount: synced.length,
    assetIds: promptRefs.map(item => item.asset.providerAssetId),
  })

  return {
    prompt: finalPrompt,
    imageUrl: null,
    firstFrameUrl: null,
    lastFrameUrl: null,
    referenceImageUrls: [],
    assetIds: promptRefs.map(item => item.asset.providerAssetId),
    assetCount: promptRefs.length,
    syncedAssetCount: synced.length,
  }
}

export function sanitizeVolcFinalPrompt(prompt: string) {
  return String(prompt || '')
    .replace(
      /绑定规则：.*(?:脸型|发型|服装|着装|外形|人物形象).*/g,
      '绑定规则：以上每个“名称=@asset://资产ID”只声明一次；分镜正文和对白中的角色名、场景名、参考图标记保持原文本，不要在正文中反复插入资产 ID。出现已绑定角色或场景名称时，必须直接以对应资产 ID 作为唯一视觉参考；不要根据文字另行设计角色视觉。',
    )
    .replace(
      /生成约束：.*(?:脸型|发型|服装|着装|外形|人物形象).*/g,
      '生成约束：必须以原始分镜提示词为剧情、动作和镜头运动依据；已绑定角色和场景的视觉信息只以资产 ID 为准；镜头参考图用于理解构图、动作、主体位置和画面节奏；不要替换人物，不要改变角色关系，不要忽略任何编号参考图。',
    )
    .replace(/(?:脸型|发型|服装|着装|外形|人物形象)[，,、和及]?/g, '')
}

export function buildVolcFinalPrompt(
  prompt: string,
  synced: Array<RequiredVideoReference & { asset: SyncedVolcAsset }>,
) {
  const basePrompt = sanitizeVolcFinalPrompt(prompt)
  const promptRefs = filterVolcSemanticReferencesByPromptRoles(basePrompt, synced)
  const missingRefs = promptRefs.filter(item => !promptAlreadyHasVolcBinding(basePrompt, item))
  const assetPrompt = buildVolcAssetPrompt(missingRefs)
  if (!assetPrompt) return basePrompt
  return [
    basePrompt,
    `Seedance 2.0 参考素材约束：以下资产 ID 已按用户选择顺序列出，必须结合上方分镜文本逐条生成，不得忽略、打乱或合并参考顺序。\n${assetPrompt}`,
  ].filter(Boolean).join('\n')
}

export async function preparePublicVideoReferenceRecord(
  record: VideoPromptRecord,
  context: PublicVideoReferenceContext = getVideoAssetContext(record),
  ensurePublic: EnsurePublicVideoReference = ensurePublicVideoReference,
): Promise<PreparedVideoReferenceRecord> {
  const isGrok = isGrokVideoModelName(record.model)
  const referenceLimit = isGrok ? GROK_VIDEO_MAX_REFERENCE_IMAGES : 9
  const refs = collectVideoReferencesFromContext(record, context, referenceLimit)
  if (!refs.length) {
    return {
      prompt: String(record.prompt || ''),
      imageUrl: null,
      firstFrameUrl: null,
      lastFrameUrl: null,
      referenceImageUrls: [],
      referenceMode: 'none',
    }
  }

  const uploaded: Array<RequiredVideoReference & { publicUrl: string; provider: string }> = []
  const failedRefs: Array<RequiredVideoReference & { error: string }> = []

  for (const ref of refs) {
    try {
      const hosted = await ensurePublic(
        ref.url,
        ref.name,
        isGrok
          ? {
            preferUguu: true,
            validateResult: true,
            allowedProviders: ['uguu-upload', 'eggfans-image-host'],
          }
          : undefined,
      )
      uploaded.push({ ...ref, publicUrl: hosted.url, provider: hosted.provider })
    } catch (err) {
      failedRefs.push({ ...ref, error: err instanceof Error ? err.message : String(err || 'unknown error') })
    }
  }

  if (failedRefs.length) {
    const reasons = failedRefs.map(item => `${item.name}: ${item.error}`).join('；')
    throw new Error(`Eggfans/Grok 视频参考图上传公网图床失败，已取消视频生成。${failedRefs.length}/${refs.length} 张失败：${reasons}`)
  }

  const selected = uploaded.slice(0, referenceLimit)
  const referenceImageUrls = selected.map(item => item.publicUrl)
  const prompt = appendPublicVideoReferencePrompt(String(record.prompt || ''), selected, isGrok ? {
    title: 'Eggfans/Grok 视频参考图：多图参考，最多7张；以下图片链接已上传到公网图床，并会作为 images 参数传输；必须结合分镜文本使用，不要忽略角色和场景参考。',
    rule: '参考规则：Grok 本次使用多参考图模式，最多 7 张，人物、场景和镜头参考图共同计数；角色设定稿用于锁定人物五官、发型、体型和固定服装；场景图用于锁定空间环境；镜头参考图用于锁定构图、动作和画面节奏。不要使用首帧图模式，不要重新设计角色外观。',
  } : undefined)

  logTaskProgress('VideoTask', 'public-references-ready', {
    id: record.id,
    storyboardId: record.storyboardId,
    referenceCount: referenceImageUrls.length,
    referencePolicy: isGrok ? 'grok-public-multiple-max-7' : 'public-multiple',
    providers: Array.from(new Set(selected.map(item => item.provider))),
  })

  return {
    prompt,
    imageUrl: null,
    firstFrameUrl: null,
    lastFrameUrl: null,
    referenceImageUrls,
    referenceMode: referenceImageUrls.length ? 'multiple' : 'none',
  }
}

function isGrokVideoModelName(model: string | null | undefined) {
  return String(model || '').toLowerCase().includes('grok-video')
}

function collectVideoReferencesFromContext(
  record: VideoPromptRecord,
  context: PublicVideoReferenceContext,
  maxReferences = 9,
) {
  const refs: RequiredVideoReference[] = []
  const seen = new Set<string>()
  const push = (
    url: string | null | undefined,
    name: string,
    role: string,
    category = 'reference',
    order?: number,
    entityName?: string,
    existingAsset?: SyncedVolcAsset,
  ) => {
    const value = String(url || '').trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    refs.push({ url: value, name, role, category, order, entityName, existingAsset })
  }

  const storyboardLabel = record.storyboardId ? `镜头${record.storyboardId}` : `视频任务${record.id}`
  if (record.referenceMode === 'single') {
    push(record.imageUrl, `${storyboardLabel}-首帧`, 'first_frame', 'storyboard', 1)
  } else if (record.referenceMode === 'first_last') {
    push(record.firstFrameUrl, `${storyboardLabel}-首帧`, 'first_frame', 'storyboard', 1)
    push(record.lastFrameUrl, `${storyboardLabel}-尾帧`, 'last_frame', 'storyboard', 2)
  } else if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
    let parsed: unknown = []
    try {
      parsed = JSON.parse(record.referenceImageUrls)
    } catch {
      parsed = []
    }
    if (Array.isArray(parsed)) {
      parsed.forEach((url, index) => push(
        String(url || ''),
        `${storyboardLabel}-参考图${index + 1}`,
        'reference_image',
        'storyboard',
        index + 1,
      ))
    }
  }

  context.sceneImages.forEach((item, index) => push(item.url, `场景-${item.name || index + 1}`, 'scene', 'scene', undefined, item.name))
  context.characterImages.forEach((item, index) => push(
    item.url,
    `角色-${item.name || index + 1}`,
    'character',
    'character',
    undefined,
    item.name,
    item.asset,
  ))
  return refs.slice(0, maxReferences)
}

function appendPublicVideoReferencePrompt(
  prompt: string,
  uploaded: Array<RequiredVideoReference & { publicUrl: string; provider: string }>,
  copy: { title?: string; rule?: string } = {},
) {
  const basePrompt = stripPublicVideoReferencePrompt(prompt)
  if (!uploaded.length) return basePrompt

  const lines = [
    copy.title || 'Eggfans/Grok 视频参考图：以下图片链接已上传到公网图床，并会作为 images 参数传输；必须结合分镜文本使用，不要忽略角色和场景参考。',
    ...uploaded.map((item, index) => {
      const label = item.category === 'storyboard' && item.role === 'reference_image'
        ? `参考图${item.order || index + 1}`
        : cleanBindingLabel(item.name || item.entityName)
      return `${label || item.name}=${item.publicUrl}`
    }),
    copy.rule || '参考规则：角色设定稿用于锁定人物五官、发型、体型和固定服装；场景图用于锁定空间环境；镜头参考图用于锁定构图、动作和画面节奏。不要重新设计角色外观。',
  ]
  return [basePrompt, ...lines].filter(Boolean).join('\n')
}

function stripPublicVideoReferencePrompt(prompt: string) {
  const lines = String(prompt || '').split(/\r?\n/)
  const kept: string[] = []
  let skipping = false

  for (const line of lines) {
    if (isPublicVideoReferenceBlockStart(line)) {
      skipping = true
      continue
    }

    if (skipping) {
      if (/^\s*参考规则[：:]/.test(line)) {
        skipping = false
      }
      continue
    }

    kept.push(line)
  }

  return kept.join('\n').trim()
}

function isPublicVideoReferenceBlockStart(line: string) {
  return /Eggfans\/Grok 视频参考图|Grok公网参考|Eggfans 视频参考图/.test(String(line || ''))
}

export function buildVolcAssetPrompt(
  synced: Array<RequiredVideoReference & { asset: SyncedVolcAsset }>,
) {
  const orderedStoryboardRefs = synced
    .filter(item => item.category === 'storyboard' && item.role === 'reference_image')
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
  const extraRefs = synced.filter(item => !(item.category === 'storyboard' && item.role === 'reference_image'))
  const characterRefs = groupSemanticVolcAssetBindings(extraRefs.filter(item => item.category === 'character'))
  const sceneRefs = groupSemanticVolcAssetBindings(extraRefs.filter(item => item.category === 'scene'))
  const otherExtraRefs = extraRefs.filter(item => item.category !== 'character' && item.category !== 'scene')
  const lines: string[] = []
  const assetBindings: string[] = []

  if (orderedStoryboardRefs.length) {
    const sequence = orderedStoryboardRefs
      .map((item, index) => `参考图${item.order || index + 1}`)
      .join(' → ')
    orderedStoryboardRefs.forEach((item, index) => {
      const order = item.order || index + 1
      assetBindings.push(`${buildStoryboardBindingLabel(item, order)}=${formatVolcAssetReference(item.asset).trim()}`)
    })
    lines.push(`这 ${orderedStoryboardRefs.length} 张镜头参考图是有顺序的，必须严格按${sequence}的顺序理解镜头连续动作、构图、人物状态和画面变化。`)
    orderedStoryboardRefs.forEach((item, index) => {
      const order = item.order || index + 1
      const bindingLabel = buildStoryboardBindingLabel(item, order)
      lines.push(`参考图${order}：对应“资产绑定”中的${bindingLabel}，只能按这个顺序作为第 ${order} 段/第 ${order} 个画面状态的参考。`)
    })
  }

  const semanticBindings = [
    ...characterRefs.map(item => ({ ...item, label: '角色' })),
    ...sceneRefs.map(item => ({ ...item, label: '场景' })),
  ]
  if (semanticBindings.length) {
    semanticBindings.forEach((item) => {
      assetBindings.push(`${item.entityName}=${item.assetRefs}`)
    })
  }

  if (assetBindings.length) {
    lines.push('资产绑定：')
    lines.push(...Array.from(new Set(assetBindings)))
    lines.push('绑定规则：以上每个“名称=@asset://资产ID”只声明一次；分镜正文和对白中的角色名、场景名、参考图标记保持原文本，不要在正文中反复插入资产 ID。出现已绑定角色或场景名称时，必须直接以对应资产 ID 作为唯一视觉参考；不要根据文字另行设计角色视觉。')
  }

  if (otherExtraRefs.length) {
    lines.push(`附加一致性素材：${otherExtraRefs.map((item) => {
      const tag = formatVolcAssetReference(item.asset)
      if (item.role === 'first_frame') return `首帧参考 ${tag}`
      if (item.role === 'last_frame') return `尾帧参考 ${tag}`
      return `参考素材 ${tag}`
    }).join('；')}`)
  }

  lines.push('生成约束：必须以原始分镜提示词为剧情、动作和镜头运动依据；已绑定角色和场景的视觉信息只以资产 ID 为准；镜头参考图用于理解构图、动作、主体位置和画面节奏；不要替换人物，不要改变角色关系，不要忽略任何编号参考图。')

  return lines.join('\n')
}

export function prependVolcStoryboardAssetSequence(
  prompt: string,
  synced: Array<RequiredVideoReference & { asset: SyncedVolcAsset }>,
) {
  const storyboardRefs = synced
    .filter(item => item.category === 'storyboard' && item.role === 'reference_image')
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
  if (!storyboardRefs.length) return String(prompt || '')

  const segments = splitPromptSegments(prompt)
  if (!segments.length) return String(prompt || '')

  return segments.map((segment, index) => {
    const ref = storyboardRefs[index]
    if (!ref) return segment
    const label = `参考图${ref.order || index + 1}；`
    if (segment.startsWith(label)) return segment
    return `${label}${segment}`
  }).join('<n>')
}

export function filterVolcSemanticReferencesByPromptRoles<T extends RequiredVideoReference>(
  prompt: string,
  refs: T[],
) {
  const visibleRoleNames = extractPromptTagValues(prompt, 'role')
  const visualText = normalizeEntityText(stripDialogueText(prompt))
  return refs.filter((item) => {
    if (item.category !== 'character') return true
    const aliases = semanticReferenceAliases(item)
    if (!aliases.length) return false
    if (!visibleRoleNames.length) return aliases.some(alias => visualText.includes(alias))
    return aliases.some(alias => visibleRoleNames.some(roleName => roleName === alias || roleName.includes(alias) || alias.includes(roleName)))
  })
}

function groupSemanticVolcAssetBindings(
  refs: Array<RequiredVideoReference & { asset: SyncedVolcAsset }>,
) {
  const grouped = new Map<string, { category: string; entityName: string; assetRefs: string[] }>()
  refs.forEach((item) => {
    const entityName = buildSemanticBindingLabel(item)
    if (!entityName) return
    const key = `${item.category}:${entityName}`
    const current = grouped.get(key) || { category: item.category, entityName, assetRefs: [] }
    const assetRef = formatVolcAssetReference(item.asset).trim()
    if (!current.assetRefs.includes(assetRef)) current.assetRefs.push(assetRef)
    grouped.set(key, current)
  })

  return Array.from(grouped.values()).map(item => ({
    category: item.category,
    entityName: item.entityName,
    assetRefs: item.assetRefs.join(' ；'),
  }))
}

function splitPromptSegments(prompt: string) {
  return String(prompt || '')
    .split(/<n>/i)
    .map(item => item.trim())
    .filter(Boolean)
}

function extractPromptTagValues(prompt: string, tagName: string) {
  const values: string[] = []
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(prompt || '')))) {
    const value = normalizeEntityText(String(match[1] || '').replace(/@asset:\/\/[^\s；;，,。<]+/g, ''))
    if (value && !values.includes(value)) values.push(value)
  }
  return values
}

function stripReferencePrefix(value: string) {
  return String(value || '').trim().replace(/^(角色|场景|参考素材|镜头\d+-参考图\d+)[-：:]/, '').trim()
}

function normalizeEntityText(value: string) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[，,。；;：:、]/g, '')
    .trim()
}

function stripDialogueText(prompt: string) {
  return String(prompt || '')
    .split(/\n+/)
    .filter(line => !/^\s*(?:对白|台词|旁白)\s*[：:]/.test(line))
    .join('\n')
}

function promptAlreadyHasVolcBinding(
  prompt: string,
  item: RequiredVideoReference & { asset: SyncedVolcAsset },
) {
  const label = item.category === 'storyboard' && item.role === 'reference_image'
    ? buildStoryboardBindingLabel(item, item.order || 0)
    : buildSemanticBindingLabel(item)
  if (!label) return false
  const assetRef = formatVolcAssetReference(item.asset).trim()
  const pattern = new RegExp(`${escapeRegExp(label)}\\s*=\\s*${escapeRegExp(assetRef)}`)
  return pattern.test(prompt)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatVolcAssetReference(asset: SyncedVolcAsset) {
  const raw = String(asset.assetUri || asset.providerAssetId || '').trim()
  const normalized = raw
    .replace(/^@+/, '')
    .replace(/^asset:\/\//i, '')
    .replace(/^Asset:\/\//, '')
  if (!normalized) throw new Error('火山素材引用缺少资产 ID')
  return `@asset://${normalized} `
}

function buildStoryboardBindingLabel(
  item: RequiredVideoReference & { asset: SyncedVolcAsset },
  order: number,
) {
  const base = `参考图${order || item.order || ''}`.trim() || cleanBindingLabel(item.name) || '参考图'
  const localName = cleanBindingLabel(item.asset.localName)
  const originalName = cleanBindingLabel(item.name)
  if (localName && localName !== originalName && localName !== base) return `${base}（${localName}）`
  return base
}

function buildSemanticBindingLabel(item: RequiredVideoReference & { asset?: SyncedVolcAsset }) {
  const fallback = cleanBindingLabel(item.entityName || stripReferencePrefix(item.name))
  const localName = cleanBindingLabel(item.asset?.localName)
  const originalName = cleanBindingLabel(item.name)
  if (localName && localName !== originalName && localName !== fallback) return localName
  return fallback || localName || originalName
}

function semanticReferenceAliases(item: RequiredVideoReference & { asset?: SyncedVolcAsset }) {
  return [
    item.entityName,
    stripReferencePrefix(item.name),
    item.asset?.localName,
  ]
    .map(value => normalizeEntityText(value || ''))
    .filter((value, index, arr) => value && arr.indexOf(value) === index)
}

function cleanBindingLabel(value: string | null | undefined) {
  return String(value || '')
    .replace(/@asset:\/\/[^\s；;，,。<]+/g, '')
    .replace(/[=@\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

type RequiredVideoReference = {
  url: string
  name: string
  role: string
  category: string
  order?: number
  entityName?: string
  characterId?: number
  existingAsset?: SyncedVolcAsset
}

type VideoAssetContext = {
  episodeId?: number | null
  storyboardNum?: number | null
  groupName?: string | null
}

type VolcSyncRecordContext = {
  id: number
  storyboardId?: number | null
  dramaId?: number | null
}

export async function syncRequiredVolcReferences(
  refs: RequiredVideoReference[],
  record: VolcSyncRecordContext,
  context: VideoAssetContext,
  syncAsset: (input: VolcAssetReferenceInput) => Promise<SyncedVolcAsset> = syncVolcImageAsset,
  options: {
    syncCharacterAsset?: (characterId: number) => Promise<SyncedVolcAsset>
  } = {},
) {
  const synced: Array<RequiredVideoReference & { asset: SyncedVolcAsset }> = []
  const failedRefs: Array<RequiredVideoReference & { error: string }> = []

  for (const ref of refs) {
    try {
      let asset = ref.existingAsset
      if (!asset && ref.category === 'character' && ref.characterId) {
        asset = await (options.syncCharacterAsset || syncVolcCharacterAssetForCharacter)(ref.characterId)
      }
      if (!asset) {
        asset = await syncAsset({
          url: ref.url,
          name: ref.name,
          category: ref.category,
          dramaId: record.dramaId,
          episodeId: context.episodeId,
          storyboardId: record.storyboardId,
          storyboardNum: context.storyboardNum,
          groupName: context.groupName,
          source: 'volc:seedanceReference',
        })
      }
      synced.push({ ...ref, asset })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || 'unknown error')
      failedRefs.push({ ...ref, error: message })
      logTaskWarn('VideoTask', 'volc-asset-sync-failed', {
        id: record.id,
        storyboardId: record.storyboardId,
        ref: ref.name,
        url: redactUrl(ref.url),
        error: message,
      })
    }
  }

  if (failedRefs.length) {
    const reasons = failedRefs.map(item => `${item.name}: ${item.error}`).join('；')
    throw new Error(`参考图上传火山素材失败，已取消视频生成。${failedRefs.length}/${refs.length} 张失败：${reasons}`)
  }

  return synced
}

export function collectVideoReferences(record: VideoPromptRecord) {
  const refs: RequiredVideoReference[] = []
  const seen = new Set<string>()
  const push = (
    url: string | null | undefined,
    name: string,
    role: string,
    category = 'reference',
    order?: number,
    entityName?: string,
    existingAsset?: SyncedVolcAsset,
    characterId?: number,
  ) => {
    const value = String(url || '').trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    refs.push({ url: value, name, role, category, order, entityName, existingAsset, characterId })
  }

  const storyboardLabel = record.storyboardId ? `镜头${record.storyboardId}` : `视频任务${record.id}`
  if (record.referenceMode === 'single') {
    pushRequired(record.imageUrl, `${storyboardLabel}-首帧`, 'first_frame', 'storyboard', '单图参考模式缺少首帧参考图', 1)
  } else if (record.referenceMode === 'first_last') {
    pushRequired(record.firstFrameUrl, `${storyboardLabel}-首帧`, 'first_frame', 'storyboard', '首尾帧模式缺少首帧参考图', 1)
    pushRequired(record.lastFrameUrl, `${storyboardLabel}-尾帧`, 'last_frame', 'storyboard', '首尾帧模式缺少尾帧参考图', 2)
  } else if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
    let parsed: unknown
    try {
      parsed = JSON.parse(record.referenceImageUrls)
    } catch {
      throw new Error('Seedance 2.0 多图参考解析失败，已取消视频生成')
    }
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error('Seedance 2.0 多图参考模式缺少参考图，已取消视频生成')
    }
    parsed.forEach((url, index) => pushRequired(
      url,
      `${storyboardLabel}-参考图${index + 1}`,
      'reference_image',
      'storyboard',
      `多图参考模式第 ${index + 1} 张参考图为空`,
      index + 1,
    ))
  } else if (record.referenceMode === 'multiple') {
    throw new Error('Seedance 2.0 多图参考模式缺少参考图，已取消视频生成')
  }

  const context = getVideoAssetContext(record)
  context.sceneImages.forEach((item, index) => push(item.url, `场景-${item.name || index + 1}`, 'scene', 'scene', undefined, item.name))
  context.characterImages.forEach((item, index) => push(
    item.url,
    `角色-${item.name || index + 1}`,
    'character',
    'character',
    undefined,
    item.name,
    item.asset,
    item.characterId,
  ))

  return refs.slice(0, 9)

  function pushRequired(
    url: string | null | undefined,
    name: string,
    role: string,
    category: string,
    emptyMessage: string,
    order?: number,
  ) {
    if (!String(url || '').trim()) {
      throw new Error(`Seedance 2.0 ${emptyMessage}，已取消视频生成`)
    }
    push(url, name, role, category, order)
  }
}

function getVideoAssetContext(record: VideoPromptRecord) {
  const [storyboard] = record.storyboardId
    ? db.select().from(schema.storyboards).where(eq(schema.storyboards.id, record.storyboardId)).all()
    : []
  const [episode] = storyboard?.episodeId
    ? db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all()
    : []
  const [drama] = record.dramaId
    ? db.select().from(schema.dramas).where(eq(schema.dramas.id, record.dramaId)).all()
    : episode?.dramaId
      ? db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).all()
      : []
  const [scene] = storyboard?.sceneId
    ? db.select().from(schema.scenes).where(eq(schema.scenes.id, storyboard.sceneId)).all()
    : []
  const characterIds = storyboard?.id
    ? db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboard.id))
      .all()
      .map(item => item.characterId)
    : []
  const characters = characterIds.length
    ? db.select().from(schema.characters).all()
      .filter(char => characterIds.includes(char.id) && !char.deletedAt && char.imageUrl)
    : []

  return {
    episodeId: episode?.id || storyboard?.episodeId || null,
    storyboardNum: storyboard?.storyboardNumber || null,
    groupName: drama?.title ? `${drama.title}-火山素材库` : record.dramaId ? `Eggfans-短剧-${record.dramaId}` : null,
    sceneName: scene?.location || storyboard?.location || '',
    sceneImages: scene?.imageUrl ? [{ name: scene?.location || storyboard?.location || '场景', url: scene.imageUrl }] : [],
    characterImages: characters.map(char => ({
      characterId: char.id,
      name: char.name,
      url: char.imageUrl!,
      asset: buildCharacterExistingVolcAsset(char),
    })),
  }
}

function buildCharacterExistingVolcAsset(
  char: typeof schema.characters.$inferSelect,
): SyncedVolcAsset | undefined {
  const providerAssetId = String(char.volcCharacterAssetId || '').trim()
  const assetUri = String(char.volcCharacterUri || '').trim()
  if (!providerAssetId && !assetUri) return undefined
  return {
    localAssetId: Number(char.volcCharacterLocalAssetId || 0),
    localName: char.name || null,
    providerAssetId: providerAssetId || assetUri.replace(/^asset:\/\//i, ''),
    assetUri: assetUri || providerAssetId,
    groupName: '火山虚拟角色库',
    publicUrl: char.imageUrl || '',
  }
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      return await readImageAsCompressedDataUrl(localPath, {
        maxWidth: 768,
        maxHeight: 768,
        quality: 68,
      })
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(raw: string | null | undefined): Promise<string[]> {
  if (!raw) return []
  let refs: string[] = []
  try {
    refs = JSON.parse(raw)
  } catch {
    refs = []
  }
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(item)),
  )
  return normalized.filter((item): item is string => !!item)
}

async function pollVideoTask(
  id: number,
  config: AIConfig,
  taskId: string,
  storyboardId?: number | null,
  options: VideoPollOptions = {},
) {
  const adapter = getVideoAdapter(config.provider)
  const intervalMs = options.intervalMs ?? VIDEO_POLL_INTERVAL_MS
  const maxAttempts = options.maxAttempts ?? VIDEO_POLL_MAX_ATTEMPTS
  const initialDelayMs = options.initialDelayMs ?? intervalMs

  for (let i = 0; i < maxAttempts; i++) {
    const delayMs = i === 0 ? initialDelayMs : intervalMs
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    try {
      const [current] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
      if (!isResumableVideoGeneration(current)) {
        logTaskProgress('VideoTask', 'poll-stop', {
          id,
          taskId,
          provider: config.provider,
          status: current?.status,
          reason: current ? 'not-resumable' : 'record-missing',
        })
        return
      }
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress('VideoTask', 'poll-request', {
        id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const resp = await fetch(url, buildVideoFetchInit(method, headers, undefined, VIDEO_POLL_REQUEST_TIMEOUT_MS))
      if (!resp.ok) {
        const errorBody = await resp.text()
        logTaskWarn('VideoTask', 'poll-http-error', {
          id,
          taskId,
          provider: config.provider,
          attempt: i + 1,
          status: resp.status,
          body: errorBody.slice(0, 500),
        })
        if (resp.status >= 400 && resp.status < 500) {
          db.update(schema.videoGenerations)
            .set({ status: 'failed', errorMsg: `轮询失败 ${resp.status}: ${errorBody}`, updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id))
            .run()
          return
        }
        continue
      }
      const result = await resp.json() as any

      const pollResp = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed' && pollResp.videoUrl) {
        logTaskSuccess('VideoTask', 'poll-complete', { id, taskId, videoUrl: pollResp.videoUrl })
        await handleVideoComplete(id, pollResp.videoUrl, null, storyboardId)
        return
      }
      if (pollResp.status === 'failed') {
        const errorMsg = formatVideoProviderError(pollResp.error || 'Video generation failed')
        logTaskError('VideoTask', 'poll-failed', { id, taskId, error: errorMsg })
        db.update(schema.videoGenerations)
          .set({ status: 'failed', errorMsg, updatedAt: now() })
          .where(eq(schema.videoGenerations.id, id))
          .run()
        return
      }
    } catch (err: any) {
      if (i === maxAttempts - 1) {
        logTaskError('VideoTask', 'poll-timeout', { id, taskId, error: err.message })
        db.update(schema.videoGenerations)
          .set({ status: 'failed', errorMsg: `Timeout: ${err.message}`, updatedAt: now() })
          .where(eq(schema.videoGenerations.id, id))
          .run()
        return
      }
      logTaskWarn('VideoTask', 'poll-retry', { id, taskId, attempt: i + 1, error: err.message })
    }
  }

  logTaskError('VideoTask', 'poll-timeout', { id, taskId, error: 'max attempts exceeded' })
  db.update(schema.videoGenerations)
    .set({ status: 'failed', errorMsg: '视频生成超时：轮询次数已达到上限', updatedAt: now() })
    .where(eq(schema.videoGenerations.id, id))
    .run()
}

export function formatVideoProviderError(error: unknown) {
  if (error && typeof error === 'object') {
    const code = String((error as any).code || '').trim()
    const message = String((error as any).message || '').trim()
    if (code === 'OutputVideoSensitiveContentDetected.PolicyViolation') {
      return `火山视频生成失败：输出视频触发平台审核/版权策略限制（${code}）。${message}`
    }
    return [code, message].filter(Boolean).join(': ') || 'Video generation failed'
  }
  return String(error || 'Video generation failed')
}

async function handleVideoComplete(id: number, videoUrl: string, duration: number | null | undefined, storyboardId?: number | null) {
  const [record] = db.select().from(schema.videoGenerations)
    .where(eq(schema.videoGenerations.id, id)).all()
  if (!record || record.deletedAt) {
    logTaskProgress('VideoTask', 'complete-ignored', {
      id,
      storyboardId,
      reason: record ? 'generation-invalidated' : 'record-missing',
    })
    return
  }

  const isCurrentGeneration = isLatestVideoGeneration(record.id, record.storyboardId || storyboardId)

  db.update(schema.videoGenerations)
    .set({ videoUrl, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.videoGenerations.id, id))
    .run()

  if (storyboardId && isCurrentGeneration) {
    db.update(schema.storyboards)
      .set({ videoUrl, duration: duration || undefined, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
  }

  try {
    const localPath = await downloadFile(videoUrl, 'videos', { timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS })
    const [current] = db.select().from(schema.videoGenerations)
      .where(eq(schema.videoGenerations.id, id)).all()
    if (!current || current.deletedAt) {
      logTaskProgress('VideoTask', 'download-result-ignored', {
        id,
        storyboardId,
        localPath,
        reason: current ? 'generation-invalidated' : 'record-missing',
      })
      return
    }
    db.update(schema.videoGenerations)
      .set({ localPath, updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
    logTaskSuccess('VideoTask', 'downloaded', { id, localPath, storyboardId, duration })

    if (storyboardId && isLatestVideoGeneration(id, storyboardId)) {
      db.update(schema.storyboards)
        .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
        .where(eq(schema.storyboards.id, storyboardId))
        .run()
    }
  } catch (err: any) {
    logTaskWarn('VideoTask', 'download-skipped', {
      id,
      storyboardId,
      error: err.message,
      remoteVideoUrl: videoUrl,
    })
  }
}

function isLatestVideoGeneration(id: number, storyboardId?: number | null) {
  if (!storyboardId) return true
  const rows = db.select().from(schema.videoGenerations).all()
    .filter(item => item.storyboardId === storyboardId && !item.deletedAt)
  return isLatestGeneration(rows, id)
}

export async function ensureVideoLocalCopy(generationId: number): Promise<string | null> {
  const [record] = db.select().from(schema.videoGenerations)
    .where(eq(schema.videoGenerations.id, generationId)).all()
  if (!record?.videoUrl) return null
  if (record.localPath) return record.localPath

  const localPath = await downloadFile(record.videoUrl, 'videos', { timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS })
  db.update(schema.videoGenerations)
    .set({ localPath, updatedAt: now() })
    .where(eq(schema.videoGenerations.id, generationId))
    .run()

  if (record.storyboardId) {
    db.update(schema.storyboards)
      .set({ videoUrl: localPath, updatedAt: now() })
      .where(eq(schema.storyboards.id, record.storyboardId))
      .run()
  }

  return localPath
}
