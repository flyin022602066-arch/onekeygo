import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPropAssetPrompt } from '../prop-image-prompt.js'

test('prop asset prompt isolates one prop and excludes people and text', () => {
  const prompt = buildPropAssetPrompt({
    name: '旧怀表',
    type: '随身物品',
    description: '黄铜外壳，表盖有划痕',
  })

  assert.match(prompt, /旧怀表/)
  assert.match(prompt, /黄铜外壳/)
  assert.match(prompt, /单个物件/)
  assert.match(prompt, /不要人物/)
  assert.match(prompt, /不要.*文字/)
})
