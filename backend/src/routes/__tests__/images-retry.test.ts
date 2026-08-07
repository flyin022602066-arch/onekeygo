import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveImageRetrySelection } from '../images.js'

const configs = [
  {
    id: 2,
    serviceType: 'image',
    provider: 'eggfans',
    model: JSON.stringify(['gpt-image-2-c']),
    priority: 99,
    isDefault: false,
    isActive: true,
  },
  {
    id: 65,
    serviceType: 'image',
    provider: 'mijing',
    model: JSON.stringify(['gpt-image-2']),
    priority: 0,
    isDefault: false,
    isActive: false,
  },
]

test('image retry selects the current config and exact model override', () => {
  assert.deepEqual(
    resolveImageRetrySelection(
      { provider: 'eggfans', model: 'gpt-image-2' },
      configs,
      2,
      'gpt-image-2-c',
    ),
    { configId: 2, model: 'gpt-image-2-c' },
  )
})

test('image retry can resolve a current model without a config id', () => {
  assert.deepEqual(
    resolveImageRetrySelection(
      { provider: 'eggfans', model: 'gpt-image-2' },
      configs,
      undefined,
      'gpt-image-2-c',
    ),
    { configId: 2, model: 'gpt-image-2-c' },
  )
})

test('image retry without overrides preserves the failed task model for compatibility', () => {
  assert.deepEqual(
    resolveImageRetrySelection(
      { provider: 'eggfans', model: 'gpt-image-2-c' },
      configs,
    ),
    { configId: 2, model: 'gpt-image-2-c' },
  )
})

test('image retry rejects inactive or non-image overrides', () => {
  assert.throws(
    () => resolveImageRetrySelection({ provider: 'eggfans', model: 'gpt-image-2' }, configs, 65, 'gpt-image-2'),
    /未启用/,
  )
  assert.throws(
    () => resolveImageRetrySelection({ provider: 'eggfans', model: 'gpt-image-2' }, configs, undefined, 'missing-image-model'),
    /找不到模型/,
  )
})
