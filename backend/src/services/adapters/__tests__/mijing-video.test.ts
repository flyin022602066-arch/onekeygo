import test from 'node:test'
import assert from 'node:assert/strict'
import { MijingVideoAdapter } from '../mijing-video.js'

const adapter = new MijingVideoAdapter()

test('MijingVideoAdapter builds Seedance 2.0 creation requests with top-level fields', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc',
      apiKey: 'secret',
      model: 'seedance2.0创作版',
      endpoint: '/v1/video/generations',
      queryEndpoint: '/v1/video/generations/{task_id}',
      settings: { mijing: { defaults: { resolution: '720p' } } },
    },
    {
      id: 1,
      model: 'seedance2.0创作版',
      prompt: 'cinematic scene',
      referenceMode: 'multiple',
      referenceImageUrls: JSON.stringify([
        'https://cdn.example/role.png',
        'https://cdn.example/scene.png',
      ]),
      duration: 11,
      aspectRatio: '16:9',
    },
  )

  assert.equal(req.url, 'https://api.magine.work/v1/video/generations')
  assert.equal(req.method, 'POST')
  assert.equal(req.headers.Authorization, 'Bearer secret')
  assert.equal(req.body.model, 'seedance2.0创作版')
  assert.equal(req.body.prompt, 'cinematic scene')
  assert.equal(req.body.duration, 11)
  assert.equal(req.body.ratio, '16:9')
  assert.equal(req.body.watermark, false)
  assert.equal(req.body.generate_audio, true)
  assert.equal(req.body.resolution, '720p')
  assert.deepEqual(req.body.reference_image_urls, [
    'https://cdn.example/role.png',
    'https://cdn.example/scene.png',
  ])
  assert.equal('image_url' in req.body, false)
})

test('MijingVideoAdapter keeps documented resolution values and clamps duration to the creation API limit', () => {
  const adapter = new MijingVideoAdapter()
  const req = adapter.buildGenerateRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.magine.work',
      apiKey: 'secret',
      model: 'seedance2.0创作版',
      settings: { mijing: { defaults: { resolution: '4k' } } },
    },
    { id: 7, prompt: 'test', duration: 45 },
  )

  assert.equal(req.body.resolution, '4k')
  assert.equal(req.body.duration, 30)
})

test('MijingVideoAdapter builds mutually exclusive first-last frame requests', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc/v1',
      apiKey: 'secret',
      model: 'seedance2.0创作版',
    },
    {
      id: 2,
      prompt: 'start to end',
      referenceMode: 'first_last',
      firstFrameUrl: 'https://cdn.example/start.png',
      lastFrameUrl: 'https://cdn.example/end.png',
      duration: 5,
      aspectRatio: '9:16',
    },
  )

  assert.equal(req.url, 'https://api.magine.work/v1/video/generations')
  assert.equal(req.body.image_url, 'https://cdn.example/start.png')
  assert.equal(req.body.image_end_url, 'https://cdn.example/end.png')
  assert.equal(req.body.image_role, 'first_last_frames')
  assert.equal(req.body.reference_image_urls, undefined)
  assert.equal(req.body.ratio, '9:16')
})

test('MijingVideoAdapter keeps the continuity frame first in mixed references', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc',
      apiKey: 'secret',
      model: 'seedance2.0创作版',
    },
    {
      id: 3,
      prompt: 'continue the shot',
      referenceMode: 'first_frame_multiple',
      firstFrameUrl: 'https://cdn.example/tail.png',
      referenceImageUrls: JSON.stringify([
        'https://cdn.example/role.png',
        'https://cdn.example/scene.png',
      ]),
      duration: 8,
      aspectRatio: '16:9',
    },
  )

  assert.deepEqual(req.body.reference_image_urls, [
    'https://cdn.example/tail.png',
    'https://cdn.example/role.png',
    'https://cdn.example/scene.png',
  ])
  assert.equal(req.body.image_url, undefined)
  assert.equal(req.body.image_role, undefined)
  assert.equal(req.body.image_end_url, undefined)
})

test('MijingVideoAdapter forwards Volc Asset URIs for serial continuity and semantic references', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc',
      apiKey: 'secret',
      model: 'seedance2.0创作版',
    },
    {
      id: 4,
      prompt: 'continue with the same characters',
      referenceMode: 'first_frame_multiple',
      firstFrameUrl: 'Asset://asset-tail',
      referenceImageUrls: JSON.stringify([
        'Asset://asset-role',
        'Asset://asset-scene',
        'Asset://asset-prop',
      ]),
      duration: 5,
      aspectRatio: '16:9',
    },
  )

  assert.deepEqual(req.body.reference_image_urls, [
    'Asset://asset-tail',
    'Asset://asset-role',
    'Asset://asset-scene',
    'Asset://asset-prop',
  ])
  assert.equal(req.body.image_url, undefined)
  assert.equal(req.body.image_role, undefined)
})

test('MijingVideoAdapter routes the creation model through the documented gateway', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc',
      apiKey: 'secret',
      model: 'seedance2.0创作版',
    },
    { id: 5, prompt: 'cinematic shot', model: 'seedance2.0创作版' },
  )

  assert.equal(req.url, 'https://api.magine.work/v1/video/generations')
})

test('MijingVideoAdapter migrates legacy Mijing video URLs without changing the selected model', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc',
      apiKey: 'secret',
      model: '山河2.0-mini',
    },
    { id: 6, prompt: 'cinematic shot', model: '山河2.0-mini' },
  )

  assert.equal(req.url, 'https://api.magine.work/v1/video/generations')
  assert.equal(req.body.model, '山河2.0-mini')
})

test('MijingVideoAdapter parses task ids and poll responses', () => {
  assert.deepEqual(adapter.parseGenerateResponse({
    success: true,
    data: { provider_task_id: 'task-123', raw: { id: 'raw-123' } },
  }), {
    isAsync: true,
    taskId: 'mijing:video:task-123',
  })

  const poll = adapter.buildPollRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc',
      apiKey: 'secret',
      model: 'seedance2.0创作版',
      queryEndpoint: '/v1/video/generations/{task_id}',
    },
    'mijing:video:task-123',
  )
  assert.equal(poll.url, 'https://api.magine.work/v1/video/generations/task-123')

  assert.deepEqual(adapter.parsePollResponse({
    data: {
      status: 'succeeded',
      video_url: 'https://cdn.example/video.mp4',
    },
  }), {
    status: 'completed',
    videoUrl: 'https://cdn.example/video.mp4',
  })
})

test('MijingVideoAdapter reads creation API result_url on completed tasks', () => {
  const adapter = new MijingVideoAdapter()
  const poll = adapter.parsePollResponse({
    id: 13758,
    status: 'success',
    result_url: 'https://media.magine.work/video.mp4',
  })

  assert.deepEqual(poll, {
    status: 'completed',
    videoUrl: 'https://media.magine.work/video.mp4',
  })
})
