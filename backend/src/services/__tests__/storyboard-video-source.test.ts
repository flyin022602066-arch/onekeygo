import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getStoryboardVideoSource,
  groupVideoGenerationsByStoryboard,
  isCompletedVideoGeneration,
  pickLatestCompletedVideoGeneration,
} from '../storyboard-video-source.js'

test('storyboard video source prefers the newest completed generation over stale storyboard video_url', () => {
  const source = getStoryboardVideoSource(
    { id: 7, videoUrl: 'static/videos/old.mp4' },
    [
      { id: 1, storyboardId: 7, status: 'completed', localPath: 'static/videos/older.mp4', updatedAt: '2026-05-26T10:00:00.000Z' },
      { id: 2, storyboardId: 7, status: 'completed', localPath: 'static/videos/new.mp4', updatedAt: '2026-05-27T10:00:00.000Z' },
    ],
  )

  assert.equal(source?.videoUrl, 'static/videos/new.mp4')
  assert.equal(source?.source, 'generation-local')
  assert.equal(source?.generation?.id, 2)
})

test('storyboard video source does not fall back to an old video while the newest task is running', () => {
  assert.equal(getStoryboardVideoSource(
    { id: 7, videoUrl: 'static/videos/old.mp4' },
    [
      { id: 10, storyboardId: 7, status: 'completed', localPath: 'static/videos/old.mp4' },
      { id: 11, storyboardId: 7, status: 'processing', localPath: '', videoUrl: '' },
    ],
  ), null)
})

test('storyboard video source falls back to remote completed generation and then storyboard field', () => {
  assert.deepEqual(getStoryboardVideoSource(
    { id: 8, videoUrl: '' },
    [{ id: 3, storyboardId: 8, status: 'completed', videoUrl: 'https://cdn.example/video.mp4' }],
  ), {
    videoUrl: 'https://cdn.example/video.mp4',
    source: 'generation-remote',
    generation: { id: 3, storyboardId: 8, status: 'completed', videoUrl: 'https://cdn.example/video.mp4' },
  })

  assert.deepEqual(getStoryboardVideoSource({ id: 9, videoUrl: 'static/videos/manual.mp4' }, []), {
    videoUrl: 'static/videos/manual.mp4',
    source: 'storyboard',
  })
})

test('video generation helpers ignore failed or empty completed records', () => {
  assert.equal(isCompletedVideoGeneration({ status: 'failed', localPath: 'static/videos/a.mp4' }), false)
  assert.equal(isCompletedVideoGeneration({ status: 'completed', localPath: '' }), false)
  assert.equal(isCompletedVideoGeneration({ status: 'completed', localPath: 'static/videos/old.mp4', deletedAt: '2026-08-05T00:00:00.000Z' }), false)
  assert.equal(isCompletedVideoGeneration({ status: 'completed', localPath: 'static/videos/a.mp4' }), true)
  assert.equal(pickLatestCompletedVideoGeneration([
    { id: 1, storyboardId: 1, status: 'processing', localPath: 'static/videos/a.mp4' },
    { id: 2, storyboardId: 2, status: 'completed', localPath: 'static/videos/b.mp4' },
  ], 1), null)
})

test('video generations are grouped by storyboard id', () => {
  const grouped = groupVideoGenerationsByStoryboard([
    { id: 1, storyboardId: 1 },
    { id: 2, storyboardId: 1 },
    { id: 3, storyboardId: 2 },
    { id: 4, storyboardId: null },
  ])

  assert.deepEqual(grouped.get(1)?.map(item => item.id), [1, 2])
  assert.deepEqual(grouped.get(2)?.map(item => item.id), [3])
  assert.equal(grouped.has(0), false)
})
