import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStoryboardAgentMessage,
  getStoryboardBreakdownModeRule,
  getStoryboardVideoModelRule,
  isGrokTenSecondVideoModel,
} from '../storyboard-video-rules.js'

test('detects Grok 10s video models from model names and labels', () => {
  assert.equal(isGrokTenSecondVideoModel({ model: 'grok-video-3-10s' }), true)
  assert.equal(isGrokTenSecondVideoModel({ model: 'GROK-VIDEO-3-10S' }), true)
  assert.equal(isGrokTenSecondVideoModel({ label: 'Eggfans Grok 10s 版' }), true)
  assert.equal(isGrokTenSecondVideoModel({ model: 'veo3.1' }), false)
})

test('Grok 10s storyboard rule forces 10-second shots and matching time blocks', () => {
  const rule = getStoryboardVideoModelRule({
    model: 'grok-video-3-10s',
    provider: 'eggfans',
    label: 'Eggfans 视频 · grok-video-3-10s',
  })

  assert.match(rule, /Grok 10s/)
  assert.match(rule, /duration.*10/)
  assert.match(rule, /0-5秒/)
  assert.match(rule, /5-10秒/)
  assert.match(rule, /save_storyboards/)
  assert.doesNotMatch(rule, /10-15 秒/)
})

test('Grok 10s storyboard rule can cap the episode breakdown to three minutes', () => {
  const rule = getStoryboardVideoModelRule({
    model: 'grok-video-3-10s',
    provider: 'eggfans',
    label: 'Eggfans 视频 · grok-video-3-10s',
  }, {
    mode: 'grok_3min',
    shotDuration: 10,
    maxTotalDuration: 180,
    maxShots: 18,
  })

  assert.match(rule, /3 分钟/)
  assert.match(rule, /180 秒/)
  assert.match(rule, /最多 18 个镜头/)
  assert.match(rule, /压缩/)
})

test('storyboard agent message appends Grok 10s rule only for Grok 10s models', () => {
  const base = '请拆解分镜并生成视频提示词。'
  const grokMessage = buildStoryboardAgentMessage(base, {
    model: 'grok-video-3-10s',
    provider: 'eggfans',
  })
  const veoMessage = buildStoryboardAgentMessage(base, { model: 'veo3.1', provider: 'eggfans' })

  assert.match(grokMessage, /目标视频模型/)
  assert.match(grokMessage, /每个镜头的 duration 必须填 10/)
  assert.match(veoMessage, /普通短剧紧凑分镜规则/)
  assert.match(veoMessage, /4-7 秒/)
  assert.doesNotMatch(veoMessage, /Grok 10s/)
})

test('storyboard agent message includes user-selected Grok breakdown limits', () => {
  const message = buildStoryboardAgentMessage('请拆解分镜并生成视频提示词。', {
    model: 'grok-video-3-10s',
    provider: 'eggfans',
  }, {
    mode: 'grok_3min',
    shotDuration: 10,
    maxTotalDuration: 180,
    maxShots: 18,
  })

  assert.match(message, /Grok 10s/)
  assert.match(message, /总时长必须控制在 180 秒以内/)
  assert.match(message, /调用 save_storyboards 时最多提交 18 个镜头/)
})

test('TK overseas rule preserves English dialogue and uses adaptive duration', () => {
  const rule = getStoryboardBreakdownModeRule({
    mode: 'tk_overseas',
    minTotalDuration: 60,
    maxTotalDuration: 100,
  })

  assert.match(rule, /TK 海外剧拆解模式/)
  assert.match(rule, /英文原文/)
  assert.match(rule, /括号内的中文是翻译或辅助说明，不是实际对白/)
  assert.match(rule, /60-100 秒/)
  assert.match(rule, /不设固定镜头数量/)
  assert.match(rule, /4-15 秒范围/)
  assert.match(rule, /12-15 秒/)
  assert.match(rule, /2\.3-2\.6 个单词\/秒/)
  assert.match(rule, /至少需要 4 个镜头/)
  assert.match(rule, /每一个场景/)
  assert.match(rule, /不得新增剧本外人物、地点、对白/)
  assert.doesNotMatch(rule, /每个镜头的 duration 必须填 10/)
})

test('TK overseas rule is selected independently of video model', () => {
  const message = buildStoryboardAgentMessage('请拆解分镜。', {
    model: 'veo3.1',
    provider: 'mijing',
  }, { mode: 'tk_overseas' })

  assert.match(message, /TK 海外剧拆解模式/)
  assert.match(message, /dialogue 和 video_prompt 中保留英文台词的原始大小写/)
})

test('explicit standard and full modes do not inherit Grok rules', () => {
  const standard = getStoryboardVideoModelRule({
    model: 'grok-video-3-10s',
    provider: 'eggfans',
  }, { mode: 'standard' })
  const full = getStoryboardVideoModelRule({
    model: 'grok-video-3-10s',
    provider: 'eggfans',
  }, { mode: 'full' })

  assert.match(standard, /普通短剧紧凑分镜规则/)
  assert.doesNotMatch(standard, /Grok 10s/)
  assert.match(full, /角色参考资产外观锁定规则/)
  assert.match(full, /角色参考资产图是人物身份和全部静态外观的唯一来源/)
  assert.doesNotMatch(full, /Grok 10s/)
})

test('explicit Grok mode wins only when selected', () => {
  const rule = getStoryboardVideoModelRule({ model: 'veo3.1', provider: 'mijing' }, {
    mode: 'grok_3min',
    shotDuration: 10,
    maxTotalDuration: 180,
    maxShots: 18,
  })

  assert.match(rule, /Grok 10s/)
  assert.match(rule, /最多 18 个镜头/)
})

test('local MiniMax mode keeps the existing breakdown contract and adds adaptive 8-10-second continuity', () => {
  const message = buildStoryboardAgentMessage('请拆解分镜并生成视频提示词。', {
    model: 'minimax-h3-local',
    provider: 'comfyui',
  }, {
    mode: 'minimax_local_8s',
    shotDuration: 5,
  })

  assert.match(message, /^请拆解分镜并生成视频提示词。/)
  assert.match(message, /本地 MiniMax H3 自适应 8-10 秒连续分镜/)
  assert.match(message, /Continuity preface is mandatory/)
  assert.match(message, /shot 1 must not mention a prior video/)
  assert.match(message, /duration 必须根据实际剧情填写 8、9 或 10 秒/)
  assert.match(message, /8 秒约 192 帧.*9 秒约 216 帧.*10 秒约 240 帧/)
  assert.match(message, /不得为了凑 8 秒截断对白/)
  assert.match(message, /当前镜头0秒必须直接继承前一镜头最后可见的时间状态和画面状态/)
  assert.match(message, /标准 R2V 串行只使用完整 <Video 1>.*不使用 Motion Context 节点/)
  assert.match(message, /不是当前镜头的结尾目标/)
  assert.match(message, /R2V/)
  assert.doesNotMatch(message, /first_frame_url|last_frame_url|FL2VA\/I2V/)
  assert.match(message, /Motion Context Plus.*AV latent/)
  assert.match(message, /新增人物、道具、动作或切换场景.*0秒开场构图之后/)
  assert.match(message, /镜头1最多 9 张资产/)
  assert.match(message, /镜头2及以后最多 9 张当前镜头剧情资产/)
  assert.match(message, /2-3 个按时间顺序连续的摄影阶段/)
  assert.match(message, /语气、情绪强度、语速、停顿、重音、呼吸/)
  assert.match(message, /说话者 -> 听者/)
  assert.match(message, /说话者看听者而非镜头/)
  assert.match(message, /dialogue 字段是唯一发声源/)
  assert.match(message, /不得写实际台词、<voice> 标签、gender\/voice_id/)
  assert.match(message, /CONTINUITY_START.*CURRENT_SHOT_PROGRESS.*CURRENT_SHOT_END/)
  assert.match(message, /不能把上一镜结尾原样当成本镜 result/)
})

test('local MiniMax storyboard rule isolates customers from the father conflict focal point', () => {
  const rule = getStoryboardBreakdownModeRule({ mode: 'minimax_local_8s' })
  assert.match(rule, /顾客、食客、客人即使有对白或举杯反应/)
  assert.match(rule, /苏大强必须是当前镜头的动作主角色和视觉主焦点/)
  assert.match(rule, /顾客对白不等于顾客主镜头/)
})

test('storyboard rules lock original screenplay facts and require expressive cinematic coverage', () => {
  const rule = getStoryboardVideoModelRule({ model: 'veo3.1', provider: 'mijing' })
  assert.match(rule, /original_script/)
  assert.match(rule, /storyboard_script/)
  assert.match(rule, /英文原文是实际发声对白/)
  assert.match(rule, /嘴唇开合/)
  assert.match(rule, /远景\/全景/)
  assert.match(rule, /特写(?:\/|、|或)大特写/)
  assert.match(rule, /远景\/全景默认 0 次/)
  assert.match(rule, /整集绝不超过 1 次/)
  assert.match(rule, /中景\/双人中景整集最多 2 次，默认只用 1 次/)
  assert.match(rule, /镜头主体默认使用近景、特写或大特写/)
  assert.match(rule, /不得因此强制使用远景\/全景/)
  assert.match(rule, /推轨、拉轨、跟拍/)
  assert.match(rule, /不得连续使用相同景别和固定机位/)
  assert.match(rule, /dialogue 字段是每个镜头实际发声台词的唯一事实来源/)
  assert.match(rule, /不得逐字重复完整 dialogue/)
  assert.match(rule, /屏幕方位\/视线落点/)
  assert.match(rule, /禁止无理由直视镜头/)
  assert.match(rule, /180 度轴线/)
})

test('storyboard rules keep relationship text separate from character asset identity', () => {
  const rule = getStoryboardBreakdownModeRule({ mode: 'minimax_local_8s' })
  assert.match(rule, /角色身份绑定必须使用上下文中的精确角色名称和 character_ids/)
  assert.match(rule, /父亲\/女儿\/老板\/同事/)
  assert.match(rule, /不能当作角色名、别名或资产身份/)
})

test('storyboard rules keep screenplay wardrobe text out of shot prompts', () => {
  const standard = getStoryboardVideoModelRule({ model: 'veo3.1', provider: 'mijing' })
  const localMiniMax = getStoryboardBreakdownModeRule({ mode: 'minimax_local_8s' })
  const full = getStoryboardVideoModelRule({ model: 'veo3.1', provider: 'mijing' }, { mode: 'full' })
  const fullSystemRule = getStoryboardBreakdownModeRule({ mode: 'full' })

  for (const rule of [standard, localMiniMax, full, fullSystemRule]) {
    assert.match(rule, /不得描述角色的脸部五官、肤色、年龄感、体型身材、头发发型发色、服装穿搭、配饰或其他外形特征/)
    assert.match(rule, /只用角色名\/role 标签指明是谁/)
    assert.match(rule, /允许并应保留剧情需要的动态表演信息：微表情、眼神、眉眼变化、嘴角变化/)
    assert.match(rule, /不得因清理静态外观而删改这些微表情、动作、对白或剧情事件/)
  }
})

test('full storyboard breakdowns also inherit the framing priority rules', () => {
  const rule = getStoryboardBreakdownModeRule({ mode: 'full' })
  assert.match(rule, /远景\/全景默认 0 次/)
  assert.match(rule, /中景\/双人中景整集最多 2 次，默认只用 1 次/)
  assert.match(rule, /镜头主体默认使用近景、特写或大特写/)
})

test('MiniMax language option switches descriptive fields without translating source dialogue', () => {
  const english = getStoryboardBreakdownModeRule({ mode: 'minimax_local_8s', language: 'en' })
  const chinese = getStoryboardBreakdownModeRule({ mode: 'minimax_local_8s', language: 'zh' })
  assert.match(english, /MiniMax 分镜输出语言：English/)
  assert.match(english, /说明字段英文/)
  assert.match(english, /没有英文原文的中文台词或旁白保留中文/)
  assert.match(chinese, /MiniMax 分镜输出语言：中文/)
  assert.match(chinese, /已有英文台词保留英文原文/)
})

test('MiniMax prompt rules follow Promptor Ref2VA identity and audio principles', () => {
  const rule = getStoryboardBreakdownModeRule({ mode: 'minimax_local_8s', language: 'en' })
  assert.match(rule, /Picture 1/)
  assert.match(rule, /唯一的标准角色资产/)
  assert.match(rule, /source_dialogue_order|说话人|S 编号/)
  assert.match(rule, /整体.*声音|overall_soundscape|环境音|音乐/)
  assert.match(rule, /参考图.*顺序|图片顺序|有序多参考|图片列表|提示词映射/)
})

test('MiniMax asset cap keeps current picture slots independent from video continuity', () => {
  const rule = getStoryboardBreakdownModeRule({ mode: 'minimax_local_8s' })
  assert.match(rule, /上一镜完整视频及其 Motion Context 尾部连续性不占用 Picture 图片位/)
  assert.match(rule, /同一资产别名、重复图片只计 1 张/)
  assert.match(rule, /不得拆分名称或重复绑定绕过上限/)
  assert.match(rule, /每个 8-10 秒镜头必须包含 2-3 个按时间顺序连续的摄影阶段/)
  assert.match(rule, /不得无理由慢速拖字/)
})
