import { createExtractTools, resolveExtractionSource, type ExtractionSource } from '../agents/tools/extract-tools.js'
import { createScriptTools } from '../agents/tools/script-tools.js'
import { createStoryboardTools } from '../agents/tools/storyboard-tools.js'
import { isGrokDurationPolicy, normalizeStoryboardDuration } from '../agents/tools/storyboard-tools.js'
import type { StoryboardDurationPolicy } from '../agents/tools/storyboard-tools.js'
import { getStoryboardBreakdownModeRule } from '../agents/storyboard-video-rules.js'
import type { AIConfig } from './ai.js'
import { getTextProviderBaseUrl } from './ai.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { buildVisualStyleLock, withVisualStyleLock } from './visual-style.js'
import { buildTkOverseasVisualLock, isTkOverseasMode, withTkOverseasVisualLock } from './overseas-visual.js'

type ToolRecord = {
  toolName: string
  args: Record<string, unknown>
  result: string
}

type MijingAgentResult = {
  text: string
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>
  toolResults: Array<{ toolName: string; result: string }>
}

type MijingChatOptions = {
  temperature?: number
  maxOutputTokens?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  retryDelaysMs?: number[]
}

type MijingAgentInput = {
  agentType: string
  config: AIConfig
  episodeId: number
  dramaId: number
  message: string
  extractionSource?: ExtractionSource
  storyboardDurationPolicy?: StoryboardDurationPolicy | null
  breakdownMode?: string | null
  temperature?: number
  maxOutputTokens?: number
  fetchImpl?: typeof fetch
  retryDelaysMs?: number[]
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const STORYBOARD_AGENT_TIMEOUT_MS = 600_000
const DEFAULT_TEXT_AGENT_TIMEOUT_MS = 240_000

export function supportsMijingPlainAgent(agentType: string) {
  return ['script_rewriter', 'extractor', 'storyboard_breaker'].includes(agentType)
}

export async function runMijingPlainAgent(input: MijingAgentInput): Promise<MijingAgentResult> {
  if (input.agentType === 'script_rewriter') return runScriptRewriter(input)
  if (input.agentType === 'extractor') return runExtractor(input)
  if (input.agentType === 'storyboard_breaker') return runStoryboardBreaker(input)
  throw new Error(`谜镜文本兼容流程暂不支持 ${input.agentType}`)
}

export async function requestMijingPlainChat(
  config: AIConfig,
  system: string,
  user: string,
  options: MijingChatOptions = {},
) {
  const fetchImpl = options.fetchImpl || fetch
  const retryDelays = options.retryDelaysMs || [800, 1800]
  const endpoint = `${getTextProviderBaseUrl(config).replace(/\/+$/, '')}/chat/completions`
  const maxAttempts = retryDelays.length + 1

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: options.temperature ?? 0.4,
          max_tokens: options.maxOutputTokens || 8192,
          stream: false,
        }),
        signal: AbortSignal.timeout(options.timeoutMs || 240_000),
      })
    } catch (error: any) {
      if (attempt < maxAttempts && isRetryableNetworkError(error)) {
        logTaskWarn('MijingText', 'request-retry', { attempt, reason: error?.message || String(error) })
        await wait(retryDelays[attempt - 1])
        continue
      }
      throw new Error(`${textProviderLabel(config)}请求失败：${friendlyNetworkError(error)}`)
    }

    const raw = await response.text()
    const payload = parseJsonSafely(raw)
    if (!response.ok) {
      const message = extractTextProviderError(config, payload, raw, response.status)
      if (attempt < maxAttempts && RETRYABLE_STATUS.has(response.status)) {
        logTaskWarn('MijingText', 'response-retry', { attempt, status: response.status, message })
        await wait(retryDelays[attempt - 1])
        continue
      }
      throw new Error(message)
    }

    const content = normalizeMessageContent(payload?.choices?.[0]?.message?.content)
    if (!content.trim()) {
      if (attempt < maxAttempts) {
        logTaskWarn('MijingText', 'empty-response-retry', { attempt })
        await wait(retryDelays[attempt - 1])
        continue
      }
      throw new Error('谜镜文本模型返回了空内容，请检查模型状态或稍后重试')
    }
    return content.trim()
  }

  throw new Error('谜镜文本请求失败')
}

async function runScriptRewriter(input: MijingAgentInput): Promise<MijingAgentResult> {
  const tools = createScriptTools(input.episodeId)
  const sourceResult = await executeTool(tools.readEpisodeScript, {})
  if (sourceResult?.error) throw new Error(sourceResult.error)
  const source = String(sourceResult?.content || '').trim()
  if (!source) throw new Error('当前集没有可改写的原始内容')

  const output = await requestMijingPlainChat(
    input.config,
    `你是专业短剧编剧。请把用户提供的原始文本改写为可直接制作的格式化剧本。
必须遵守：
- 保留原剧情事件、人物关系和关键对白，不要擅自改变主线。
- 场景头格式：## S编号 | 内景/外景 · 地点 | 时间段。
- 动作描写使用自然段落，对白格式：角色名：（状态/表情）台词。
- 纠正明显的对白归属错误，不要把其他人的台词归给主角。
- 只输出完整剧本正文，不要输出解释、前言、JSON 或 Markdown 代码块。
${isTkOverseasMode(input.breakdownMode) ? buildTkOverseasVisualLock('剧本改写与后续选角美术') : ''}`,
    `${input.message}\n\n【原始内容】\n${source}`,
    requestOptions(input, Math.max(input.maxOutputTokens || 0, 8192)),
  )
  const rewritten = stripCodeFence(output)
  if (rewritten.length < 50) throw new Error('谜镜文本模型返回的剧本过短，未执行保存')
  const saved = await executeTool(tools.saveScript, { content: rewritten })
  return resultFromRecords(rewritten, [
    record('read_episode_script', {}, sourceResult),
    record('save_script', { content_length: rewritten.length }, saved),
  ])
}

async function runExtractor(input: MijingAgentInput): Promise<MijingAgentResult> {
  const extractionSource = resolveExtractionSource(input.extractionSource)
  const tools = createExtractTools(input.episodeId, input.dramaId, {
    source: extractionSource,
    breakdownMode: input.breakdownMode,
  })
  const [scriptResult, characterResult, sceneResult] = await Promise.all([
    executeTool(tools.readScriptForExtraction, {}),
    executeTool(tools.readExistingCharacters, {}),
    executeTool(tools.readExistingScenes, {}),
  ])
  if (scriptResult?.error) throw new Error(scriptResult.error)

  const context = {
    script: scriptResult?.script || '',
    existing_characters: compactCharacters(characterResult?.characters || []),
    existing_scenes: compactScenes(sceneResult?.scenes || []),
  }
  const output = await requestMijingPlainChat(
    input.config,
    `你是短剧制片助理。根据剧本提取当前集真实出现的角色和场景，并与已有数据去重。
只输出一个合法 JSON 对象，不要代码块或解释，格式必须是：
{"characters":[{"name":"","role":"","description":"","appearance":"","personality":""}],"scenes":[{"location":"","time":"","prompt":""}]}
角色按姓名去重；场景按“地点+时间段”去重；不要遗漏有台词或关键动作的角色。
场景 prompt 只能描述无人环境本身，包括空间结构、建筑、家具陈设、天气、光线、色调和氛围；严禁写入任何角色姓名、人物外貌、人物动作、对白或剧情事件，场景资产中不得出现人物。
${isTkOverseasMode(input.breakdownMode) ? buildTkOverseasVisualLock('角色与场景提取、后续资产生成') : ''}`,
    `${input.message}\n\n【提取来源】${extractionSource === 'raw' ? '第一集原始内容（content）' : '格式化剧本（script_content）'}\n\n【上下文 JSON】\n${JSON.stringify(context)}`,
    requestOptions(input, Math.max(input.maxOutputTokens || 0, 8192)),
  )
  const parsed = parseJsonObject(output, '角色场景提取')
  const characters = normalizeExtractedCharacters(parsed.characters)
  const scenes = normalizeExtractedScenes(parsed.scenes)
  const characterSaved = await executeTool(tools.saveDedupCharacters, { characters })
  const sceneSaved = await executeTool(tools.saveDedupScenes, { scenes })
  return resultFromRecords(`已提取 ${characters.length} 个角色、${scenes.length} 个场景`, [
    record('read_script_for_extraction', {}, scriptResult),
    record('read_existing_characters', {}, characterResult),
    record('read_existing_scenes', {}, sceneResult),
    record('save_dedup_characters', { count: characters.length }, characterSaved),
    record('save_dedup_scenes', { count: scenes.length }, sceneSaved),
  ])
}

async function runStoryboardBreaker(input: MijingAgentInput): Promise<MijingAgentResult> {
  const tools = createStoryboardTools(
    input.episodeId,
    input.dramaId,
    input.storyboardDurationPolicy || null,
  )
  const contextResult = await executeTool(tools.readStoryboardContext, {})
  if (contextResult?.error) throw new Error(contextResult.error)
  const context = buildMijingStoryboardContext(contextResult)
  const policy = input.storyboardDurationPolicy
  const tkRule = getStoryboardBreakdownModeRule(policy)
  const durationRule = tkRule
    ? tkRule
    : policy?.mode === 'grok_3min'
    ? `必须生成不超过 ${policy.maxShots || 18} 个镜头，每个镜头 ${policy.shotDuration || 10} 秒，总时长不超过 ${policy.maxTotalDuration || 180} 秒。`
    : isGrokDurationPolicy(policy)
      ? `每个镜头必须固定为 ${policy?.shotDuration || 10} 秒，按剧情完整度生成合适数量的镜头，不得使用浮动时长。`
    : `采用普通短剧紧凑拆解：duration 默认 5；简单动作、反应和环境建立镜头使用 4-5 秒，关键对白或连续动作使用 5-7 秒，普通镜头不得超过 7 秒。
按约 3.5-4 个中文字/秒估算对白时长并预留动作停顿；同一场景、同一连续动作链、同一说话焦点优先合并，只在叙事重点明显变化时切镜。
合并重复情绪、无信息过渡和空泛特写；不要把镜头上限当成目标，不得为了凑数量或时长扩写剧情。`

  const system = `你是资深影视分镜师。服务端已经提供剧本片段、角色和场景，不要调用工具。
只输出一个合法 JSON 对象，不要代码块或解释，根对象必须是 {"storyboards":[...]} 。
每个分镜必须包含：shot_number,title,shot_type,angle,movement,location,time,character_ids,action,dialogue,description,result,atmosphere,image_prompt,video_prompt,bgm_prompt,sound_effect,duration,scene_id。
scene_id 和 character_ids 只能使用上下文中已有的 ID；无匹配场景时 scene_id 用 null；无角色的空镜头 character_ids 用 []。
video_prompt 使用 <location>地点</location>、<role>角色名</role>、<voice>角色名</voice> 标记，用 <n> 分隔时间段。
必须严格执行上下文 visual_style_lock。每个镜头的 description/action/atmosphere/image_prompt/video_prompt 都要有足够的环境、构图、光影、色温、材质、人物视线、姿态和微表情细节。
image_prompt 描述单帧主体位置、前中后景层次、环境物件、主光源方向、明暗关系、色彩基调、镜头景深和材质；video_prompt 描述动作起点、连续动作、微表情/视线变化、镜头运动、环境动态和动作结果。
写实项目必须始终是 photorealistic live-action 真人摄影，严禁输出 3D、CGI、动漫、游戏角色、塑料皮肤或虚拟人风格。
${durationRule}
对白必须按剧本真实说话人归属，不得把其他人的台词错配给主角。
location 必须直接复用上下文 scenes 中的地点名称；只处理当前剧本明确写出的情节，严禁新增剧本外地点、人物、对白、冲突、回忆、转折或悬念结尾。`
  const script = String(context.script || '')
  const contextJson = JSON.stringify({
    episode: context.episode,
    characters: context.characters,
    scenes: context.scenes,
  })
  const chunks = splitScriptForMijing(
    script,
    policy?.mode === 'tk_overseas' ? 900 : script.length > 3000 ? 2400 : 10000,
  )
  const boundedChunkLimits = policy?.mode === 'grok_3min'
    ? distributeStoryboardQuota(Number(policy.maxShots || 18), chunks.length)
    : null
  const perChunkLimits = chunks.map((chunk, index) => boundedChunkLimits
    ? Math.max(1, boundedChunkLimits[index])
    : estimateCompactShotLimit(chunk))
  const perChunkMinimums = chunks.map(() => 0)
  const records: ToolRecord[] = [record('read_storyboard_context', {}, contextResult)]
  const generated: any[] = []

  logTaskProgress('MijingText', 'storyboard-chunk-plan', {
    episodeId: input.episodeId,
    scriptLength: script.length,
    chunks: chunks.length,
    perChunkLimits,
  })

  for (let index = 0; index < chunks.length; index++) {
    const perChunkLimit = perChunkLimits[index]
    const quotaHint = policy?.mode === 'tk_overseas'
      ? '按本段真实叙事节拍拆分，不设固定镜头数量。每镜通常 4-10 秒；仅当连续动作、较长对白或动作结果确实需要时使用 11-15 秒，不要为了凑数量或时长扩写剧情。'
      : perChunkMinimums[index]
      ? `本段建议生成至少 ${perChunkMinimums[index]} 个、最多 ${perChunkLimit} 个镜头；不要因压缩而遗漏本段的场景事件、英文对白或结果。`
      : `本段最多生成 ${perChunkLimit} 个镜头，不要重复其他片段。`
    const chunkUser = `${input.message}\n\n这是剧本拆解的第 ${index + 1}/${chunks.length} 段。只处理下方剧本片段，但要保留片段内的完整因果。${quotaHint}\n\n【角色场景上下文 JSON】\n${contextJson}\n\n【当前剧本片段】\n${chunks[index]}`
    // 分镜字段多且每个镜头包含详细的图像/视频提示词，不能沿用 8192 的旧硬上限。
    const storyboardOutputTokens = Math.max(input.maxOutputTokens || 0, 12000)
    const chunkOutput = await requestMijingPlainChat(
      input.config,
      system,
      chunkUser,
      requestOptions(input, storyboardOutputTokens),
    )
    let parsed: Record<string, any>
    try {
      parsed = parseJsonObject(chunkOutput, `分镜拆解第 ${index + 1} 段`)
    } catch (error: any) {
      // 模型偶发在长 JSON 中漏逗号或输出未闭合，自动用严格格式要求重试一次。
      logTaskWarn('MijingText', 'storyboard-json-retry', {
        chunk: index + 1,
        reason: error?.message || String(error),
      })
      const retryOutput = await requestMijingPlainChat(
        input.config,
        `${system}\n上一次输出格式无效。本次必须只返回可被 JSON.parse 直接解析的 JSON；字符串内的双引号必须转义，不要输出 Markdown 代码块、注释或额外文字。`,
        `${chunkUser}\n\n【格式修复要求】上一次结果无法解析，请完整重新输出本段 JSON，不要省略字段，不要在 JSON 字符串中使用未转义的双引号。`,
        requestOptions(input, storyboardOutputTokens),
      )
      parsed = parseJsonObject(retryOutput, `分镜拆解第 ${index + 1} 段重试`)
    }
    const chunkStoryboards = normalizeStoryboards(
      parsed.storyboards,
      context,
      policy || null,
      policy?.mode === 'grok_3min' ? perChunkLimit : undefined,
    )
    generated.push(...chunkStoryboards)
    records.push(record(`generate_storyboards_chunk_${index + 1}`, { chunk: index + 1 }, { count: chunkStoryboards.length }))
  }

  const storyboards = normalizeStoryboards(generated, context, policy || null)
  const saved = await executeTool(tools.saveStoryboards, { storyboards })
  records.push(record('save_storyboards', { count: storyboards.length }, saved))
  return resultFromRecords(`已生成 ${storyboards.length} 个分镜`, records)
}

function requestOptions(input: MijingAgentInput, maxOutputTokens: number): MijingChatOptions {
  return {
    temperature: input.temperature,
    maxOutputTokens,
    timeoutMs: input.agentType === 'storyboard_breaker'
      ? STORYBOARD_AGENT_TIMEOUT_MS
      : DEFAULT_TEXT_AGENT_TIMEOUT_MS,
    fetchImpl: input.fetchImpl,
    retryDelaysMs: input.retryDelaysMs ?? (input.agentType === 'storyboard_breaker' ? [1200] : undefined),
  }
}

export function getMijingAgentTimeoutMs(agentType: string) {
  return agentType === 'storyboard_breaker'
    ? STORYBOARD_AGENT_TIMEOUT_MS
    : DEFAULT_TEXT_AGENT_TIMEOUT_MS
}

async function executeTool(tool: any, args: Record<string, unknown>) {
  if (!tool?.execute) throw new Error(`本地工具 ${tool?.id || 'unknown'} 不可执行`)
  return tool.execute(args, {} as any)
}

function record(toolName: string, args: Record<string, unknown>, result: unknown): ToolRecord {
  return { toolName, args, result: JSON.stringify(result ?? null) }
}

function resultFromRecords(text: string, records: ToolRecord[]): MijingAgentResult {
  return {
    text,
    toolCalls: records.map(item => ({ toolName: item.toolName, args: item.args })),
    toolResults: records.map(item => ({ toolName: item.toolName, result: item.result })),
  }
}

function compactCharacters(rows: any[]) {
  return rows.map(row => ({
    id: Number(row.id || 0) || undefined,
    name: String(row.name || ''),
    role: String(row.role || ''),
    description: String(row.description || ''),
    appearance: String(row.appearance || ''),
    personality: String(row.personality || ''),
  }))
}

function compactScenes(rows: any[]) {
  return rows.map(row => ({
    id: Number(row.id || 0) || undefined,
    location: String(row.location || ''),
    time: String(row.time || ''),
    prompt: String(row.prompt || ''),
  }))
}

function normalizeExtractedCharacters(value: unknown) {
  if (!Array.isArray(value)) throw new Error('角色场景提取结果缺少 characters 数组')
  return value.slice(0, 80).map((item: any) => ({
    name: String(item?.name || '').trim(),
    role: String(item?.role || '').trim(),
    description: String(item?.description || '').trim(),
    appearance: String(item?.appearance || '').trim(),
    personality: String(item?.personality || '').trim(),
  })).filter(item => item.name)
}

function normalizeExtractedScenes(value: unknown) {
  if (!Array.isArray(value)) throw new Error('角色场景提取结果缺少 scenes 数组')
  return value.slice(0, 80).map((item: any) => ({
    location: String(item?.location || '').trim(),
    time: String(item?.time || '').trim(),
    prompt: String(item?.prompt || item?.location || '').trim(),
  })).filter(item => item.location)
}

export function normalizeStoryboards(value: unknown, context: any, policy: StoryboardDurationPolicy | null, maxShotsOverride?: number) {
  if (!Array.isArray(value) || !value.length) throw new Error('分镜拆解结果没有 storyboards 数组')
  const validCharacterIds = new Set((context.characters || []).map((item: any) => Number(item.id)).filter(Boolean))
  const validSceneIds = new Set((context.scenes || []).map((item: any) => Number(item.id)).filter(Boolean))
  const maxShots = maxShotsOverride || (policy?.mode === 'grok_3min' ? Number(policy.maxShots || 18) : 120)
  if (value.length > maxShots) {
    throw new Error(`分镜数量超过当前模式上限 ${maxShots}，模型返回了 ${value.length} 个`)
  }

  const groundedItems = value
    .map((item: any) => ({ item, scene: resolveStoryboardScene(item, context) }))
    .filter(({ item, scene }) => isStoryboardGrounded(item, scene, context))
  if (!groundedItems.length) throw new Error('分镜拆解结果均未匹配当前剧本和场景，未执行保存')

  return groundedItems.map(({ item, scene }, index: number) => {
    const requestedSceneId = Number(scene?.id || item?.scene_id || 0)
    const duration = normalizeStoryboardDuration(item?.duration, policy)
    return {
      shot_number: index + 1,
      title: textField(item?.title, `镜头${index + 1}`),
      shot_type: textField(item?.shot_type, '中景'),
      angle: textField(item?.angle, '平视'),
      movement: textField(item?.movement, '固定'),
      location: textField(scene?.location || item?.location),
      time: textField(scene?.time || item?.time),
      character_ids: Array.isArray(item?.character_ids)
        ? [...new Set(item.character_ids.map(Number).filter((id: number) => validCharacterIds.has(id)))]
        : [],
      action: textField(item?.action),
      dialogue: textField(item?.dialogue),
      description: textField(item?.description),
      result: textField(item?.result),
      atmosphere: textField(item?.atmosphere),
      image_prompt: withTkOverseasVisualLock(
        withVisualStyleLock(textField(item?.image_prompt), context.visual_style, '分镜静态画面'),
        policy?.mode,
        '分镜静态画面',
      ),
      video_prompt: withTkOverseasVisualLock(
        withVisualStyleLock(textField(item?.video_prompt), context.visual_style, '分镜动态画面'),
        policy?.mode,
        '分镜动态画面',
      ),
      bgm_prompt: textField(item?.bgm_prompt),
      sound_effect: textField(item?.sound_effect),
      duration,
      scene_id: validSceneIds.has(requestedSceneId) ? requestedSceneId : null,
    }
  })
}

export function buildMijingStoryboardContext(contextResult: any) {
  const visualStyle = String(contextResult?.episode?.visual_style || contextResult?.visual_style || 'realistic')
  return {
    episode: contextResult?.episode,
    script: String(contextResult?.script || ''),
    characters: compactCharacters(contextResult?.characters || []),
    scenes: compactScenes(contextResult?.scenes || []),
    visual_style: visualStyle,
    visual_style_lock: buildVisualStyleLock(visualStyle, '整部短剧'),
  }
}

export function estimateCompactShotLimit(script: string) {
  const length = String(script || '').replace(/\s/g, '').length
  return Math.min(10, Math.max(3, Math.ceil(length / 360)))
}

export function distributeStoryboardQuota(total: number, buckets: number) {
  const safeTotal = Math.max(0, Math.round(total))
  const safeBuckets = Math.max(1, Math.round(buckets))
  const base = Math.floor(safeTotal / safeBuckets)
  const remainder = safeTotal % safeBuckets
  return Array.from({ length: safeBuckets }, (_, index) => base + (index < remainder ? 1 : 0))
}

function resolveStoryboardScene(item: any, context: any) {
  const scenes = Array.isArray(context?.scenes) ? context.scenes : []
  const requestedSceneId = Number(item?.scene_id || 0)
  const byId = scenes.find((scene: any) => Number(scene?.id || 0) === requestedSceneId)
  const requestedLocation = normalizeGroundingText(item?.location)
  if (byId && (!requestedLocation || sceneLocationMatches(requestedLocation, byId?.location))) return byId
  if (!requestedLocation) return null
  return scenes.find((scene: any) => sceneLocationMatches(requestedLocation, scene?.location)) || null
}

function sceneLocationMatches(normalizedLocation: string, sceneLocationValue: unknown) {
  const sceneLocation = normalizeGroundingText(sceneLocationValue)
  return !!sceneLocation && (
    normalizedLocation === sceneLocation
    || normalizedLocation.includes(sceneLocation)
    || sceneLocation.includes(normalizedLocation)
  )
}

function isStoryboardGrounded(item: any, scene: any, context: any) {
  if (scene) return true
  const location = normalizeGroundingText(item?.location)
  if (!location) return true
  if (Array.isArray(context?.scenes) && context.scenes.length) return false
  return normalizeGroundingText(context?.script).includes(location)
}

function normalizeGroundingText(value: unknown) {
  return String(value || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

export function splitScriptForMijing(script: string, maxChars: number) {
  const source = String(script || '').trim()
  if (!source) return []
  if (source.length <= maxChars) return [source]

  const chunks: string[] = []
  let remaining = source
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars)
    const candidates = [
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
    ]
    const boundary = Math.max(...candidates)
    const cut = boundary > Math.floor(maxChars * 0.55) ? boundary + 1 : maxChars
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks.filter(Boolean)
}

function parseJsonObject(content: string, label: string): Record<string, any> {
  const cleaned = stripCodeFence(content).trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`${label}模型返回不是有效 JSON`)
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root is not object')
    return parsed
  } catch (error: any) {
    throw new Error(`${label}模型返回的 JSON 无法解析：${error?.message || '格式错误'}`)
  }
}

function stripCodeFence(content: string) {
  const trimmed = content.trim()
  const match = trimmed.match(/^```(?:json|markdown|md|text)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : trimmed
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part: any) => typeof part === 'string' ? part : String(part?.text || '')).join('')
}

function extractTextProviderError(config: AIConfig, payload: any, raw: string, status: number) {
  const detail = String(payload?.error?.message || payload?.message || raw || '').trim()
  const label = textProviderLabel(config)
  if (detail.includes('负载已饱和')) return `${label}上游当前负载已饱和（HTTP ${status}），已自动重试但仍未恢复`
  if (status === 502 && /bad gateway|nginx/i.test(detail)) {
    return `${label}上游生成超时或网关暂时不可用（HTTP 502），已自动重试但仍未恢复`
  }
  if (/fields not exists.*platform_model_ratio_source/i.test(detail)) {
    return `${label}上游接口版本不兼容（HTTP ${status}：platform_model_ratio_source 字段不存在），请在谜镜平台切换可用文本模型或更新接口后重试`
  }
  return `${label}接口返回 HTTP ${status}${detail ? `：${detail}` : ''}`
}

function textProviderLabel(config: AIConfig) {
  return config.provider.toLowerCase() === 'mijing' ? '谜镜文本' : `${config.provider} 文本`
}

function parseJsonSafely(raw: string): any {
  try { return JSON.parse(raw) } catch { return null }
}

function isRetryableNetworkError(error: any) {
  const name = String(error?.name || '')
  const message = String(error?.message || '')
  return name === 'TimeoutError' || name === 'AbortError' || /timeout|fetch failed|socket|network/i.test(message)
}

function friendlyNetworkError(error: any) {
  const name = String(error?.name || '')
  if (name === 'TimeoutError' || name === 'AbortError') return '请求超时'
  return error?.message || String(error)
}

function textField(value: unknown, fallback = '') {
  const text = String(value || '').trim()
  return text || fallback
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
