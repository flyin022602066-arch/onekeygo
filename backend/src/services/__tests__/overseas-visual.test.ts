import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTkOverseasVisualLock,
  buildTkEnglishDialogueLock,
  isTkOverseasMode,
  stripTkOverseasVisualLock,
  withTkOverseasVisualLock,
} from '../overseas-visual.js'

test('TK English dialogue lock forbids translation and preserves canonical lines', () => {
  const lock = buildTkEnglishDialogueLock()
  assert.match(lock, /Do not translate/)
  assert.match(lock, /Preserve English dialogue verbatim/)
})

test('TK overseas mode is explicit and does not affect ordinary projects', () => {
  assert.equal(isTkOverseasMode('tk_overseas'), true)
  assert.equal(isTkOverseasMode('standard'), false)
  assert.equal(withTkOverseasVisualLock('base prompt', 'standard'), 'base prompt')
})

test('TK overseas visual lock covers casting, environment, and explicit-script exceptions', () => {
  const lock = buildTkOverseasVisualLock('test')
  assert.match(lock, /非东亚面孔/)
  assert.match(lock, /欧美或国际化影视环境/)
  assert.match(lock, /剧本明确指定/)
})

test('TK overseas visual lock replaces stale duplicate blocks instead of appending them', () => {
  const oldLock = buildTkOverseasVisualLock('旧用途')
  const prompt = withTkOverseasVisualLock(`镜头正文\n${oldLock}\n${oldLock}`, 'tk_overseas', '新用途')

  assert.equal((prompt.match(/TK 海外剧视觉锁定（/g) || []).length, 1)
  assert.match(prompt, /新用途/)
  assert.doesNotMatch(prompt, /旧用途/)
  assert.equal(stripTkOverseasVisualLock(prompt), '镜头正文')
})
