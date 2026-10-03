import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, getAbsolutePath, getStaticRelativePath, parseDataUrl, readImageAsCompressedDataUrl, readLocalFile } from '../utils/storage.js'
import { getVideoAdapter } from './adapters/registry'
import type { AIConfig, VideoGenerationRecord } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { ensurePublicImageUrl, syncVolcCharacterAssetForCharacter, syncVolcImageAsset } from './volc-asset-sync.js'
import type { PublicImageUploadOptions, PublicImageUrlResult, SyncedVolcAsset, VolcAssetReferenceInput } from './volc-asset-sync.js'
import { withVisualStyleLock } from './visual-style.js'
import { withTkOverseasVisualLock } from './overseas-visual.js'
import { appendStoryboardDialoguePrompt } from './video-dialogue-prompt.js'
import { isLatestGeneration } from './generation-freshness.js'
import { ensureComfyUiGenerationReady } from './comfyui-preflight.js'
import type { ComfyUiSageAttentionNode } from './comfyui-preflight.js'
import { canResumeBackgroundTasks } from '../utils/background-resume.js'
import { applyLocalH3VideoContinuation } from './local-h3-continuation.js'
import { inspectLocalH3Refinement, inspectLocalH3VideoTail } from './local-h3-refinement.js'
import { getFfmpegBinary } from './media-tools.js'
import { releaseComfyUiMemory } from './comfyui-memory.js'

const VIDEO_DOWNLOAD_TIMEOUT_MS = 45000
const VIDEO_REQUEST_TIMEOUT_MS = 120_000
const VIDEO_POLL_REQUEST_TIMEOUT_MS = 65_000
const VIDEO_POLL_INTERVAL_MS = 10000
const VIDEO_POLL_MAX_ATTEMPTS = 300
const COMFYUI_MAX_CONSECUTIVE_TRANSPORT_FAILURES = 6
// AutoDL's task itself is asynchronous, but the result endpoint can spend
// longer than a normal hosted-provider poll while the remote GPU is waking.
// Keep the timeout finite per HTTP request while allowing a substantially
// longer total polling window (roughly 5 hours at the default interval).
const AUTODL_VIDEO_POLL_MAX_ATTEMPTS = 1_800
const RESUMABLE_VIDEO_STATUSES = new Set(['pending', 'processing', 'queued', 'running'])
const activeVideoPollers = new Set<number>()
const execFileAsync = promisify(execFile)

// A full previous clip is a generic H3 reference and lets the model replay its
// opening. Standard serial R2V needs only the previous shot's ending context;
// keep a short, frame-accurate tail so the next shot can continue instead of
// reconstructing the whole source clip.
export const LOCAL_H3_CONTINUATION_TAIL_SECONDS = 2.5

/** Keep provider-specific LoRA input bounded and preserve an explicit 0. */
export function normalizeLoraStrength(value?: number | null) {
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  return Math.max(0, Math.min(1, Math.round(number * 100) / 100))
}

export function normalizeSeed(value?: number | string | null) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) return undefined
  return parsed
}

type VideoGenerationRow = typeof schema.videoGenerations.$inferSelect
type AIConfigRow = typeof schema.aiServiceConfigs.$inferSelect
type StaleVideoGenerationRecord = Pick<VideoGenerationRow, 'status' | 'taskId' | 'createdAt' | 'updatedAt' | 'provider'>

/** A serial parent is authoritative for local H3 jobs. Once it reaches a
 * terminal state, its child generation must never be resumed by a desktop
 * restart or a later GET /videos/:id call. */
export function isTerminalSequenceStatus(status?: string | null) {
  return ['completed', 'failed', 'cancelled'].includes(String(status || '').trim().toLowerCase())
}

function sequenceRunIsTerminal(sequenceRunId?: number | null) {
  const id = Number(sequenceRunId)
  if (!Number.isFinite(id) || id <= 0) return false
  const [run] = db.select({ status: schema.videoSequenceRuns.status })
    .from(schema.videoSequenceRuns)
    .where(eq(schema.videoSequenceRuns.id, id)).all()
  return isTerminalSequenceStatus(run?.status)
}

function cancelVideoGenerationForSequence(id: number, reason = '串行任务已停止') {
  db.update(schema.videoGenerations)
    .set({ status: 'cancelled', errorMsg: reason, updatedAt: now() })
    .where(eq(schema.videoGenerations.id, id))
    .run()
}

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
  imageUrl?: string | null
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  /** Accept both API/DB JSON strings and normalized arrays. */
  referenceImageUrls?: string[] | string | null
  /** AutoDL MiniMax H3 optional reference audio URLs (max 3). */
  referenceAudioUrls?: string[] | string | null
  duration?: number
  aspectRatio?: string
  megapixels?: number
  steps?: number
  /** Local MiniMax H3 LoRA strength, normalized to 0-1. */
  loraStrength?: number
  seed?: number | null
  configId?: number
  promptIsFinal?: boolean
  /** Local ComfyUI MiniMax H3 jobs are only allowed from a serial run. */
  sequenceRunId?: number | null
  sequenceStepIndex?: number | null
  continuityMode?: string | null
  latentPath?: string | null
  latentClipIndex?: number | null
  referenceVideoLocalPath?: string | null
}

/** Fail closed for the local MiniMax H3 R2V contract. */
export function assertLocalComfyUiR2VRecord(record: {
  referenceMode?: string | null
  imageUrl?: string | null
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  referenceImageUrls?: string[] | string | null
  prompt?: string | null
}) {
  if (String(record.referenceMode || '').trim().toLowerCase() !== 'multiple') {
    throw new Error('Local MiniMax H3 requires multi-reference R2V mode')
  }
  if (String(record.imageUrl || '').trim() || String(record.firstFrameUrl || '').trim() || String(record.lastFrameUrl || '').trim()) {
    throw new Error('Local MiniMax H3 R2V forbids image_url/first_frame_url/last_frame_url')
  }
  let refs: unknown[] = []
  const rawReferences: any = record.referenceImageUrls
  if (Array.isArray(rawReferences)) refs = rawReferences
  else if (typeof rawReferences === 'string' && rawReferences.trim()) {
    try { const parsed = JSON.parse(rawReferences); refs = Array.isArray(parsed) ? parsed : [] } catch { throw new Error('Local MiniMax H3 R2V reference list is invalid JSON') }
  }
  if (!refs.length || refs.some(item => !String(item || '').trim())) {
    throw new Error('Local MiniMax H3 R2V requires an ordered reference-image list')
  }
  if (/(?:FL2VA|\bI2V\b|first(?:[-_ ]frame)|last(?:[-_ ]frame)|tail(?:[-_ ]frame)|opening(?:[-_ ]frame)|R2V\s+OPENING\s+FRAME|frame[-_ ]?0|首尾帧|首帧|第一帧|尾帧|第\s*0\s*帧)/i.test(String(record.prompt || ''))) {
    throw new Error('Local MiniMax H3 prompt contains disabled frame-slot terminology')
  }
  return true
}

/** AutoDL's hosted MiniMax workflow is also an ordered multi-reference R2V
 * contract.  Keep this guard separate from the local ComfyUI guard: AutoDL
 * must never inherit local worker/LoRA/latent settings, but it must reject
 * stale single-image or first/last-frame fields before they reach the hosted
 * workflow.
 */
export function assertAutoDlComfyUiR2VRecord(record: {
  referenceMode?: string | null
  imageUrl?: string | null
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  referenceImageUrls?: string[] | string | null
}) {
  if (String(record.referenceMode || '').trim().toLowerCase() !== 'multiple') {
    throw new Error('AutoDL MiniMax H3 requires multi-reference R2V mode')
  }
  if (String(record.imageUrl || '').trim() || String(record.firstFrameUrl || '').trim() || String(record.lastFrameUrl || '').trim()) {
    throw new Error('AutoDL MiniMax H3 R2V forbids image_url/first_frame_url/last_frame_url')
  }
  let refs: unknown[] = []
  const rawReferences: any = record.referenceImageUrls
  if (Array.isArray(rawReferences)) refs = rawReferences
  else if (typeof rawReferences === 'string' && rawReferences.trim()) {
    try {
      const parsed = JSON.parse(rawReferences)
      refs = Array.isArray(parsed) ? parsed : []
    } catch {
      throw new Error('AutoDL MiniMax H3 R2V reference list is invalid JSON')
    }
  }
  if (refs.some(item => !String(item || '').trim())) {
    throw new Error('AutoDL MiniMax H3 R2V reference list contains an empty image')
  }
  return true
}

/** Public guard used by API callers and tests to ensure local H3 requests
 * never carry a retired frame-slot mode. */
export function normalizeLocalComfyUiReferenceMode(value?: string | null) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized !== 'multiple') {
    throw new Error('本地 MiniMax H3 仅支持多参考 R2V 模式')
  }
  return 'multiple'
}

export function assertLocalComfyUiContinuityMode(value?: string | null) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized && !['standard_r2v', 'latent_plus'].includes(normalized)) {
    throw new Error('本地 MiniMax H3 仅支持标准 R2V 或 Motion Context Plus')
  }
  return true
}

/**
 * Local ComfyUI jobs run on the user's GPU and can legitimately take longer
 * than the remote-provider safety window.  A local job is therefore bounded
 * by its provider result (completed/failed/cancelled), while remote jobs keep
 * the existing finite retry budget.
 */
export function getVideoPollMaxAttempts(provider: string) {
  return String(provider || '').trim().toLowerCase() === 'comfyui'
    ? Number.POSITIVE_INFINITY
    : String(provider || '').trim().toLowerCase() === 'autodl_comfyui'
      ? AUTODL_VIDEO_POLL_MAX_ATTEMPTS
    : VIDEO_POLL_MAX_ATTEMPTS
}

export function getVideoPollConnectivityFailureLimit(provider: string) {
  return String(provider || '').trim().toLowerCase() === 'comfyui'
    ? COMFYUI_MAX_CONSECUTIVE_TRANSPORT_FAILURES
    : 0
}

/** AutoDL is remote; keep its polling bounded like other hosted providers. */
export function isAutoDlComfyUiProvider(provider: string) {
  return String(provider || '').trim().toLowerCase() === 'autodl_comfyui'
}

/**
 * MiniMax H3 running through a local ComfyUI instance is not safe to submit
 * concurrently. Keep this invariant in the service layer so API callers
 * cannot bypass the serial-generation UI.
 */
export function assertVideoGenerationMode(
  config: Pick<AIConfig, 'provider'>,
  sequenceRunId?: number | null,
) {
  const provider = String(config.provider || '').trim().toLowerCase()
  if (provider === 'comfyui' && (!sequenceRunId || !Number.isFinite(Number(sequenceRunId)))) {
    throw new Error('本地 MiniMax H3 只能通过一键串行生成，请勿直接提交单镜头或批量任务')
  }
}

function assertLocalComfyUiSequenceRun(
  config: Pick<AIConfig, 'provider'>,
  sequenceRunId?: number | null,
) {
  assertVideoGenerationMode(config, sequenceRunId)
  if (String(config.provider || '').trim().toLowerCase() !== 'comfyui') return
  const runId = Number(sequenceRunId)
  const [run] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all()
  if (!run || String(run.provider || '').trim().toLowerCase() !== 'comfyui'
    || !['queued', 'running', 'paused'].includes(String(run.status || '').toLowerCase())) {
    throw new Error('本地 MiniMax H3 只能通过正在运行的一键串行任务提交')
  }
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  const ts = now()
  const config = params.configId
    ? getConfigById(params.configId)
    : getActiveConfig('video')
  if (!config) throw new Error('No active video AI config')
  assertLocalComfyUiSequenceRun(config, params.sequenceRunId)
    const normalizedProvider = String(config.provider || '').trim().toLowerCase()
    const isLocalComfyUi = normalizedProvider === 'comfyui'
    const isAutoDlComfyUi = normalizedProvider === 'autodl_comfyui'
  const referenceMode = (isLocalComfyUi || isAutoDlComfyUi)
    ? (isLocalComfyUi
      ? normalizeLocalComfyUiReferenceMode(params.referenceMode)
      : (String(params.referenceMode || '').trim().toLowerCase() === 'multiple' ? 'multiple' : (() => { throw new Error('AutoDL MiniMax H3 requires multi-reference R2V mode') })()))
    : (params.referenceMode || 'none')
  if (isLocalComfyUi) {
    assertLocalComfyUiContinuityMode(params.continuityMode)
    assertLocalComfyUiR2VRecord({ ...params, referenceMode: 'multiple' })
  }
  if (isAutoDlComfyUi) {
    assertAutoDlComfyUiR2VRecord({ ...params, referenceMode: 'multiple' })
  }
  const visualContext = resolveVideoProjectVisualContext(params.storyboardId, params.dramaId)
  const finalPrompt = appendStoryboardDialoguePrompt(
    applyVideoVisualStyleLock(params.prompt, visualContext.style, visualContext.breakdownMode),
    params.storyboardId,
    visualContext.breakdownMode,
    isLocalComfyUi,
  )

  const res = db.insert(schema.videoGenerations).values({
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    prompt: finalPrompt,
    model: params.model || config.model,
    provider: config.provider,
    referenceMode,
    promptIsFinal: params.promptIsFinal === true,
    imageUrl: params.imageUrl,
    firstFrameUrl: params.firstFrameUrl,
    lastFrameUrl: params.lastFrameUrl,
    referenceImageUrls: params.referenceImageUrls ? JSON.stringify(params.referenceImageUrls) : null,
    referenceAudioUrls: params.referenceAudioUrls ? JSON.stringify(params.referenceAudioUrls) : null,
    seed: normalizeSeed(params.seed),
    duration: params.duration || 5,
    aspectRatio: params.aspectRatio || '16:9',
    megapixels: params.megapixels || 1,
    steps: params.steps || undefined,
    loraStrength: normalizeLoraStrength(params.loraStrength),
    sequenceRunId: params.sequenceRunId ?? null,
    sequenceStepIndex: params.sequenceStepIndex ?? null,
    continuityMode: params.continuityMode || null,
    latentPath: params.latentPath || null,
    latentClipIndex: params.latentClipIndex ?? null,
    referenceVideoLocalPath: String(config.provider || '').trim().toLowerCase() === 'comfyui'
      ? params.referenceVideoLocalPath || null
      : null,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  if (params.storyboardId) {
    db.update(schema.storyboards)
      // `updatedAt` is the storyboard-content revision.  Video lifecycle
      // changes must not advance it, otherwise a completed generation would
      // look like a newer decomposition and invalidate the whole serial run.
      .set({ videoUrl: null, composedVideoUrl: null, composedVideoGenerationId: null, status: 'pending' })
      .where(eq(schema.storyboards.id, params.storyboardId))
      .run()
    // Any new shot generation invalidates the episode-level merged file. Keep
    // the old file in history, but never expose it as the current episode
    // output while the shot is being regenerated/recomposed.
    const [storyboard] = db.select({ episodeId: schema.storyboards.episodeId })
      .from(schema.storyboards)
      .where(eq(schema.storyboards.id, params.storyboardId)).all()
    if (storyboard?.episodeId) {
      db.update(schema.episodes)
        .set({ videoUrl: null, updatedAt: ts })
        .where(eq(schema.episodes.id, storyboard.episodeId)).run()
    }
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
    if (sequenceRunIsTerminal(record.sequenceRunId)) {
      cancelVideoGenerationForSequence(id)
      logTaskProgress('VideoTask', 'parent-terminal-before-submit', { id, sequenceRunId: record.sequenceRunId })
      return
    }
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
        String(config.provider || '').trim().toLowerCase() === 'comfyui',
      ),
    }
    logTaskProgress('VideoTask', 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      referenceMode: record.referenceMode,
    })

    let comfyH3SageAttentionNode: ComfyUiSageAttentionNode | null = null
    if (String(config.provider || '').trim().toLowerCase() === 'comfyui') {
      logTaskProgress('VideoTask', 'comfyui-preflight', { id, baseUrl: config.baseUrl })
      // Local MiniMax H3 has one provider contract only: ordered multi-
      // reference R2V.  The serial continuity variant is selected solely by
      // continuityMode (standard R2V vs Motion Context Plus); first/last-frame
      // and ordinary I2V are never valid preflight branches.
      const preflightMode = record.continuityMode === 'latent_plus' ? 'r2v_plus' : 'r2v'
      const preflight = await ensureComfyUiGenerationReady(config, { mode: preflightMode, modelOverride: record.model })
      comfyH3SageAttentionNode = preflight.sageAttentionNode || null
      logTaskProgress('VideoTask', 'comfyui-ready', {
        id,
        baseUrl: config.baseUrl,
        sageAttentionNode: comfyH3SageAttentionNode,
      })
    }
    if (String(config.provider || '').trim().toLowerCase() === 'comfyui') assertLocalComfyUiR2VRecord(requestRecord)

    const preparedRecord = config.provider === 'comfyui'
      ? await prepareComfyUiVideoReferenceRecord(requestRecord, config)
      : config.provider === 'volcengine'
      ? await prepareVolcengineSeedanceRecord(requestRecord)
      : config.provider === 'eggfans'
        ? await preparePublicVideoReferenceRecord(requestRecord)
        : config.provider === 'mijing'
          ? await prepareMijingVideoReferenceRecord(requestRecord)
          : config.provider === 'grok_openai'
            ? await prepareGrokOpenAIVideoReferenceRecord(requestRecord)
            : config.provider === 'autodl_comfyui'
              ? await prepareAutoDlComfyUiVideoReferenceRecord(requestRecord, config)
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
    const autodlReferenceImages = 'autodlReferenceImages' in preparedRecord
      ? preparedRecord.autodlReferenceImages
      : null
    const adapterRecord: VideoGenerationRecord = {
      id: record.id,
      model: record.model,
      prompt: preparedRecord.prompt,
      referenceMode: preparedRecord.referenceMode || record.referenceMode,
      imageUrl: preparedRecord.imageUrl,
      firstFrameUrl: preparedRecord.firstFrameUrl,
      lastFrameUrl: preparedRecord.lastFrameUrl,
      referenceImageUrls: preparedRecord.referenceImageUrls ? JSON.stringify(preparedRecord.referenceImageUrls) : null,
      referenceAudioUrls: record.referenceAudioUrls,
      seed: record.seed,
      comfyImageNames: (preparedRecord as any).comfyImageNames,
      comfyVideoName: (preparedRecord as any).comfyVideoName,
      duration: record.duration,
      aspectRatio: record.aspectRatio,
      megapixels: record.megapixels,
      steps: record.steps,
      loraStrength: record.loraStrength,
      sequenceRunId: record.sequenceRunId,
      sequenceStepIndex: record.sequenceStepIndex,
      continuityMode: record.continuityMode,
      latentPath: record.latentPath,
      latentClipIndex: record.latentClipIndex,
      comfyH3SageAttentionNode,
    }
    if (String(config.provider || '').trim().toLowerCase() === 'autodl_comfyui') {
      adapterRecord.autodlReferenceImages = autodlReferenceImages
    }
    if (config.provider === 'comfyui') {
      const refinement = await inspectLocalH3Refinement(config)
      adapterRecord.comfyH3RefinementAvailable = refinement.available
      if (refinement.reason) logTaskWarn('VideoTask', 'h3-refinement-skipped', { id, reason: refinement.reason })
      if (adapterRecord.comfyVideoName && record.continuityMode !== 'latent_plus') {
        const tail = await inspectLocalH3VideoTail(config)
        adapterRecord.comfyH3VideoTailAvailable = tail.available
        if (tail.reason) logTaskWarn('VideoTask', 'h3-video-tail-unavailable', { id, reason: tail.reason })
      }
    }
    let { url, method, headers, body } = adapter.buildGenerateRequest(config, adapterRecord)
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

    const provider = String(config.provider || '').trim().toLowerCase()
    let autodlInlineRetryUsed = false
    let requestRecordForParse: VideoGenerationRecord = adapterRecord
    let resp: Response
    if (provider === 'comfyui') {
      const memory = await releaseComfyUiMemory(config)
      logTaskProgress('VideoTask', 'comfyui-memory-ready', {
        id,
        storyboardId: record.storyboardId,
        vramFreeBytes: memory.free,
        vramTotalBytes: memory.total,
        vramRequiredFreeBytes: memory.requiredFree,
        releasePolls: memory.polls,
      })
    }
    try {
      try {
        resp = await fetch(url, buildVideoFetchInit(method, headers, body, VIDEO_REQUEST_TIMEOUT_MS))
      } catch (retryError: any) {
        throw new Error(`本地 MiniMax H3 Worker 自动修复后仍无法提交任务：${String(retryError?.message || retryError)}`)
      }
    } catch (error) {
      if (String(config.provider || '').trim().toLowerCase() !== 'comfyui') throw error
      logTaskWarn('VideoTask', 'comfyui-request-repair', { id, error: String((error as any)?.message || error) })
      const preflightMode = record.continuityMode === 'latent_plus' ? 'r2v_plus' : 'r2v'
      await ensureComfyUiGenerationReady(config, { forceRepair: true, skipCache: true, mode: preflightMode, modelOverride: record.model })
      resp = await fetch(url, buildVideoFetchInit(method, headers, body, VIDEO_REQUEST_TIMEOUT_MS))
    }

    if (!resp.ok) {
      const errorBody = await resp.text()
      if (provider === 'autodl_comfyui' && !autodlInlineRetryUsed && isAutoDlMiniMaxH3ReferenceUrlError(url, body, resp.status, errorBody)) {
        const inlineReferences = await buildAutoDlInlineReferenceUrls(autodlReferenceImages)
        autodlInlineRetryUsed = true
        if (inlineReferences.length) {
          logTaskWarn('VideoTask', 'autodl-reference-inline-retry', {
            id,
            status: resp.status,
            referenceCount: inlineReferences.length,
          })
          requestRecordForParse = {
            ...adapterRecord,
            referenceImageUrls: JSON.stringify(inlineReferences),
            autodlReferenceImages: null,
          }
          const retryRequest = adapter.buildGenerateRequest(config, requestRecordForParse)
          url = retryRequest.url
          method = retryRequest.method
          headers = retryRequest.headers
          body = retryRequest.body
          logTaskPayload('VideoTask', 'autodl-reference-inline-retry payload', {
            id,
            method,
            url,
            headers,
            body,
          })
          resp = await fetch(url, buildVideoFetchInit(method, headers, body, VIDEO_REQUEST_TIMEOUT_MS))
          if (!resp.ok) {
            const retryErrorBody = await resp.text()
            throw new Error(`API error ${resp.status}: ${retryErrorBody}`)
          }
        } else {
          throw new Error(`API error ${resp.status}: ${errorBody}`)
        }
      } else {
        throw new Error(`API error ${resp.status}: ${errorBody}`)
      }
    }
    let result = await resp.json() as any
    try {
      adapter.parseGenerateResponse(result, config, requestRecordForParse)
    } catch (parseError) {
      const responseBody = JSON.stringify(result)
      if (provider !== 'autodl_comfyui' || autodlInlineRetryUsed
        || !isAutoDlMiniMaxH3ReferenceUrlError(url, body, resp.status, responseBody, result)) {
        throw parseError
      }
      const inlineReferences = await buildAutoDlInlineReferenceUrls(autodlReferenceImages)
      autodlInlineRetryUsed = true
      if (!inlineReferences.length) throw parseError
      requestRecordForParse = {
        ...adapterRecord,
        referenceImageUrls: JSON.stringify(inlineReferences),
        autodlReferenceImages: null,
      }
      const retryRequest = adapter.buildGenerateRequest(config, requestRecordForParse)
      url = retryRequest.url
      method = retryRequest.method
      headers = retryRequest.headers
      body = retryRequest.body
      logTaskWarn('VideoTask', 'autodl-reference-inline-retry', {
        id,
        status: resp.status,
        referenceCount: inlineReferences.length,
      })
      logTaskPayload('VideoTask', 'autodl-reference-inline-retry payload', {
        id,
        method,
        url,
        headers,
        body,
      })
      resp = await fetch(url, buildVideoFetchInit(method, headers, body, VIDEO_REQUEST_TIMEOUT_MS))
      const retryBody = await resp.text()
      if (!resp.ok) throw new Error(`API error ${resp.status}: ${retryBody}`)
      try {
        result = JSON.parse(retryBody)
      } catch {
        throw new Error(`API returned invalid JSON: ${retryBody.slice(0, 500)}`)
      }
      adapter.parseGenerateResponse(result, config, requestRecordForParse)
    }

    const { isAsync, taskId, videoUrl } = adapter.parseGenerateResponse(result, config, requestRecordForParse)

    if (!isAsync && videoUrl) {
      if (sequenceRunIsTerminal(record.sequenceRunId)) {
        cancelVideoGenerationForSequence(id)
        logTaskProgress('VideoTask', 'sync-complete-parent-terminal', { id, sequenceRunId: record.sequenceRunId })
        return
      }
      logTaskProgress('VideoTask', 'sync-complete', { id, videoUrl })
      // 同步模式
      await handleVideoComplete(id, videoUrl, record.duration, record.storyboardId, config)
      return
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.videoGenerations)
      .set({ taskId, status: 'processing', updatedAt: now() })
      .where(eq(schema.videoGenerations.id, id))
      .run()
    if (sequenceRunIsTerminal(record.sequenceRunId)) {
      cancelVideoGenerationForSequence(id)
      logTaskProgress('VideoTask', 'parent-terminal-after-submit', { id, sequenceRunId: record.sequenceRunId, taskId })
      return
    }
    logTaskProgress('VideoTask', 'poll-start', { id, taskId, provider: config.provider })

    // Vidu 没有轮询端点，跳过轮询（依赖 Webhook 回调）
    if (adapter.provider === 'vidu') {
      logTaskProgress('VideoTask', 'webhook-wait', { id, taskId, provider: adapter.provider })
      return
    }

    startVideoPoller(id, config, taskId!, record.storyboardId)
  } catch (err: any) {
    logTaskError('VideoTask', 'process', { id, provider: config.provider, error: err.message })
    const [current] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
    if (sequenceRunIsTerminal(current?.sequenceRunId)) {
      cancelVideoGenerationForSequence(id)
    } else {
      db.update(schema.videoGenerations)
        .set({ status: 'failed', errorMsg: err.message, updatedAt: now() })
        .where(eq(schema.videoGenerations.id, id))
        .run()
    }
  }
}

async function prepareMijingVideoReferenceRecord(record: VideoPromptRecord): Promise<PreparedVideoReferenceRecord> {
  return prepareMijingVideoReferences(record)
  /* istanbul ignore next: legacy branch retained below for source compatibility
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
    if (reference && reference !== firstFrameUrl && !references.includes(reference as string)) references.push(reference as string)
  }
  return {
    imageUrl: null,
    firstFrameUrl,
    lastFrameUrl: null,
    referenceImageUrls: references.slice(0, 8),
    prompt: String(record.prompt || ''),
    referenceMode: 'first_frame_multiple',
  }
  */
}

/** Prepare references for the hosted AutoDL workflow API. AutoDL cannot read
 * this application's `static/` paths, so local/data images are converted to
 * short-lived public URLs before submission. The resulting list is kept in
 * one provider-neutral field; no local ComfyUI upload, LoRA or latent state is
 * involved.
 */
async function prepareAutoDlComfyUiVideoReferenceRecord(record: VideoPromptRecord, config: AIConfig): Promise<PreparedVideoReferenceRecord> {
  const settings = config.settings?.autodlComfyui || {}
  const rawRefs: string[] = []
  const push = (value: unknown) => {
    const raw = String(value || '').trim()
    if (!raw || rawRefs.includes(raw)) return
    rawRefs.push(raw)
  }
  // A configured AutoDL R2V workflow receives the preceding continuity image
  // in the same ordered reference list. It is not sent as a first/last-frame
  // provider field, so the workflow remains independent from legacy I2V paths.
  if (record.referenceMode === 'first_frame_multiple' || record.referenceMode === 'first_last') {
    throw new Error('AutoDL ComfyUI 仅支持多参考图工作流；请在分镜串行模式中使用 referenceMode=multiple')
  }
  // AutoDL receives references only through the configured workflow field.
  // Do not promote generic image/first-frame columns into that list: those
  // fields belong to legacy I2V providers and would let a stale caller replace
  // the ordered R2V Picture 1 continuity image.
  parseReferenceImageUrls(record.referenceImageUrls).forEach(push)

  const referenceUrls: string[] = []
  const autodlReferenceImages: NonNullable<PreparedVideoReferenceRecord['autodlReferenceImages']> = []
  for (const [index, raw] of rawRefs.entries()) {
    if (isVolcAssetUri(raw)) {
      throw new Error(`AutoDL ComfyUI 不支持火山 Asset URI：参考图${index + 1}，请使用本地图片或公网 URL`)
    }
    // AutoDL receives a public URL after the upload step.  Keep local static
    // assets at their original resolution here; normalizeVideoReferenceUrl()
    // is intentionally a compressed preview path for providers that accept
    // inline images, while AutoDL's uploader can read the local 4K source
    // directly before publishing it.
    const normalized = normalizeAutoDlReferenceUrl(raw)
    if (!normalized) continue
    const hosted = await ensurePublicImageUrl(normalized, `AutoDL-参考图${index + 1}`)
    if (hosted?.url && !referenceUrls.includes(hosted.url)) {
      referenceUrls.push(hosted.url)
      autodlReferenceImages.push({ url: hosted.url, source: raw })
    }
  }

  const maxReferences = Number(settings.maxReferenceImages || settings.max_reference_images)
  const limited = referenceUrls.slice(0, Number.isFinite(maxReferences) ? Math.max(1, Math.min(9, Math.round(maxReferences))) : 9)
  const prompt = limited.length
    ? [
      String(record.prompt || '').trim(),
      `AutoDL ComfyUI 有序参考图（共 ${limited.length} 张）：${limited.map((_, index) => `<Picture ${index + 1}>`).join('、')}。请严格按顺序将每张图片用于对应的连续构图、角色、场景或道具，不得交换、合并或忽略。`,
    ].filter(Boolean).join('\n')
    : String(record.prompt || '')
  return {
    prompt,
    imageUrl: null,
    firstFrameUrl: null,
    lastFrameUrl: null,
    referenceImageUrls: limited,
    referenceMode: limited.length ? 'multiple' : 'none',
    autodlReferenceImages: autodlReferenceImages.slice(0, limited.length),
  }
}

function normalizeAutoDlReferenceUrl(value: string): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) return raw
  return raw
}

export function isAutoDlMiniMaxH3ReferenceUrlError(
  url: string,
  body: unknown,
  status: number,
  errorBody: string,
  parsedResponse?: unknown,
): boolean {
  const requestUrl = String(url || '')
  const serializedBody = safeJsonStringify(body)
  if (!/minimax_h3_image_audio_to_video_v2_15s/i.test(requestUrl)
    && !/minimax_h3_image_audio_to_video_v2_15s/i.test(serializedBody)) return false

  const bodyObject = typeof body === 'string' ? parseJsonObject(body) : body
  const hasReferenceInput = bodyObject && typeof bodyObject === 'object'
    ? Object.keys(bodyObject as Record<string, unknown>).some(key => /^ref_image_\d+$/i.test(key))
    : /ref_image_\d+/i.test(String(body || ''))
  if (!hasReferenceInput) return false

  const serializedResponse = safeJsonStringify(parsedResponse)
  const errorText = `${String(errorBody || '')} ${serializedResponse} status=${Number(status)}`.toLowerCase()
  const mentionsReferenceImage = /ref[_ -]?image[_ -]?\d+|reference\s*image|参考图|图片/.test(errorText)
  const mentionsUrl = /\burl\b|地址|链接|uri/.test(errorText)
  const mentionsInvalidReference = /403|forbidden|invalid|illegal|not\s+found|unreachable|不存在|不合法|不可访问/.test(errorText)
  return mentionsReferenceImage && mentionsUrl && mentionsInvalidReference
}

export async function buildAutoDlInlineReferenceUrls(
  references?: Array<{ url: string; source?: string | null }> | null,
): Promise<string[]> {
  const result: string[] = []
  for (const [index, reference] of (references || []).entries()) {
    const source = String(reference?.source || reference?.url || '').trim()
    if (!source) throw new Error(`AutoDL 参考图 ${index + 1} 缺少图片来源`)
    result.push(await readAutoDlInlineReference(source, index + 1))
  }
  return result
}

async function readAutoDlInlineReference(source: string, index: number): Promise<string> {
  if (/^data:image\//i.test(source)) return source

  const staticPath = getStaticRelativePath(source)
  if (staticPath) {
    return readImageAsCompressedDataUrl(staticPath, {
      maxWidth: 1024,
      maxHeight: 1024,
      quality: 76,
    })
  }

  if (fs.existsSync(source)) {
    const buffer = fs.readFileSync(source)
    return `data:${autoDlInlineMimeType(source)};base64,${buffer.toString('base64')}`
  }

  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(65_000) })
    if (!response.ok) throw new Error(`AutoDL 参考图 ${index} 下载失败：HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const mimeType = contentType.startsWith('image/') ? contentType : autoDlInlineMimeType(source)
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  }

  throw new Error(`AutoDL 参考图 ${index} 无法读取：${source.slice(0, 160)}`)
}

function parseJsonObject(value: string): unknown {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function safeJsonStringify(value: unknown): string {
  if (value === undefined) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function autoDlInlineMimeType(value: string): string {
  const extension = String(value).split(/[?#]/)[0].toLowerCase().match(/\.(png|webp|gif|jpg|jpeg)$/)?.[1]
  return extension === 'png' ? 'image/png'
    : extension === 'webp' ? 'image/webp'
      : extension === 'gif' ? 'image/gif'
        : 'image/jpeg'
}

/** Upload local/data/remote references into ComfyUI's input directory. */
async function prepareComfyUiVideoReferenceRecord(record: VideoPromptRecord, config: AIConfig): Promise<PreparedVideoReferenceRecord> {
  const uploadedNames: NonNullable<PreparedVideoReferenceRecord['comfyImageNames']> = { referenceImages: [] }
  // MiniMax H3 R2V has no first-frame/last-frame request fields.  The previous
  // tail must already be Picture 1 in the ordered reference-image list.  Do
  // not consume legacy firstFrameUrl/lastFrameUrl values here: accepting them
  // would silently re-introduce the retired FL2VA/I2V semantics and is exactly
  // how a serial hand-off can end up on the wrong frame.
  assertLocalComfyUiR2VRecord(record)
  const parsedReferenceUrls = dedupeComfyUiReferenceUrls(parseReferenceImageUrls(record.referenceImageUrls))
  const mode = String(record.referenceMode || 'none').toLowerCase()
  // Every local ComfyUI generation is submitted by the serial R2V pipeline.
  // Keep this guard here as a second line of defence for stale/manual rows.
  // Local MiniMax H3 is strictly the R2V multi-reference pipeline.  A
  // first_frame_multiple record belongs to the retired FL2VA/I2V path and
  // must never be silently accepted or translated here.
  if (mode !== 'multiple') {
    throw new Error('本地 MiniMax H3 仅支持多参考 R2V，禁止首帧/尾帧/I2V/FL2VA 模式')
  }
  // Model/node availability is checked by ensureComfyUiGenerationReady with
  // the currently selected UNET (`record.model`). Do not repeat a hard-coded
  // ref2va basename check here: the Studio supports all selectable H3 R2V
  // checkpoints, including the hybrid FL2VA/Ref2VA model.
  const upload = async (value: string | null | undefined, label: string, slotIndex: number) => {
    const raw = String(value || '').trim()
    if (!raw) return null
    if (/^(?:@)?asset:\/\//i.test(raw)) throw new Error(`ComfyUI 不支持火山 Asset URI：${label}，请使用项目图片或本地素材`)
    const source = parseDataUrl(raw)
    let buffer: Buffer
    let mimeType = 'image/jpeg'
    let fileName = `${label}.jpg`
    if (source) {
      buffer = Buffer.from(source.data, 'base64')
      mimeType = source.mimeType || mimeType
    } else {
      const staticPath = getStaticRelativePath(raw)
      if (staticPath) {
        const local = readLocalFile(staticPath)
        buffer = local.buffer
        mimeType = local.mimeType
        // Do not reuse the source basename. ComfyUI caches LoadImage nodes by
        // filename; reusing a character's old basename can therefore make a
        // freshly decomposed shot receive a previous character image even
        // though the upload succeeded. The final upload name is made unique
        // below for every generation and every reference slot.
      } else if (/^https?:\/\//i.test(raw)) {
        const response = await fetch(raw, { signal: AbortSignal.timeout(65_000) })
        if (!response.ok) throw new Error(`${label}下载失败：HTTP ${response.status}`)
        buffer = Buffer.from(await response.arrayBuffer())
        mimeType = response.headers.get('content-type')?.split(';')[0] || mimeType
      } else {
        throw new Error(`${label}不是可读取的图片地址：${raw.slice(0, 120)}`)
      }
    }
    const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg'
    const uniqueName = `mijing-reference-${record.id}-${slotIndex + 1}-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(buffer)], { type: mimeType }), uniqueName)
    // Unique names are intentional. Overwrite=true with a stable filename
    // allows ComfyUI's prompt cache to reuse the old LoadImage result.
    form.append('overwrite', 'false')
    const base = String(config.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
    const response = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(65_000) })
    const text = await response.text()
    if (!response.ok) throw new Error(`ComfyUI 上传${label}失败：HTTP ${response.status} ${text.slice(0, 300)}`)
    let parsed: any = {}
    try { parsed = JSON.parse(text) } catch { /* handled by fallback below */ }
    const name = String(parsed.name || parsed.image || parsed.filename || uniqueName).trim()
    if (!name) throw new Error(`ComfyUI 上传${label}未返回文件名`)
    return name
  }

  for (const [index, value] of parsedReferenceUrls.entries()) {
    const name = await upload(value, `mijing-reference-${index + 1}`, index)
    if (name && !uploadedNames.referenceImages!.includes(name)) uploadedNames.referenceImages!.push(name)
  }
  const comfyVideoName = record.referenceVideoLocalPath
    ? await uploadComfyUiVideo(record.referenceVideoLocalPath, config, record.id,
      record.continuityMode !== 'latent_plus' && Number(record.sequenceStepIndex) > 0)
    : null
  const prompt = comfyVideoName && record.continuityMode !== 'latent_plus' && Number(record.sequenceStepIndex) > 0
    ? applyLocalH3VideoContinuation(String(record.prompt || ''))
    : String(record.prompt || '')
  const prepared: PreparedVideoReferenceRecord = {
    // R2V is image-list only. Never persist or forward a legacy imageUrl as a
    // hidden single-image input; doing so can make an old protagonist replace
    // the explicitly ordered Picture bindings.
    imageUrl: null,
    firstFrameUrl: null,
    lastFrameUrl: null,
    referenceImageUrls: parsedReferenceUrls,
    prompt,
    referenceMode: 'multiple',
    comfyImageNames: uploadedNames,
    comfyVideoName,
  }
  // Re-check the normalized record as the final barrier before persistence.
  // This catches a future upload/normalization branch that accidentally adds
  // a legacy frame slot or strips the ordered image list.
  assertLocalComfyUiR2VRecord(prepared)
  return prepared
}

async function uploadComfyUiVideo(value: string, config: AIConfig, recordId: number, trimToContinuationTail = false): Promise<string> {
  const raw = String(value || '').trim()
  const staticPath = getStaticRelativePath(raw)
  let buffer: Buffer
  let extension = '.mp4'
  let sourcePath: string | null = null
  let temporarySourcePath: string | null = null
  if (staticPath) {
    const local = readLocalFile(staticPath)
    buffer = local.buffer
    extension = /\.(webm|mov|m4v|avi)$/i.test(local.filename) ? `.${local.filename.split('.').pop()}` : '.mp4'
    sourcePath = getAbsolutePath(staticPath)
  } else if (fs.existsSync(raw)) {
    buffer = fs.readFileSync(raw)
    extension = /\.(webm|mov|m4v|avi)$/i.test(raw) ? `.${raw.split('.').pop()}` : '.mp4'
    sourcePath = raw
  } else if (/^https?:\/\//i.test(raw)) {
    const response = await fetch(raw, { signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`ComfyUI 上一镜视频下载失败：HTTP ${response.status}`)
    buffer = Buffer.from(await response.arrayBuffer())
    const match = new URL(raw).pathname.match(/\.(webm|mov|m4v|avi|mp4)$/i)
    extension = match ? `.${match[1].toLowerCase()}` : '.mp4'
  } else {
    throw new Error(`ComfyUI 上一镜视频无法读取：${raw.slice(0, 160)}`)
  }
  if (trimToContinuationTail) {
    const workDir = getAbsolutePath('static/sequence-videos')
    fs.mkdirSync(workDir, { recursive: true })
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    if (!sourcePath) {
      temporarySourcePath = path.join(workDir, `source-${recordId}-${nonce}${extension}`)
      fs.writeFileSync(temporarySourcePath, buffer)
      sourcePath = temporarySourcePath
    }
    const tailPath = path.join(workDir, `continuation-${recordId}-${nonce}.mp4`)
    try {
      await execFileAsync(getFfmpegBinary(), [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-sseof', `-${LOCAL_H3_CONTINUATION_TAIL_SECONDS}`,
        '-i', sourcePath,
        '-t', String(LOCAL_H3_CONTINUATION_TAIL_SECONDS),
        '-vf', 'fps=24',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-movflags', '+faststart',
        tailPath,
      ], { timeout: VIDEO_DOWNLOAD_TIMEOUT_MS })
      buffer = fs.readFileSync(tailPath)
      extension = '.mp4'
    } finally {
      if (fs.existsSync(tailPath)) fs.rmSync(tailPath, { force: true })
      if (temporarySourcePath && fs.existsSync(temporarySourcePath)) fs.rmSync(temporarySourcePath, { force: true })
    }
  }
  const name = `mijing-previous-video-${recordId}-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(buffer)], { type: 'video/mp4' }), name)
  form.append('type', 'input')
  form.append('overwrite', 'false')
  const base = String(config.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
  const response = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS) })
  const text = await response.text()
  if (!response.ok) throw new Error(`ComfyUI 上一镜视频上传失败：HTTP ${response.status} ${text.slice(0, 300)}`)
  let parsed: any = {}
  try { parsed = JSON.parse(text) } catch {}
  const uploadedName = String(parsed.name || parsed.filename || name).trim()
  if (!uploadedName) throw new Error('ComfyUI 上一镜视频上传未返回文件名')
  return uploadedName
}

/** Return local references without duplicate image values.  MiniMax H3 R2V
 * receives the complete ordered list through `referenceImages`; Picture 1 is
 * the previous tail and there is no dedicated first-frame slot. */
export function dedupeComfyUiReferenceUrls(values: string[], firstFrameUrl?: string | null) {
  // The optional argument is retained for source compatibility with callers
  // outside this module, but local R2V never treats it as a provider frame
  // input.  Callers must pass the complete ordered list via `values`.
  const first = comfyReferenceSourceKey(firstFrameUrl)
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values || []) {
    const normalized = String(value || '').trim()
    const key = comfyReferenceSourceKey(normalized)
    if (!normalized || !key || key === first || seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function comfyReferenceSourceKey(value?: string | null) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const local = raw
    .replace(/^https?:\/\/[^/]+\/static\//i, 'static/')
    .replace(/^\/static\//i, 'static/')
    .replace(/\\/g, '/')
  return local.startsWith('static/') ? `static:${local.slice(7)}` : local
}

export async function prepareMijingVideoReferences(
  record: VideoPromptRecord,
  syncAsset: (input: VolcAssetReferenceInput) => Promise<SyncedVolcAsset> = syncVolcImageAsset,
): Promise<PreparedVideoReferenceRecord> {
  const context = getVideoAssetContext(record)
  const sync = async (value: string | null | undefined, name: string) => {
    const raw = String(value || '').trim()
    if (!raw) return null
    if (isVolcAssetUri(raw)) return normalizeVolcAssetUri(raw)
    const asset = await syncAsset({ url: raw, name, category: 'storyboard', dramaId: record.dramaId, episodeId: context.episodeId, storyboardId: record.storyboardId, storyboardNum: context.storyboardNum, groupName: context.groupName, source: 'volc:mijingVideoReference' })
    return normalizeVolcAssetUri(asset.assetUri || asset.providerAssetId)
  }
  if (record.referenceMode === 'first_frame_multiple') {
    const firstFrameUrl = await sync(record.firstFrameUrl, '首帧')
    if (!firstFrameUrl) throw new Error('首帧缺少图片地址，已取消视频生成')
    const references: string[] = []
    for (const [index, url] of parseReferenceImageUrls(record.referenceImageUrls).entries()) {
      const reference = await sync(url, `参考图${index + 1}`)
      if (reference && reference !== firstFrameUrl && !references.includes(reference)) references.push(reference)
    }
    return { imageUrl: null, firstFrameUrl, lastFrameUrl: null, referenceImageUrls: references.slice(0, 8), prompt: String(record.prompt || ''), referenceMode: 'first_frame_multiple' }
  }
  if (record.referenceMode === 'first_last') {
    const firstFrameUrl = await sync(record.firstFrameUrl, '首帧')
    const lastFrameUrl = await sync(record.lastFrameUrl, '尾帧')
    if (!firstFrameUrl || !lastFrameUrl) throw new Error('首尾帧缺少图片地址，已取消视频生成')
    return { imageUrl: null, firstFrameUrl, lastFrameUrl, referenceImageUrls: [], prompt: String(record.prompt || ''), referenceMode: 'first_last' }
  }
  const imageUrl = await sync(record.imageUrl, '参考图')
  const firstFrameUrl = await sync(record.firstFrameUrl, '首帧')
  const lastFrameUrl = await sync(record.lastFrameUrl, '尾帧')
  const referenceImageUrls: string[] = []
  for (const [index, url] of parseReferenceImageUrls(record.referenceImageUrls).entries()) {
    const reference = await sync(url, `参考图${index + 1}`)
    if (reference && !referenceImageUrls.includes(reference)) referenceImageUrls.push(reference)
  }
  return { imageUrl, firstFrameUrl, lastFrameUrl, referenceImageUrls: referenceImageUrls.slice(0, 9), prompt: String(record.prompt || ''), referenceMode: record.referenceMode || 'none' }
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
  record: Pick<VideoGenerationRow, 'id' | 'storyboardId' | 'provider' | 'model' | 'status' | 'taskId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'sequenceRunId'> | null | undefined,
  reason = 'api',
) {
  if (!canResumeBackgroundTasks(reason)) return false
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
    .finally(async () => {
      const [current] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
      if (String(config.provider || '').trim().toLowerCase() === 'comfyui' && current?.status !== 'completed') {
        try {
          await releaseComfyUiMemory(config)
          logTaskProgress('VideoTask', 'comfyui-memory-released', { id, taskId, reason: 'terminal-without-completion' })
        } catch (err: any) {
          logTaskWarn('VideoTask', 'comfyui-memory-release-failed', { id, taskId, error: err?.message || String(err) })
        }
      }
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
> & { steps?: number | null; referenceAudioUrls?: string | null; seed?: number | null; referenceVideoLocalPath?: string | null; continuityMode?: string | null; sequenceStepIndex?: number | null }

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
  autodlReferenceImages?: Array<{
    url: string
    source?: string | null
  }> | null
  comfyImageNames?: {
    referenceImages?: string[]
  } | null
  comfyVideoName?: string | null
}

type PublicVideoReferenceContext = {
  sceneImages: Array<{ name: string; url: string }>
  characterImages: Array<{ name: string; url: string; characterId?: number; asset?: SyncedVolcAsset }>
  propImages?: Array<{ name: string; url: string }>
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

  const isLocalComfyUi = String(config.provider || '').trim().toLowerCase() === 'comfyui'
  if (isLocalComfyUi) {
    // Preview must obey exactly the same local H3 contract as generation.
    // Never expose a first/last-frame or I2V preview from a stale caller.
    const localReferenceMode = normalizeLocalComfyUiReferenceMode(params.referenceMode)
    assertLocalComfyUiR2VRecord({
      referenceMode: localReferenceMode,
      // Validate the caller's actual fields.  The preview endpoint must not
      // silently discard a legacy frame slot and make an invalid local request
      // look like a valid multi-reference preview.
      imageUrl: params.imageUrl,
      firstFrameUrl: params.firstFrameUrl,
      lastFrameUrl: params.lastFrameUrl,
      referenceImageUrls: params.referenceImageUrls,
      prompt: params.prompt,
    })
  }

  const model = params.model || config.model
  // Local MiniMax H3 has one preview contract too: ordered multi-reference
  // R2V. Do not echo a stale first_last/first_frame_multiple value back to the
  // UI even when an older caller omitted or supplied the retired mode.
  const referenceMode = isLocalComfyUi ? 'multiple' : (params.referenceMode || 'none')
  const visualContext = resolveVideoProjectVisualContext(params.storyboardId, params.dramaId)
  const prompt = appendStoryboardDialoguePrompt(
    applyVideoVisualStyleLock(
      params.prompt,
      visualContext.style,
      visualContext.breakdownMode,
    ),
    params.storyboardId,
    visualContext.breakdownMode,
    isLocalComfyUi,
  )
  if (config.provider !== 'volcengine') {
    const prepared = config.provider === 'comfyui'
      ? {
        prompt,
        referenceImageUrls: Array.isArray(params.referenceImageUrls)
          ? params.referenceImageUrls
          : parseReferenceImageUrls(params.referenceImageUrls),
      }
      : config.provider === 'eggfans'
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
      : config.provider === 'grok_openai'
        ? await prepareGrokOpenAIVideoReferenceRecord({
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
      : config.provider === 'autodl_comfyui'
        ? await prepareAutoDlComfyUiVideoReferenceRecord({
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
        }, config)
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
      reference_kind: config.provider === 'grok_openai' ? 'public_url_or_base64' : 'public_image_url',
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

/**
 * Prepare xAI/Grok Imagine references without touching the Volcengine asset
 * service. Local images become compressed data URLs; existing public URLs are
 * kept as URLs so the gateway receives the smallest valid representation.
 */
export async function prepareGrokOpenAIVideoReferenceRecord(
  record: VideoPromptRecord,
  context: PublicVideoReferenceContext = getVideoAssetContext(record),
): Promise<PreparedVideoReferenceRecord> {
  const refs = collectVideoReferencesFromContext(record, context, 7)
  if (!refs.length) {
    return {
      prompt: stripPublicVideoReferencePrompt(String(record.prompt || '')),
      imageUrl: null,
      firstFrameUrl: null,
      lastFrameUrl: null,
      referenceImageUrls: [],
      referenceMode: 'none',
    }
  }

  const normalized: Array<RequiredVideoReference & { publicUrl: string; provider: string }> = []
  for (const ref of refs) {
    if (isVolcAssetUri(ref.url)) {
      throw new Error(`Grok Imagine 不支持火山资产 URI：${ref.name}。请使用本地图片、base64 或公网图片 URL`)
    }
    try {
      const value = await normalizeVideoReferenceUrl(ref.url)
      if (!value) throw new Error('图片内容为空')
      normalized.push({ ...ref, publicUrl: value, provider: value.startsWith('data:') ? 'base64' : 'public-url' })
    } catch (error) {
      throw new Error(`Grok Imagine 参考图${ref.name}无法转换：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const referenceImageUrls = normalized.map(item => item.publicUrl)
  const prompt = appendGrokOpenAIReferencePrompt(String(record.prompt || ''), normalized)
  const mode = record.referenceMode === 'first_frame_multiple'
    ? 'first_frame_multiple'
    : referenceImageUrls.length ? (record.referenceMode === 'single' ? 'single' : 'multiple') : 'none'

  return {
    prompt,
    imageUrl: mode === 'single' ? referenceImageUrls[0] : null,
    firstFrameUrl: mode === 'first_frame_multiple' ? referenceImageUrls[0] : null,
    lastFrameUrl: null,
    referenceImageUrls: mode === 'first_frame_multiple' ? referenceImageUrls.slice(1) : mode === 'single' ? [] : referenceImageUrls,
    referenceMode: mode,
  }
}

function appendGrokOpenAIReferencePrompt(
  prompt: string,
  references: Array<RequiredVideoReference & { publicUrl: string; provider: string }>,
) {
  if (/Grok Imagine 只使用公网图片 URL 或 base64/.test(prompt)) {
    return prompt
  }
  const basePrompt = stripPublicVideoReferencePrompt(prompt)
  const bindings = references.map((item, index) => {
    const label = cleanBindingLabel(item.name || item.entityName) || `参考图${index + 1}`
    return `<IMAGE_${index + 1}> = ${label}`
  })
  return [
    basePrompt,
    'Grok Imagine reference-to-video：参考图已按顺序通过 reference_images 参数传输；请严格结合分镜正文使用，不要忽略或重新设计参考对象。',
    '参考图对应关系：',
    ...bindings,
    '如果存在首帧画面，<IMAGE_1> 是本镜头必须承接的首帧；其他图片用于角色、场景、道具和构图一致性。不要调用火山资产库，不要使用 @asset://。',
  ].filter(Boolean).join('\n')
}

function isGrokVideoModelName(model: string | null | undefined) {
  const normalized = String(model || '').toLowerCase()
  return normalized.includes('grok-video') || normalized.includes('grok-imagine-video')
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
  } else if (record.referenceMode === 'first_frame_multiple') {
    push(record.firstFrameUrl, `${storyboardLabel}-首帧`, 'first_frame', 'storyboard', 1)
    let parsed: unknown = []
    try {
      parsed = JSON.parse(record.referenceImageUrls || '[]')
    } catch {
      parsed = []
    }
    if (Array.isArray(parsed)) {
      parsed.forEach((url, index) => push(
        String(url || ''),
        `${storyboardLabel}-参考图${index + 1}`,
        'reference_image',
        'storyboard',
        index + 2,
      ))
    }
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
  ;(context.propImages || []).forEach((item, index) => push(item.url, `道具-${item.name || index + 1}`, 'prop', 'prop', undefined, item.name))
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
  } else if (record.referenceMode === 'first_frame_multiple') {
    pushRequired(record.firstFrameUrl, `${storyboardLabel}-首帧`, 'first_frame', 'storyboard', '首帧多图模式缺少首帧参考图', 1)
    let parsed: unknown
    try { parsed = JSON.parse(record.referenceImageUrls || '[]') } catch { throw new Error('Seedance 2.0 首帧多图参考图解析失败') }
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('Seedance 2.0 首帧多图模式缺少参考图')
    parsed.forEach((url, index) => pushRequired(url, `${storyboardLabel}-参考图${index + 1}`, 'reference_image', 'storyboard', `首帧多图模式第 ${index + 1} 张参考图为空`, index + 2))
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
  ;(context.propImages || []).forEach((item, index) => push(item.url, `道具-${item.name || index + 1}`, 'prop', 'prop', undefined, item.name))

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
  // Re-decomposed shots may carry the location only in a structured field or
  // in image/result/dialogue text. Use the same complete source used by the
  // serial reference builder so a valid scene asset cannot disappear merely
  // because the model paraphrased the location.
  const promptText = [
    storyboard?.title,
    storyboard?.location,
    storyboard?.time,
    storyboard?.videoPrompt,
    storyboard?.action,
    storyboard?.description,
    storyboard?.result,
    storyboard?.imagePrompt,
    storyboard?.atmosphere,
    storyboard?.dialogue,
  ].filter(Boolean).join('\n')
  const allScenes = db.select().from(schema.scenes).all()
  const episodeSceneIds = storyboard?.episodeId
    ? new Set(db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, storyboard.episodeId)).all()
      .map(link => link.sceneId))
    : new Set<number>()
  const sceneCandidates = episodeSceneIds.size
    ? allScenes.filter(item => episodeSceneIds.has(item.id))
    : allScenes.filter(item => !storyboard?.episodeId || item.episodeId === storyboard.episodeId || item.dramaId === (drama?.id || episode?.dramaId))
  const requestedLocation = String(storyboard?.location || '').trim()
  const normalizedPromptText = normalizeVideoAssetText(promptText)
  const staleScene = storyboard?.sceneId
    ? allScenes.find(item => item.id === storyboard.sceneId && !item.deletedAt)
    : null
  const sceneLocationHints = [
    requestedLocation,
    String(staleScene?.location || '').trim(),
  ].filter(Boolean)
  const sceneTimeHints = [
    String(storyboard?.time || '').trim(),
    String(staleScene?.time || '').trim(),
  ].filter(Boolean)
  const promptScene = sceneCandidates
    .filter(item => !item.deletedAt
      && item.location
      && (sceneLocationHints.some(hint => sameVideoEntityText(item.location, hint))
        || normalizedPromptText.includes(normalizeVideoAssetText(item.location))
        || (item.prompt && normalizedPromptText.includes(normalizeVideoAssetText(item.prompt)))))
    .sort((a, b) => {
      const aScore = sceneVideoCandidateScore(a, sceneLocationHints, sceneTimeHints, normalizedPromptText)
      const bScore = sceneVideoCandidateScore(b, sceneLocationHints, sceneTimeHints, normalizedPromptText)
      if (bScore !== aScore) return bScore > aScore ? 1 : -1
      const bId = Number((b as any).id || 0)
      const aId = Number((a as any).id || 0)
      return bId === aId ? 0 : (bId > aId ? 1 : -1)
    })[0]
  // Re-decomposition may leave a legacy scene_id on the storyboard.  Once
  // episodeScenes exists, an explicit id is only valid when it is one of the
  // current episode's linked scenes; never fall back to another scene from
  // the same drama because that produces a visually wrong/blank background.
  const explicitScene = storyboard?.sceneId
    ? allScenes.find(item => item.id === storyboard.sceneId
      && !item.deletedAt
      && (episodeSceneIds.size
        ? episodeSceneIds.has(item.id)
        : (item.episodeId === storyboard?.episodeId || item.dramaId === (drama?.id || episode?.dramaId))))
    : null
  // A storyboard's explicit scene_id is authoritative.  Prompt text can
  // mention another place (for example a character's destination or a
  // transition), but it must never replace the scene asset selected during
  // decomposition.  Only fall back to textual matching when no valid id was
  // stored.
  // If the episode has exactly one linked scene, it is authoritative even
  // when the model omitted or paraphrased location/time in the shot. This is
  // the safe case where no cross-scene guess is possible.
  const soleEpisodeScene = episodeSceneIds.size === 1
    ? sceneCandidates.find(item => !item.deletedAt)
    : null
  const scene = explicitScene || promptScene || soleEpisodeScene
  if (requestedLocation && !scene) {
    throw new Error(`镜头${storyboard?.storyboardNumber || record.id}未绑定场景资产“${requestedLocation}”，已阻止生成白底视频；请重新提取场景并重拆解分镜`)
  }
  const characterIds = storyboard?.id
    ? db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboard.id))
      .all()
      .map(item => item.characterId)
    : []
  const allCharacters = db.select().from(schema.characters).all()
    .filter(char => !char.deletedAt && char.dramaId === (drama?.id || episode?.dramaId) && entityImageUrl(char))
  const normalizedPrompt = normalizeVideoAssetText(promptText)
  const mentionedCharacters = allCharacters.filter(char => {
    const name = String(char.name || '').trim()
    return !!name && normalizedPrompt.includes(normalizeVideoAssetText(name))
      && !isRelationshipOnlyVideoCharacterMention(promptText, name)
      && !isExplicitlyAbsentVideoCharacter(promptText, name)
  })
  const roleNames = extractVideoRoleNames(promptText)
  const taggedCharacters = roleNames.length
    ? allCharacters.filter(char => roleNames.some(name => normalizeVideoAssetText(name) === normalizeVideoAssetText(char.name)))
    : []
  const characters = roleNames.length
    ? taggedCharacters
    : mentionedCharacters.length
      ? mentionedCharacters
      : allCharacters.filter(char => characterIds.includes(char.id))
  const props = db.select().from(schema.props).all()
    .filter(prop => !prop.deletedAt && prop.dramaId === (drama?.id || episode?.dramaId) && entityImageUrl(prop)
      && prop.name && promptText.includes(prop.name))

  return {
    episodeId: episode?.id || storyboard?.episodeId || null,
    storyboardNum: storyboard?.storyboardNumber || null,
    groupName: drama?.title ? `${drama.title}-火山素材库` : record.dramaId ? `Eggfans-短剧-${record.dramaId}` : null,
    sceneName: scene?.location || storyboard?.location || '',
    sceneImages: sceneImageUrl(scene) ? [{ name: scene?.location || storyboard?.location || '场景', url: sceneImageUrl(scene)! }] : [],
    characterImages: characters.map(char => ({
      characterId: char.id,
      name: char.name,
      url: entityImageUrl(char)!,
      asset: buildCharacterExistingVolcAsset(char),
    })),
    propImages: props.map(prop => ({ name: prop.name, url: entityImageUrl(prop)! })),
  }
}

/** Return the usable asset path regardless of whether it came from a remote
 * image_url or a downloaded/generated local_path. */
function entityImageUrl(entity: { imageUrl?: string | null; localPath?: string | null }) {
  const localPath = String(entity.localPath || '').trim()
  // The local copy is the durable source for ComfyUI. Prefer it only when it
  // is actually readable; otherwise retain a valid remote image_url fallback.
  if (localPath && isReadableLocalAsset(localPath)) return localPath
  return String(entity.imageUrl || localPath || '').trim() || null
}

function sceneImageUrl(scene: { imageUrl?: string | null; localPath?: string | null } | null | undefined) {
  return entityImageUrl(scene || {})
}

function normalizeVideoAssetText(value: unknown) {
  return String(value || '').trim().replace(/[\s\u3000]+/g, '').toLocaleLowerCase()
}

function sameVideoEntityText(left: unknown, right: unknown) {
  const a = normalizeVideoAssetText(left)
  const b = normalizeVideoAssetText(right)
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a))
}

function sceneVideoCandidateScore(
  scene: { location?: string | null; time?: string | null; prompt?: string | null },
  locationHints: string[],
  timeHints: string[],
  normalizedPromptText: string,
) {
  const location = String(scene.location || '').trim()
  let score = locationHints.some(hint => sameVideoEntityText(location, hint)) ? 100 : 0
  if (location && normalizedPromptText.includes(normalizeVideoAssetText(location))) score += 30
  if (scene.prompt && normalizedPromptText.includes(normalizeVideoAssetText(scene.prompt))) score += 20
  if (timeHints.some(hint => sameVideoEntityText(scene.time, hint))) score += 10
  return score
}

function extractVideoRoleNames(prompt: string) {
  const names: string[] = []
  const pattern = /<role>\s*([^<]+?)\s*<\/role>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(prompt || '')))) {
    const name = String(match[1] || '').trim()
    if (name && !names.some(item => normalizeVideoAssetText(item) === normalizeVideoAssetText(name))) names.push(name)
  }
  return names
}

function isExplicitlyAbsentVideoCharacter(prompt: string, name: string) {
  const source = normalizeVideoAssetText(prompt).replace(/<[^>]+>/g, '')
  const absent = '(?:未入画|暂未入画|尚未入画|未出现|不在画面|不入画|不出现)'
  return new RegExp(`${escapeVideoRegExp(normalizeVideoAssetText(name))}[\\s,，。；;:：、-]*${absent}`).test(source)
}

function isRelationshipOnlyVideoCharacterMention(prompt: string, name: string) {
  const normalizedName = normalizeVideoAssetText(name)
  if (!normalizedName) return false
  const source = normalizeVideoAssetText(prompt).replace(/<[^>]+>/g, '')
  let offset = source.indexOf(normalizedName)
  while (offset >= 0) {
    const before = source.slice(Math.max(0, offset - 8), offset)
    const after = source.slice(offset + normalizedName.length, offset + normalizedName.length + 8)
    if (/的(?:父亲|母亲|女儿|儿子|丈夫|妻子|哥哥|姐姐|弟弟|妹妹|老板|店主|同事|朋友)/.test(after)
      || /(?:父亲|母亲|女儿|儿子|丈夫|妻子|哥哥|姐姐|弟弟|妹妹|老板|店主|同事|朋友)的$/.test(before)) {
      offset = source.indexOf(normalizedName, offset + normalizedName.length)
      continue
    }
    return false
  }
  return true
}

function escapeVideoRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isReadableLocalAsset(value: string) {
  const raw = String(value || '').trim()
  if (!raw) return false
  const staticPath = getStaticRelativePath(raw)
  if (staticPath) return fs.existsSync(getAbsolutePath(staticPath))
  return fs.existsSync(raw)
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
    publicUrl: entityImageUrl(char) || '',
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
  const maxAttempts = options.maxAttempts ?? getVideoPollMaxAttempts(config.provider)
  const initialDelayMs = options.initialDelayMs ?? intervalMs
  const connectivityFailureLimit = getVideoPollConnectivityFailureLimit(config.provider)
  let consecutiveConnectivityFailures = 0

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
      if (sequenceRunIsTerminal(current.sequenceRunId)) {
        cancelVideoGenerationForSequence(id)
        logTaskProgress('VideoTask', 'poll-stop-parent-terminal', {
          id,
          taskId,
          sequenceRunId: current.sequenceRunId,
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
      consecutiveConnectivityFailures = 0
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

      // Pass the active provider config so adapters can construct media URLs
      // against the configured gateway (including custom local ComfyUI ports).
      const pollResp = adapter.parsePollResponse(result, config)

      if (pollResp.status === 'completed' && pollResp.videoUrl) {
        if (pollResp.warning) logTaskWarn('VideoTask', 'h3-refinement-fallback', { id, warning: pollResp.warning })
        if (sequenceRunIsTerminal(current.sequenceRunId)) {
          cancelVideoGenerationForSequence(id)
          logTaskProgress('VideoTask', 'poll-complete-parent-terminal', { id, taskId, sequenceRunId: current.sequenceRunId })
          return
        }
        logTaskSuccess('VideoTask', 'poll-complete', { id, taskId, videoUrl: pollResp.videoUrl })
        await handleVideoComplete(id, pollResp.videoUrl, null, storyboardId, config)
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
      const errorMessage = String(err?.message || err || 'unknown error')
      const isConnectivityFailure = /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network/i.test(errorMessage)
      if (isConnectivityFailure) {
        consecutiveConnectivityFailures += 1
        if (connectivityFailureLimit > 0 && consecutiveConnectivityFailures >= connectivityFailureLimit) {
          const failureMessage = `本地 ComfyUI 已失联：连续 ${consecutiveConnectivityFailures} 次轮询失败（${errorMessage}），已停止等待，请检查 ComfyUI 进程和显存。`
          logTaskError('VideoTask', 'poll-provider-unreachable', {
            id,
            taskId,
            provider: config.provider,
            attempt: i + 1,
            consecutiveFailures: consecutiveConnectivityFailures,
            error: errorMessage,
          })
          db.update(schema.videoGenerations)
            .set({ status: 'failed', errorMsg: failureMessage, updatedAt: now() })
            .where(eq(schema.videoGenerations.id, id))
            .run()
          return
        }
      } else {
        consecutiveConnectivityFailures = 0
      }
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
  const text = String(error || 'Video generation failed')
  if (/fetch failed|econnrefused|无法连接.*worker/i.test(text)) {
    return `本地 MiniMax H3 Worker 无法连接：${text}。软件已执行自检和自动修复；若仍失败，请查看软件数据目录 logs/comfyui-worker.log。`
  }
  if (/outofmemory|out of memory|cuda out of memory|显存不足/i.test(text)) {
    return '本地 MiniMax H3 生成失败：显存不足。请关闭其他占显存程序，确认使用指定的 int8 主模型与 Turbo LoRA，并按需要降低“百万像素”；Worker 会在串行镜头之间自动清理显存。'
  }
  return text
}

async function handleVideoComplete(
  id: number,
  videoUrl: string,
  duration: number | null | undefined,
  storyboardId?: number | null,
  config?: AIConfig,
) {
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

  if (String(record.provider || '').trim().toLowerCase() === 'comfyui') {
    try {
      const memory = await releaseComfyUiMemory(config || resolveVideoPollingConfig(record) || { baseUrl: 'http://127.0.0.1:8188' })
      logTaskProgress('VideoTask', 'comfyui-memory-released', {
        id,
        storyboardId,
        reason: 'generation-complete',
        vramFreeBytes: memory.free,
        vramTotalBytes: memory.total,
        vramRequiredFreeBytes: memory.requiredFree,
        releasePolls: memory.polls,
      })
    } catch (err: any) {
      const errorMsg = `ComfyUI 显存释放未确认，已阻止下一镜：${err?.message || String(err)}`
      db.update(schema.videoGenerations)
        .set({ status: 'failed', errorMsg, updatedAt: now() })
        .where(eq(schema.videoGenerations.id, id))
        .run()
      logTaskError('VideoTask', 'comfyui-memory-release-failed', { id, storyboardId, error: errorMsg })
      throw new Error(errorMsg)
    }
  }

  db.update(schema.videoGenerations)
    .set({ videoUrl, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.videoGenerations.id, id))
    .run()

  if (storyboardId && isCurrentGeneration) {
    db.update(schema.storyboards)
      .set({ videoUrl, duration: duration || undefined })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
  }

  try {
    const downloadTimeout = String(record.provider || '').trim().toLowerCase() === 'autodl_comfyui'
      ? 180_000
      : VIDEO_DOWNLOAD_TIMEOUT_MS
    const localPath = await downloadFile(videoUrl, 'videos', { timeoutMs: downloadTimeout })
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
        .set({ videoUrl: localPath, duration: duration || undefined })
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

  const downloadTimeout = String(record.provider || '').trim().toLowerCase() === 'autodl_comfyui'
    ? 180_000
    : VIDEO_DOWNLOAD_TIMEOUT_MS
  const localPath = await downloadFile(record.videoUrl, 'videos', { timeoutMs: downloadTimeout })
  db.update(schema.videoGenerations)
    .set({ localPath, updatedAt: now() })
    .where(eq(schema.videoGenerations.id, generationId))
    .run()

  if (record.storyboardId) {
    db.update(schema.storyboards)
      .set({ videoUrl: localPath })
      .where(eq(schema.storyboards.id, record.storyboardId))
      .run()
  }

  return localPath
}
