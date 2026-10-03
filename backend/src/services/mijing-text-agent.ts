import { createExtractTools, resolveExtractionSource, type ExtractionSource } from '../agents/tools/extract-tools.js'
import { createScriptTools } from '../agents/tools/script-tools.js'
import { createStoryboardTools } from '../agents/tools/storyboard-tools.js'
import { isGrokDurationPolicy, normalizeStoryboardDuration, resolveStoryboardCharacterIds } from '../agents/tools/storyboard-tools.js'
import type { StoryboardDurationPolicy } from '../agents/tools/storyboard-tools.js'
import { getStoryboardBreakdownModeRule } from '../agents/storyboard-video-rules.js'
import type { AIConfig } from './ai.js'
import { getTextProviderBaseUrl, getTextProviderStreamIdleTimeoutMs } from './ai.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { fetchProvider } from '../utils/provider-fetch.js'
import { buildVisualStyleLock, withVisualStyleLock } from './visual-style.js'
import { buildTkEnglishDialogueLock, buildTkOverseasVisualLock, isTkOverseasMode, withTkOverseasVisualLock } from './overseas-visual.js'
import { assetAliasesForPrompt, assetBindingTerms, parseAssetAliases } from './asset-aliases.js'

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
  streamIdleTimeoutMs?: number
  fetchImpl?: typeof fetch
  retryDelaysMs?: number[]
  /** Internal compatibility switch for gateways that reject stream=true. */
  forceJson?: boolean
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
const TEXT_CONNECT_TIMEOUT_MS = 30_000

export function supportsMijingPlainAgent(agentType: string) {
  return ['script_rewriter', 'extractor', 'storyboard_breaker'].includes(agentType)
}

export function supportsPlainTextAgentProvider(provider: string, agentType: string) {
  return ['mijing', 'eggfans'].includes(String(provider || '').trim().toLowerCase())
    && supportsMijingPlainAgent(agentType)
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
  const fetchImpl = options.fetchImpl || fetchProvider
  const retryDelays = options.retryDelaysMs || [800, 1800]
  const endpoint = `${getTextProviderBaseUrl(config).replace(/\/+$/, '')}/chat/completions`
  const maxAttempts = retryDelays.length + 1
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs || getTextProviderStreamIdleTimeoutMs(config)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    let response: Response
    try {
      response = await fetchWithConnectTimeout(fetchImpl, endpoint, {
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
          stream: options.forceJson !== true,
        }),
        signal: controller.signal,
      }, controller, options.forceJson === true
        ? Math.max(TEXT_CONNECT_TIMEOUT_MS, options.timeoutMs || STORYBOARD_AGENT_TIMEOUT_MS)
        : TEXT_CONNECT_TIMEOUT_MS)
    } catch (error: any) {
      if (attempt < maxAttempts && isRetryableNetworkError(error)) {
        logTaskWarn('MijingText', 'request-retry', { attempt, reason: error?.message || String(error) })
        await wait(retryDelays[attempt - 1])
        continue
      }
      throw new Error(`${textProviderLabel(config)}请求失败：${friendlyNetworkError(error)}`)
    }

    if (!response.ok) {
      const raw = await response.text()
      if (options.forceJson !== true && isMijingStreamUnsupportedError(response.status, raw)) {
        logTaskWarn('MijingText', 'stream-compat-fallback', { status: response.status })
        return requestMijingPlainChat(config, system, user, {
          ...options,
          forceJson: true,
          retryDelaysMs: options.retryDelaysMs || [],
        })
      }
      const payload = parseJsonSafely(raw)
      const message = extractTextProviderError(config, payload, raw, response.status)
      if (attempt < maxAttempts && RETRYABLE_STATUS.has(response.status)) {
        logTaskWarn('MijingText', 'response-retry', { attempt, status: response.status, message })
        await wait(retryDelays[attempt - 1])
        continue
      }
      throw new Error(message)
    }

    let content: string
    try {
      content = await readMijingSseContent(response, controller, streamIdleTimeoutMs)
    } catch (error: any) {
      if (attempt < maxAttempts && isRetryableNetworkError(error)) {
        logTaskWarn('MijingText', 'stream-retry', { attempt, reason: error?.message || String(error) })
        await wait(retryDelays[attempt - 1])
        continue
      }
      throw new Error(`${textProviderLabel(config)}请求失败：${friendlyNetworkError(error)}`)
    }
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

  const tkDialogueLock = isTkOverseasMode(input.breakdownMode)
    ? buildTkEnglishDialogueLock()
    : ''
  const sourceForPrompt = [tkDialogueLock, source].filter(Boolean).join('\n\n')
  const output = await requestMijingPlainChat(
    input.config,
    `你是专业短剧编剧。请把用户提供的原始文本改写为可直接制作的格式化剧本。
必须遵守：
- 保留原剧情事件、人物关系和关键对白，不要擅自改变主线。
- 场景头格式：## S编号 | 内景/外景 · 地点 | 时间段。
- 动作描写使用自然段落，对白格式：角色名：（状态/表情）台词。
- 纠正明显的对白归属错误，不要把其他人的台词归给主角。
- 只输出完整剧本正文，不要输出解释、前言、JSON 或 Markdown 代码块。
${[tkDialogueLock, isTkOverseasMode(input.breakdownMode) ? buildTkOverseasVisualLock('剧本改写与后续选角美术') : ''].filter(Boolean).join('\n')}`,
    `${input.message}\n\n【原始内容】\n${sourceForPrompt}`,
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
  const [scriptResult, characterResult, sceneResult, propResult] = await Promise.all([
    executeTool(tools.readScriptForExtraction, {}),
    executeTool(tools.readExistingCharacters, {}),
    executeTool(tools.readExistingScenes, {}),
    executeTool(tools.readExistingProps, {}),
  ])
  if (scriptResult?.error) throw new Error(scriptResult.error)

  const context = {
    script: scriptResult?.script || '',
    existing_characters: compactCharacters(characterResult?.characters || []),
    existing_scenes: compactScenes(sceneResult?.scenes || []),
    existing_props: (propResult?.props || []).map((row: any) => ({ id: row.id, name: row.name, aliases: assetAliasesForPrompt(row), type: row.type, description: row.description, prompt: row.prompt })),
  }
  const output = await requestMijingPlainChat(
    input.config,
    `你是短剧制片助理。根据剧本提取当前集真实出现的角色、场景和道具，并与已有数据去重。
只输出一个合法 JSON 对象，不要代码块或解释，格式必须是：
{"characters":[{"name":"","aliases":[],"english_name":"","role":"","description":"","appearance":"","personality":""}],"scenes":[{"location":"","aliases":[],"english_name":"","time":"","prompt":""}],"props":[{"name":"","aliases":[],"english_name":"","type":"","description":"","prompt":"","mention_count":2}]}
角色按姓名去重；场景按“地点+时间段”去重；道具只有在当前剧本中明确出现至少两次时才提取，mention_count 必须为实际出现次数；不要遗漏有台词或关键动作的角色。每个角色、场景和道具都要同时输出 aliases 数组和 english_name（若剧本含英文或后续可能使用英文拆解，填写稳定英文名称及常见拼写）；name 保持资产池标准显示名，aliases 只做中英文匹配，不要为同一资产创建多个记录。
场景 prompt 只能描述无人环境本身，包括空间结构、建筑、家具陈设、天气、光线、色调和氛围；严禁写入任何角色姓名、人物外貌、人物动作、对白或剧情事件，场景资产中不得出现人物。
${isTkOverseasMode(input.breakdownMode) ? buildTkOverseasVisualLock('角色与场景提取、后续资产生成') : ''}`,
    `${input.message}\n\n【提取来源】${extractionSource === 'raw' ? '第一集原始内容（content）' : '格式化剧本（script_content）'}\n\n【上下文 JSON】\n${JSON.stringify(context)}`,
    requestOptions(input, Math.max(input.maxOutputTokens || 0, 8192)),
  )
  const parsed = await parseJsonObjectWithRepair(output, '角色场景道具提取', () => requestMijingPlainChat(
    input.config,
    `你是短剧制片助理。上一次响应格式错误；请重新分析给定的剧本和上下文，只输出指定结构的完整 JSON 对象，不要解释、拒答、Markdown 或代码围栏。
输出格式：{characters:[],scenes:[],props:[]}
characters 项字段：name, aliases, english_name, role, description, appearance, personality。
scenes 项字段：location, aliases, english_name, time, prompt。
props 项字段：name, aliases, english_name, type, description, prompt, mention_count。
角色按姓名去重；场景按地点和时间段去重；道具仅在剧本中明确出现至少两次时提取。场景 prompt 只能描述无人环境。${isTkOverseasMode(input.breakdownMode) ? `\n${buildTkOverseasVisualLock('角色与场景提取、后续资产生成')}` : ''}`,
    `${input.message}\n\n【提取来源】${extractionSource === 'raw' ? '第一集原始内容（content）' : '格式化剧本（script_content）'}\n\n【上下文 JSON】\n${JSON.stringify(context)}\n\n请直接返回完整 JSON。`,
    { ...requestOptions(input, Math.max(input.maxOutputTokens || 0, 8192)), forceJson: true },
  ))
  const characters = normalizeExtractedCharacters(parsed.characters)
  const scenes = normalizeExtractedScenes(parsed.scenes)
  const props = normalizeExtractedProps(parsed.props)
  const characterSaved = await executeTool(tools.saveDedupCharacters, { characters })
  const sceneSaved = await executeTool(tools.saveDedupScenes, { scenes })
  const propSaved = await executeTool(tools.saveDedupProps, { props })
  return resultFromRecords(`已提取 ${characters.length} 个角色、${scenes.length} 个场景、${props.length} 个道具`, [
    record('read_script_for_extraction', {}, scriptResult),
    record('read_existing_characters', {}, characterResult),
    record('read_existing_scenes', {}, sceneResult),
    record('save_dedup_characters', { count: characters.length }, characterSaved),
    record('save_dedup_scenes', { count: scenes.length }, sceneSaved),
    record('read_existing_props', {}, propResult),
    record('save_dedup_props', { count: props.length }, propSaved),
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
    : policy?.mode === 'full'
    ? `采用完整拆解模式：整集只做一次全局规划，必须完整保留 original_script 中的所有剧情事件、动作结果、人物关系、场景、道具和对白原文，不得摘要、删减、改写、重复或新增剧情。镜头数量按真实叙事节拍决定，不设少量镜头目标；对白过长时只在自然语义、动作结果或场景边界切镜，绝不截断对白。`
    : policy?.mode === 'grok_3min'
    ? `必须生成不超过 ${policy.maxShots || 18} 个镜头，每个镜头 ${policy.shotDuration || 10} 秒，总时长不超过 ${policy.maxTotalDuration || 180} 秒。`
    : isGrokDurationPolicy(policy)
      ? `每个镜头必须固定为 ${policy?.shotDuration || 10} 秒，按剧情完整度生成合适数量的镜头，不得使用浮动时长。`
    : `采用普通短剧紧凑拆解：duration 默认 5；简单动作、反应和环境建立镜头使用 4-5 秒，关键对白或连续动作使用 5-7 秒，普通镜头不得超过 7 秒。
按约 3.5-4 个中文字/秒估算对白时长并预留动作停顿；同一场景、同一连续动作链、同一说话焦点优先合并，只在叙事重点明显变化时切镜。
合并重复情绪、无信息过渡和空泛特写；不要把镜头上限当成目标，不得为了凑数量或时长扩写剧情。`

  const speakerContract = buildSpeakerContract(context.characters)
  const miniMaxSystemRule = policy?.mode === 'minimax_local_8s'
    ? `本地 MiniMax 8-10 秒模式的资产和摄影硬约束：资产包括角色、场景、道具和手动参考图。镜头1最多 9 张资产；镜头2及以后最多 8 张剧情资产，必须为自动注入的上一镜尾帧预留 1 个参考位，串行请求总参考数最多 9 张。输出前逐项去重，同一资产别名/重复图片只计 1 张，不得拆分名称或重复绑定绕过上限。
本地 MiniMax 8-10 秒模式每个镜头必须包含 2-3 个按时间顺序连续的摄影阶段，并在 video_prompt 中明确每阶段的时间、景别、机位、运镜、焦点和动作变化；阶段之间是同一动作链的连续运镜，不是静止摆拍或幻灯片跳切。对白必须明确语气、情绪强度、语速、停顿、重音、呼吸及听者反应，中文约 4-6 字/秒、英文约 2.8-3.5 词/秒，禁止无理由慢速拖字、只动嘴或全程同表情。`
    : ''
  const system = `你是资深影视分镜师。服务端已经提供剧本片段、角色和场景，不要调用工具。
只输出一个合法 JSON 对象，不要代码块或解释，根对象必须是 {"storyboards":[...]} 。
每个分镜必须包含：shot_number,title,shot_type,angle,movement,location,time,character_ids,action,dialogue,description,result,atmosphere,image_prompt,video_prompt,bgm_prompt,sound_effect,duration,scene_id。
scene_id 和 character_ids 只能使用上下文中已有的 ID；无匹配场景时 scene_id 用 null；无角色的空镜头 character_ids 用 []。
video_prompt 使用 <location>地点</location>、<role>角色名</role>、<voice>角色名</voice> 标记，用 <n> 分隔时间段。
必须严格执行上下文 visual_style_lock。每个镜头的 description/action/atmosphere/image_prompt/video_prompt 都要有足够的环境、构图、光影、色温、材质、人物视线、姿态和微表情细节。
image_prompt 描述单帧主体位置、前中后景层次、环境物件、主光源方向、明暗关系、色彩基调、镜头景深和材质；video_prompt 描述动作起点、连续动作、微表情/视线变化、镜头运动、环境动态和动作结果。
 写实项目必须始终是 photorealistic live-action 真人摄影，严禁输出 3D、CGI、动漫、游戏角色、塑料皮肤或虚拟人风格。
剧本事实锁定：上下文中的 original_script 是唯一事实来源，storyboard_script 只能用于场景头和排版参考。分镜必须完整覆盖 original_script 的事件、对白、说话人、人物关系、环境和事件顺序；不得翻译、改写、摘要或用新剧情填充镜头数量；有冲突时以 original_script 原文为准。
原剧本来自用户最初提交的 content；不要把 script_content 中的格式化文字或意译当成新的事实。对白必须逐字保留，按原文顺序分配给真实说话人；英文原文保留原大小写和标点，紧随其后的中文括号仅作翻译提示，不进入实际发声对白。
上下文中的 source_dialogue_order 是从 original_script 提取的按原文顺序对白台账；index、speaker 和 line 是稳定校对锚点。每一条台账对白必须按顺序分配给同一 speaker 一次，不能跳过、调换、合并或把 line 交给其他角色；若台词后紧跟动作文字，只把实际说出的句子写入 dialogue，动作留在 action/description。
dialogue 字段是每个镜头实际发声台词的唯一来源。video_prompt、action、description、result 和摄影/表演说明不得逐字复制完整 dialogue；如需指示发声，只写“按 dialogue 字段原文说出一次”，并补充语气、语速、停顿、重音、呼吸、口型及听者反应，禁止同一句台词在同一镜头中重复朗读。
表演与口型：video_prompt 必须写清“谁在说话 -> 谁在听 -> 双方屏幕方位和视线落点”。说话者的眼睛、鼻尖、下颌和胸口朝向听者而非镜头，嘴唇开合、停顿、吞咽、呼吸和语速与台词节奏同步；非说话者要看向说话者并有视线转移、眨眼、呼吸、重心或手部听觉反应。多人对白使用双人、过肩或反打并保持180度轴线；只有原剧本明确对镜头/独白时才允许直视镜头。每个情绪都要写起点->变化->落点（眉眼、眼睑、瞳孔、嘴角、下颌），禁止只动嘴、全程同一表情、木偶站立或无理由夸张表演。
景别和运镜必须服务叙事且有变化：建立空间用远景/全景，中段关系和动作用中景/双人中景/过肩，情绪转折用近景，关键表情/眼神/道具状态用特写或大特写，必要时用细节插入；相邻镜头不得连续使用相同景别+固定机位，除非原文明确要求静止。movement 必须明确推轨/拉轨/跟拍/横摇/纵摇/环绕/升降/手持微晃/焦点转移等至少一种具体运动，并写清起点、方向、速度、焦点变化和最终落点，不得只填“固定/镜头移动”。不得为制造镜头变化新增剧情，只改变摄影表达。
优先构成专业覆盖：每个场景至少包含一个建立镜头；每个关键对白段至少包含主镜头、反应近景或过肩切换；每个关键动作/道具结果至少包含一个特写或细节镜头。镜头总数按原剧情需要决定，不以凑数为目的。
${miniMaxSystemRule}
${durationRule}
  对白必须按剧本真实说话人归属，不得把其他人的台词错配给主角。
  ${speakerContract}
  对话字段输出规则：dialogue 每一行必须使用“原剧本中的标准角色名：原文台词”格式；说话人前缀和台词正文都必须逐字来自 original_script，不能用“她/他/父亲/女儿/顾客”等关系称呼代替标准角色名。若同一句台词在原剧本中由不同角色分别说出，必须按各自说话人分别保留，不能合并去重。禁止在 dialogue 中写旁白式改写、剧情摘要、镜头说明或模型自行补写的对白。
角色绑定必须严格使用上下文中的精确角色名称或其 aliases/english_name，并填写对应 character_ids；video_prompt 中每个 <role> 标签必须对应当前画面实际出场的角色资产。关系描述（如某人的父亲、女儿、老板、同事）只能保留为剧情关系，绝不能当作角色名、别名或资产身份。若 <role> 标签与 character_ids 不一致，先修正绑定再保存，禁止继续生成。
location 必须直接复用上下文 scenes 中的地点 name 或其 aliases/english_name；道具也只能引用上下文 props 中的 name 或 aliases/english_name。只处理当前剧本明确写出的情节，严禁新增剧本外地点、人物、对白、冲突、回忆、转折或悬念结尾。`
  const script = String(context.script || '')
  const contextJson = JSON.stringify({
    episode: context.episode,
    original_script: context.original_script || context.script,
    storyboard_script: context.storyboard_script || context.script,
    source_dialogue_order: buildSourceDialogueContract(
      context.original_script || context.script,
      context.characters || [],
    ),
    characters: context.characters,
    scenes: context.scenes,
    props: context.props || [],
  })
  // TK 海外剧必须让模型同时看到整集剧本。按 900 字切块会切断同一场景的
  // 多人对白和动作因果，模型只能把每个片段当成独立小故事，最终产生碎片化镜头。
  // 其他模式仍保留分块，避免超长普通剧本超出上游上下文窗口。
  const chunks = buildStoryboardScriptChunks(script, policy)
  const boundedChunkLimits = policy?.mode === 'grok_3min'
    ? distributeStoryboardQuota(Number(policy.maxShots || 18), chunks.length)
    : null
  const perChunkLimits = chunks.map((chunk, index) => boundedChunkLimits
    ? Math.max(1, boundedChunkLimits[index])
    : resolveStoryboardChunkLimit(chunk, policy))
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
      ? '这是整集剧本的全局拆解，不是局部片段。先建立整场主画面和人物走位，再按完整叙事节拍拆分；单一场景短段落以 3-5 镜为软目标，目标总时长不少于 60 秒时至少 4 镜，本例型连续对话优先 4-5 镜。多人连续对白必须保留在同一交流单元中，不要按说话人逐句切镜。每镜完整使用 4-15 秒范围：英文对白按约 2.3-2.6 词/秒估时并预留 2-4 秒动作和停顿，累计到约 12-15 秒后才在自然语义或动作结果边界切镜。'
      : policy?.mode === 'minimax_local_8s'
        ? '这是当前集完整剧本的全局连续性拆解。按实际剧情长度生成需要的镜头数量，最多120镜，不得为减少镜头而遗漏剧情；每镜根据叙事节奏使用8、9或10秒，简单节拍优先8秒，连续动作或对白密集时使用9-10秒，不得截断对白或关键动作；先规划整集首尾帧状态链，再逐镜输出。'
        : policy?.mode === 'full'
          ? '这是当前集完整剧本的全局拆解。按原剧本真实叙事节拍生成完整镜头序列，不得为了缩短输出而省略中后段剧情、对白或场景；所有镜头编号必须连续。'
      : perChunkMinimums[index]
      ? `本段建议生成至少 ${perChunkMinimums[index]} 个、最多 ${perChunkLimit} 个镜头；不要因压缩而遗漏本段的场景事件、英文对白或结果。`
      : `本段最多生成 ${perChunkLimit} 个镜头，不要重复其他片段。`
    const wholeEpisodeMode = policy?.mode === 'tk_overseas' || policy?.mode === 'minimax_local_8s' || policy?.mode === 'full'
    const chunkUser = `${input.message}\n\n${wholeEpisodeMode
      ? '这是当前集完整剧本，请先从全局理解整场空间、人物关系、对白顺序和结尾状态，再输出连续分镜。不要把每句对白或每次说话人切换单独拆镜。'
      : `这是剧本拆解的第 ${index + 1}/${chunks.length} 段。只处理下方剧本片段，但要保留片段内的完整因果。`} ${quotaHint}\n\n【角色场景上下文 JSON】\n${contextJson}\n\n【当前剧本${wholeEpisodeMode ? '（全集）' : '片段'}】\n${chunks[index]}`
    // A local MiniMax episode is intentionally generated in one global pass,
    // so its output is much larger than the old 12k-token default.  Chinese
    // descriptions consume more output tokens than English descriptions and
    // were previously truncated into a short, but valid, JSON array.
    const storyboardOutputTokens = getStoryboardOutputTokenBudget(
      input.maxOutputTokens,
      script,
      policy,
    )
    let parsed: Record<string, any> | null = null
    let chunkStoryboards: any[] = []
    let lastQualityError: Error | null = null
    const maxStoryboardAttempts = policy?.mode === 'minimax_local_8s' || policy?.mode === 'full' ? 4 : 2
    for (let attempt = 0; attempt < maxStoryboardAttempts; attempt++) {
      const attemptSystem = attempt === 0
        ? system
        : `${system}\n${attempt === 1
          ? '上一次分镜结果不完整或 JSON 被截断。本次必须重新输出当前集的完整 storyboards 数组，不能只返回前几个镜头；保持字段精确但内容紧凑，确保 JSON 在最后一个镜头后闭合。'
          : '再次强调：上一次只覆盖了部分剧情。本次必须覆盖原剧本全部场景、事件和对白，并一次性返回完整且可解析的 storyboards 数组；不要省略中后段镜头。'}`
      const attemptUser = attempt === 0
        ? chunkUser
        : `${chunkUser}\n\n【完整性修复】${lastQualityError?.message || '上一次结果未通过完整性校验'}。请从头完整输出，不要摘要、截断或只返回前几个镜头；所有镜头编号必须连续。`
      let output = ''
      const compactRetryInstruction = attempt >= 3
        ? '\n\nReturn one compact valid JSON object only. Keep every required storyboard and dialogue, but shorten descriptions and remove all optional prose. Ensure every array item is separated by a comma and all braces and brackets are closed.'
        : ''
      try {
        output = await requestMijingPlainChat(
          input.config,
          attemptSystem,
          `${attemptUser}${compactRetryInstruction}`,
          requestOptions(input, storyboardOutputTokens),
        )
        parsed = parseJsonObject(output, `分镜拆解第 ${index + 1} 段${attempt ? '重试' : ''}`)
        chunkStoryboards = normalizeStoryboards(
          parsed.storyboards,
          context,
          policy || null,
          policy?.mode === 'grok_3min' ? perChunkLimit : undefined,
        )
        if (policy?.mode === 'minimax_local_8s' || policy?.mode === 'full') {
          const completenessContext = wholeEpisodeMode
            ? context
            : { ...context, script: chunks[index], original_script: chunks[index] }
          const completeness = validateStoryboardCompleteness(chunkStoryboards, completenessContext, policy)
          if (!completeness.valid) {
            lastQualityError = new Error(completeness.reasons.join('；'))
            logTaskWarn('MijingText', 'storyboard-incomplete-retry', {
              chunk: index + 1,
              attempt: attempt + 1,
              count: chunkStoryboards.length,
              expectedMinimum: completeness.minimumCount,
              reasons: completeness.reasons,
            })
            continue
          }
        }
        break
      } catch (error: any) {
        lastQualityError = error instanceof Error ? error : new Error(String(error))
        if (attempt + 1 >= maxStoryboardAttempts) throw lastQualityError
        logTaskWarn('MijingText', 'storyboard-json-retry', {
          chunk: index + 1,
          attempt: attempt + 1,
          reason: lastQualityError.message,
        })
      }
    }
    if (lastQualityError && !chunkStoryboards.length) throw lastQualityError
    if (policy?.mode === 'minimax_local_8s' || policy?.mode === 'full') {
      const finalCompletenessContext = wholeEpisodeMode
        ? context
        : { ...context, script: chunks[index], original_script: chunks[index] }
      const finalCompleteness = validateStoryboardCompleteness(chunkStoryboards, finalCompletenessContext, policy)
      if (!finalCompleteness.valid) {
        const repaired = repairMissingStoryboardDialogue(chunkStoryboards, finalCompletenessContext, policy)
        if (repaired) {
          chunkStoryboards = repaired
        } else {
          if (policy?.mode === 'minimax_local_8s' && chunkStoryboards.length) {
            logTaskWarn('MijingText', 'storyboard-best-effort-save', {
              chunk: index + 1,
              count: chunkStoryboards.length,
              reasons: finalCompleteness.reasons,
            })
          } else {
            throw new Error(`分镜拆解未通过完整性校验：${finalCompleteness.reasons.join('；')}。自动修复未能完成，未保存本次不完整结果。`)
          }
        }
      }
    }
    generated.push(...chunkStoryboards)
    records.push(record(`generate_storyboards_chunk_${index + 1}`, { chunk: index + 1 }, { count: chunkStoryboards.length }))
  }

  const storyboards = normalizeStoryboards(generated, context, policy || null)
  // All modes must preserve every source dialogue occurrence and its speaker.
  // Only local MiniMax uses the length-derived shot-count lower bound; normal
  // editorial projects may validly use fewer, longer shots.
  const sourceCompleteness = validateStoryboardCompleteness(
    storyboards,
    context,
    policy || null,
    { enforceShotCount: policy?.mode === 'minimax_local_8s' || policy?.mode === 'full' },
  )
  if (!sourceCompleteness.valid) {
    const repaired = repairMissingStoryboardDialogue(storyboards, context, policy)
    if (!repaired) {
      if (policy?.mode === 'minimax_local_8s' && storyboards.length) {
        logTaskWarn('MijingText', 'storyboard-source-coverage-warning', {
          count: storyboards.length,
          reasons: sourceCompleteness.reasons,
        })
      } else {
        throw new Error(`分镜拆解未通过原剧本覆盖校验：${sourceCompleteness.reasons.join('；')}。自动修复未能完成，未保存本次结果。`)
      }
    } else {
      storyboards.splice(0, storyboards.length, ...repaired)
    }
  }
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
    aliases: assetAliasesForPrompt(row),
    role: String(row.role || ''),
    description: String(row.description || ''),
    appearance: String(row.appearance || ''),
    personality: String(row.personality || ''),
    voice_style: String(row.voiceStyle || row.voice_style || ''),
    voice_gender: inferCharacterGender(row),
  }))
}

/**
 * Give the storyboard model a stable speaker contract.  MiniMax H3's
 * `(S1)/(S2)` speaker convention is useful only when the mapping is declared
 * once and then reused; otherwise a long Chinese prompt can make a line drift
 * to the most recently mentioned character.  The contract is descriptive and
 * does not alter the persisted schema.
 */
export function buildSpeakerContract(characters: any[] = []) {
  const rows = characters
    .filter(character => Number(character?.id || 0) && String(character?.name || '').trim())
    .map((character, index) => {
      const aliases = assetAliasesForPrompt(character).filter(alias => alias !== character.name)
      const voice = String(character.voice_style || character.voiceStyle || '').trim() || '未分配，使用该角色的自然音色'
      const gender = String(character.voice_gender || inferCharacterGender(character))
      return `S${index + 1}=character_id ${Number(character.id)} "${String(character.name).trim()}"${aliases.length ? ` (aliases: ${aliases.join(', ')})` : ''}; gender=${gender}; voice=${voice}`
    })
  if (!rows.length) return '【说话人绑定合同】当前没有可用角色资产；不要虚构说话人或声音。'
  return [
    '【MiniMax H3 说话人/音色绑定合同】',
    ...rows.map(row => `- ${row}`),
    '- 每个有声事件必须使用上表唯一的 S 编号；同一角色在整集始终复用同一 S 编号。',
    '- dialogue 中的说话人必须是对应角色的标准 name；video_prompt 中用 <voice>标准角色名</voice>，并在表演描述中写明该角色对谁说话。',
    '- 严禁把“他/她/父亲/女儿/老板/顾客/食客”等关系称呼当成说话人，严禁把一位角色的台词、口型或音色分配给另一位角色。',
  ].join('\n')
}

function inferCharacterGender(character: any) {
  const text = [character?.name, character?.role, character?.description, character?.appearance, character?.personality]
    .map(value => String(value || '')).join(' ')
  // English pronouns must be whole words: matching `he`/`her` as a
  // substring misclassified descriptions such as "the young woman" and
  // was a direct cause of female characters receiving male voice contracts.
  if (/(女性|女人|女孩|少女|女儿|女主|女士|\b(?:woman|girl|female|she|her)\b)/i.test(text)) return 'female'
  if (/(男性|男人|男孩|少年|父亲|男主|先生|大爷|\b(?:man|boy|male|he|him|his)\b)/i.test(text)) return 'male'
  return 'unspecified'
}

function compactScenes(rows: any[]) {
  return rows.map(row => ({
    id: Number(row.id || 0) || undefined,
    location: String(row.location || ''),
    aliases: assetAliasesForPrompt(row),
    time: String(row.time || ''),
    prompt: String(row.prompt || ''),
  }))
}

function normalizeExtractedCharacters(value: unknown) {
  if (!Array.isArray(value)) throw new Error('角色场景提取结果缺少 characters 数组')
  return value.slice(0, 80).map((item: any) => ({
    name: String(item?.name || '').trim(),
    ...normalizeAssetAliasFields(item),
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
    ...normalizeAssetAliasFields(item),
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

  const usedDialogue = new Map<string, number>()
  const usedDialogueRecords = new Set<number>()
  return groundedItems.map(({ item, scene }, index: number) => {
    const requestedSceneId = Number(scene?.id || item?.scene_id || 0)
    const duration = normalizeStoryboardDuration(item?.duration, policy)
    const dialogue = normalizeStoryboardDialogue(item?.dialogue, context, usedDialogue, usedDialogueRecords)
    const videoPrompt = normalizeStoryboardVideoPrompt(
      textField(item?.video_prompt),
      dialogue,
      context.characters || [],
    )
    return {
      shot_number: index + 1,
      title: textField(item?.title, `镜头${index + 1}`),
      shot_type: textField(item?.shot_type, defaultShotType(index)),
      angle: textField(item?.angle, '平视'),
      movement: textField(item?.movement, defaultCameraMotion(index)),
      location: textField(scene?.location || item?.location),
      time: textField(scene?.time || item?.time),
      character_ids: mergeDialogueCharacterIds(
        resolveStoryboardCharacterIds(
          item?.character_ids,
          videoPrompt,
          context.characters || [],
        ).filter((id: number) => validCharacterIds.has(id)),
        dialogue,
        context.characters || [],
      ),
      action: textField(item?.action),
      // A model can repeat a line in two adjacent shots even though the
      // original screenplay contains it once. Keep the original occurrence
      // count as the upper bound, while still allowing intentionally repeated
      // lines when they really appear repeatedly in the source script.
      dialogue,
      description: textField(item?.description),
      result: textField(item?.result),
      atmosphere: textField(item?.atmosphere),
      image_prompt: withTkOverseasVisualLock(
        withVisualStyleLock(textField(item?.image_prompt), context.visual_style, '分镜静态画面'),
        policy?.mode,
        '分镜静态画面',
      ),
      video_prompt: withTkOverseasVisualLock(
        withVisualStyleLock(
          videoPrompt,
          context.visual_style,
          '分镜动态画面',
        ),
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
  const script = String(contextResult?.script || contextResult?.original_script || '').trim()
  return {
    episode: contextResult?.episode,
    script,
    original_script: String(contextResult?.original_script || script).trim(),
    storyboard_script: String(contextResult?.storyboard_script || script).trim(),
    characters: compactCharacters(contextResult?.characters || []),
    scenes: compactScenes(contextResult?.scenes || []),
    props: (contextResult?.props || []).map((row: any) => ({
      id: Number(row.id || 0) || undefined,
      name: String(row.name || ''),
      aliases: assetAliasesForPrompt(row),
      type: String(row.type || ''),
      description: String(row.description || ''),
      prompt: String(row.prompt || ''),
    })),
    visual_style: visualStyle,
    visual_style_lock: buildVisualStyleLock(visualStyle, '整部短剧'),
  }
}

export function estimateCompactShotLimit(script: string) {
  const length = String(script || '').replace(/\s/g, '').length
  return Math.min(10, Math.max(3, Math.ceil(length / 360)))
}

/**
 * Storyboard output is a large JSON document: every shot carries image/video
 * prompts, acting, camera and continuity fields.  The old 12k floor was
 * enough for a short English response but routinely truncated Chinese output.
 * Keep the caller's explicit budget when it is larger, otherwise scale the
 * budget with source length and reserve extra room for Chinese text.
 */
export function getStoryboardOutputTokenBudget(
  configured: number | null | undefined,
  script: string,
  policy: StoryboardDurationPolicy | null | undefined,
) {
  const sourceLength = String(script || '').replace(/\s/g, '').length
  const estimatedShots = policy?.mode === 'minimax_local_8s' || policy?.mode === 'full'
    ? Math.max(6, Math.ceil(sourceLength / 260))
    : Math.max(3, Math.ceil(sourceLength / 360))
  const perShotTokens = policy?.mode === 'minimax_local_8s' || policy?.mode === 'full' ? 900 : 700
  // Use source length as the primary signal.  A 1.7k-character Chinese
  // screenplay can legitimately need 18k+ output tokens once every shot has
  // the required prompt and continuity fields; a shot-count-only formula
  // underestimates this and recreates the truncation bug.
  const scaledBudget = policy?.mode === 'minimax_local_8s' || policy?.mode === 'full'
    ? 6000 + sourceLength * 8
    // Chinese storyboard JSON is dense even outside the local MiniMax
    // profile.  Scale from the authoritative screenplay length so a long
    // Chinese response cannot fall back to the old 12k-token ceiling merely
    // because the model estimated too few shots.
    : Math.max(4000 + estimatedShots * perShotTokens, 5000 + sourceLength * 5)
  const hardCap = policy?.mode === 'minimax_local_8s' || policy?.mode === 'full' ? 48_000 : 32_000
  const configuredBudget = Number(configured || 0)
  return Math.max(configuredBudget, 12_000, Math.min(hardCap, scaledBudget))
}

type StoryboardCompleteness = {
  valid: boolean
  minimumCount: number
  reasons: string[]
  missingSceneIds?: number[]
  missingDialogue?: SourceDialogueRecord[]
}

/**
 * Reject a syntactically valid but obviously truncated storyboard response.
 * This is deliberately conservative: it does not enforce a fixed shot count,
 * but uses source dialogue, scene coverage and a length-derived lower bound to
 * detect the exact "5 shots after a JSON retry" failure without rewriting the
 * model's story.
 */
export function validateStoryboardCompleteness(
  storyboards: any[],
  context: any,
  policy: StoryboardDurationPolicy | null | undefined,
  options: { enforceShotCount?: boolean } = {},
): StoryboardCompleteness {
  const source = String(context?.original_script || context?.script || '')
  const sourceLength = source.replace(/\s/g, '').length
  const isFixedLocal = policy?.mode === 'minimax_local_8s'
  const isFullBreakdown = policy?.mode === 'full'
  const minimumCount = isFixedLocal
    ? Math.max(1, Math.min(120, Math.ceil(sourceLength / 320)))
    : isFullBreakdown
      ? Math.max(1, Math.min(120, Math.ceil(sourceLength / 450)))
    : Math.max(1, Math.min(30, Math.ceil(sourceLength / 700)))
  const reasons: string[] = []
  let missingSceneIds: number[] = []
  let missingDialogue: SourceDialogueRecord[] = []
  if (!Array.isArray(storyboards) || !storyboards.length) {
    reasons.push('没有返回任何分镜')
    return { valid: false, minimumCount, reasons, missingSceneIds, missingDialogue }
  }
  const enforceShotCount = options.enforceShotCount !== false
  if (enforceShotCount && storyboards.length < minimumCount) {
    reasons.push(`仅返回 ${storyboards.length} 个镜头，按剧本长度至少需要约 ${minimumCount} 个`)
  }

  const requiredSceneIds: number[] = [...new Set<number>((context?.scenes || [])
    .map((item: any) => Number(item?.id || 0))
    .filter((id: number) => Boolean(id)))]
  const usedSceneIds = new Set(storyboards.map(item => Number(item?.scene_id || 0)).filter(Boolean))
  missingSceneIds = requiredSceneIds.filter(id => !usedSceneIds.has(id))
  if (requiredSceneIds.length && missingSceneIds.length && (policy?.mode === 'tk_overseas' || isFixedLocal || isFullBreakdown)) {
    reasons.push(`未覆盖场景 ${missingSceneIds.join(', ')}`)
  }

  const dialogueSource = compactDialogueText(source)
  const sourceDialogueRecords = extractSourceDialogueRecords(source, context?.characters || [])
  if (sourceDialogueRecords.length) {
    const generatedDialogueRecords = extractGeneratedDialogueRecords(storyboards)
    // Match as an ordered multiset rather than with `some()`.  This catches
    // both repeated lines and lines emitted in the wrong speaker/order slot;
    // a single generated line must never satisfy two source occurrences.
    let generatedCursor = 0
    for (const record of sourceDialogueRecords) {
      const matchIndex = generatedDialogueRecords.findIndex((generated, index) => index >= generatedCursor
        && dialogueKeysMatch(generated.key, record.key)
        && normalizeGroundingText(generated.speaker) === normalizeGroundingText(record.speaker))
      if (matchIndex < 0) {
        missingDialogue.push(record)
      } else {
        generatedCursor = matchIndex + 1
      }
    }
    if (missingDialogue.length) {
      reasons.push(`遗漏或错序 ${missingDialogue.length} 条原剧本对白`)
    }
  } else if (dialogueSource.length > 900 && !storyboards.some(item => String(item?.dialogue || '').trim())) {
    reasons.push('长剧本未返回任何对白字段')
  }

  return { valid: reasons.length === 0, minimumCount, reasons, missingSceneIds, missingDialogue }
}

export function repairMissingStoryboardDialogue(
  storyboards: any[],
  context: any,
  policy: StoryboardDurationPolicy | null | undefined,
) {
  const completeness = validateStoryboardCompleteness(storyboards, context, policy)
  if (completeness.valid || !completeness.missingDialogue?.length || completeness.missingSceneIds?.length) return null

  const sourceRecords = extractSourceDialogueRecords(
    String(context?.original_script || context?.script || ''),
    context?.characters || [],
  )
  const repaired = (storyboards || []).map(item => ({ ...item }))
  for (const missing of completeness.missingDialogue) {
    const sourceIndex = sourceRecords.findIndex(record => record.key === missing.key
      && normalizeGroundingText(record.speaker) === normalizeGroundingText(missing.speaker))
    const previous = sourceRecords.slice(0, sourceIndex).reverse().find(record => findStoryboardDialogueLine(repaired, record))
    const next = sourceRecords.slice(sourceIndex + 1).find(record => findStoryboardDialogueLine(repaired, record))
    const target = previous || next ? findStoryboardDialogueLine(repaired, previous || next)?.storyboard : repaired[0]
    if (!target) return null

    const lines = String(target.dialogue || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const insertAt = previous
      ? (findStoryboardDialogueLine([target], previous)?.lineIndex ?? lines.length - 1) + 1
      : next
        ? (findStoryboardDialogueLine([target], next)?.lineIndex ?? 0)
        : lines.length
    const dialogueLine = `${missing.speaker}：${missing.line}`
    if (!lines.some(line => dialogueKeysMatch(compactDialogueText(stripDialogueSpeaker(line)), missing.key))) {
      lines.splice(Math.max(0, insertAt), 0, dialogueLine)
      target.dialogue = lines.join('\n')
    }
  }

  const normalized = normalizeStoryboards(repaired, context, policy || null)
  return validateStoryboardCompleteness(normalized, context, policy).valid ? normalized : null
}

function findStoryboardDialogueLine(storyboards: any[], record: SourceDialogueRecord | undefined) {
  if (!record) return null
  for (const storyboard of storyboards || []) {
    const lines = String(storyboard?.dialogue || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const lineIndex = lines.findIndex(line => {
      const speaker = extractDialogueSpeaker(line)
      const text = stripDialogueStageDirection(stripDialogueSpeaker(line))
      return dialogueKeysMatch(compactDialogueText(text), record.key)
        && normalizeGroundingText(speaker) === normalizeGroundingText(record.speaker)
    })
    if (lineIndex >= 0) return { storyboard, lineIndex }
  }
  return null
}

type SourceDialogueRecord = { speaker: string; line: string; key: string }

const NARRATION_SPEAKERS = new Set([
  '旁白', '画外音', '内心独白', '独白', 'narrator', 'voice-over', 'voice over', 'off-screen', 'off screen',
])

const NON_DIALOGUE_LABELS = new Set([
  '地点', '时间', '场景', '内景', '外景', '时段', '镜号', '场次', '人物', '动作', '音效', '音乐', '备注', '标题',
])

function buildSourceDialogueContract(source: string, characters: any[] = []) {
  return extractSourceDialogueRecords(source, characters).map((record, index) => ({
    index: index + 1,
    speaker: record.speaker,
    line: record.line,
  }))
}

function extractSourceDialogueRecords(source: string, characters: any[] = []): SourceDialogueRecord[] {
  const records: SourceDialogueRecord[] = []
  const speakerTerms = new Set(
    characters.flatMap((character: any) => assetBindingTerms(character)
      .map(term => normalizeGroundingText(term)))
      .filter(Boolean),
  )
  for (const raw of String(source || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('##')) continue
    // Supports both `角色：台词` and natural screenplay forms such as
    // `角色说道：“台词”`.  The latter is common in pasted Chinese scripts
    // and was previously invisible to the source-dialogue ledger.
    const match = line.match(/^([^:：]{1,40})[:：]\s*(.+)$/)
      || line.match(/^(.{1,40}?)(?:说|说道|喊道|问道|答道|回应道|低声道|轻声说|大喊道)\s*[:：]?\s*(.+)$/u)
    if (!match) continue
    const rawSpeaker = String(match[1] || '')
      .replace(/[（(].*?[）)]/g, '')
      // In natural Chinese prose the colon matcher sees “苏小小说” as the
      // speaker. Strip the speech verb before resolving it to the canonical
      // character asset, while leaving names that genuinely contain these
      // characters untouched when they match an asset exactly.
      .replace(/(?:回应道|低声道|轻声说|大喊道|说道|喊道|问道|答道|说)$/u, '')
      .trim()
    const speaker = normalizeGroundingText(rawSpeaker)
    const isKnownCharacter = [...speakerTerms].some(term => speaker === term || speaker.includes(term) || term.includes(speaker))
    const isNarration = NARRATION_SPEAKERS.has(speaker)
    // Only treat a line as dialogue when its speaker is a known asset or an
    // explicit narration source.  Scene metadata such as “地点：厨房” and
    // “时间：夜” must never create false missing-dialogue failures.
    if (NON_DIALOGUE_LABELS.has(speaker) || (speakerTerms.size && !isKnownCharacter && !isNarration)) continue
    const dialogue = String(match[2] || '').trim()
    const canonicalCharacter = characters.find((character: any) => assetBindingTerms(character)
      .some(term => normalizeGroundingText(term) === speaker))
    const canonicalSpeaker = String(canonicalCharacter?.name || rawSpeaker).trim()
    const spokenLine = stripDialogueStageDirection(dialogue)
    const key = compactDialogueText(spokenLine)
    if (spokenLine.length >= 2 && key) records.push({ speaker: canonicalSpeaker, line: spokenLine, key })
  }
  return records
}

function extractSourceDialogueCandidates(source: string, characters: any[] = []) {
  const seen = new Set<string>()
  return extractSourceDialogueRecords(source, characters)
    .filter(record => {
      if (seen.has(record.key)) return false
      seen.add(record.key)
      return true
    })
    .map(record => record.line)
}

function extractGeneratedDialogueRecords(storyboards: any[]) {
  const records: SourceDialogueRecord[] = []
  for (const storyboard of storyboards || []) {
    for (const raw of String(storyboard?.dialogue || '').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const speaker = extractDialogueSpeaker(line)
      const text = stripDialogueStageDirection(stripDialogueSpeaker(line))
      const key = compactDialogueText(text)
      if (key) records.push({ speaker, line: text, key })
    }
  }
  return records
}

function normalizeStoryboardDialogue(
  value: unknown,
  context: any,
  usedDialogue: Map<string, number>,
  usedDialogueRecords: Set<number> = new Set(),
) {
  const raw = textField(value)
  if (!raw) return ''
  const source = String(context?.original_script || context?.script || '')
  const sourceText = compactDialogueText(source)
  const sourceRecords = extractSourceDialogueRecords(source, context?.characters || [])
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const kept: string[] = []
  for (const line of lines) {
    const key = compactDialogueText(stripDialogueStageDirection(stripDialogueSpeaker(line)))
    if (!key) continue
    const speaker = extractDialogueSpeaker(line)
    const normalizedSpeaker = normalizeGroundingText(speaker)
    const matchingRecords = sourceRecords
      .map((record, index) => ({ record, index }))
      .filter(item => dialogueKeysMatch(key, item.record.key) && !usedDialogueRecords.has(item.index))
    if (sourceRecords.length) {
      if (!matchingRecords.length) continue
      const preferred = matchingRecords.find(item => normalizedSpeaker
        && normalizeGroundingText(item.record.speaker) === normalizedSpeaker)
        || matchingRecords[0]
      usedDialogueRecords.add(preferred.index)
      usedDialogue.set(key, (usedDialogue.get(key) || 0) + 1)
      // Keep the model's exact spoken fragment, but bind it to the source
      // speaker.  The source line may contain a trailing action sentence
      // (e.g. "火候到了。她继续颠锅。"), which must never become voice audio.
      const spokenLine = stripDialogueStageDirection(stripDialogueSpeaker(line))
      kept.push(`${preferred.record.speaker}：${spokenLine}`)
      continue
    }
    const sourceCount = countCompactOccurrences(sourceText, key)
    const allowed = sourceCount || 1
    const alreadyUsed = usedDialogue.get(key) || 0
    if (alreadyUsed >= allowed) continue
    usedDialogue.set(key, alreadyUsed + 1)
    kept.push(line)
  }
  return kept.join('\n')
}

function extractDialogueSpeaker(value: string) {
  return String(value || '').match(/^\s*([^:：\n]{1,40})\s*[:：]/)?.[1]?.trim() || ''
}

function stripDialogueStageDirection(value: string) {
  return String(value || '').replace(/^\s*[（(][^）)]*[）)]\s*/u, '').trim()
}

function mergeDialogueCharacterIds(requestedIds: number[], dialogue: string, characters: any[]) {
  const ids = new Set(requestedIds.map(Number).filter(Boolean))
  for (const line of String(dialogue || '').split(/\r?\n/).filter(Boolean)) {
    const speaker = extractDialogueSpeaker(line)
    if (!speaker || /^(旁白|画外音|内心独白|narrator|voice[- ]?over|off[- ]?screen)$/i.test(speaker)) continue
    const normalized = normalizeGroundingText(speaker)
    const match = characters.find((character: any) => assetBindingTerms(character)
      .some(term => normalizeGroundingText(term) === normalized))
    if (match?.id) ids.add(Number(match.id))
  }
  return [...ids]
}

function normalizeStoryboardVideoPrompt(prompt: string, dialogue: string, characters: any[]) {
  const base = String(prompt || '').trim()
  const speakers = [...new Set(String(dialogue || '').split(/\r?\n/)
    .map(extractDialogueSpeaker)
    .filter(Boolean))]
  if (!speakers.length) return base
  const cleaned = base.replace(/<voice>\s*[^<]+?\s*<\/voice>/gi, '').replace(/\s{2,}/g, ' ').trim()
  const speakerCharacters = characters.filter(character => Number(character?.id || 0) && String(character?.name || '').trim())
  const mappings = speakers.map((speaker, index) => {
    const characterIndex = speakerCharacters.findIndex((item: any) => assetBindingTerms(item)
      .some(term => normalizeGroundingText(term) === normalizeGroundingText(speaker)))
    const character = characterIndex >= 0 ? speakerCharacters[characterIndex] : null
    const voiceId = characterIndex >= 0 ? characterIndex + 1 : index + 1
    const gender = inferCharacterGender(character || { name: speaker })
    const voice = String(character?.voice_style || character?.voiceStyle || '').trim()
    return `<voice>${speaker}</voice> (S${voiceId}; gender=${gender}${voice ? `; voice=${voice}` : ''})`
  }).join('；')
  return [cleaned, `对白发声绑定（仅允许这些说话人）：${mappings}；每句 dialogue 原文只发声一次。`]
    .filter(Boolean).join('\n')
}

function stripDialogueSpeaker(value: string) {
  return String(value || '').replace(/^\s*[^:：\n]{1,40}\s*[:：]\s*/, '').trim()
}

function compactDialogueText(value: string) {
  return String(value || '')
    .replace(/[“”「」『』"'‘’]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？；：、,.!?;:]+/g, '')
    .toLocaleLowerCase()
}

/**
 * Match a generated spoken fragment against a source dialogue record.
 * Screenplay lines sometimes place an action sentence after the spoken text
 * on the same line.  Exact matching remains preferred, while a sufficiently
 * substantial contiguous fragment is accepted in either direction so that
 * the action suffix does not make an otherwise valid line look missing.
 */
function dialogueKeysMatch(generatedKey: string, sourceKey: string) {
  if (!generatedKey || !sourceKey) return false
  if (generatedKey === sourceKey) return true
  // Only accept a generated prefix of the source record.  This covers a
  // screenplay line that appends an action or translation after the spoken
  // sentence, while avoiding accidental matches on a short word appearing
  // in the middle of another character's line.
  if (generatedKey.length < 2 || generatedKey.length > sourceKey.length) return false
  return sourceKey.startsWith(generatedKey)
}

function countCompactOccurrences(haystack: string, needle: string) {
  if (!needle) return 0
  let count = 0
  let offset = haystack.indexOf(needle)
  while (offset >= 0) {
    count++
    offset = haystack.indexOf(needle, offset + needle.length)
  }
  return count
}

// A missing field should not collapse every generated shot into the same
// medium/static setup. These are photographic fallbacks only; they do not add
// story facts and are replaced whenever the model provides an explicit value.
const SHOT_TYPE_FALLBACKS = ['远景/建立镜头', '中景/双人关系', '过肩中近景', '近景/情绪反应', '特写/关键细节', '全景/动作结果']
const CAMERA_MOTION_FALLBACKS = ['横摇展示空间→停在主体', '跟拍主体前进→平稳落点', '缓慢推轨靠近→焦点落在眼睛', '过肩切换→焦点转移到说话者', '细节特写轻微推近→停在道具状态', '拉轨扩大空间→主体落入构图中心']

function defaultShotType(index: number) {
  return SHOT_TYPE_FALLBACKS[index % SHOT_TYPE_FALLBACKS.length]
}

function defaultCameraMotion(index: number) {
  return CAMERA_MOTION_FALLBACKS[index % CAMERA_MOTION_FALLBACKS.length]
}

export function resolveStoryboardChunkLimit(
  script: string,
  policy: StoryboardDurationPolicy | null | undefined,
) {
  if (policy?.mode === 'minimax_local_8s' || policy?.mode === 'full') return 120
  return estimateCompactShotLimit(script)
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
  const taggedLocations = extractStoryboardLocationNames(item?.video_prompt)
  // The top-level location (or the first canonical location tag) describes
  // the opening environment of this shot. Do not concatenate every location
  // mentioned in a transition (for example kitchen -> dining room), because
  // substring matching would then make the resolver pick an arbitrary scene
  // and silently omit the actual scene asset from the video references.
  const requestedLocation = normalizeGroundingText(
    String(item?.location || '').trim() || taggedLocations[0] || '',
  )
  const requestedTime = normalizeGroundingText(item?.time)
  // scene_id is the persisted binding produced by decomposition.  It is
  // authoritative even when the model's free-text location is stale or
  // mentions a transition destination.  Falling back to location matching
  // here used to silently swap the scene asset during re-decomposition.
  if (byId) {
    if (!requestedLocation || sceneLocationMatches(requestedLocation, byId)) return byId
    // If the free-text location names another known scene, keep the explicit
    // id: the persisted binding is authoritative and prevents prompt text
    // from swapping the asset. Unknown locations remain ungrounded and are
    // rejected by the normal storyboard validation below.
    const conflictingKnownScene = scenes.find((scene: any) => scene !== byId
      && sceneLocationMatches(requestedLocation, scene))
    return conflictingKnownScene ? byId : null
  }
  if (!requestedLocation) return null
  const matches = scenes.filter((scene: any) => {
    if (!sceneLocationMatches(requestedLocation, scene)) return false
    const sceneTime = normalizeGroundingText(scene?.time)
    return !requestedTime || !sceneTime || sceneTime === requestedTime || sceneTime.includes(requestedTime) || requestedTime.includes(sceneTime)
  })
  return matches.length === 1
    ? matches[0]
    : matches.length > 1
      ? null
      : scenes.find((scene: any) => sceneLocationMatches(requestedLocation, scene)) || null
}

function sceneLocationMatches(normalizedLocation: string, scene: any) {
  const left = normalizeGroundingText(normalizedLocation)
  return !!left && assetBindingTerms({
    name: scene?.location,
    aliases: scene?.aliases,
    english_name: scene?.english_name,
    englishName: scene?.englishName,
  }).some(term => sceneLocationMatchesBinding(left, normalizeGroundingText(term)))
}

function effectiveStoryboardLocation(item: any) {
  const tagged = extractStoryboardLocationNames(item?.video_prompt)
  return String(item?.location || '').trim() || tagged[0] || ''
}

function extractStoryboardLocationNames(value: unknown) {
  const names: string[] = []
  const pattern = /<location>\s*([^<]+?)\s*<\/location>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(value || '')))) {
    const name = String(match[1] || '').trim()
    if (name && !names.some(item => normalizeGroundingText(item) === normalizeGroundingText(name))) names.push(name)
  }
  return names
}

function sceneLocationVariants(value: unknown) {
  const normalized = normalizeGroundingText(value)
  const variants = new Set(normalized ? [normalized] : [])
  const aliases: Array<[string, string]> = [
    ['厨房', '后厨'],
    ['店内', '店里'],
    ['室内', '屋内'],
    ['起居室', '客厅'],
    ['卧房', '卧室'],
  ]
  for (const [left, right] of aliases) {
    if (normalized.includes(left)) variants.add(normalized.replaceAll(left, right))
    if (normalized.includes(right)) variants.add(normalized.replaceAll(right, left))
  }
  return [...variants]
}

function sceneLocationMatchesBinding(left: string, right: string) {
  if (!left || !right) return false
  return sceneLocationVariants(left).some(a => sceneLocationVariants(right).some(b => a === b || a.includes(b) || b.includes(a)))
}

function isStoryboardGrounded(item: any, scene: any, context: any) {
  if (scene) return true
  const location = normalizeGroundingText(effectiveStoryboardLocation(item))
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

export function normalizeExtractedProps(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 120).map((item: any) => ({
    name: String(item?.name || '').trim(),
    ...normalizeAssetAliasFields(item),
    type: String(item?.type || '').trim(),
    description: String(item?.description || '').trim(),
    prompt: String(item?.prompt || item?.description || item?.name || '').trim(),
    mention_count: Math.max(0, Math.floor(Number(item?.mention_count || item?.mentionCount || 0))),
  })).filter(item => item.name && item.mention_count >= 2)
}

function normalizeAssetAliasFields(item: any) {
  const aliases = parseAssetAliases(item?.aliases ?? item?.alias)
  const englishName = String(item?.english_name || item?.englishName || '').trim()
  return {
    ...(aliases.length ? { aliases } : {}),
    ...(englishName ? { english_name: englishName } : {}),
  }
}

export function buildStoryboardScriptChunks(
  script: string,
  policy: StoryboardDurationPolicy | null | undefined,
) {
  const source = String(script || '').trim()
  if (!source) return []
  // Fixed-duration local MiniMax jobs need one global scene/continuity plan.
  // Splitting the screenplay into independent requests would hide the
  // previous chunk's tail state and let the next chunk restart at a new
  // opening frame, which breaks the serial tail-to-head contract.
  if (policy?.mode === 'tk_overseas' || policy?.mode === 'minimax_local_8s' || policy?.mode === 'full') return [source]
  return splitScriptForMijing(source, source.length > 3000 ? 2400 : 10000)
}

function parseJsonObject(content: string, label: string): Record<string, any> {
  const cleaned = stripCodeFence(content).trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`${label}模型返回不是有效 JSON`)
  try {
    const parsed = parseJsonWithSyntaxRepair(cleaned.slice(start, end + 1))
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

function parseJsonWithSyntaxRepair(raw: string) {
  let lastError: any = null
  for (const candidate of [raw, repairJsonSyntax(raw)]) {
    try {
      return JSON.parse(candidate)
    } catch (error: any) {
      lastError = error
    }
  }
  throw lastError || new Error('invalid JSON')
}

function repairJsonSyntax(value: string) {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const current = value[index]
    if (inString) {
      output += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') inString = false
      continue
    }
    if (current === '"') {
      inString = true
      output += current
      continue
    }
    if (current === ',') {
      let next = index + 1
      while (next < value.length && /\s/.test(value[next])) next++
      if (value[next] === '}' || value[next] === ']') continue
    }
    output += current
    if (current === '}' || current === ']') {
      let next = index + 1
      while (next < value.length && /\s/.test(value[next])) next++
      if (value[next] === '{' || value[next] === '[') output += ','
    }
  }
  return output
}

export async function parseJsonObjectWithRepair(
  initialOutput: string,
  label: string,
  retry: () => Promise<string>,
) {
  try {
    return parseJsonObject(initialOutput, label)
  } catch (error: any) {
    logTaskWarn('MijingText', 'json-format-retry', {
      label,
      initialOutputLength: initialOutput.length,
      reason: error?.message || String(error),
    })
    return parseJsonObject(await retry(), `${label}重试`)
  }
}

async function fetchWithConnectTimeout(
  fetchImpl: typeof fetch,
  endpoint: string,
  init: RequestInit,
  controller: AbortController,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const request = fetchImpl(endpoint, init)
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        const error = new Error('stream connect timeout')
        error.name = 'TimeoutError'
        reject(error)
      }, timeoutMs)
    })
    return await Promise.race([request, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readMijingSseContent(
  response: Response,
  controller: AbortController,
  idleTimeoutMs: number,
) {
  const contentType = response.headers.get('content-type') || ''
  if (!response.body || !/text\/event-stream/i.test(contentType)) {
    const raw = await response.text()
    const payload = parseJsonSafely(raw)
    return payload ? normalizeMessageContent(payload?.choices?.[0]?.message?.content) : raw
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let sawSseEvent = false

  const consumeEvent = (event: string) => {
    const data = event.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data) return false
    sawSseEvent = true
    if (data === '[DONE]') return true
    const payload = parseJsonSafely(data)
    if (!payload) return false
    const delta = normalizeMessageContent(payload?.choices?.[0]?.delta?.content)
    content += delta || normalizeMessageContent(payload?.choices?.[0]?.message?.content)
    return false
  }

  while (true) {
    const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs, controller)
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() || ''
    for (const event of events) {
      if (consumeEvent(event)) return content
    }
    if (done) break
  }

  const trailing = buffer.trim()
  if (trailing) {
    if (trailing.startsWith('data:')) consumeEvent(trailing)
    else if (!sawSseEvent) {
      const payload = parseJsonSafely(trailing)
      if (payload) content += normalizeMessageContent(payload?.choices?.[0]?.message?.content)
      else content += trailing
    }
  }
  return content
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  controller: AbortController,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        const error = new Error('stream idle timeout')
        error.name = 'TimeoutError'
        reject(error)
      }, timeoutMs)
    })
    return await Promise.race([reader.read(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function extractTextProviderError(config: AIConfig, payload: any, raw: string, status: number) {
  const detail = String(payload?.error?.message || payload?.message || raw || '').trim()
  const label = textProviderLabel(config)
  if (/variable type error\s*[：:]?\s*object/i.test(detail)) {
    return `${label}网关不支持当前流式请求（HTTP ${status}：stream 参数类型错误），已尝试兼容模式仍失败，请稍后重试或更换文本网关`
  }
  if (detail.includes('负载已饱和')) return `${label}上游当前负载已饱和（HTTP ${status}），已自动重试但仍未恢复`
  if (status === 502 && /bad gateway|nginx/i.test(detail)) {
    return `${label}上游生成超时或网关暂时不可用（HTTP 502），已自动重试但仍未恢复`
  }
  if (/fields not exists.*platform_model_ratio_source/i.test(detail)) {
    return `${label}上游接口版本不兼容（HTTP ${status}：platform_model_ratio_source 字段不存在），请在谜镜平台切换可用文本模型或更新接口后重试`
  }
  return `${label}接口返回 HTTP ${status}${detail ? `：${detail}` : ''}`
}

function isMijingStreamUnsupportedError(status: number, raw: string) {
  return status === 500 && /variable type error\s*[：:]?\s*object/i.test(raw)
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
  return name === 'TimeoutError' || name === 'AbortError'
    || /timeout|fetch failed|socket|network|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE/i.test(message)
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
