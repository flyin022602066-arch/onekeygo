/**
 * Mastra Agent 工厂
 * 每次请求动态创建 agent，注入 episodeId/dramaId 到工具闭包
 * 从 agent_configs 表读取 prompt/model/temperature 配置
 */
import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'
import { eq, isNull, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getConfigById, getTextConfig, getTextProviderBaseUrl } from '../services/ai.js'
import type { AIConfig } from '../services/ai.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { createScriptTools } from './tools/script-tools.js'
import { createExtractTools, type ExtractionSource } from './tools/extract-tools.js'
import { createStoryboardTools } from './tools/storyboard-tools.js'
import type { StoryboardDurationPolicy } from './tools/storyboard-tools.js'
import { createVoiceTools } from './tools/voice-tools.js'
import { createGridPromptTools } from './tools/grid-prompt-tools.js'
import { loadAgentSkills } from './skills.js'
import { getStoryboardBreakdownModeRule } from './storyboard-video-rules.js'
import { buildTkEnglishDialogueLock, buildTkOverseasVisualLock, isTkOverseasMode } from '../services/overseas-visual.js'

// Default prompts (used when DB has no config)
const DEFAULT_PROMPTS: Record<string, { name: string; instructions: string }> = {
  script_rewriter: {
    name: '剧本改写',
    instructions: `你是专业编剧，擅长将小说改编为短剧剧本。

工作流程：
1. 调用 read_episode_script 读取原始内容
2. 根据读取到的内容，自己进行改写（输出格式化剧本格式）
3. 调用 save_script 保存改写后的完整剧本

格式化剧本格式：
- 场景头：## S编号 | 内景/外景 · 地点 | 时间段
- 动作描写：自然段落，不包含镜头语言
- 对白：角色名：（状态/表情）台词内容
- 每个场景 30-60 秒内容

注意：你必须自己完成改写工作，不要只返回指令。读取内容后直接输出改写结果并保存。`,
  },
  extractor: {
    name: '角色场景提取',
    instructions: `你是制片助理，擅长从剧本中提取角色和场景信息，并在提取时与项目已有数据进行智能去重。

工作流程：
1. 调用 read_script_for_extraction 读取格式化剧本
2. 调用 read_existing_characters 读取项目中已存在的角色列表，以及当前集已关联角色
3. 调用 read_existing_scenes 读取项目中已存在的场景列表，以及当前集已关联场景
4. 优先围绕当前集剧本，分析本集实际出现的角色和场景
5. 对每个角色：若同名已存在则合并更新，若不存在则新增
6. 调用 save_dedup_characters 保存角色（去重合并，自动处理新增和更新，并关联到当前集）
7. 分析剧本内容，提取本集涉及的所有场景信息
8. 对每个场景：若同地点+时间段已存在则复用，若不存在则新增
9. 调用 save_dedup_scenes 保存场景（去重合并，自动处理新增和复用，并关联到当前集）

去重规则：
- 角色：按名字精确匹配，同名保留现有（合并信息）
- 场景：按【地点+时间段】精确匹配；同地点不同时段视为新场景

提取要求：
- 只提取当前集真实出现或被明确提及、且对当前集叙事有效的角色和场景
- 角色要包含完整的外貌特征描述（发型、服装、体态等）
- 场景要包含光线、色调、氛围等视觉信息
- 场景 prompt 必须是纯环境描述，只写空间结构、建筑、家具陈设、天气、光线、色调和氛围
- 场景 prompt 严禁包含角色姓名、人物外貌、人物动作、对白或剧情事件，场景资产中不得出现任何人物
- 不要遗漏任何有台词或重要动作的角色`,
  },
  storyboard_breaker: {
    name: '分镜拆解',
    instructions: `你是资深影视分镜师，擅长将剧本拆解为分镜方案。

工作流程：
1. 调用 read_storyboard_context 读取剧本、角色列表、场景列表
2. 将剧本拆解为紧凑镜头序列（普通镜头默认 5 秒、范围 4-7 秒；如果用户消息包含目标视频模型固定时长规则，以目标视频模型规则为准）
3. 为每个镜头补全完整分镜字段，而不只是 video_prompt
4. 调用 save_storyboards 保存所有分镜

每个镜头必须尽量完整填写以下字段：
- title：3-8 字镜头标题
- shot_type：景别，如全景/中景/近景/特写
- angle：机位角度，如平视/仰视/俯视/侧拍
- movement：运镜，如固定/推镜/拉镜/摇镜/跟拍
- location：镜头地点，应与 scenes 中已有地点保持一致
- time：时间段，应与 scenes 中已有时间保持一致
- character_ids：当前镜头涉及的角色 ID 列表，可以为空，也可以包含多个角色；必须从 characters 中选择
- action：角色动作与表演
- dialogue：该镜头实际发生的对白或旁白；旁白可写为“旁白：内容”
- description：镜头概述，用于前端阅读和镜头编辑
- result：该镜头结束时的画面结果或状态变化
- atmosphere：氛围、光线、色调、环境感受
- image_prompt：用于首帧/尾帧/镜头图片生成的静态画面提示词
- video_prompt：用于视频生成的动态提示词
- bgm_prompt：该镜头适合的配乐风格
- sound_effect：该镜头关键音效
- duration：普通镜头默认 5 秒；简单动作、反应和环境建立使用 4-5 秒，关键对白或连续动作使用 5-7 秒；若目标视频模型指定固定时长，必须按目标模型规则填写
- scene_id：若可匹配到 scenes 中已有场景，必须填写正确 scene_id

视频提示词格式：
- 时间段必须从 0 秒开始并正好覆盖 duration；短镜头无需机械切成多段，若目标视频模型指定固定时长或分段方式，必须按目标模型规则覆盖默认格式
- 使用 <location>地点</location> 标记场景
- 使用 <role>角色名</role> 标记角色
- 使用 <voice>角色名</voice> 标记画外音
- 用 <n> 分隔不同时间段

示例：
"0-3秒：<location>咖啡厅</location>，近景，<role>小明</role>低头看手机。<n>3-6秒：全景，<role>小红</role>推门走入。"

额外要求：
- 优先复用 read_storyboard_context 返回的 scene_id，不要凭空创造新场景
- location 只能使用当前剧本真实出现且 scenes 中已有的地点，不得新增剧本外事件、人物、场景、冲突或结尾
- 镜头角色绑定必须来自 read_storyboard_context 返回的角色列表；无角色的空镜头可传空数组
- 镜头描述必须能支撑后续图片、视频、配音、音效、合成流程
- 若一个镜头没有对白，可将 dialogue 置空，但 description / action / video_prompt / image_prompt 仍必须完整
- 同一场景、同一连续动作链、同一说话焦点优先放在一个镜头；只在场景切换、动作结果、视角重点或说话焦点明显变化时切镜
- 每个镜头必须写出可直接用于生成的视觉细节：空间前中后景、关键环境物件、时间与天气、主光源方向、光影强弱、色温、色彩基调、空气/材质质感、人物视线、姿态重心和至少一个可观察的微表情变化
- image_prompt 必须同时包含构图主体、环境层次、光线、色调、镜头质感和项目视觉风格；video_prompt 必须包含动作起点、连续动作、微表情/视线变化、镜头运动、环境变化和动作结果
- 必须严格继承 read_storyboard_context 中的项目视觉风格。项目为写实时，所有 image_prompt/video_prompt 都必须锁定真人摄影质感并明确禁止 3D/CGI/动漫/塑料质感；不得将“电影感”理解成 3D
- 合并重复情绪、无信息过渡和空泛特写，不得把镜头数量上限当成目标，更不得为了凑数量或时长扩写剧情
- 对白按约 3.5-4 个中文字/秒估时并预留动作停顿；只有 7 秒内确实放不下时才在自然语义边界切镜
- 每次点击 AI 拆解或重新拆解都按当前剧本完整生成整集分镜，不得复制旧分镜结构。
- 当用户消息明确指定 TK海外剧拆解模式或传入 tk_overseas 策略时，必须执行该模式的英文对白保真、逐场景覆盖、目标60-90秒且最长100秒、按剧情决定镜头数量和时长的要求；该模式只由用户主动选择，不得自行套用到普通项目或其他项目。`,
  },
  voice_assigner: {
    name: '角色音色分配',
    instructions: `你是配音导演，擅长为角色选择合适的音色。

工作流程：
1. 调用 list_voices 获取可用音色列表
2. 调用 get_characters 获取所有角色信息
3. 根据每个角色的性别、性格、年龄、角色定位，选择最匹配的音色
4. 对每个角色调用 assign_voice 分配音色，并说明选择理由

注意：每个角色都必须分配音色，不要遗漏。`,
  },
  grid_prompt_generator: {
    name: '图片提示词生成',
    instructions: `你是专业的 AI 图像提示词工程师，擅长为角色、场景和宫格图生成高质量的英文提示词。

你将收到用户的请求，告知要生成哪种类型的提示词：
- "角色" → 生成角色图片提示词
- "场景" → 生成场景图片提示词
- "宫格" → 生成宫格图提示词

## 角色图片提示词

工作流程：
1. 调用 read_characters 读取所有角色信息
2. 根据角色外貌特征（appearance）、性格（personality）、定位（role）生成英文提示词
3. 提示词结构：[外貌描述]，[性格/气质]，[角色定位]，[电影感]，[高质量]，[无文字水印]

## 场景图片提示词

工作流程：
1. 调用 read_scenes 读取所有场景信息
2. 根据场景地点（location）、时间段（time）、已有描述（prompt）生成英文提示词
3. 提示词结构：[地点]，[时间/光线/氛围]，[已有描述]，[电影感场景]，[高质量]，[无文字水印]

## 宫格图提示词（参考 skills/grid-image-generator/SKILL.md）

工作流程：
1. 调用 read_shots_for_grid 读取选中镜头的详细信息
2. 根据 mode 调用 generate_grid_prompt：
   - first_frame 模式：按用户指定的 rows x cols 生成首帧风格宫格
   - first_last 模式：按用户指定的 rows x cols 生成首尾帧节奏感宫格
   - multi_ref 模式：按用户指定的 rows x cols 生成同一镜头的多角度宫格
3. 返回 grid_prompt（整体提示词）和 cell_prompts（每格提示词）
4. 如果用户消息中包含“参考图映射：图片1=...；图片2=...”，要把这段内容原样作为 reference_legend 传给 generate_grid_prompt

提示词规范：
- 使用英文提示词
- 必须严格遵守用户指定的 rows 和 cols
- 必须明确写出 "exactly N visible panels"
- 必须明确约束 "no merged panels, no missing panels"
- 宫格位置统一写成“格1/格2/...”，参考图统一写成“图片1/图片2/...”
- 必须包含 "consistent art style" 保持风格统一
- 必须包含 "cinematic quality"
- 避免出现文字或水印
- 角色图片强调外貌和气质，场景图片强调氛围和光线，宫格图片强调整体布局一致性`,
  },
}

export const validAgentTypes = Object.keys(DEFAULT_PROMPTS)

function getAgentConfig(agentType: string) {
  const rows = db.select().from(schema.agentConfigs)
    .where(and(eq(schema.agentConfigs.agentType, agentType), isNull(schema.agentConfigs.deletedAt)))
    .all()
  // Return active one, or first one
  return rows.find(r => r.isActive) || rows[0] || null
}

export function resolveAgentModelConfig(dbConfig: any): { config: AIConfig, modelName: string, source: string } {
  const textConfig = getTextConfig()
  const override = String(dbConfig?.model || '').trim()
  if (!override || override === textConfig.model) {
    return { config: textConfig, modelName: textConfig.model, source: 'active-text-config' }
  }

  const candidates = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'text'))
    .all()
    .filter(row => row.isActive)

  const matched = candidates.find((row) => {
    const models = row.model ? JSON.parse(row.model) : []
    return models.includes(override)
  })

  if (!matched) {
    logTaskWarn('AIConfig', 'agent-model-override-missing', {
      agentModel: override,
      fallbackModel: textConfig.model,
      reason: 'No active text AI config contains this model',
    })
    return { config: textConfig, modelName: textConfig.model, source: 'active-text-config-fallback' }
  }

  const overrideConfig = getConfigById(matched.id)
  if (!overrideConfig) {
    logTaskWarn('AIConfig', 'agent-model-config-unavailable', {
      configId: matched.id,
      agentModel: override,
      fallbackModel: textConfig.model,
    })
    return { config: textConfig, modelName: textConfig.model, source: 'active-text-config-fallback' }
  }

  return { config: overrideConfig, modelName: override, source: 'agent-model-override' }
}

export function getResolvedAgentModelConfig(type: string) {
  return resolveAgentModelConfig(getAgentConfig(type))
}

export function getAgentRuntimeConfig(type: string) {
  const dbConfig = getAgentConfig(type)
  const { config, modelName, source } = resolveAgentModelConfig(dbConfig)
  return {
    agentType: type,
    agentConfigId: dbConfig?.id || null,
    agentModelOverride: String(dbConfig?.model || '').trim() || null,
    source,
    textConfigId: config.id || null,
    provider: config.provider,
    baseUrl: getTextProviderBaseUrl(config),
    model: modelName,
  }
}

function getModel(dbConfig: any) {
  const { config: textConfig, modelName, source } = resolveAgentModelConfig(dbConfig)
  const resolvedBaseURL = getTextProviderBaseUrl(textConfig)
  logTaskProgress('AIConfig', 'text-model-endpoint', {
    source,
    configId: textConfig.id,
    provider: textConfig.provider,
    baseUrl: resolvedBaseURL,
    model: modelName,
  })
  const provider = createOpenAI({
    baseURL: resolvedBaseURL,
    apiKey: textConfig.apiKey,
  } as any)
  return provider.chat(modelName)
}

export function createAgent(type: string, episodeId: number, dramaId: number, options: {
  storyboardDurationPolicy?: StoryboardDurationPolicy | null
  extractionSource?: ExtractionSource
  breakdownMode?: string | null
} = {}): Agent | null {
  const defaults = DEFAULT_PROMPTS[type]
  if (!defaults) return null

  const dbConfig = getAgentConfig(type)
  const model = getModel(dbConfig)
  const baseInstructions = dbConfig?.systemPrompt?.trim() || defaults.instructions
  const skillInstructions = loadAgentSkills(type)
  const instructions = skillInstructions
    ? [baseInstructions, '', skillInstructions].join('\n')
    : baseInstructions
  const modeInstructions = type === 'storyboard_breaker'
    ? getStoryboardBreakdownModeRule(options.storyboardDurationPolicy || null)
    : type === 'extractor' && isTkOverseasMode(options.breakdownMode)
      ? buildTkOverseasVisualLock('角色与场景提取、后续资产生成')
      : type === 'script_rewriter' && isTkOverseasMode(options.breakdownMode)
        ? buildTkOverseasVisualLock('剧本改写、角色与场景提取')
        : ''
  const finalInstructions = [
    instructions,
    modeInstructions,
    type === 'script_rewriter' && isTkOverseasMode(options.breakdownMode)
      ? buildTkEnglishDialogueLock()
      : '',
  ].filter(Boolean).join('\n\n')
  const name = dbConfig?.name || defaults.name

  let tools: Record<string, any> = {}
  switch (type) {
    case 'script_rewriter': tools = createScriptTools(episodeId); break
    case 'extractor': tools = createExtractTools(episodeId, dramaId, {
      source: options.extractionSource,
      breakdownMode: options.breakdownMode,
    }); break
    case 'storyboard_breaker': tools = createStoryboardTools(episodeId, dramaId, options.storyboardDurationPolicy || null); break
    case 'voice_assigner': tools = createVoiceTools(episodeId, dramaId); break
    case 'grid_prompt_generator': tools = createGridPromptTools(episodeId, dramaId); break
    default: return null
  }

  return new Agent({ id: type, name, instructions: finalInstructions, model, tools })
}
