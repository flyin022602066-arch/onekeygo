import test from 'node:test'
import assert from 'node:assert/strict'
import { getDefaultProviderPriority } from './provider-defaults.ts'

test('Mijing is the default provider priority for text and image', () => {
  assert.ok(getDefaultProviderPriority('text', 'mijing') > getDefaultProviderPriority('text', 'eggfans'))
  assert.ok(getDefaultProviderPriority('image', 'mijing') > getDefaultProviderPriority('image', 'eggfans'))
})

test('Mijing video is preferred over official VolcEngine and Eggfans defaults', () => {
  assert.ok(getDefaultProviderPriority('video', 'mijing') > getDefaultProviderPriority('video', 'volcengine'))
  assert.ok(getDefaultProviderPriority('video', 'volcengine') > getDefaultProviderPriority('video', 'eggfans'))
})

test('audio keeps Eggfans as the default because Mijing audio is unavailable', () => {
  assert.equal(getDefaultProviderPriority('audio', 'eggfans'), 97)
  assert.equal(getDefaultProviderPriority('audio', 'mijing'), 0)
})
