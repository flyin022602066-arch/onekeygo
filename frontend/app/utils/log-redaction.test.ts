import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeApiLogPayload } from './log-redaction.ts'

test('sanitizeApiLogPayload redacts API keys recursively for browser logs', () => {
  const safe = sanitizeApiLogPayload({
    api_key: 'sk-eggfans-secret',
    seedance_api_key: 'ark-secret',
    nested: {
      Authorization: 'Bearer real-token',
      model: 'gpt-5.5',
    },
  })

  const serialized = JSON.stringify(safe)
  assert.doesNotMatch(serialized, /sk-eggfans-secret|ark-secret|real-token/)
  assert.match(serialized, /"api_key":"\*\*\*"/)
  assert.match(serialized, /"seedance_api_key":"\*\*\*"/)
  assert.match(serialized, /"Authorization":"\*\*\*"/)
  assert.match(serialized, /"model":"gpt-5\.5"/)
})
