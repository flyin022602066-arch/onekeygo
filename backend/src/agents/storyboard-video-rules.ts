export interface StoryboardVideoModelInfo {
  model?: string | null
  provider?: string | null
  label?: string | null
}

export interface StoryboardBreakdownPolicy {
  mode?: string | null
  shotDuration?: number | null
  shotDurationMin?: number | null
  shotDurationMax?: number | null
  minTotalDuration?: number | null
  maxTotalDuration?: number | null
  minShots?: number | null
  maxShots?: number | null
}

function normalizeText(value?: string | null) {
  return String(value || '').trim()
}

function normalizePositiveInteger(value?: number | string | null) {
  const parsed = Math.round(Number(value || 0))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function isGrokTenSecondVideoModel(info: StoryboardVideoModelInfo | string) {
  const text = typeof info === 'string'
    ? info
    : [info.model, info.provider, info.label].map(normalizeText).join(' ')
  const normalized = text.toLowerCase().replace(/[\s_.-]+/g, '')
  return normalized.includes('grok') && normalized.includes('10s')
}

export function isTkOverseasStoryboardPolicy(policy: StoryboardBreakdownPolicy | null | undefined) {
  return policy?.mode === 'tk_overseas'
}

export function getStoryboardBreakdownModeRule(policy: StoryboardBreakdownPolicy | null | undefined) {
  if (!isTkOverseasStoryboardPolicy(policy)) return ''

  const minShotDuration = normalizePositiveInteger(policy?.shotDurationMin) || 4
  const maxShotDuration = normalizePositiveInteger(policy?.shotDurationMax) || 15
  const minTotalDuration = normalizePositiveInteger(policy?.minTotalDuration) || 60
  const maxTotalDuration = normalizePositiveInteger(policy?.maxTotalDuration) || 100
  const minShots = normalizePositiveInteger(policy?.minShots)
  const maxShots = normalizePositiveInteger(policy?.maxShots)

  return [
    '## TK 海外剧拆解模式（英文对白、完整覆盖）',
    '- 当前是 TK 海外剧提取模式：先忠实读取原始剧本，再按场景和连续叙事节拍拆镜头；不得把剧情概括成少量摘要镜头。',
    `- 本集目标总时长约 ${minTotalDuration}-${maxTotalDuration} 秒；不设固定镜头数量，必须按原剧本的真实叙事节拍决定镜头数。`,
    `- 每镜 duration 必须按实际内容在 ${minShotDuration}-${maxShotDuration} 秒内填写，完整使用 4-15 秒范围；多人连续对白、连续动作或动作结果可以正常使用 12-15 秒，不要默认压回 4-10 秒。`,
    '- 英文对白按约 2.3-2.6 个单词/秒估时，并为开场动作、说话人切换、停顿和人物反应预留 2-4 秒；把同一交流单元持续合并到约 12-15 秒，只有预计超过 15 秒时才在自然语义或动作结果边界切镜。',
    '- 拆镜前必须先建立“整场主画面”：确认场景的空间结构、人物相对位置、视线方向、进入/离开路径、对白顺序和本场结束状态，再从这个全局连续性中选择少量必要的镜头。',
    '- 对于单一场景短段落，3-5 个镜头是软目标；当目标总时长不少于 60 秒且单镜上限为 15 秒时，至少需要 4 个镜头。本例型的连续对话优先拆成 4-5 镜：第一个镜头使用包含主要人物关系的全景/主镜头，承载开场动作和随后未超时的多人对话；后续只补充关键动作、关系变化和结果。不要把每句对白或每次说话人切换机械拆成新镜头。',
    '- 同一场景中的连续多人对话必须作为一个完整交流单元处理：同一镜头的 character_ids 包含画面中所有实际出场人物，dialogue 按剧本顺序保留连续对白；只有空间关系改变、动作结果发生或叙事焦点真正转移时才切镜。',
    '- 第一个镜头必须交代全局空间和人物站位，后续镜头必须明确承接上一个镜头的空间轴线、人物位置、道具状态和情绪结果；禁止连续输出互不相连的“两人对话特写”。',
    '- 必须覆盖上下文中本集已提取的每一个场景；场景数量必须动态读取 read_storyboard_context 返回的当前集场景列表，当前剧本有几个场景就逐个覆盖几个场景，绝对不得把 TK 模式固定理解为三个场景，也不得自行新增或删减场景。每个场景的基本事件、动作、对白和结果都要保留。',
    '- 先按场景边界和剧本事件建立镜头序列，再补充景别、运镜、光影和提示词；一个镜头承载一个完整连续叙事节拍，但一个叙事节拍可以包含多位角色的连续对白，不得把一个交流单元拆成多个碎片。',
    '- 不得删掉原剧本已有的关键动作、冲突、对白、人物反应、道具变化或事件结果；不得新增剧本外人物、地点、对白、事件、冲突、回忆、反转或结尾。',
    '- 英文对白必须识别英文原文：dialogue 和 video_prompt 中保留英文台词的原始大小写、标点、引号和说话人归属，不翻译、不改写、不用中文替代英文。',
    '- 英文台词后面括号内的中文是翻译或辅助说明，不是实际对白，禁止把括号中文写进对白内容；括号内的表演说明只能用于 action/atmosphere。',
    '- 例如 `Emma: "I cannot stay here."（我不能留在这里）` 应保存为 `Emma: "I cannot stay here."`；例如 `Emma（紧张）: "I cannot stay here."` 中“紧张”只能作为表演状态。',
    '- 对白必须按明确的 speaker label 归属；不要因为中文翻译、括号说明或上下文主角身份而把其他角色的英文台词分配给主角。',
    '- 每个镜头的 description、action、result、dialogue、image_prompt、video_prompt 必须与原剧本事实逐项对应；不要为达到镜头数量而制造新剧情，应把真实的动作起点、反应、停顿、视线和结果拆成可执行节拍。',
    '- 每个镜头继续执行已有视觉风格锁定：补足环境前中后景、光源方向、明暗关系、色温、材质、人物姿态、视线和微表情，但不得改变项目画风。',
    '- TK 海外视觉要求：角色默认使用欧美/国际真人影视选角和非东亚面孔；场景默认使用欧美/国际影视美术，避免中国或东亚建筑、标识、陈设和服装审美。不要因中文姓名或括号中文翻译把角色画成东方人；剧本明确民族、地域或文化时以剧本为准。',
    `- 调用 save_storyboards 前必须自检：总时长在 ${minTotalDuration}-${maxTotalDuration} 秒，每镜时长在 ${minShotDuration}-${maxShotDuration} 秒；不为镜头数量设硬性目标，且所有已提取场景均已覆盖。`,
  ].join('\n')
}

export function getStoryboardVideoModelRule(info: StoryboardVideoModelInfo, policy: StoryboardBreakdownPolicy = {}) {
  if (isTkOverseasStoryboardPolicy(policy)) return getStoryboardBreakdownModeRule(policy)

  if (!isGrokTenSecondVideoModel(info)) {
    return [
      '## 普通短剧紧凑分镜规则',
      '- duration 默认填 5；简单动作、反应和环境建立镜头使用 4-5 秒，关键对白或连续动作使用 5-7 秒。',
      '- 普通镜头 duration 必须控制在 4-7 秒，不得沿用 10-15 秒旧规则；只有目标视频模型明确要求固定时长时才覆盖本规则。',
      '- 按约 3.5-4 个中文字/秒估算对白时长，并为动作、停顿保留少量时间；对白放不下时才在自然语义边界切镜。',
      '- 同一场景、同一连续动作链、同一说话焦点应优先合并；只在场景切换、动作结果、视角重点或说话焦点明显变化时切新镜头。',
      '- 合并重复情绪、无信息过渡和空泛特写；镜头数量上限不是目标，不得为了凑数量或时长新增剧本外事件。',
      '- location 和 scene_id 只能使用当前剧本及已提取场景；不得虚构新地点、人物、对白、冲突或结尾。',
      '- video_prompt 的时间段必须从 0 秒开始并正好覆盖 duration，不得写出超过该镜头时长的时间段。',
    ].join('\n')
  }

  const shotDuration = normalizePositiveInteger(policy.shotDuration) || 10
  const maxTotalDuration = normalizePositiveInteger(policy.maxTotalDuration)
  const maxShots = normalizePositiveInteger(policy.maxShots)
  const hasGrokThreeMinuteCap = policy.mode === 'grok_3min' && maxTotalDuration && maxShots
  return [
    '## 目标视频模型规则：Grok 10s',
    '- 当前目标视频模型是 Eggfans Grok 10s 视频模型，分镜拆解必须使用 10 秒版规则。',
    `- 每个镜头的 duration 必须填 ${shotDuration}，不能填 3、5、8、12、15 或浮动时长。`,
    `- 每个 video_prompt 必须正好覆盖 ${shotDuration} 秒，推荐拆成两个连续段：0-5秒、5-10秒。`,
    hasGrokThreeMinuteCap
      ? `- Grok 3 分钟拆解模式已启用：总时长必须控制在 ${maxTotalDuration} 秒以内，最多 ${maxShots} 个镜头；调用 save_storyboards 时最多提交 ${maxShots} 个镜头，不得超过这个上限。`
      : '',
    hasGrokThreeMinuteCap
      ? '- 必须主动压缩剧情：保留主线动作、关键对白和转折；合并过渡、重复情绪和弱信息动作；不要为了覆盖所有细节拆出额外镜头。'
      : '',
    '- 如果剧情动作很短，也要把该镜头扩写成完整 10 秒的可执行画面动作；如果剧情动作过长，要拆成多个 10 秒镜头。',
    '- video_prompt 中不要再写旧的浮动秒数、按 3 秒分段或 0-3/3-6/6-9 的旧格式。',
    `- 调用 save_storyboards 时，所有 storyboards[].duration 都必须为数字 ${shotDuration}。`,
    '- 画面提示词仍然要适配后续图生视频：角色、场景、动作、情绪和镜头运动要清楚，但时长节奏以 Grok 10s 为准。',
  ].filter(Boolean).join('\n')
}

export function buildStoryboardAgentMessage(
  baseMessage: string,
  info: StoryboardVideoModelInfo,
  policy: StoryboardBreakdownPolicy = {},
) {
  const rule = getStoryboardVideoModelRule(info, policy)
  return rule ? [baseMessage, '', rule].join('\n') : baseMessage
}
