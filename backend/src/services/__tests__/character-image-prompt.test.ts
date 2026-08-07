import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCharacterDesignPrompt } from '../character-image-prompt.js'

test('buildCharacterDesignPrompt creates a horizontal turntable design sheet prompt', () => {
  const prompt = buildCharacterDesignPrompt({
    name: '陈风',
    role: '男主',
    appearance: '28岁中国男性，短发，白衬衫，黑色西裤，疲惫但坚毅',
    description: '深夜公司职员',
    personality: '谨慎、压抑、责任感强',
    style: 'realistic',
  })

  assert.match(prompt, /横版/)
  assert.match(prompt, /16:9/)
  assert.match(prompt, /最左侧.*人物上半身/)
  assert.match(prompt, /第2区.*正面全身/)
  assert.match(prompt, /第3区.*侧面全身/)
  assert.match(prompt, /第4区.*背面全身/)
  assert.match(prompt, /只允许.*四个分区/)
  assert.match(prompt, /总计四个角色呈现/)
  assert.match(prompt, /禁止.*四分之三视角/)
  assert.match(prompt, /禁止.*额外视角/)
  assert.match(prompt, /禁止.*第五视图/)
  assert.match(prompt, /禁止.*左右两个侧面/)
  assert.match(prompt, /人物上半身照/)
  assert.match(prompt, /同一个角色/)
  assert.match(prompt, /固定服装/)
  assert.match(prompt, /不要生成剧情场景/)
  assert.match(prompt, /photorealistic live-action/)
  assert.match(prompt, /不要磨皮、不要美颜/)
  assert.match(prompt, /严禁 3D 渲染、CGI/)
  assert.doesNotMatch(prompt, /随便/)
})

test('TK overseas character prompt locks international casting and rejects East Asian defaults', () => {
  const prompt = buildCharacterDesignPrompt({
    name: 'Emma',
    role: 'lead',
    appearance: 'young corporate lawyer in a navy suit',
    style: 'realistic',
    breakdownMode: 'tk_overseas',
  })

  assert.match(prompt, /TK 海外剧视觉锁定/)
  assert.match(prompt, /欧美\/国际真人影视/)
  assert.match(prompt, /非东亚面孔/)
  assert.match(prompt, /不要输出东亚默认脸/)
})
