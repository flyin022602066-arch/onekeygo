import { and, eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { downloadFile, getAbsolutePath } from '../utils/storage.js'
import { getConfigById } from './ai.js'
import { ensureVideoPolling, generateVideo } from './video-generation.js'
import { syncVolcCharacterAssetForCharacter, syncVolcImageAsset } from './volc-asset-sync.js'
import type { SyncedVolcAsset } from './volc-asset-sync.js'
import { logTaskError, logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { withTkOverseasVisualLock } from './overseas-visual.js'
import { appendVideoDialoguePrompt } from './video-dialogue-prompt.js'
import { FFMPEG_BINARY } from './media-tools.js'

const execFileAsync = promisify(execFile)
const MAX_ASSETS = 9
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000
const activeRuns = new Set<number>()

type Run = typeof schema.videoSequenceRuns.$inferSelect
type Step = typeof schema.videoSequenceSteps.$inferSelect
type Storyboard = typeof schema.storyboards.$inferSelect

type AssetRef = {
  url: string
  name: string
  role: string
  category: string
  entityName?: string
  characterId?: number
  asset?: SyncedVolcAsset
}

export async function startVideoSequence(input: {
  dramaId: number
  episodeId: number
  configId?: number | null
  model?: string | null
  aspectRatio?: string | null
}) {
  const config = input.configId ? getConfigById(Number(input.configId)) : null
  if (!config || !['mijing', 'grok_openai'].includes(String(config.provider || '').toLowerCase())) {
    throw new Error('一键串行生成仅支持谜镜或 Grok Imagine 视频通道，请选择对应的视频配置')
  }
  const model = String(input.model || config.model || '').trim()
  if (!model) throw new Error('串行视频模型未配置')

  const storyboards = getEpisodeStoryboards(input.episodeId)
  if (!storyboards.length) throw new Error('当前集没有可生成的分镜')

  const existing = db.select().from(schema.videoSequenceRuns).all()
    .filter(row => row.episodeId === input.episodeId && ['queued', 'running', 'paused'].includes(String(row.status)))
    .sort((a, b) => Number(b.id) - Number(a.id))[0]
  if (existing) {
    ensureSequenceWorker(existing.id)
    return getVideoSequence(existing.id)
  }

  const ts = now()
  const runResult = db.insert(schema.videoSequenceRuns).values({
    dramaId: input.dramaId,
    episodeId: input.episodeId,
    provider: config.provider,
    model,
    configId: input.configId || config.id || null,
    aspectRatio: input.aspectRatio || '16:9',
    status: 'queued',
    currentIndex: 0,
    totalCount: storyboards.length,
    currentStoryboardId: storyboards[0].id,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const runId = Number(runResult.lastInsertRowid)

  storyboards.forEach((storyboard, index) => {
    db.insert(schema.videoSequenceSteps).values({
      runId,
      storyboardId: storyboard.id,
      stepIndex: index,
      storyboardNumber: storyboard.storyboardNumber,
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
    }).run()
  })

  ensureSequenceWorker(runId)
  return getVideoSequence(runId)
}

export function getVideoSequence(runId: number) {
  const [run] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all()
  if (!run) return null
  const steps = db.select().from(schema.videoSequenceSteps)
    .where(eq(schema.videoSequenceSteps.runId, runId)).all()
    .sort((a, b) => a.stepIndex - b.stepIndex)
  return { ...run, steps }
}

export function getEpisodeVideoSequence(episodeId: number) {
  const run = db.select().from(schema.videoSequenceRuns).all()
    .filter(row => row.episodeId === episodeId)
    .sort((a, b) => Number(b.id) - Number(a.id))[0]
  return run ? getVideoSequence(run.id) : null
}

export function ensureSequenceWorker(runId: number) {
  if (activeRuns.has(runId)) return false
  const run = getVideoSequence(runId)
  if (!run || ['completed', 'cancelled'].includes(String(run.status))) return false
  activeRuns.add(runId)
  processSequence(runId).catch(error => {
    logTaskError('VideoSequence', 'worker-crashed', { runId, error: error?.message || String(error) })
    markRunFailed(runId, error?.message || String(error))
  }).finally(() => activeRuns.delete(runId))
  return true
}

export function resumeVideoSequences(reason = 'startup') {
  const runs = db.select().from(schema.videoSequenceRuns).all()
    .filter(run => ['queued', 'running', 'paused'].includes(String(run.status)))
  for (const run of runs) ensureSequenceWorker(run.id)
  logTaskProgress('VideoSequence', 'resume-scan', { reason, count: runs.length })
  return runs.length
}

export function cancelVideoSequence(runId: number) {
  const [run] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all()
  if (!run) return null
  if (!['completed', 'failed', 'cancelled'].includes(String(run.status))) {
    db.update(schema.videoSequenceRuns).set({ status: 'cancelled', errorMsg: '用户停止串行生成', updatedAt: now() }).where(eq(schema.videoSequenceRuns.id, runId)).run()
    const steps = db.select().from(schema.videoSequenceSteps).where(eq(schema.videoSequenceSteps.runId, runId)).all()
    for (const step of steps.filter(item => !['completed', 'failed', 'cancelled'].includes(String(item.status)))) {
      db.update(schema.videoSequenceSteps).set({ status: 'cancelled', updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run()
    }
  }
  return getVideoSequence(runId)
}

export function retryVideoSequence(runId: number) {
  const sequence = getVideoSequence(runId)
  if (!sequence) throw new Error('串行任务不存在')
  if (sequence.status !== 'failed') throw new Error('当前串行任务没有失败步骤')
  const failed = sequence.steps.find(step => step.status === 'failed')
  if (!failed) throw new Error('没有可重试的失败镜头')
  const failedGeneration = failed.videoGenerationId ? getVideoGeneration(failed.videoGenerationId) : null
  if (failedGeneration && !failedGeneration.deletedAt) {
    db.update(schema.videoGenerations)
      .set({ deletedAt: now(), updatedAt: now() })
      .where(eq(schema.videoGenerations.id, failedGeneration.id))
      .run()
  }
  db.update(schema.videoSequenceRuns).set({ status: 'queued', errorMsg: null, currentIndex: failed.stepIndex, currentStoryboardId: failed.storyboardId, updatedAt: now() }).where(eq(schema.videoSequenceRuns.id, runId)).run()
  db.update(schema.videoSequenceSteps).set({ status: 'pending', videoGenerationId: null, errorMsg: null, updatedAt: now() })
    .where(and(eq(schema.videoSequenceSteps.runId, runId), eq(schema.videoSequenceSteps.stepIndex, failed.stepIndex))).run()
  ensureSequenceWorker(runId)
  return getVideoSequence(runId)
}

async function processSequence(runId: number) {
  const initial = getVideoSequence(runId)
  if (!initial) return
  setRunStatus(runId, 'running')

  for (;;) {
    const sequence = getVideoSequence(runId)
    if (!sequence || ['cancelled', 'completed'].includes(String(sequence.status))) return
    resetStaleSequenceSteps(sequence)
    const current = getVideoSequence(runId)
    if (!current || ['cancelled', 'completed'].includes(String(current.status))) return
    const step = current.steps.find(item => ['pending', 'running', 'preparing', 'submitting', 'processing', 'extracting_tail'].includes(String(item.status)))
    if (!step) {
      setRunStatus(runId, 'completed', { completedAt: now(), currentIndex: sequence.totalCount, currentStoryboardId: null })
      return
    }
    try {
      await processStep(current, step)
    } catch (error: any) {
      const [latestRun] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all()
      if (error instanceof SequenceCancelledError || latestRun?.status === 'cancelled') return
      const message = error?.message || String(error)
      db.update(schema.videoSequenceSteps).set({ status: 'failed', errorMsg: message, updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run()
      markRunFailed(runId, message, step.storyboardId)
      logTaskError('VideoSequence', 'step-failed', { runId, stepId: step.id, storyboardId: step.storyboardId, error: message })
      return
    }
  }
}

function resetStaleSequenceSteps(sequence: NonNullable<ReturnType<typeof getVideoSequence>>) {
  const restartIndex = sequence.steps
    .filter(step => {
      if (!step.videoGenerationId) return false
      const generation = getVideoGeneration(step.videoGenerationId)
      return !generation || !!generation.deletedAt
    })
    .reduce<number | null>((min, step) => min == null ? step.stepIndex : Math.min(min, step.stepIndex), null)
  if (restartIndex == null) return

  const timestamp = now()
  for (const step of sequence.steps.filter(item => item.stepIndex >= restartIndex)) {
    db.update(schema.videoSequenceSteps).set({
      status: 'pending',
      videoGenerationId: null,
      firstFrameLocalPath: null,
      firstFrameUrl: null,
      firstFrameAssetId: null,
      firstFrameAssetUri: null,
      tailFrameLocalPath: null,
      tailFrameUrl: null,
      tailFrameAssetId: null,
      tailFrameAssetUri: null,
      assetIds: null,
      assetRefs: null,
      referenceImageUrls: null,
      prompt: null,
      errorMsg: null,
      completedAt: null,
      updatedAt: timestamp,
    }).where(eq(schema.videoSequenceSteps.id, step.id)).run()
  }
  db.update(schema.videoSequenceRuns).set({
    status: 'queued',
    currentIndex: restartIndex,
    currentStoryboardId: sequence.steps.find(item => item.stepIndex === restartIndex)?.storyboardId || null,
    updatedAt: timestamp,
  }).where(eq(schema.videoSequenceRuns.id, sequence.id)).run()
  logTaskProgress('VideoSequence', 'stale-steps-reset', { runId: sequence.id, restartIndex })
}

async function processStep(sequence: ReturnType<typeof getVideoSequence>, step: Step) {
  if (!sequence) return
  const storyboard = getStoryboard(step.storyboardId)
  if (!storyboard) throw new Error(`镜头 ${step.storyboardNumber || step.storyboardId} 不存在`)
  db.update(schema.videoSequenceSteps).set({ status: 'preparing', errorMsg: null, updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run()
  db.update(schema.videoSequenceRuns).set({ currentIndex: step.stepIndex, currentStoryboardId: step.storyboardId, updatedAt: now() }).where(eq(schema.videoSequenceRuns.id, sequence.id)).run()

  const previous = step.stepIndex > 0 ? sequence.steps.find(item => item.stepIndex === step.stepIndex - 1) || null : null
  const isGrokOpenAI = String(sequence.provider || '').toLowerCase() === 'grok_openai'
  const refs = isGrokOpenAI
    ? await buildGrokStepReferences(storyboard, previous)
    : await buildStepReferences(storyboard, previous)
  assertSequenceActive(sequence.id)
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sequence.episodeId)).all()
  const prompt = isGrokOpenAI
    ? buildGrokSequencePrompt(
      String(storyboard.videoPrompt || ''),
      refs,
      step.stepIndex > 0,
      episode?.breakdownMode,
      storyboard.dialogue,
    )
    : buildSequencePrompt(
    String(storyboard.videoPrompt || ''),
    refs,
    step.stepIndex > 0,
    episode?.breakdownMode,
    storyboard.dialogue,
  )
  const referenceUrls = refs.map(item => item.url)
  const referenceAssetUris = isGrokOpenAI
    ? refs.map(item => item.url)
    : refs.map(item => formatSequenceAssetUri(item.asset))
  const assetIds = refs.map(item => item.asset?.providerAssetId).filter(Boolean) as string[]
  const assetBindings = refs.map(item => ({ name: item.name, role: item.role, category: item.category, asset_id: item.asset?.providerAssetId, asset_uri: item.asset?.assetUri }))

  db.update(schema.videoSequenceSteps).set({
    status: 'submitting',
    prompt,
    assetIds: JSON.stringify(assetIds),
    assetRefs: JSON.stringify(assetBindings),
    referenceImageUrls: JSON.stringify(referenceAssetUris),
    firstFrameLocalPath: previous?.tailFrameLocalPath || null,
    firstFrameUrl: previous?.tailFrameUrl || null,
    firstFrameAssetId: isGrokOpenAI ? null : previous?.tailFrameAssetId || null,
    firstFrameAssetUri: isGrokOpenAI ? null : previous?.tailFrameAssetUri || null,
    updatedAt: now(),
  }).where(eq(schema.videoSequenceSteps.id, step.id)).run()

  let generationId = step.videoGenerationId || null
  if (generationId) {
    const existingGeneration = getVideoGeneration(generationId)
    if (!existingGeneration || existingGeneration.deletedAt) generationId = null
  }
  if (!generationId) {
    assertSequenceActive(sequence.id)
    generationId = await generateVideo({
      storyboardId: storyboard.id,
      dramaId: sequence.dramaId,
      prompt,
      promptIsFinal: true,
      model: sequence.model || undefined,
      referenceMode: step.stepIndex > 0 ? 'first_frame_multiple' : (referenceUrls.length ? 'multiple' : 'none'),
      firstFrameUrl: previous ? referenceAssetUris[0] : undefined,
      referenceImageUrls: previous ? referenceAssetUris.slice(1, isGrokOpenAI ? 7 : 9) : referenceAssetUris.slice(0, isGrokOpenAI ? 7 : 9),
      duration: storyboard.duration || 5,
      aspectRatio: sequence.aspectRatio || undefined,
      configId: sequence.configId || undefined,
    })
    db.update(schema.videoSequenceSteps).set({ status: 'processing', videoGenerationId: generationId, updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run()
  } else {
    db.update(schema.videoSequenceSteps).set({ status: 'processing', updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run()
  }
  await waitForVideoGeneration(generationId, sequence.id)
  const completed = getVideoGeneration(generationId)
  if (!completed || completed.status !== 'completed') throw new Error(completed?.errorMsg || '串行视频生成失败')
  db.update(schema.videoSequenceSteps).set({ status: 'extracting_tail', updatedAt: now() }).where(eq(schema.videoSequenceSteps.id, step.id)).run()
  const tail = await extractTailFrame(completed.localPath || completed.videoUrl || '')
  const isGrokSequence = String(sequence.provider || '').toLowerCase() === 'grok_openai'
  const publicUrl = await uploadTailFrame(tail.localPath, storyboard, sequence, isGrokSequence)
  const asset = isGrokSequence
    ? null
    : await syncVolcImageAsset({
      url: publicUrl,
      name: `镜头${storyboard.storyboardNumber}-尾帧`,
      category: 'storyboard',
      dramaId: sequence.dramaId,
      episodeId: sequence.episodeId,
      storyboardId: storyboard.id,
      storyboardNum: storyboard.storyboardNumber,
      source: 'volc:videoSequenceTailFrame',
    })
  db.update(schema.videoSequenceSteps).set({
    status: 'completed',
    tailFrameLocalPath: tail.localPath,
    tailFrameUrl: publicUrl,
    tailFrameAssetId: asset?.providerAssetId || null,
    tailFrameAssetUri: asset?.assetUri || asset?.providerAssetId || null,
    completedAt: now(),
    updatedAt: now(),
  }).where(eq(schema.videoSequenceSteps.id, step.id)).run()
  // 将串行尾帧同步到镜头尾帧字段，便于普通视频页继续查看和人工重用。
  db.update(schema.storyboards).set({ lastFrameImage: tail.localPath, updatedAt: now() }).where(eq(schema.storyboards.id, storyboard.id)).run()
  logTaskProgress('VideoSequence', 'step-completed', { runId: sequence.id, storyboardId: storyboard.id, stepIndex: step.stepIndex, assetCount: assetIds.length })
}

async function buildStepReferences(storyboard: Storyboard, previous: Step | null): Promise<AssetRef[]> {
  const refs: AssetRef[] = []
  const seenUrls = new Set<string>()
  const seenAssets = new Set<string>()
  const push = (item: AssetRef) => {
    const url = String(item.url || '').trim()
    const assetId = String(item.asset?.providerAssetId || '').trim()
    if (!url || (url && seenUrls.has(url)) || (assetId && seenAssets.has(assetId))) return
    seenUrls.add(url)
    if (assetId) seenAssets.add(assetId)
    refs.push({ ...item, url })
  }

  if (previous?.tailFrameUrl && previous.tailFrameAssetId) {
    push({
      url: previous.tailFrameUrl,
      name: '首帧画面',
      role: 'first_frame',
      category: 'storyboard',
      asset: {
        localAssetId: 0,
        providerAssetId: previous.tailFrameAssetId,
        assetUri: previous.tailFrameAssetUri,
        groupName: 'Eggfans-串行尾帧',
        publicUrl: previous.tailFrameUrl,
      },
    })
  } else if (previous) {
    throw new Error(`上一镜头尾帧资产未准备完成，无法生成镜头${storyboard.storyboardNumber}`)
  }

  const context = getStoryboardContext(storyboard)
  const missingCharacters = context.characters.filter(character => !getEntityImageUrl(character))
  if (missingCharacters.length) throw new Error(`镜头${storyboard.storyboardNumber}角色缺少形象图：${missingCharacters.map(item => item.name).join('、')}`)
  if (context.scene && !getEntityImageUrl(context.scene)) throw new Error(`镜头${storyboard.storyboardNumber}场景“${context.scene.location}”缺少场景图`)
  const missingProps = context.props.filter(prop => !getEntityImageUrl(prop))
  if (missingProps.length) throw new Error(`镜头${storyboard.storyboardNumber}道具缺少图片：${missingProps.map(item => item.name).join('、')}`)

  const requiredSources = [
    ...context.characters.map(character => ({ name: `角色-${character.name}`, url: getEntityImageUrl(character) })),
    ...(context.scene ? [{ name: `场景-${context.scene.location}`, url: getEntityImageUrl(context.scene) }] : []),
    ...context.props.map(prop => ({ name: `道具-${prop.name}`, url: getEntityImageUrl(prop) })),
  ]
  const requiredUrls = new Set(seenUrls)
  for (const item of requiredSources) requiredUrls.add(item.url)
  if (requiredUrls.size > MAX_ASSETS) {
    const firstFrameCount = previous ? 1 : 0
    throw new Error(
      `镜头${storyboard.storyboardNumber}必须参考 ${requiredUrls.size} 个资产（首帧${firstFrameCount}、角色${context.characters.length}、场景${context.scene ? 1 : 0}、道具${context.props.length}），超过谜镜 9 个资产上限，请减少本镜头角色或道具后重试`,
    )
  }

  for (const character of context.characters) {
    const asset = await syncVolcCharacterAssetForCharacter(character.id)
    push({ url: asset.publicUrl || getEntityImageUrl(character), name: `角色-${character.name}`, role: 'character', category: 'character', entityName: character.name, characterId: character.id, asset })
  }
  if (context.scene) {
    const sceneImageUrl = getEntityImageUrl(context.scene)
    const asset = await syncVolcImageAsset({ url: sceneImageUrl, name: `场景-${context.scene.location}`, category: 'scene', dramaId: context.dramaId, episodeId: context.episodeId, storyboardId: storyboard.id, storyboardNum: storyboard.storyboardNumber, source: 'volc:videoSequenceScene' })
    push({ url: asset.publicUrl || sceneImageUrl, name: `场景-${context.scene.location}`, role: 'scene', category: 'scene', entityName: context.scene.location, asset })
  }
  for (const prop of context.props) {
    const propImageUrl = getEntityImageUrl(prop)
    const asset = await syncVolcImageAsset({ url: propImageUrl, name: `道具-${prop.name}`, category: 'prop', dramaId: context.dramaId, episodeId: context.episodeId, storyboardId: storyboard.id, storyboardNum: storyboard.storyboardNumber, source: 'volc:videoSequenceProp' })
    push({ url: asset.publicUrl || propImageUrl, name: `道具-${prop.name}`, role: 'prop', category: 'prop', entityName: prop.name, asset })
  }
  const manualRefs = parseReferenceImages(storyboard.referenceImages)
  let skippedManualRefs = 0
  for (const [index, url] of manualRefs.entries()) {
    if (refs.length >= MAX_ASSETS) {
      skippedManualRefs = manualRefs.length - index
      break
    }
    const asset = await syncVolcImageAsset({ url, name: `镜头${storyboard.storyboardNumber}-参考图${index + 1}`, category: 'storyboard', dramaId: context.dramaId, episodeId: context.episodeId, storyboardId: storyboard.id, storyboardNum: storyboard.storyboardNumber, source: 'volc:videoSequenceReference' })
    push({ url: asset.publicUrl || url, name: `镜头${storyboard.storyboardNumber}-参考图${index + 1}`, role: 'reference_image', category: 'storyboard', asset })
  }
  if (skippedManualRefs) {
    logTaskWarn('VideoSequence', 'optional-references-truncated', {
      storyboardId: storyboard.id,
      storyboardNumber: storyboard.storyboardNumber,
      skippedManualRefs,
      maxAssets: MAX_ASSETS,
    })
  }
  return refs
}

async function buildGrokStepReferences(storyboard: Storyboard, previous: Step | null): Promise<AssetRef[]> {
  const refs: AssetRef[] = []
  const seen = new Set<string>()
  const push = (url: string | null | undefined, name: string, role: string, category: string, entityName?: string) => {
    const value = String(url || '').trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    refs.push({ url: value, name, role, category, entityName })
  }

  if (previous) {
    if (!previous.tailFrameUrl) throw new Error(`上一镜头尾帧未准备完成，无法生成镜头${storyboard.storyboardNumber}`)
    push(previous.tailFrameUrl, '首帧画面', 'first_frame', 'storyboard')
  }

  const context = getStoryboardContext(storyboard)
  const missingCharacters = context.characters.filter(character => !getEntityImageUrl(character))
  if (missingCharacters.length) throw new Error(`镜头${storyboard.storyboardNumber}角色缺少形象图：${missingCharacters.map(item => item.name).join('、')}`)
  if (context.scene && !getEntityImageUrl(context.scene)) throw new Error(`镜头${storyboard.storyboardNumber}场景“${context.scene.location}”缺少场景图`)
  const missingProps = context.props.filter(prop => !getEntityImageUrl(prop))
  if (missingProps.length) throw new Error(`镜头${storyboard.storyboardNumber}道具缺少图片：${missingProps.map(item => item.name).join('、')}`)

  context.characters.forEach(character => push(getEntityImageUrl(character), `角色-${character.name}`, 'character', 'character', character.name))
  if (context.scene) push(getEntityImageUrl(context.scene), `场景-${context.scene.location}`, 'scene', 'scene', context.scene.location)
  context.props.forEach(prop => push(getEntityImageUrl(prop), `道具-${prop.name}`, 'prop', 'prop', prop.name))
  parseReferenceImages(storyboard.referenceImages).forEach((url, index) => push(url, `镜头${storyboard.storyboardNumber}-参考图${index + 1}`, 'reference_image', 'storyboard'))

  if (refs.length > 7) {
    throw new Error(`镜头${storyboard.storyboardNumber}需要 ${refs.length} 张 Grok Imagine 参考图，超过最多 7 张限制；请减少角色、道具或镜头参考图`)
  }
  return refs
}

export function buildSequencePrompt(
  original: string,
  refs: AssetRef[],
  hasFirstFrame: boolean,
  breakdownMode?: string | null,
  dialogue?: string | null,
) {
  const bindings = refs.map(item => `${bindingLabel(item)}=${formatAsset(item.asset)} `).join('；')
  const rules = hasFirstFrame
    ? '首帧画面资产必须作为本镜头第一帧，严格承接上一镜尾帧；随后再按原分镜文本生成动作。角色、场景和道具只使用对应资产的外观，不要重新设计，不要改变服装或人物关系。'
    : '这是串行生成的第一个镜头；角色、场景和道具只使用对应资产的外观，不要重新设计，不要改变服装或人物关系。'
  const prompt = [`连续镜头资产绑定：${bindings}`, rules, '资产 ID 只在本段绑定中声明一次；对白中的角色名保持原文。', stripSequencePrompt(String(original || '').trim())].filter(Boolean).join('\n')
  return withTkOverseasVisualLock(
    appendVideoDialoguePrompt(prompt, dialogue, breakdownMode),
    breakdownMode,
    '谜镜串行视频生成',
  )
}

export function buildGrokSequencePrompt(
  original: string,
  refs: AssetRef[],
  hasFirstFrame: boolean,
  breakdownMode?: string | null,
  dialogue?: string | null,
) {
  const cleanOriginal = stripGrokSequencePrompt(stripSequencePrompt(String(original || '').trim()))
  const rules = hasFirstFrame
    ? '这是串行生成的后续镜头；第一张参考图是上一镜头尾帧，必须作为本镜头第一帧严格承接，再按原分镜文本完成动作和镜头运动。'
    : '这是串行生成的第一个镜头；按原分镜文本开始生成，不要添加未提供的角色、场景或道具。'
  const bindings = refs.map((item, index) => `<IMAGE_${index + 1}>：${grokBindingLabel(item)}`)
  const prompt = [
    rules,
    'Grok Imagine 只使用公网图片 URL 或 base64 参考图，不使用火山 Asset URI；图片已经通过 reference_images 参数按以下顺序传输。',
    `参考图传输顺序（共 ${refs.length} 张，最多 7 张）：`,
    ...bindings,
    '必须按照上述映射使用对应参考图：首帧图负责连续性，角色图负责人物一致性，场景图负责环境一致性，道具图负责物件一致性；不要重新设计参考对象。',
    cleanOriginal,
  ].filter(Boolean).join('\n')
  return withTkOverseasVisualLock(
    appendVideoDialoguePrompt(prompt, dialogue, breakdownMode),
    breakdownMode,
    'Grok Imagine 串行视频生成',
  )
}

function stripGrokSequencePrompt(value: string) {
  const lines = value.split(/\r?\n/)
  const marker = lines.findIndex(line => /Grok Imagine 只使用公网|Grok Imagine reference-to-video|参考图传输顺序（共|参考图对应关系：/.test(line))
  return (marker >= 0 ? lines.slice(0, marker) : lines).join('\n').trim()
}

function grokBindingLabel(item: AssetRef) {
  if (item.role === 'first_frame') return '上一镜尾帧，本镜头首帧'
  return String(item.entityName || item.name || '参考资产').replace(/^角色-|^场景-|^道具-/, '').trim()
}

function stripSequencePrompt(value: string) {
  const lines = value.split(/\r?\n/)
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    if (/^\s*连续镜头资产绑定[：:]/.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^\s*资产 ID 只在本段绑定中声明一次/.test(line)) {
      skipping = false
      continue
    }
    if (skipping) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

function formatAsset(asset?: SyncedVolcAsset) {
  const raw = formatSequenceAssetUri(asset).replace(/^Asset:\/\//, '')
  return `@asset://${raw}`
}

function formatSequenceAssetUri(asset?: Partial<Pick<SyncedVolcAsset, 'assetUri' | 'providerAssetId'>> | null): string {
  const raw = String(asset?.assetUri || asset?.providerAssetId || '').trim().replace(/^@+/, '')
  const assetId = raw.replace(/^asset:\/\//i, '')
  if (!assetId) throw new Error('火山资产缺少 asset URI')
  return `Asset://${assetId}`
}

function bindingLabel(item: AssetRef) {
  if (item.role === 'first_frame') return '首帧画面'
  return String(item.entityName || item.name || '参考资产').replace(/^角色-|^场景-|^道具-/, '').trim()
}

function getEpisodeStoryboards(episodeId: number) {
  return db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all().filter(item => !item.deletedAt).sort((a, b) => a.storyboardNumber - b.storyboardNumber)
}

function getStoryboard(id: number) {
  const [row] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  return row
}

function getStoryboardContext(storyboard: Storyboard) {
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all()
  const [drama] = episode ? db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).all() : []
  const promptText = `${storyboard.videoPrompt || ''}\n${storyboard.action || ''}\n${storyboard.description || ''}`
  const locationNames = extractLocationNames(promptText)
  const allScenes = db.select().from(schema.scenes).all()
  const [scene] = storyboard.sceneId
    ? allScenes.filter(item => item.id === storyboard.sceneId)
    : allScenes
      .filter(item => !item.deletedAt
        && (item.episodeId === storyboard.episodeId || item.dramaId === episode?.dramaId)
        && (item.location === String(storyboard.location || '').trim() || locationNames.includes(String(item.location || '').trim())))
      .sort((a, b) => Number(b.id) - Number(a.id))
  const linkedIds = db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboard.id)).all().map(item => item.characterId)
  const roleNames = extractRoleNames(promptText)
  const characters = db.select().from(schema.characters).all()
    .filter(item => !item.deletedAt
      && item.dramaId === (drama?.id || episode?.dramaId)
      && (linkedIds.includes(item.id) || roleNames.includes(String(item.name || '').trim())))
  const props = db.select().from(schema.props).all().filter(prop => prop.dramaId === (drama?.id || episode?.dramaId) && !prop.deletedAt && prop.name && promptText.includes(prop.name))
  return { episodeId: episode?.id || storyboard.episodeId, dramaId: drama?.id || episode?.dramaId || 0, scene, characters, props }
}

function getEntityImageUrl(entity: { imageUrl?: string | null; localPath?: string | null }) {
  return String(entity.imageUrl || entity.localPath || '').trim()
}

function extractRoleNames(prompt: string) {
  const names: string[] = []
  const pattern = /<role>\s*([^<]+?)\s*<\/role>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(prompt))) {
    const name = String(match[1] || '').trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

function extractLocationNames(prompt: string) {
  const names: string[] = []
  const pattern = /<location>\s*([^<]+?)\s*<\/location>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(prompt))) {
    const name = String(match[1] || '').trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

function parseReferenceImages(value?: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : []
  } catch { return [] }
}

async function waitForVideoGeneration(id: number, runId: number) {
  for (let i = 0; i < 660; i++) {
    const [run] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all()
    if (!run || run.status === 'cancelled') throw new SequenceCancelledError()
    const record = getVideoGeneration(id)
    if (!record) throw new Error('视频生成记录不存在')
    if (record.status === 'completed') return
    if (record.status === 'failed') throw new Error(record.errorMsg || '谜镜视频生成失败')
    await sleep(5000)
  }
  throw new Error('串行视频生成超时：等待视频任务超过 55 分钟')
}

async function extractTailFrame(videoPathOrUrl: string) {
  let localPath = videoPathOrUrl
  if (/^https?:\/\//i.test(localPath)) localPath = await downloadFile(localPath, 'videos', { timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS })
  const absoluteVideo = getAbsolutePath(localPath)
  if (!fs.existsSync(absoluteVideo)) throw new Error('视频已完成但本地视频文件不存在，无法提取尾帧')
  const outputDir = path.dirname(absoluteVideo).replace(`${path.sep}videos`, `${path.sep}sequence-frames`)
  fs.mkdirSync(outputDir, { recursive: true })
  const output = path.join(outputDir, `tail-${Date.now()}-${Math.random().toString(16).slice(2)}.png`)
  await execFileAsync(FFMPEG_BINARY, ['-y', '-sseof', '-1', '-i', absoluteVideo, '-vf', 'reverse', '-frames:v', '1', '-update', '1', output], { timeout: 90_000 })
  const relative = path.relative(path.dirname(getAbsolutePath('static/')), output).split(path.sep).join('/')
  return { localPath: `static/${relative.replace(/^static\//, '')}` }
}

async function uploadTailFrame(localPath: string, storyboard: Storyboard, sequence: Run, grokOpenAI = false) {
  const { ensurePublicImageUrl } = await import('./volc-asset-sync.js')
  try {
    const result = await ensurePublicImageUrl(
      localPath,
      `镜头${storyboard.storyboardNumber}-尾帧`,
      undefined,
      undefined,
      grokOpenAI ? {
        preferUguu: true,
        validateResult: true,
        allowedProviders: ['uguu-upload', 'eggfans-image-host'],
      } : undefined,
    )
    return result.url
  } catch (error) {
    if (!grokOpenAI) throw error
    // Grok accepts local images after the normalizer converts them to base64.
    // Keep serial generation usable when both public upload fallbacks are down.
    logTaskWarn('VideoSequence', 'grok-tail-public-upload-fallback-to-base64', {
      storyboardId: storyboard.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return localPath
  }
}

function getVideoGeneration(id: number) {
  const [row] = db.select().from(schema.videoGenerations).where(eq(schema.videoGenerations.id, id)).all()
  return row
}

function assertSequenceActive(runId: number) {
  const [run] = db.select().from(schema.videoSequenceRuns).where(eq(schema.videoSequenceRuns.id, runId)).all()
  if (!run || run.status === 'cancelled') throw new SequenceCancelledError()
}

function setRunStatus(runId: number, status: string, extra: Record<string, any> = {}) {
  db.update(schema.videoSequenceRuns).set({ status, updatedAt: now(), ...extra }).where(eq(schema.videoSequenceRuns.id, runId)).run()
}

function markRunFailed(runId: number, message: string, storyboardId?: number) {
  setRunStatus(runId, 'failed', { errorMsg: message, currentStoryboardId: storyboardId || null })
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }

class SequenceCancelledError extends Error {
  constructor() { super('串行任务已停止') }
}
