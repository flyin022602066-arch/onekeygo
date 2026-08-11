import test from 'node:test'
import assert from 'node:assert/strict'
import { buildConfigTestPayload, resolveMijingBaseUrl } from './provider-config.ts'

test('resolveMijingBaseUrl selects the creation gateway for video configs', () => {
  assert.equal(resolveMijingBaseUrl('video'), 'https://api.magine.work')
  assert.equal(resolveMijingBaseUrl('text'), 'https://api.magine.work')
  assert.equal(resolveMijingBaseUrl('image'), 'https://api.magine.work')
})

test('buildConfigTestPayload keeps the saved config id so its API key can be reused', () => {
  assert.deepEqual(buildConfigTestPayload({ provider: 'mijing', api_key: '' }, 7), {
    provider: 'mijing',
    api_key: '',
    id: 7,
  })
})
