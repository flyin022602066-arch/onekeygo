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
  assert.match(rule, /4-10 秒/)
  assert.match(rule, /11-15 秒/)
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
