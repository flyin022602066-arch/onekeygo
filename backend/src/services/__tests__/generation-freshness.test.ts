import test from 'node:test'
import assert from 'node:assert/strict'
import { isLatestGeneration, latestGenerationId } from '../generation-freshness.js'

test('generation freshness uses creation order instead of completion order', () => {
  const rows = [
    { id: 101, status: 'completed', completedAt: '2026-08-06T12:10:00.000Z' },
    { id: 102, status: 'processing', completedAt: null },
  ]
  assert.equal(latestGenerationId(rows), 102)
  assert.equal(isLatestGeneration(rows, 101), false)
  assert.equal(isLatestGeneration(rows, 102), true)
})
