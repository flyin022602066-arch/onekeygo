import test from 'node:test'
import assert from 'node:assert/strict'
import { MijingImageAdapter } from '../mijing-image.js'

const adapter = new MijingImageAdapter()

test('MijingImageAdapter uses configured generation and poll endpoints', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc/v1',
      apiKey: 'secret',
      model: 'Seedream5.0',
      endpoint: '/v1/images/generations',
      queryEndpoint: '/v1/images/generations/{task_id}',
    },
    {
      id: 1,
      prompt: 'portrait',
      model: 'Seedream5.0',
      size: '1920x1080',
      referenceImages: JSON.stringify(['https://cdn.example/ref.png']),
    },
  )

  assert.equal(req.url, 'https://api.mjing.cc/v1/images/generations')
  assert.equal(req.method, 'POST')
  assert.equal(req.headers.Authorization, 'Bearer secret')
  assert.equal(req.body.model, 'Seedream5.0')
  assert.equal(req.body.size, '1280x720')
  assert.equal(req.body.quality, undefined)
  assert.deepEqual(req.body.image, ['https://cdn.example/ref.png'][0])

  assert.deepEqual(adapter.parseGenerateResponse({ data: { provider_task_id: 'img-1' } }), {
    isAsync: true,
    taskId: 'mijing:img-1',
  })

  const poll = adapter.buildPollRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc',
      apiKey: 'secret',
      model: 'Seedream5.0',
      queryEndpoint: '/v1/images/generations/{task_id}',
    },
    'mijing:img-1',
  )
  assert.equal(poll.url, 'https://api.mjing.cc/v1/images/generations/img-1')

  assert.deepEqual(adapter.parsePollResponse({
    status: 'failed',
    data: { error: { message: '当前分组上游负载已饱和，请稍后再试' } },
  }), {
    status: 'failed',
    error: '当前分组上游负载已饱和，请稍后再试',
  })
})

test('Mijing gpt-image-2 uses the 1K high-quality defaults', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc',
      apiKey: 'secret',
      model: 'gpt-image-2',
      endpoint: '/v1/images/generations',
    },
    {
      id: 2,
      prompt: 'cinematic portrait',
      model: 'gpt-image-2',
      // Existing callers store the legacy canvas size; it must not leak to this model.
      size: '1920x1080',
    },
  )

  assert.equal(req.body.size, '1K')
  assert.equal(req.body.quality, 'high')
})

test('Mijing image requests use the standard gateway when the creation gateway is configured', () => {
  const req = new MijingImageAdapter().buildGenerateRequest(
    {
      provider: 'mijing',
      baseUrl: 'https://api.magine.work',
      apiKey: 'secret',
      model: 'gpt-image-2',
    },
    { id: 3, model: 'gpt-image-2', prompt: 'test', size: '1K' },
  )

  assert.equal(req.url, 'https://api.mjing.cc/v1/images/generations')
})
