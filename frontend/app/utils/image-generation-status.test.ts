import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldFinishImageRegenerationPoll } from './image-generation-status.ts'

test('image regeneration poll ignores the old asset path while the new generation is still processing', () => {
  assert.equal(
    shouldFinishImageRegenerationPoll({
      generation: { status: 'processing' },
      currentPath: 'static/images/old.png',
      previousPath: 'static/images/old.png',
    }).done,
    false,
  )
})

test('image regeneration poll finishes only when the requested generation completes with a new path', () => {
  assert.deepEqual(
    shouldFinishImageRegenerationPoll({
      generation: { status: 'completed', local_path: 'static/images/new.png' },
      currentPath: 'static/images/new.png',
      previousPath: 'static/images/old.png',
    }),
    { done: true, failed: false },
  )
})

test('image regeneration poll reports generation failure', () => {
  assert.deepEqual(
    shouldFinishImageRegenerationPoll({
      generation: { status: 'failed', error_msg: 'blocked' },
      currentPath: 'static/images/old.png',
      previousPath: 'static/images/old.png',
    }),
    { done: true, failed: true, error: 'blocked' },
  )
})
