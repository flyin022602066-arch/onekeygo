function normalizeText(value) {
    return String(value || '').trim();
}
function normalizePositiveInteger(value) {
    const parsed = Math.round(Number(value || 0));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
export function isGrokTenSecondVideoModel(info) {
    const text = typeof info === 'string'
        ? info
        : [info.model, info.provider, info.label].map(normalizeText).join(' ');
    const normalized = text.toLowerCase().replace(/[\s_.-]+/g, '');
    return normalized.includes('grok') && normalized.includes('10s');
}
export function isTkOverseasStoryboardPolicy(policy) {
    return policy?.mode === 'tk_overseas';
}
const PERFORMANCE_AND_SOURCE_RULE = [
    '## 原剧本与表演/摄影硬约束',
    '- original_script（用户最初粘贴的 content）是唯一事实来源；storyboard_script 只能用于识别场景头和排版。剧情事件、对白原文、说话人、人物关系、地点、道具状态和事件顺序必须逐项保留，不得翻译、改写、总结、删减或添加剧本外内容。',
    '- 混合中英文对白时，英文原文是实际发声对白：保留英文大小写、标点、引号和说话人；英文行后中文括号只作翻译/表演提示，不得写入 dialogue、video_prompt 的发声内容。纯中文对白不得擅自翻译成英文。',
    '- 表演必须可观察且有过程：明确谁说话、谁聆听；嘴唇开合、停顿、吞咽、呼吸、语速与台词同步，听者有视线、眨眼、呼吸、重心或手部反应。情绪写成眉眼/眼睑/瞳孔/嘴角/下颌的起点→变化→落点，禁止只动嘴、全程同表情、木偶站立或无理由夸张。',
    '- 景别按叙事功能分布：建立空间使用远景/全景，关系与动作使用中景/双人中景/过肩，情绪转折使用近景，关键表情/眼神/道具结果使用特写/大特写，必要时加入细节插入。相邻镜头不得连续使用相同景别和固定机位，除非原文明确要求静止。',
    '- movement 必须使用具体专业运镜并写清起点→方向→速度→焦点变化→最终落点：推轨、拉轨、跟拍、横摇、纵摇、环绕、升降、手持微晃、焦点转移或过肩切换。运镜只改变摄影表达，不得为制造镜头变化新增剧情。每个场景至少一个建立镜头，每个关键对白段至少一个主镜头加反应近景/过肩，每个关键动作或道具结果至少一个特写/细节镜头。',
].join('\n');
function withPerformanceAndSourceRule(rule) {
    return [rule, PERFORMANCE_AND_SOURCE_RULE].filter(Boolean).join('\n');
}
function normalizeStoryboardLanguage(policy) {
    return String(policy?.language || 'zh').trim().toLowerCase() === 'en' ? 'en' : 'zh';
}
function getMiniMaxLanguageRule(policy) {
    const language = normalizeStoryboardLanguage(policy);
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
        ].join('\n');
}
export function isMiniMaxLocalEightSecondStoryboardPolicy(policy) {
    return policy?.mode === 'minimax_local_8s';
}
function getMiniMaxLocalEightSecondRule(policy) {
    const shotDuration = 8;
    const frames = shotDuration * 24;
    return [
        '## 目标视频模型规则：本地 MiniMax H3 固定 8 秒连续分镜',
        '- 这是在原有分镜拆解指令之上追加的时长与连续性合同；剧情覆盖、对白原文、角色/场景/道具绑定、摄影设计、视觉风格和所有既有字段规则保持不变。',
        `- 每个分镜的 duration 必须填数字 ${shotDuration}，不能使用浮动时长；按 24fps 设计为每镜 ${frames} 帧。`,
        `- 必须按剧本真实顺序把剧情重组为若干个完整 ${shotDuration} 秒叙事单元：内容不足时用合理的停顿、反应、微表情、视线或环境运动填满，不得新增剧情；内容过长时在自然动作或语义边界拆成下一个 ${shotDuration} 秒分镜，不得截断对白和关键动作。`,
        `- 每个 video_prompt 必须正好覆盖 0-${shotDuration} 秒，并明确写出“0秒首帧状态 -> 中段连续动作 -> ${shotDuration}秒尾帧状态”；不得写出超过 ${shotDuration} 秒的时间段。`,
        '- 参考资产硬上限：资产包括角色、场景、道具和手动参考图；镜头1最多 9 张资产（含首帧图），镜头2及以后最多 8 张剧情资产，必须预留第 1 个参考位给自动注入的上一镜尾帧，因此串行请求总参考数最多 9 张。',
        '- 输出每个镜头前必须先逐项去重并计数资产；同一资产别名、重复图片只计 1 张，重复出现也不得重复计数，不得拆分名称或重复绑定绕过上限，也不得通过额外参考图绕过上限。超出上限时只保留叙事必需资产并合并摄影表达，不得删除、改写或新增原剧本事实。',
        '- 每个 8 秒镜头必须包含 2-3 个按时间顺序连续的摄影阶段（例如 0-2.5 秒、2.5-5.5 秒、5.5-8 秒），每阶段明确景别/机位/运镜/焦点和动作变化；movement 字段必须与 video_prompt 的阶段一致。阶段之间是同一动作链的连续运镜，不是静止摆拍、幻灯片式跳切或凭空新增剧情。',
        '- 每个摄影阶段至少有一个具体运镜变化（推轨、拉轨、跟拍、横摇、纵摇、环绕、升降、焦点转移或手持微晃），写清起点→方向→速度→焦点→落点；8 秒内不得全程固定机位，也不得只写“镜头移动”。',
        '- 对白表演必须写明语气、情绪强度、语速、停顿、重音、呼吸和听者反应：中文通常按约 4-6 个字/秒、英文约 2.8-3.5 个词/秒估算，紧张/激动可自然加速，强调处短暂停顿或减速；不得无理由慢速拖字，禁止平铺直叙、只动嘴或全程同一表情。',
        '- 拆解整集前先规划完整首尾帧状态链。镜头1的首帧来自剧本开场；从镜头2开始，当前镜头的0秒首帧必须与前一镜头的最后一帧完全相同。',
        '- 相邻镜头交接时必须逐项继承：人物身份与数量、面部、服装、发型、姿态、视线、左右站位、手部状态、道具种类/数量/位置、场景结构、机位构图、光线方向和色温。首帧不得凭空新增、删除、替换或移动任何人物、道具和背景元素。',
        '- 每个镜头的 result 必须描述可直接看见的精确尾帧；下一个镜头的 image_prompt 和 video_prompt 首帧描述必须逐项复用该尾帧事实，不得只写“承接上一镜”或“保持一致”等空泛文字。',
        '- 如果下一镜需要新增人物、道具、动作或切换场景，只能在0秒首帧之后通过入画、取出、遮挡转场、运镜或剧本明确的动作自然发生；禁止在新镜头第一帧直接跳变。',
        '- video_prompt 必须把尾帧设计成稳定可提取的落点：动作已落稳、主体清晰、避免运动模糊、闪白、黑场、溶解一半或遮挡主体，便于该真实尾帧直接作为下一镜首帧。',
        '- 本地 MiniMax H3 一键串行仅使用多参考 R2V 图片列表；不得生成或填写 first_frame_url、last_frame_url，不得切换到 FL2VA/I2V。上一镜结束画面如需连续参考，只作为下一镜 Picture 1 的普通参考图，不是独立的 provider 首帧参数；Motion Context Plus 仅使用 AV latent 连续，禁止提取尾帧或把尾帧当作首帧/尾帧参数。',
        `- 调用 save_storyboards 时，所有 storyboards[].duration 都必须为数字 ${shotDuration}。`,
    ].join('\n');
}
function neutralizeMiniMaxLocalFrameTerminology(rule) {
    return String(rule || '')
        .split(/\r?\n/)
        .map(line => {
        if (/first_frame_url|last_frame_url|FL2VA\/I2V/i.test(line)) {
            return '- 本地 MiniMax H3 两种串行模式统一使用有序多参考 R2V 图片列表；标准模式将上一镜结束画面作为下一镜 Picture 1 普通参考图，Motion Context Plus 仅使用上一镜 AV latent 连续；不得填写任何独立的帧位参数。';
        }
        return line;
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
        .join('\n');
}
export function getStoryboardBreakdownModeRule(policy) {
    if (isMiniMaxLocalEightSecondStoryboardPolicy(policy))
        return withPerformanceAndSourceRule([
            getMiniMaxLocalEightSecondRule(policy),
            getMiniMaxLanguageRule(policy),
        ].map(neutralizeMiniMaxLocalFrameTerminology).join('\n'));
    if (!isTkOverseasStoryboardPolicy(policy))
        return '';
    const minShotDuration = normalizePositiveInteger(policy?.shotDurationMin) || 4;
    const maxShotDuration = normalizePositiveInteger(policy?.shotDurationMax) || 15;
    const minTotalDuration = normalizePositiveInteger(policy?.minTotalDuration) || 60;
    const maxTotalDuration = normalizePositiveInteger(policy?.maxTotalDuration) || 100;
    const minShots = normalizePositiveInteger(policy?.minShots);
    const maxShots = normalizePositiveInteger(policy?.maxShots);
    return withPerformanceAndSourceRule([
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
    ].join('\n'));
}
export function getStoryboardVideoModelRule(info, policy = {}) {
    if (isMiniMaxLocalEightSecondStoryboardPolicy(policy))
        return withPerformanceAndSourceRule([
            getMiniMaxLocalEightSecondRule(policy),
            getMiniMaxLanguageRule(policy),
        ].map(neutralizeMiniMaxLocalFrameTerminology).join('\n'));
    if (isTkOverseasStoryboardPolicy(policy))
        return getStoryboardBreakdownModeRule(policy);
    if (!isGrokTenSecondVideoModel(info)) {
        return withPerformanceAndSourceRule([
            '## 普通短剧紧凑分镜规则',
            '- duration 默认填 5；简单动作、反应和环境建立镜头使用 4-5 秒，关键对白或连续动作使用 5-7 秒。',
            '- 普通镜头 duration 必须控制在 4-7 秒，不得沿用 10-15 秒旧规则；只有目标视频模型明确要求固定时长时才覆盖本规则。',
            '- 按约 3.5-4 个中文字/秒估算对白时长，并为动作、停顿保留少量时间；对白放不下时才在自然语义边界切镜。',
            '- 同一场景、同一连续动作链、同一说话焦点应优先合并；只在场景切换、动作结果、视角重点或说话焦点明显变化时切新镜头。',
            '- 合并重复情绪、无信息过渡和空泛特写；镜头数量上限不是目标，不得为了凑数量或时长新增剧本外事件。',
            '- location 和 scene_id 只能使用当前剧本及已提取场景；不得虚构新地点、人物、对白、冲突或结尾。',
            '- video_prompt 的时间段必须从 0 秒开始并正好覆盖 duration，不得写出超过该镜头时长的时间段。',
        ].join('\n'));
    }
    const shotDuration = normalizePositiveInteger(policy.shotDuration) || 10;
    const maxTotalDuration = normalizePositiveInteger(policy.maxTotalDuration);
    const maxShots = normalizePositiveInteger(policy.maxShots);
    const hasGrokThreeMinuteCap = policy.mode === 'grok_3min' && maxTotalDuration && maxShots;
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
    ].filter(Boolean).join('\n'));
}
export function buildStoryboardAgentMessage(baseMessage, info, policy = {}) {
    const rule = getStoryboardVideoModelRule(info, policy);
    return rule ? [baseMessage, '', rule].join('\n') : baseMessage;
}
