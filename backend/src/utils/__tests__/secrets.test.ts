import assert from 'node:assert/strict'
import test from 'node:test'

import { maskSecret, sanitizeAiConfigForClient, sanitizeForLog } from '../secrets.js'

test('sanitizeAiConfigForClient never exposes stored API keys', () => {
  const safe = sanitizeAiConfigForClient({
    id: 1,
    provider: 'openai',
    api_key: 'sk-real-secret',
    model: ['gpt-test'],
  })

  assert.equal(safe.api_key, '')
  assert.equal(safe.has_api_key, true)
  assert.equal(JSON.stringify(safe).includes('sk-real-secret'), false)
})

test('maskSecret gives users a stable hint without leaking the full secret', () => {
  assert.equal(maskSecret('sk-abcdefghijklmnopqrstuvwxyz'), 'sk-a...wxyz')
  assert.equal(maskSecret('short'), '***')
  assert.equal(maskSecret(''), '')
})

test('sanitizeForLog redacts sensitive JSON request bodies recursively', () => {
  const redacted = sanitizeForLog(JSON.stringify({
    api_key: 'sk-real-secret',
    nested: { Authorization: 'Bearer token-value' },
    safe: 'kept',
  }), 'application/json')

  assert.match(redacted, /"api_key":"\*\*\*"/)
  assert.match(redacted, /"Authorization":"\*\*\*"/)
  assert.match(redacted, /"safe":"kept"/)
  assert.doesNotMatch(redacted, /sk-real-secret|token-value/)
})
