import test from 'node:test'
import assert from 'node:assert/strict'
import { GrokOpenAIVideoAdapter } from '../grok-openai-video.js'

const adapter = new GrokOpenAIVideoAdapter()

const config = {
  provider: 'grok_openai',
  baseUrl: 'https://api.aigcly.top',
  apiKey: 'grok-test-key',
  model: 'grok-imagine-video',
  endpoint: '/v1/videos/generations',
  queryEndpoint: '/v1/videos/{id}',
  settings: { grokOpenai: { defaults: { resolution: '720p' } } },
}

test('GrokOpenAIVideoAdapter builds the OpenAI-compatible multi-reference request', () => {
  const req = adapter.buildGenerateRequest(config, {
    id: 1,
    model: 'grok-imagine-video',
    prompt: 'A cinematic live-action shot',
    referenceMode: 'multiple',
    referenceImageUrls: JSON.stringify([
      'https://cdn.example/role.png',
      'data:image/png;base64,ZmFrZQ==',
    ]),
    duration: 10,
    aspectRatio: '9:16',
  })

  assert.equal(req.url, 'https://api.aigcly.top/v1/videos/generations')
  assert.equal(req.method, 'POST')
  assert.equal(req.headers.Authorization, 'Bearer grok-test-key')
  assert.deepEqual(req.body, {
    model: 'grok-imagine-video',
    prompt: 'A cinematic live-action shot',
    duration: 10,
    aspect_ratio: '9:16',
    resolution: '720p',
    reference_images: [
      { url: 'https://cdn.example/role.png' },
      { url: 'data:image/png;base64,ZmFrZQ==' },
    ],
  })
  assert.equal(JSON.stringify(req.body).includes('@asset://'), false)
})
test('GrokOpenAIVideoAdapter uses the single image field only for single-reference mode', () => {
  const req = adapter.buildGenerateRequest(config, {
    id: 2,
    prompt: 'Use this image as the visual reference',
    referenceMode: 'single',
    imageUrl: 'https://cdn.example/start.png',
    duration: 3,
  })

  assert.deepEqual(req.body.image, { url: 'https://cdn.example/start.png' })
  assert.equal(req.body.reference_images, undefined)
  assert.equal(req.body.duration, 3)
})

test('GrokOpenAIVideoAdapter caps references at seven and keeps the first frame first', () => {
  const references = Array.from({ length: 9 }, (_, index) => `https://cdn.example/ref-${index + 1}.png`)
  const req = adapter.buildGenerateRequest(config, {
    id: 3,
    prompt: 'Continue from the first frame',
    referenceMode: 'first_frame_multiple',
    firstFrameUrl: 'https://cdn.example/tail.png',
    referenceImageUrls: JSON.stringify(references),
    duration: 15,
  })

  assert.deepEqual(req.body.reference_images, [
    { url: 'https://cdn.example/tail.png' },
    ...references.slice(0, 6).map(url => ({ url })),
  ])
  assert.equal(req.body.reference_images.length, 7)
})

test('GrokOpenAIVideoAdapter builds polling requests and parses async completion', () => {
  const poll = adapter.buildPollRequest(config, 'grok-openai:req-123')
  assert.equal(poll.url, 'https://api.aigcly.top/v1/videos/req-123')
  assert.equal(poll.method, 'GET')
  assert.equal(poll.headers.Authorization, 'Bearer grok-test-key')

  assert.deepEqual(adapter.parseGenerateResponse({ request_id: 'req-123', status: 'queued' }), {
    isAsync: true,
    taskId: 'grok-openai:req-123',
  })
  assert.deepEqual(adapter.parsePollResponse({
    status: 'completed',
    data: { video_url: 'https://cdn.example/result.mp4' },
  }), {
    status: 'completed',
    videoUrl: 'https://cdn.example/result.mp4',
  })
})
