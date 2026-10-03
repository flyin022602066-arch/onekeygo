import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendVideoNegativePrompt,
  stripVideoNegativePrompt,
  VIDEO_NEGATIVE_PROMPT,
} from '../video-negative-prompt.js'

test('video negative prompt covers identity, continuity, physics, vfx and cinematic defects', () => {
  assert.match(VIDEO_NEGATIVE_PROMPT, /变脸、换人、五官漂移/)
  assert.match(VIDEO_NEGATIVE_PROMPT, /塑料皮肤、过度磨皮/)
  assert.match(VIDEO_NEGATIVE_PROMPT, /手指错误、多手多脚/)
  assert.match(VIDEO_NEGATIVE_PROMPT, /瞬移、无过程换位、反轴/)
  assert.match(VIDEO_NEGATIVE_PROMPT, /武器凭空换手、道具消失/)
  assert.match(VIDEO_NEGATIVE_PROMPT, /假打、未接触却击中、无受力反馈/)
  assert.match(VIDEO_NEGATIVE_PROMPT, /能量凭空出现、特效无传播路径/)
  assert.match(VIDEO_NEGATIVE_PROMPT, /游戏 UI、动画感、漫画感、2.5D、3D 动漫/)
  assert.match(VIDEO_NEGATIVE_PROMPT, /气泡音效/)
})

test('video negative prompt preserves valid dialogue and sound channels', () => {
  assert.match(VIDEO_NEGATIVE_PROMPT, /只有 bgm_prompt 明确要求的配乐才能保留/)
  assert.match(VIDEO_NEGATIVE_PROMPT, /不得覆盖剧本对白、sound_effect、环境声/)
  assert.match(VIDEO_NEGATIVE_PROMPT, /禁止把人物介绍、角色档案、动作说明或环境描述变成旁白/)
})

test('video negative prompt injection is idempotent and removable', () => {
  const first = appendVideoNegativePrompt('人物看向门口。')
  const second = appendVideoNegativePrompt(first)

  assert.equal(first, second)
  assert.equal((second.match(/视频画面负面约束（自动注入 BEGIN）/g) || []).length, 1)
  assert.equal(stripVideoNegativePrompt(first), '人物看向门口。')
  assert.equal(stripVideoNegativePrompt(''), '')
})
