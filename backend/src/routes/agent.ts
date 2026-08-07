/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { createAgent, getAgentRuntimeConfig, getResolvedAgentModelConfig, validAgentTypes } from '../agents/index.js'
import { buildStoryboardAgentMessage, isGrokTenSecondVideoModel } from '../agents/storyboard-video-rules.js'
import type { StoryboardDurationPolicy } from '../agents/tools/storyboard-tools.js'
import { runMijingPlainAgent, supportsMijingPlainAgent } from '../services/mijing-text-agent.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { db, schema } from '../db/index.js'
import { and, eq, isNull } from 'drizzle-orm'
import type { AIConfig } from '../services/ai.js'
import { resolveExtractionSource, type ExtractionSource } from '../agents/tools/extract-tools.js'
import { isTkOverseasMode } from '../services/overseas-visual.js'

const app = new Hono()

function normalizeToolName(entry: any) {
  return entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.result ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

function normalizePositiveInteger(value: unknown) {
  const parsed = Math.round(Number(value || 0))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizeNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function getAgentConfig(agentType: string) {
  const rows = db.select().from(schema.agentConfigs)
    .where(and(eq(schema.agentConfigs.agentType, agentType), isNull(schema.agentConfigs.deletedAt)))
    .all()
  return rows.find(row => row.isActive) || rows[0] || null
}

export function buildAgentGenerateOptions(agentConfig: any) {
  const agentType = String(agentConfig?.agentType || agentConfig?.agent_type || '').trim()
  const configuredMaxSteps = normalizePositiveInteger(agentConfig?.maxIterations ?? agentConfig?.max_iterations)
  const configuredMaxTokens = normalizePositiveInteger(agentConfig?.maxTokens ?? agentConfig?.max_tokens)
  const temperature = normalizeNumber(agentConfig?.temperature) ?? 0.7

  const minMaxSteps = agentType === 'storyboard_breaker' ? 20 : 10
  const minMaxOutputTokens = agentType === 'storyboard_breaker' ? 12000 : 4096

  return {
    maxSteps: Math.max(configuredMaxSteps || minMaxSteps, minMaxSteps),
    maxOutputTokens: Math.max(configuredMaxTokens || minMaxOutputTokens, minMaxOutputTokens),
    temperature,
  }
}

export function buildAgentGenerateCallOptions(generateOptions: {
  maxSteps: number
  maxOutputTokens: number
  temperature: number
}) {
  return {
    maxSteps: generateOptions.maxSteps,
    // Mastra/AI SDK uses maxTokens. maxOutputTokens is our API-facing name.
    maxTokens: generateOptions.maxOutputTokens,
    temperature: generateOptions.temperature,
  }
}

export function assertRequiredToolCompleted(agentType: string, toolResults: Array<{ toolName: string | null; result?: string | null }>) {
  const requiredByAgent: Record<string, string[]> = {
    script_rewriter: ['save_script'],
    extractor: ['save_dedup_characters', 'save_dedup_scenes'],
    storyboard_breaker: ['save_storyboards'],
  }
  const required = requiredByAgent[agentType] || []
  if (!required.length) return
  const completed = new Set(toolResults.map(result => result.toolName).filter(Boolean))
  const missing = required.filter(toolName => !completed.has(toolName))
  if (!missing.length) return
  const label = agentType === 'script_rewriter' ? '剧本改写' : agentType === 'extractor' ? '角色场景提取' : '分镜拆解'
  throw new Error(`${label}没有真正保存结果（缺少 ${missing.join(', ')}），文本模型可能不支持 Agent 工具调用或输出被截断。`)
}

export function formatAgentProviderError(error: any) {
  const status = Number(error?.statusCode || error?.status || error?.cause?.statusCode || error?.cause?.status || 0)
  const responseBody = String(error?.responseBody || error?.cause?.responseBody || '')
  const responseHeaders = error?.responseHeaders || error?.cause?.responseHeaders || {}
  const retryAfter = String(responseHeaders?.['retry-after'] || responseHeaders?.['Retry-After'] || '').trim()
  const rawMessage = String(error?.message || '').trim()
  const message = rawMessage && rawMessage !== '<none>' ? rawMessage : ''

  if (status === 524 || /error code 524|a timeout occurred|origin web server timed out/i.test(responseBody)) {
    return `文本模型上游响应超时（HTTP 524）：Eggfans 源站在 Cloudflare 等待窗口内没有返回结果。${retryAfter ? `上游建议 ${retryAfter} 秒后重试。` : '请稍后重试或切换可用的文本模型。'}`
  }
  if ([502, 503, 504].includes(status)) {
    return `文本模型上游网关暂时不可用（HTTP ${status}）。${retryAfter ? `上游建议 ${retryAfter} 秒后重试。` : '请稍后重试。'}`
  }
  if (status === 429) return '文本模型上游限流（HTTP 429），请稍后重试。'
  if (message) return message
  if (status) return `文本模型上游请求失败（HTTP ${status}），请稍后重试。`
  return '文本模型请求失败：上游没有返回可识别的错误信息，请检查模型状态后重试。'
}

export function buildMijingTextFallbackConfig(
  rows: Array<typeof schema.aiServiceConfigs.$inferSelect>,
  primaryConfig: AIConfig,
  error: unknown,
): AIConfig | null {
  const message = error instanceof Error ? error.message : String(error || '')
  if (primaryConfig.provider.toLowerCase() !== 'mijing'
    || !/fields not exists/i.test(message)
    || !/platform_model_ratio_source/i.test(message)) return null

  const row = rows
    .filter(candidate => candidate.serviceType === 'text'
      && candidate.provider?.toLowerCase() === 'eggfans'
      && !!String(candidate.apiKey || '').trim())
    .sort((a, b) => Number(b.isActive) - Number(a.isActive)
      || Number(b.priority || 0) - Number(a.priority || 0))[0]
  if (!row) return null

  const models = parseStringArray(row.model)
  if (!models.length) return null
  return {
    id: row.id,
    serviceType: 'text',
    provider: 'eggfans',
    baseUrl: normalizeEggfansTextFallbackBaseUrl(row.baseUrl),
    apiKey: row.apiKey,
    model: models[0],
    endpoint: row.endpoint || null,
    queryEndpoint: row.queryEndpoint || null,
    settings: parseJsonObject(row.settings),
  }
}

export function normalizeEggfansTextFallbackBaseUrl(baseUrl: string) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  return /^https:\/\/api\.eggfans\.com$/i.test(normalized) ? 'https://eggfans.com' : normalized
}

function parseStringArray(value?: string | null) {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed.map(String).map(item => item.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function parseJsonObject(value?: string | null) {
  try {
    const parsed = JSON.parse(String(value || 'null'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeStoryboardDurationPolicy(body: any): StoryboardDurationPolicy | null {
  const raw = body?.storyboard_policy || body?.storyboardPolicy || body?.breakdown_policy || body?.breakdownPolicy || null
  const mode = String(raw?.mode || body?.storyboard_mode || body?.storyboardMode || body?.breakdown_mode || body?.breakdownMode || '').trim()
  if (mode === 'tk_overseas') {
    const shotDuration = normalizePositiveInteger(raw?.shot_duration ?? raw?.shotDuration ?? body?.shot_duration ?? body?.shotDuration)
    const shotDurationMin = normalizePositiveInteger(raw?.shot_duration_min ?? raw?.shotDurationMin ?? body?.shot_duration_min ?? body?.shotDurationMin) || (shotDuration || 4)
    const shotDurationMax = normalizePositiveInteger(raw?.shot_duration_max ?? raw?.shotDurationMax ?? body?.shot_duration_max ?? body?.shotDurationMax) || (shotDuration || 15)
    const minTotalDuration = normalizePositiveInteger(raw?.min_total_duration ?? raw?.minTotalDuration ?? body?.min_total_duration ?? body?.minTotalDuration) || 60
    const maxTotalDuration = normalizePositiveInteger(raw?.max_total_duration ?? raw?.maxTotalDuration ?? body?.max_total_duration ?? body?.maxTotalDuration) || 100
    const minShots = normalizePositiveInteger(raw?.min_shots ?? raw?.minShots ?? body?.min_shots ?? body?.minShots)
    const maxShots = normalizePositiveInteger(raw?.max_shots ?? raw?.maxShots ?? body?.max_shots ?? body?.maxShots)
    return {
      mode,
      shotDuration: shotDuration || null,
      shotDurationMin,
      shotDurationMax,
      minTotalDuration,
      maxTotalDuration,
      minShots,
      maxShots,
    }
  }
  const isGrokTenSecond = isGrokTenSecondVideoModel({
    model: body?.video_model || body?.videoModel,
    provider: body?.video_provider || body?.videoProvider,
    label: body?.video_model_label || body?.videoModelLabel,
  })
  if (mode !== 'grok_3min' && !isGrokTenSecond) return null

  const shotDuration = normalizePositiveInteger(raw?.shot_duration ?? raw?.shotDuration ?? body?.shot_duration ?? body?.shotDuration) || 10
  if (mode !== 'grok_3min') {
    return { mode: 'grok_10s', shotDuration }
  }
  const maxTotalDuration = normalizePositiveInteger(raw?.max_total_duration ?? raw?.maxTotalDuration ?? body?.max_total_duration ?? body?.maxTotalDuration) || 180
  const maxShots = normalizePositiveInteger(raw?.max_shots ?? raw?.maxShots ?? body?.max_shots ?? body?.maxShots) || Math.floor(maxTotalDuration / shotDuration)
  return {
    mode: 'grok_3min',
    shotDuration,
    maxTotalDuration,
    maxShots,
  }
}

function normalizeExtractionSource(body: any): ExtractionSource {
  return resolveExtractionSource(body?.extraction_source || body?.extractionSource)
}

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `Invalid agent type: ${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body
  const [requestEpisode] = episode_id
    ? db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(episode_id))).all()
    : []
  const requestedBreakdownMode = String(
    body.breakdown_mode || body.breakdownMode || body.storyboard_mode || body.storyboardMode || requestEpisode?.breakdownMode || 'standard',
  ).trim() || 'standard'
  const extractionSource = agentType === 'extractor' ? normalizeExtractionSource(body) : undefined
  const storyboardDurationPolicy = agentType === 'storyboard_breaker'
    ? normalizeStoryboardDurationPolicy(body)
    : null
  const agentMessage = agentType === 'storyboard_breaker'
    ? buildStoryboardAgentMessage(message, {
        model: body.video_model || body.videoModel,
        provider: body.video_provider || body.videoProvider,
        label: body.video_model_label || body.videoModelLabel,
      }, storyboardDurationPolicy || {})
    : isTkOverseasMode(requestedBreakdownMode) && ['script_rewriter', 'extractor'].includes(agentType)
      ? `${message}\n\n当前集使用 TK 海外剧模式：角色默认提取为欧美/国际真人影视选角，默认非东亚面孔；场景默认提取为欧美/国际影视美术环境。不得因中文姓名或中文翻译生成东方人或中式场景；剧本明确民族和地点时按剧本执行。`
      : message

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message: agentMessage,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, 'drama_id and episode_id are required')
  }

  if (requestEpisode && requestEpisode.breakdownMode !== requestedBreakdownMode) {
    db.update(schema.episodes)
      .set({ breakdownMode: requestedBreakdownMode, updatedAt: new Date().toISOString() })
      .where(eq(schema.episodes.id, Number(episode_id)))
      .run()
  }

  if (agentType === 'voice_assigner') {
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(episode_id))).all()
    if (!episode?.dubbingEnabled) return badRequest(c, '当前集已关闭配音，请先在制作工作台开启配音')
  }

  const agentConfig = getAgentConfig(agentType)
  const generateOptions = buildAgentGenerateOptions(agentConfig ? { ...agentConfig, agentType } : { agentType })
  const resolvedModel = getResolvedAgentModelConfig(agentType)
  const useMijingPlainAgent = resolvedModel.config.provider.toLowerCase() === 'mijing'
    && supportsMijingPlainAgent(agentType)
  const agent = useMijingPlainAgent
    ? null
    : createAgent(agentType, episode_id, drama_id, {
        storyboardDurationPolicy,
        extractionSource,
        breakdownMode: requestedBreakdownMode,
      })
  if (!agent && !useMijingPlainAgent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent not found')
  }

  const startTime = performance.now()

  try {
    const primaryPlainConfig = { ...resolvedModel.config, model: resolvedModel.modelName }
    const runPlainAgent = (config: AIConfig) => runMijingPlainAgent({
      agentType,
      config,
      episodeId: Number(episode_id),
      dramaId: Number(drama_id),
      message: agentMessage,
      extractionSource,
      storyboardDurationPolicy,
      breakdownMode: requestedBreakdownMode,
      temperature: generateOptions.temperature,
      maxOutputTokens: generateOptions.maxOutputTokens,
    })
    const result = useMijingPlainAgent
      ? await runPlainAgent(primaryPlainConfig).catch(async (error) => {
          const fallbackConfig = buildMijingTextFallbackConfig(
            db.select().from(schema.aiServiceConfigs).all(),
            primaryPlainConfig,
            error,
          )
          if (!fallbackConfig) throw error
          logTaskProgress('Agent', 'mijing-text-fallback', {
            agentType,
            failedProvider: primaryPlainConfig.provider,
            fallbackConfigId: fallbackConfig.id,
            fallbackProvider: fallbackConfig.provider,
            fallbackModel: fallbackConfig.model,
          })
          return runPlainAgent(fallbackConfig)
        })
      : await agent!.generate(
          [{ role: 'user', content: agentMessage }],
          buildAgentGenerateCallOptions(generateOptions),
        )

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)
    assertRequiredToolCompleted(agentType, normalizedToolResults)

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    const formattedError = formatAgentProviderError(err)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: formattedError, upstreamStatus: err?.statusCode || err?.status || undefined })
    console.error(err.stack || err)
    return badRequest(c, formattedError)
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, 'Invalid agent type')
  const agentConfig = getAgentConfig(agentType)
  return success(c, {
    agent_type: agentType,
    valid: true,
    runtime: {
      ...getAgentRuntimeConfig(agentType),
      generateOptions: buildAgentGenerateOptions(agentConfig ? { ...agentConfig, agentType } : { agentType }),
    },
  })
})

export default app
