import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffectiveGenerationConfigId } from './generation-config.ts'

test('resolveEffectiveGenerationConfigId prefers locked active episode config before active default', () => {
  assert.equal(
    resolveEffectiveGenerationConfigId(null, 8, [{ id: 8, is_active: true, priority: 1 }, { id: 2, is_active: true, priority: 108 }]),
    8,
  )
})

test('resolveEffectiveGenerationConfigId lets explicit active user selection override locked config', () => {
  assert.equal(
    resolveEffectiveGenerationConfigId(3, 8, [{ id: 3, is_active: true }, { id: 8, is_active: true }]),
    3,
  )
})

test('resolveEffectiveGenerationConfigId ignores inactive or missing locked configs', () => {
  assert.equal(
    resolveEffectiveGenerationConfigId(null, 8, [{ id: 8, is_active: false }, { id: 2, is_active: true, priority: 108 }]),
    2,
  )
  assert.equal(
    resolveEffectiveGenerationConfigId(9, 8, [{ id: 8, is_active: false }, { id: 2, is_active: true, priority: 108 }]),
    2,
  )
})

test('resolveEffectiveGenerationConfigId falls back to active default when no selection or lock exists', () => {
  assert.equal(
    resolveEffectiveGenerationConfigId(null, null, [{ id: 2, is_active: true, priority: 108 }]),
    2,
  )
})
