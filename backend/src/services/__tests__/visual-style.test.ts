import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPhotorealisticImageDetailLock,
  buildVisualStyleLock,
  getVisualStyleSpec,
  withVisualStyleLock,
} from '../visual-style.js'

test('realistic visual style explicitly requires live action and rejects 3D rendering', () => {
  const lock = buildVisualStyleLock('realistic', '测试画面')

  assert.match(lock, /写实真人/)
  assert.match(lock, /photorealistic live-action/)
  assert.match(lock, /真实皮肤纹理、发丝和布料材质/)
  assert.match(lock, /严禁 3D 渲染、CGI/)
})

test('realistic image detail lock requires natural skin texture and rejects beauty retouching', () => {
  const lock = buildPhotorealisticImageDetailLock('realistic', '首帧')

  assert.match(lock, /毛孔/)
  assert.match(lock, /细纹/)
  assert.match(lock, /皮肤瑕疵/)
  assert.match(lock, /不要磨皮、不要美颜/)
  assert.match(lock, /主光方向/)
  assert.match(lock, /高光滚降/)
  assert.match(lock, /4K UHD/)
  assert.match(lock, /3840x2160/)
  assert.match(lock, /45°/)
  assert.match(lock, /4300K/)
  assert.match(lock, /不要低清/)
})

test('non-photorealistic image styles do not receive live-action skin instructions', () => {
  assert.equal(buildPhotorealisticImageDetailLock('anime', '首帧'), '')
})

test('withVisualStyleLock keeps content and replaces any previous lock', () => {
  const prompt = withVisualStyleLock(
    '镜头正文\n视觉风格锁定（旧画面，项目风格=漫画）：旧规则。\n动作结果',
    'anime',
    '新画面',
  )

  assert.match(prompt, /镜头正文/)
  assert.match(prompt, /动作结果/)
  assert.match(prompt, /项目风格=二维动漫/)
  assert.doesNotMatch(prompt, /旧规则/)
  assert.equal(prompt.match(/视觉风格锁定（/g)?.length, 1)
})

test('unknown legacy style values safely use the realistic project default', () => {
  assert.equal(getVisualStyleSpec('现实主义年代剧').value, 'realistic')
})
