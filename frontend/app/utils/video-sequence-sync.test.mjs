import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isCurrentVideoGeneration,
  markFinalizedSequenceGeneration,
  sanitizeSequenceSnapshot,
  sequenceGenerationIdsToRefresh,
  sequenceVideoElementKey,
  sequenceVideoPosterPath,
  selectLatestVideoGeneration,
  versionedLocalVideoPath,
  videoGenerationPlaybackPath,
} from './video-sequence-sync.mjs'

test('local ComfyUI playback prefers the downloaded MP4 and falls back to the original URL', () => {
  const generation = { provider: 'comfyui', video_url: 'http://localhost:8188/view?filename=shot.mp4', local_path: 'static/videos/shot.mp4' }
  assert.equal(videoGenerationPlaybackPath(generation), 'static/videos/shot.mp4')
  assert.equal(videoGenerationPlaybackPath({ provider: 'comfyui', localPath: 'static/videos/shot.mp4' }), 'static/videos/shot.mp4')
  assert.equal(videoGenerationPlaybackPath({ ...generation, local_path: '' }), generation.video_url)
  assert.equal(videoGenerationPlaybackPath(null), null)
})

test('local playback preference does not alter remote provider selection', () => {
  for (const provider of ['autodl_comfyui', 'mijing', 'volcengine', 'openai', undefined]) {
    const generation = { provider, videoUrl: 'https://example.test/shot.mp4', local_path: 'static/videos/shot.mp4' }
    assert.equal(videoGenerationPlaybackPath(generation), generation.videoUrl)
    assert.equal(videoGenerationPlaybackPath({ ...generation, videoUrl: undefined }), null)
  }
})

test('a completed local video is refreshed through step completion to collect the downloaded path', () => {
  const finalizedIds = new Set()
  const generation = { id: 248, provider: 'comfyui', status: 'completed', video_url: 'http://localhost:8188/view?filename=shot.mp4' }
  const processing = { video_generation_id: 248, status: 'processing' }
  const completed = { ...processing, status: 'completed' }
  assert.deepEqual(sequenceGenerationIdsToRefresh([processing], [generation], finalizedIds), [248])
  markFinalizedSequenceGeneration(processing, finalizedIds)
  assert.deepEqual(sequenceGenerationIdsToRefresh([completed], [generation], finalizedIds), [248])
  const refreshed = { ...generation, local_path: 'static/videos/shot.mp4' }
  markFinalizedSequenceGeneration(completed, finalizedIds)
  assert.deepEqual(sequenceGenerationIdsToRefresh([completed], [refreshed], finalizedIds), [])
  assert.equal(videoGenerationPlaybackPath(refreshed), refreshed.local_path)
})

test('local H3 generation from before storyboard re-decomposition is not current', () => {
  assert.equal(isCurrentVideoGeneration({
    id: 12,
    provider: 'comfyui',
    reference_mode: 'multiple',
    created_at: '2026-09-01T10:00:00.000Z',
    prompt: 'ordered R2V picture mapping',
  }, { id: 7, updated_at: '2026-09-01T11:00:00.000Z' }), false)
})

test('local H3 generation with legacy frame contract is not current', () => {
  assert.equal(isCurrentVideoGeneration({
    id: 13,
    provider: 'comfyui',
    reference_mode: 'multiple',
    created_at: '2026-09-01T12:00:00.000Z',
    prompt: 'previous shot tail frame must be frame 0',
  }, { id: 7, updated_at: '2026-09-01T11:00:00.000Z' }), false)
})

test('local H3 generation from the other isolated continuity mode is not current', () => {
  const generation = {
    id: 14,
    provider: 'comfyui',
    reference_mode: 'multiple',
    continuity_mode: 'standard_r2v',
    created_at: '2026-09-01T12:00:00.000Z',
    prompt: 'ordered R2V picture mapping',
  }
  assert.equal(isCurrentVideoGeneration(generation, { id: 7, updated_at: '2026-09-01T11:00:00.000Z' }, 'comfyui', 'latent_plus'), false)
  assert.equal(isCurrentVideoGeneration({ ...generation, continuity_mode: 'latent_plus' }, { id: 7, updated_at: '2026-09-01T11:00:00.000Z' }, 'comfyui', 'latent_plus'), true)
})

test('completed local preview selects the generation matching the restored UI mode', () => {
  const generation = {
    id: 15,
    provider: 'comfyui',
    reference_mode: 'multiple',
    continuity_mode: 'latent_plus',
    status: 'completed',
    video_url: 'static/videos/shot-1.mp4',
    created_at: '2026-09-01T12:00:00.000Z',
  }
  assert.equal(
    selectLatestVideoGeneration([generation], { id: 7, updated_at: '2026-09-01T11:00:00.000Z' }, 'comfyui', 'latent_plus')?.id,
    15,
  )
})

test('Plus snapshot sanitization removes legacy frame state from cached responses', () => {
  const sanitized = sanitizeSequenceSnapshot({
    continuity_mode: 'latent_plus',
    steps: [{
      status: 'extracting_tail',
      first_frame_url: 'static/tail.png',
      tail_frame_url: 'static/tail-2.png',
      asset_refs: JSON.stringify([{ role: 'first_frame', url: 'static/tail.png' }, { role: 'character', name: '凤溪' }]),
    }],
  })
  assert.equal(sanitized.steps[0].status, 'processing')
  assert.equal(sanitized.steps[0].first_frame_url, null)
  assert.equal(sanitized.steps[0].tail_frame_url, null)
})

test('completed serial video uses the real first-frame reference as its poster', () => {
  const generation = {
    id: 65,
    status: 'completed',
    first_frame_url: 'static/sequence-frames/tail-shot-4.png',
    updated_at: '2026-08-29T04:26:33.997Z',
  }
  assert.equal(
    sequenceVideoPosterPath(generation),
    'static/sequence-frames/tail-shot-4.png?v=2026-08-29T04%3A26%3A33.997Z',
  )
})

test('video element key changes when a generation is finalised in place', () => {
  const before = { id: 65, updated_at: 'before' }
  const after = { id: 65, updated_at: 'after' }
  const videoPath = versionedLocalVideoPath('static/videos/shot-5.mp4', after)

  assert.notEqual(
    sequenceVideoElementKey(45, videoPath, before),
    sequenceVideoElementKey(45, videoPath, after),
  )
})

test('unfinished generation does not expose a stale opening poster', () => {
  assert.equal(sequenceVideoPosterPath({ status: 'processing', first_frame_url: 'static/tail.png' }), '')
})
