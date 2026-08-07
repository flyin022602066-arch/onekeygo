import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatImageProviderFailure,
  isResumableImageGeneration,
  isRetryableImageProviderFailure,
  isStaleUnrecoverableImageGeneration,
  shouldFailImagePollImmediately,
} from '../image-generation.js'

test('isResumableImageGeneration only resumes async image tasks with task ids', () => {
  assert.equal(isResumableImageGeneration({
    status: 'processing',
    taskId: 'img-task-1',
    provider: 'eggfans',
  }), true)
  assert.equal(isResumableImageGeneration({
    status: 'queued',
    taskId: 'img-task-2',
    provider: 'volcengine',
  }), true)
  assert.equal(isResumableImageGeneration({
    status: 'completed',
    taskId: 'img-task-3',
    provider: 'eggfans',
  }), false)
  assert.equal(isResumableImageGeneration({
    status: 'processing',
    taskId: '',
    provider: 'eggfans',
  }), false)
})

test('shouldFailImagePollImmediately fails client-side poll errors instead of waiting for timeout', () => {
  assert.equal(shouldFailImagePollImmediately(400), true)
  assert.equal(shouldFailImagePollImmediately(401), true)
  assert.equal(shouldFailImagePollImmediately(404), true)
  assert.equal(shouldFailImagePollImmediately(408), false)
  assert.equal(shouldFailImagePollImmediately(429), false)
  assert.equal(shouldFailImagePollImmediately(500), false)
  assert.equal(shouldFailImagePollImmediately(503), false)
})

test('Mijing saturated-upstream failures are retryable and get a useful final message', () => {
  const error = '当前分组上游负载已饱和，请稍后再试'
  assert.equal(isRetryableImageProviderFailure('mijing', error), true)
  assert.equal(isRetryableImageProviderFailure('mijing', 'API error 503: unavailable'), true)
  assert.equal(isRetryableImageProviderFailure('eggfans', error), false)
  assert.match(formatImageProviderFailure('mijing', error, 1), /已自动重试 1 次仍未恢复/)
})

test('stale image generations without task ids are unrecoverable', () => {
  const now = Date.parse('2026-05-27T10:00:00.000Z')
  assert.equal(isStaleUnrecoverableImageGeneration({
    status: 'processing',
    taskId: '',
    createdAt: '2026-05-27T09:30:00.000Z',
    updatedAt: '2026-05-27T09:30:00.000Z',
  }, now), true)
  assert.equal(isStaleUnrecoverableImageGeneration({
    status: 'processing',
    taskId: 'task-1',
    createdAt: '2026-05-27T09:30:00.000Z',
    updatedAt: '2026-05-27T09:30:00.000Z',
  }, now), false)
  assert.equal(isStaleUnrecoverableImageGeneration({
    status: 'completed',
    taskId: '',
    createdAt: '2026-05-27T09:30:00.000Z',
    updatedAt: '2026-05-27T09:30:00.000Z',
  }, now), false)
})

test('image provider failures preserve actionable upstream details', () => {
  const message = 'API error 401: {"error":{"code":"AuthenticationError","message":"key is invalid"}}'
  assert.equal(formatImageProviderFailure('eggfans', message), message)
  assert.match(formatImageProviderFailure('mijing', '当前分组上游负载已饱和（request id: abc）', 1), /request id: abc/)
})
