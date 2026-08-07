import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSceneAssetPrompt,
  normalizeSceneEnvironmentDescription,
} from '../scene-image-prompt.js'

test('scene environment description removes character and plot clauses', () => {
  const result = normalizeSceneEnvironmentDescription(
    '外景，辉煌大厦门口，烈日当空，玻璃幕墙反射强光，豪车云集。林凡手捧玫瑰站在角落。王雨欣挽着赵天龙走出。',
    ['林凡', '王雨欣', '赵天龙'],
  )

  assert.match(result, /辉煌大厦门口/)
  assert.match(result, /玻璃幕墙反射强光/)
  assert.match(result, /豪车云集/)
  assert.doesNotMatch(result, /林凡|王雨欣|赵天龙/)
})

test('scene asset prompt always requires an empty environment', () => {
  const result = buildSceneAssetPrompt({
    location: '出租屋',
    time: '夜',
    prompt: '昏暗出租屋，残破灯泡发出黄光。林凡坐在床边。墙上贴满人物照片。',
    characterNames: ['林凡'],
    style: 'realistic',
  })

  assert.match(result, /绝对不能出现任何人物/)
  assert.match(result, /禁止通过镜子、玻璃反射、照片/)
  assert.match(result, /残破灯泡发出黄光/)
  assert.doesNotMatch(result, /林凡/)
  assert.doesNotMatch(result, /人物照片/)
  assert.match(result, /photorealistic live-action/)
  assert.match(result, /严禁 3D 渲染、CGI/)
})

test('TK overseas scene prompt keeps an empty international production environment', () => {
  const result = buildSceneAssetPrompt({
    location: 'Downtown apartment',
    time: 'night',
    prompt: 'Modern open-plan living room with city lights through tall windows',
    style: 'realistic',
    breakdownMode: 'tk_overseas',
  })

  assert.match(result, /TK 海外剧视觉锁定/)
  assert.match(result, /欧美或国际化空间与建筑审美/)
  assert.match(result, /无人纯环境/)
  assert.match(result, /绝对不能出现任何人物/)
})
