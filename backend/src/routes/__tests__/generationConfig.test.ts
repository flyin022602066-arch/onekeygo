import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveGenerationConfigId } from '../generationConfig.js'

test('requested generation config wins over locked episode config', () => {
  assert.equal(resolveGenerationConfigId(8, 2), 8)
  assert.equal(resolveGenerationConfigId('9', 2), 9)
})

test('falls back to locked episode config when request has no valid config', () => {
  assert.equal(resolveGenerationConfigId(undefined, 2), 2)
  assert.equal(resolveGenerationConfigId(null, 2), 2)
  assert.equal(resolveGenerationConfigId('', 2), 2)
  assert.equal(resolveGenerationConfigId('abc', 2), 2)
  assert.equal(resolveGenerationConfigId(0, 2), 2)
})

test('returns undefined when neither requested nor fallback config is valid', () => {
  assert.equal(resolveGenerationConfigId(undefined, null), undefined)
  assert.equal(resolveGenerationConfigId('abc', undefined), undefined)
  assert.equal(resolveGenerationConfigId(0, 0), undefined)
})
