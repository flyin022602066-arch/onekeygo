export interface StoryboardVideoModelInfo {
  model?: string | null
  provider?: string | null
  label?: string | null
}

export interface StoryboardBreakdownPolicy {
  mode?: string | null
  language?: 'zh' | 'en' | string | null
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

const CHARACTER_ASSET_APPEARANCE_RULE = [
  '## 角色参考资产外观锁定规则',
  '- 角色参考资产图是人物身份和全部静态外观的唯一来源。分镜的 title、shot_type、action、description、result、atmosphere、image_prompt、video_prompt 等字段不得描述角色的脸部五官、肤色、年龄感、体型身材、头发发型发色、服装穿搭、配饰或其他外形特征；只用角色名/role 标签指明是谁。',
  '- 原剧本、改写稿或对白中的角色外貌、发型、服装和配饰文字仅作理解上下文，不复制、不改写进分镜提示词，也不据此添加、替换或改变角色资产。资产图未提供替换造型时，不表现换装、换发型、换色、增减配饰。',
  '- 允许并应保留剧情需要的动态表演信息：微表情、眼神、眉眼变化、嘴角变化、呼吸、停顿、口型、情绪反应和动作过程；这些是表演，不是静态外貌描述。不得因清理静态外观而删改这些微表情、动作、对白或剧情事件。',
  '- 角色资产身份绑定必须使用唯一且准确的 character_id、标准角色名及对应 <role> 标签；服装名、职业制服、年龄关系和外貌短语不能当作角色名、别名或独立视觉参考。',
].join('\n')

const PERFORMANCE_AND_SOURCE_RULE = [
  '## 原剧本与表演/摄影硬约束',
  CHARACTER_ASSET_APPEARANCE_RULE,
  '- original_script（用户最初粘贴的 content）是唯一事实来源；storyboard_script 只能用于识别场景头和排版。剧情事件、对白原文、说话人、人物关系、地点、道具状态和事件顺序必须逐项保留，不得翻译、改写、总结、删减或添加剧本外内容。',
  '- dialogue 字段是每个镜头实际发声台词的唯一事实来源；video_prompt、action、description、result 和表演/摄影说明不得逐字重复完整 dialogue。需要提示发声时只写“按 dialogue 字段原文说出一次”，并保留语气、语速、停顿、重音、呼吸、口型和听者反应等表演信息，禁止重复朗读同一句台词。',
  '- 混合中英文对白时，英文原文是实际发声对白：保留英文大小写、标点、引号和说话人；英文行后中文括号只作翻译/表演提示，不得写入 dialogue、video_prompt 的发声内容。纯中文对白不得擅自翻译成英文。',
  '- 表演必须可观察且有过程：明确谁说话、谁聆听；嘴唇开合、停顿、吞咽、呼吸、语速与台词同步，听者有视线、眨眼、呼吸、重心或手部反应。情绪写成眉眼/眼睑/瞳孔/嘴角/下颌的起点→变化→落点，禁止只动嘴、全程同表情、木偶站立或无理由夸张。',
  '- 对白互动与视线必须写成可执行关系：每条有台词的镜头都要明确“说话者 -> 听者 -> 屏幕方位/视线落点 -> 听者反应”。说话者的眼睛、鼻尖、下颌和胸口朝向听者，视线落在听者的眼睛或脸部，禁止无理由直视镜头；听者要看向说话者并产生可见反应。多人交流优先使用双人构图、过肩或反打，严格保持 180 度轴线和左右站位；只有原剧本明确“对镜头/面向观众/独白”时才允许直视镜头。',
  '- Dialogue staging must explicitly state speaker -> listener, each person\'s screen side and eyeline. A speaker looks at the addressed on-screen listener, never into the lens without an explicit direct-address instruction; the listener looks back and reacts. Use two-shots, over-the-shoulder or shot/reverse-shot while preserving the 180-degree axis.',
  '- 角色身份绑定必须使用上下文中的精确角色名称和 character_ids；上下文中同一资产的 aliases/english_name 也可作为输入，但必须映射回唯一的标准角色资产。每个 <role>角色名</role> 标签必须对应当前画面实际出场的角色资产。场景和道具同样只能引用上下文中声明的 name 或 aliases/english_name。中英文名称指向同一资产时不得创建或绑定第二个身份；“某人的父亲/女儿/老板/同事”等关系描述只能表示剧情关系，不能当作角色名、别名或资产身份。character_ids、<role> 标签和对白说话人必须逐一对应，禁止把关系文本中的人物误绑定到当前角色。',
  '- 景别按叙事功能分布并执行全集级配额：远景/全景默认 0 次，只有剧情无法用近景、特写或过肩交代空间时才允许 1 次，整集绝不超过 1 次；中景/双人中景整集最多 2 次，默认只用 1 次，优先改用过肩、近景和特写完成关系与动作表达。镜头主体默认使用近景、特写或大特写，分别承担情绪、对白口型、关键表情/眼神、道具结果和动作细节；不得为了凑景别强行加入远景或中景。相邻镜头不得连续使用相同景别和固定机位，除非原文明确要求静止。',
  '- movement 必须使用具体专业运镜并写清起点→方向→速度→焦点变化→最终落点：推轨、拉轨、跟拍、横摇、纵摇、环绕、升降、手持微晃、焦点转移或过肩切换。运镜只改变摄影表达，不得为制造镜头变化新增剧情。每个场景首个镜头只需用人物、前景标志物、视线和光线交代空间锚点，不得因此强制使用远景/全景；每个关键对白段优先使用近景、过肩或反打，每个关键动作或道具结果至少一个特写/细节镜头。',
  '- 声音按 MiniMax H3 Promptor 的 Ref2VA 分层规范处理：overall_soundscape 对应 sound_effect，只写环境声、动作声和非语言人声；non_diegetic_music 对应 bgm_prompt，只写角色听不见、仅观众可闻的配乐。完整对白只出现在 dialogue/audio 规划中，不得复制到环境声、配乐或其他提示字段，也不得由环境描述触发额外人声。',
].join('\n')

function withPerformanceAndSourceRule(rule: string) {
  return [rule, PERFORMANCE_AND_SOURCE_RULE].filter(Boolean).join('\n')
}

function normalizeStoryboardLanguage(policy: StoryboardBreakdownPolicy | null | undefined) {
  return String(policy?.language || 'zh').trim().toLowerCase() === 'en' ? 'en' : 'zh'
}

function getMiniMaxLanguageRule(policy: StoryboardBreakdownPolicy | null | undefined) {
  const language = normalizeStoryboardLanguage(policy)
  return language === 'en'
    ? [
      '## MiniMax 分镜输出语言：English',
      '- shot title、description、action、result、atmosphere、image_prompt、video_prompt、bgm_prompt、sound_effect 以及摄影/表演说明统一使用英文（说明字段英文）。',
      '- Dialogue/旁白必须遵循原剧本：已有英文台词保留英文原文；没有英文原文的中文台词或旁白保留中文，不得为了语言切换擅自翻译、改写、省略或添加。',
      '- 混合中英文台词时只把英文原文作为实际发声内容，紧随其后的中文括号仅作辅助翻译/表演提示，不写入实际发声对白。',
    ].join('\n')
    : [
      '## MiniMax 分镜输出语言：中文',
      '- shot title、description、action、result、atmosphere、image_prompt、video_prompt、bgm_prompt、sound_effect 以及摄影/表演说明统一使用中文。',
      '- Dialogue/旁白必须遵循原剧本：已有英文台词保留英文原文；没有英文原文的中文台词或旁白保留中文，不得翻译、改写、省略或添加。',
    ].join('\n')
}

export function isMiniMaxLocalEightSecondStoryboardPolicy(policy: StoryboardBreakdownPolicy | null | undefined) {
  return policy?.mode === 'minimax_local_8s'
}

function getMiniMaxLocalEightSecondRule(policy: StoryboardBreakdownPolicy | null | undefined) {
  const minShotDuration = 8
  const maxShotDuration = 10
  const frameRate = 24
  return [
    '- Continuity preface is mandatory: shot 1 must not mention a prior video or prior-shot inheritance. Starting with shot 2, the very first sentence of every video_prompt must be: “本分镜为 <Video 1> 参考视频的延长和继承；<Video 1> 的最后可见画面是与上一分镜衔接的唯一起点，必须从该画面之后连续推进当前分镜动作。” Put this before all cast, staging, camera, and action directions; never move it to the end or another field.',
    '## 目标视频模型规则：本地 MiniMax H3 自适应 8-10 秒连续分镜',
    '- 这是在原有分镜拆解指令之上追加的时长与连续性合同；剧情覆盖、对白原文、角色/场景/道具绑定、摄影设计、视觉风格和所有既有字段规则保持不变。',
    `- 每个分镜的 duration 必须根据实际剧情填写 ${minShotDuration}、9 或 ${maxShotDuration} 秒，只能使用这三个整数；按 ${frameRate}fps 参考时，8 秒约 192 帧、9 秒约 216 帧、10 秒约 240 帧。`,
    `- 必须按剧本真实顺序和叙事节奏选择 ${minShotDuration}-${maxShotDuration} 秒：单一动作、简单反应或单一节拍优先使用 8 秒；连续动作、多人对白、对白较密或需要完整动作结果时可使用 9-10 秒，不得为了凑 8 秒截断对白、抢快语速或拆开同一连续动作。`,
    `- 每个 video_prompt 必须从 0 秒开始覆盖本镜实际 duration，并明确写出“0秒开场状态 -> 中段连续动作 -> 8/9/10秒尾帧状态（以本镜 duration 为准）”；时间轴必须与 8-10 秒的实际 duration 一致，不得写出超过本镜 duration 的时间段。`,
    '- 参考资产硬上限：资产包括角色、场景、道具和手动参考图；镜头1最多 9 张资产，镜头2及以后最多 9 张当前镜头剧情资产。上一镜完整视频及其 Motion Context 尾部连续性不占用 Picture 图片位，不能把上一镜尾帧伪装成当前镜头 Picture 1。',
    '- 输出每个镜头前必须先逐项去重并计数资产；同一资产别名、重复图片只计 1 张，重复出现也不得重复计数，不得拆分名称或重复绑定绕过上限，也不得通过额外参考图绕过上限。超出上限时只保留叙事必需资产并合并摄影表达，不得删除、改写或新增原剧本事实。',
    '- 每个 8-10 秒镜头必须包含 2-3 个按时间顺序连续的摄影阶段（例如 0-2.5 秒、2.5-5.5 秒、5.5-8/10 秒），每阶段明确景别/机位/运镜/焦点和动作变化；movement 字段必须与 video_prompt 的阶段一致。阶段之间是同一动作链的连续运镜，不是静止摆拍、幻灯片式跳切或凭空新增剧情。',
    '- 每个摄影阶段至少有一个具体运镜变化（推轨、拉轨、跟拍、横摇、纵摇、环绕、升降、焦点转移或手持微晃），写清起点→方向→速度→焦点→落点；本镜 8-10 秒内不得全程固定机位，也不得只写“镜头移动”。',
    '- 对白表演必须写明说话者 -> 听者、双方屏幕方位、视线落点、语气、情绪强度、语速、停顿、重音、呼吸和听者反应：中文通常按约 4-6 个字/秒、英文约 2.8-3.5 个词/秒估算，紧张/激动可自然加速，强调处短暂停顿或减速；说话者看听者而非镜头，听者看说话者并回应，只有剧本明确对镜头/独白时才直视镜头；不得无理由慢速拖字，禁止平铺直叙、只动嘴或全程同一表情。',
    '- 本地 MiniMax H3 特别规则：dialogue 字段是唯一发声源。video_prompt、action、description、result、image_prompt 和 atmosphere 只写画面、口型、呼吸、视线和听者反应，不得写实际台词、<voice> 标签、gender/voice_id，也不得写“按 dialogue 字段说一次/说出对白/重复对白”等第二套发声指令；同一台词只能由原生音频合同执行一次。',
    '- dialogue 只能填写本镜实际要听见的对白、明确的画外音或旁白原文；人物介绍、年龄/身份/性格/经历/修炼/军功等角色档案不是对白，必须留在角色上下文，禁止写入 dialogue，禁止让 H3 把它们朗读成旁白。无实际发声时 dialogue 填空字符串或明确无对白标记，同时保留本镜环境音、动作声和背景音乐规划。',
    '- 本地 MiniMax H3 角色站位硬规则：顾客、食客、客人即使有对白或举杯反应，也默认固定在独立的旁边餐桌区域并保持坐姿；不得站到灶台、烤炉、吧台、操作台、后厨或父女冲突中心，不得挡在主要角色之间。只有原剧本明确写出该顾客离桌、走动、起身或进入冲突时才允许离开桌位。',
    '- 当苏大强与顾客同镜冲突时，苏大强必须是当前镜头的动作主角色和视觉主焦点：手机、夺瓶、皮带、冲入、质问及相关对白只能绑定苏大强自己的角色资产；顾客只能作为旁桌反应或听者，不能被写成前景主体、结尾主体、镜头最终焦点或主要动作执行者。',
    '- 顾客对白不等于顾客主镜头：result 与 CURRENT_SHOT_END 必须落在苏大强或本镜剧本指定的主要动作角色上，并明确其独立桌位与冲突中心的空间隔离；禁止出现“镜头横移到顾客并结束”“顾客挡在两人之间”“顾客站在灶台/吧台边”等布局。',
    '- 拆解整集前先规划完整首尾状态链。镜头1的开头来自剧本；从镜头2开始，当前镜头0秒必须直接继承前一镜头最后可见的时间状态和画面状态，再从这一瞬间继续向前生成；这只是当前镜头的起点锚点，不是当前镜头的结尾目标，也不是重新设计一个开场。',
    '- 相邻镜头交接时必须逐项继承起点锚点：人物身份与数量、面部、服装、发型、姿态、视线、左右站位、手部状态、道具种类/数量/位置、场景结构、机位构图、光线方向和色温；继承后必须按照当前镜头自己的动作、对白和摄影方向继续推进并形成新的结果。',
    '- 每个镜头的 result 必须描述当前镜头完成动作后的新尾帧，不能把上一镜最后画面原样复制成当前镜头尾帧；下一个镜头只复用这个新尾帧作为起点，不得只写“承接上一镜”或“保持一致”等空泛文字。',
    '- 先建立本集的“角色资产表”和“镜头绑定表”，再写每个 video_prompt：角色资产表固定标准名、character_id、别名、性别/年龄段、发型、服装和不可变识别特征；镜头绑定表只列当前镜头实际出场的角色、说话人、听者、屏幕方位、参考 Picture 编号和动作主语。当前镜头未列入绑定表的角色不得因上一镜视频参考自动出场。',
    '- 每个镜头的角色顺序固定为：主动作角色 -> 对白说话者 -> 主要听者 -> 背景/旁桌反应角色；Picture 编号必须只服务于该镜头绑定表中的当前角色和道具，不能把上一镜角色的 Picture、关系称谓或“父亲/女儿/老板/顾客”等关系词当成新角色。',
    '- 参考视频与参考图片分工不可混淆：<Video 1>只提供上一镜结尾的时间、动作、机位、空间和运动状态；当前 Picture/Subject 才提供当前镜头角色身份、服装、外观和道具身份。禁止从 <Video 1> 复制上一镜人物身份去填补当前镜头角色，也禁止用当前 Picture 把上一镜可见角色瞬间换脸。',
    '- 每个镜头先写“当前镜头身份清单/不出场清单”：明确本镜出现谁、谁不出现、谁只在背景反应；角色数量、性别、服装、站位和动作主语必须与清单一致。若当前镜头需要新角色，必须写成从画外/遮挡后/远处连续入画，并在入画后绑定其自己的 Picture；不得在 0 秒第一帧直接替换或新增。',
    '- 如果下一镜需要新增人物、道具、动作或切换场景，只能在继承的0秒起点（即0秒开场构图之后）通过入画、取出、遮挡转场、运镜或剧本明确的动作自然发生；禁止在新镜头第一帧直接跳变，也禁止因参考上一镜而让新角色顶替旧角色。',
    '- video_prompt 必须明确“继承上一镜结尾起点 -> 当前镜头动作推进 -> 当前镜头新结果尾帧”；尾帧要动作已落稳、主体清晰，不能停留在上一镜画面或回到上一镜的构图。',
    '- 从镜头2开始，video_prompt 必须按以下固定标记输出三段且每段都要有具体内容：CONTINUITY_START:（继承上一镜最后可见状态，作为本镜0秒起点）；CURRENT_SHOT_PROGRESS:（执行本镜自己的动作、对白和运镜）；CURRENT_SHOT_END:（形成不同于上一镜的新尾帧结果，并作为下一镜起点）。三个标记各出现一次且顺序固定。',
    '- 镜头2及以后禁止写“全新开场、重新构图、从头开始、独立开场、new opening、reset、restart”等重置语义，也不能把上一镜结尾原样当成本镜 result。若模型遗漏连续性标记或出现格式缺口，save_storyboards 会自动补齐并继续保存，不得因为标记缺失中断整集生产。',
    '- 本地 MiniMax H3 两种串行模式都使用多参考 R2V 图片列表：不得生成或填写 first_frame_url、last_frame_url，也不得切换到 FL2VA/I2V。标准 R2V 串行只使用完整 <Video 1> 作为上一镜的时间、动作、空间和连续起点来源，不使用 Motion Context 节点、不使用 latent、不把尾帧图伪装成 Picture 1；当前 Picture 仅按映射提供角色、场景和道具身份外观，不能覆盖 <Video 1> 的连续起点。Motion Context Plus 才使用上一镜 AV latent 和 Motion Context 节点提供开头连续性。角色绑定与时间连续性是两条独立约束，不能互相替代。所有图片顺序和提示词映射必须保持一致。',
    '- 采用 Ref2VA 的六段组织方式生成每个本地 H3 video_prompt：subject_definitions（当前镜头角色/道具身份定义）→ summary（本镜唯一戏剧变化与参考关系）→ retention_analysis（哪些上一镜状态继承、哪些上一镜对白/角色绑定不继承）→ detailed_description（0秒继承、连续推进、最终新结果）→ overall_soundscape（仅环境/动作声）→ non_diegetic_music（仅观众可闻配乐）。六段中的角色名、Picture 编号、Video 编号必须完全一致。',
    `- 调用 save_storyboards 时，所有 storyboards[].duration 都必须根据剧情填写 ${minShotDuration}-${maxShotDuration} 秒的整数（8、9 或 10）。`,
  ].join('\n')
}

/**
 * The local MiniMax contract is an ordered multi-reference R2V contract.  A
 * few older rule strings still contain provider frame-slot wording because
 * they predate the R2V-only implementation.  Normalize only the local rule
 * that is sent to the extractor; remote providers keep their native wording.
 */
function neutralizeMiniMaxLocalFrameTerminology(rule: string) {
  return String(rule || '')
    .split(/\r?\n/)
    .map(line => {
      if (/first_frame_url|last_frame_url|FL2VA\/I2V/i.test(line)) {
        return '- 本地 MiniMax H3 两种串行模式统一使用有序多参考 R2V 图片列表；标准 R2V 串行只使用完整 <Video 1> 提供上一镜的时间、动作、空间和连续起点来源，不使用 Motion Context 节点、不使用 latent、不把尾帧图伪装成 Picture 1；Motion Context Plus 才使用上一镜 AV latent 和 Motion Context 节点连续；当前 Picture 仅绑定当前镜头资产，不得填写任何独立的帧位参数。'
      }
      return line
    })
    .map(line => line
      .replace(/首尾帧/g, '连续参考图')
      .replace(/首帧/g, '开场构图')
      .replace(/第一帧/g, '开场画面')
      .replace(/尾帧/g, '结束构图')
      .replace(/第\s*0\s*帧/g, '开场画面')
      .replace(/first(?:[-_ ]+frame)/gi, 'opening composition')
      .replace(/last(?:[-_ ]+frame)/gi, 'ending composition')
      .replace(/tail(?:[-_ ]+frame)/gi, 'continuity image'))
    .join('\n')
}

export function getStoryboardBreakdownModeRule(policy: StoryboardBreakdownPolicy | null | undefined) {
  if (isMiniMaxLocalEightSecondStoryboardPolicy(policy)) return withPerformanceAndSourceRule([
    getMiniMaxLocalEightSecondRule(policy),
    getMiniMaxLanguageRule(policy),
  ].map(neutralizeMiniMaxLocalFrameTerminology).join('\n'))
  if (!isTkOverseasStoryboardPolicy(policy)) {
    return policy?.mode === 'full' ? withPerformanceAndSourceRule(CHARACTER_ASSET_APPEARANCE_RULE) : ''
  }

  const minShotDuration = normalizePositiveInteger(policy?.shotDurationMin) || 4
  const maxShotDuration = normalizePositiveInteger(policy?.shotDurationMax) || 15
  const minTotalDuration = normalizePositiveInteger(policy?.minTotalDuration) || 60
  const maxTotalDuration = normalizePositiveInteger(policy?.maxTotalDuration) || 100
  const minShots = normalizePositiveInteger(policy?.minShots)
  const maxShots = normalizePositiveInteger(policy?.maxShots)

  return withPerformanceAndSourceRule([
    '## TK 海外剧拆解模式（英文对白、完整覆盖）',
    '- 当前是 TK 海外剧提取模式：先忠实读取原始剧本，再按场景和连续叙事节拍拆镜头；不得把剧情概括成少量摘要镜头。',
    `- 本集目标总时长约 ${minTotalDuration}-${maxTotalDuration} 秒；不设固定镜头数量，必须按原剧本的真实叙事节拍决定镜头数。`,
    `- 每镜 duration 必须按实际内容在 ${minShotDuration}-${maxShotDuration} 秒内填写，完整使用 4-15 秒范围；多人连续对白、连续动作或动作结果可以正常使用 12-15 秒，不要默认压回 4-10 秒。`,
    '- 英文对白按约 2.3-2.6 个单词/秒估时，并为开场动作、说话人切换、停顿和人物反应预留 2-4 秒；把同一交流单元持续合并到约 12-15 秒，只有预计超过 15 秒时才在自然语义或动作结果边界切镜。',
    '- 拆镜前必须先建立“整场主画面”：确认场景的空间结构、人物相对位置、视线方向、进入/离开路径、对白顺序和本场结束状态，再从这个全局连续性中选择少量必要的镜头。',
    '- 对于单一场景短段落，3-5 个镜头是软目标；当目标总时长不少于 60 秒且单镜上限为 15 秒时，至少需要 4 个镜头。本例型的连续对话优先拆成 4-5 镜：第一个镜头使用近景、过肩或必要时唯一一次中景交代主要人物关系，承载开场动作和随后未超时的多人对话；后续只补充关键动作、关系变化和结果。不要把每句对白或每次说话人切换机械拆成新镜头。',
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
  ].join('\n'))
}

export function getStoryboardVideoModelRule(info: StoryboardVideoModelInfo, policy: StoryboardBreakdownPolicy = {}) {
  if (isMiniMaxLocalEightSecondStoryboardPolicy(policy)) return withPerformanceAndSourceRule([
    getMiniMaxLocalEightSecondRule(policy),
    getMiniMaxLanguageRule(policy),
  ].map(neutralizeMiniMaxLocalFrameTerminology).join('\n'))
  if (isTkOverseasStoryboardPolicy(policy)) return getStoryboardBreakdownModeRule(policy)
  if (policy.mode === 'full') return getStoryboardBreakdownModeRule(policy)

  const explicitGrokMode = policy.mode === 'grok_3min' || policy.mode === 'grok_10s'
  if (policy.mode === 'standard' || (!policy.mode && !explicitGrokMode && !isGrokTenSecondVideoModel(info))) {
    return withPerformanceAndSourceRule([
      '## 普通短剧紧凑分镜规则',
      '- duration 默认填 5；简单动作、反应和环境建立镜头使用 4-5 秒，关键对白或连续动作使用 5-7 秒。',
      '- 普通镜头 duration 必须控制在 4-7 秒，不得沿用 10-15 秒旧规则；只有目标视频模型明确要求固定时长时才覆盖本规则。',
      '- 按约 3.5-4 个中文字/秒估算对白时长，并为动作、停顿保留少量时间；对白放不下时才在自然语义边界切镜。',
      '- 同一场景、同一连续动作链、同一说话焦点应优先合并；只在场景切换、动作结果、视角重点或说话焦点明显变化时切新镜头。',
      '- 合并重复情绪、无信息过渡和空泛特写；镜头数量上限不是目标，不得为了凑数量或时长新增剧本外事件。',
      '- location 和 scene_id 只能使用当前剧本及已提取场景；不得虚构新地点、人物、对白、冲突或结尾。',
      '- video_prompt 的时间段必须从 0 秒开始并正好覆盖 duration，不得写出超过该镜头时长的时间段。',
    ].join('\n'))
  }

  const shotDuration = normalizePositiveInteger(policy.shotDuration) || 10
  const maxTotalDuration = normalizePositiveInteger(policy.maxTotalDuration)
  const maxShots = normalizePositiveInteger(policy.maxShots)
  const hasGrokThreeMinuteCap = policy.mode === 'grok_3min' && maxTotalDuration && maxShots
  return withPerformanceAndSourceRule([
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
  ].filter(Boolean).join('\n'))
}

export function buildStoryboardAgentMessage(
  baseMessage: string,
  info: StoryboardVideoModelInfo,
  policy: StoryboardBreakdownPolicy = {},
) {
  const rule = getStoryboardVideoModelRule(info, policy)
  return rule ? [baseMessage, '', rule].join('\n') : baseMessage
}
