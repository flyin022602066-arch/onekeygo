import test from 'node:test'
import assert from 'node:assert/strict'
import { EggfansImageAdapter } from '../eggfans-image.js'

const adapter = new EggfansImageAdapter()

test('EggfansImageAdapter builds /v1/images/generations requests without references', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gpt-image-2',
    },
    {
      id: 1,
      model: 'doubao-seedream-5-0-260128',
      prompt: 'portrait',
      size: '1920x1080',
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/v1/images/generations')
  assert.equal(req.method, 'POST')
  assert.equal(req.headers.Authorization, 'Bearer secret')
  assert.equal(req.body.model, 'doubao-seedream-5-0-260128')
  assert.equal(req.body.prompt, 'portrait')
  assert.equal(req.body.quality, undefined)
  assert.equal(req.body.response_format, 'url')
  assert.equal(req.body.watermark, false)
  assert.equal(req.body.moderation, undefined)
})

test('EggfansImageAdapter uses low moderation for gpt-image-2 generation requests', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gpt-image-2',
    },
    {
      id: 1,
      model: 'gpt-image-2',
      prompt: 'portrait',
      size: '1920x1080',
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/v1/images/generations')
  assert.equal(req.body.model, 'gpt-image-2')
  assert.equal(req.body.moderation, 'low')
  assert.equal(req.body.size, '1K')
  assert.equal(req.body.quality, 'high')
})

test('EggfansImageAdapter preserves gpt-image-2-c and applies low moderation', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gpt-image-2-c',
    },
    {
      id: 1,
      model: 'gpt-image-2-c',
      prompt: 'portrait',
      size: '1920x1080',
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/v1/images/generations')
  assert.equal(req.body.model, 'gpt-image-2-c')
  assert.equal(req.body.moderation, 'low')
  assert.equal(req.body.size, '3840x2160')
  assert.equal(req.body.quality, 'high')
})

test('EggfansImageAdapter preserves selected gpt-image-2-c generation size and auto', () => {
  const selected = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gpt-image-2-c',
    },
    {
      id: 1,
      model: 'gpt-image-2-c',
      prompt: 'landscape',
      size: '2048x1152',
    },
  )
  const automatic = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gpt-image-2-c',
    },
    {
      id: 2,
      model: 'gpt-image-2-c',
      prompt: 'portrait',
      size: 'auto',
    },
  )

  assert.equal(selected.body.size, '2048x1152')
  assert.equal(selected.body.quality, 'high')
  assert.equal(selected.body.moderation, 'low')
  assert.equal(automatic.body.size, 'auto')
})

test('EggfansImageAdapter builds multipart /v1/images/edits requests for gpt-image-2 references', async () => {
  const ref = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gpt-image-2',
    },
    {
      id: 1,
      model: 'gpt-image-2',
      prompt: 'combine these images',
      size: '1920x1080',
      referenceImages: JSON.stringify([ref, ref]),
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/v1/images/edits')
  assert.equal(req.method, 'POST')
  assert.equal(req.headers.Authorization, 'Bearer secret')
  assert.equal(req.headers.Accept, 'application/json')
  assert.equal(req.headers['Content-Type'], undefined)
  assert.equal(req.rawBody, true)
  assert.ok(req.body instanceof FormData)
  assert.equal(req.body.get('model'), 'gpt-image-2')
  assert.equal(req.body.get('prompt'), 'combine these images')
  assert.equal(req.body.get('n'), '1')
  assert.equal(req.body.get('size'), '1K')
  assert.equal(req.body.get('quality'), 'high')
  assert.equal(req.body.get('moderation'), 'low')
  assert.equal(req.body.getAll('image').length, 2)
  assert.equal((req.body.getAll('image')[0] as File).type, 'image/png')
})

test('EggfansImageAdapter uses /v1/images/edits for gpt-image-2-c references', async () => {
  const ref = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gpt-image-2-c',
    },
    {
      id: 1,
      model: 'gpt-image-2-c',
      prompt: 'combine these images',
      size: '1920x1080',
      referenceImages: JSON.stringify([ref]),
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/v1/images/edits')
  assert.ok(req.body instanceof FormData)
  assert.equal(req.body.get('model'), 'gpt-image-2-c')
  assert.equal(req.body.get('moderation'), 'low')
  assert.equal(req.body.get('size'), '3840x2160')
  assert.equal(req.body.get('quality'), 'high')
  assert.equal(req.body.getAll('image').length, 1)
})

test('EggfansImageAdapter applies selected gpt-image-2-c edit size', async () => {
  const ref = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gpt-image-2-c',
    },
    {
      id: 1,
      model: 'gpt-image-2-c',
      prompt: 'combine these images',
      size: '2160x3840',
      referenceImages: JSON.stringify([ref]),
    },
  )

  assert.ok(req.body instanceof FormData)
  assert.equal(req.body.get('size'), '2160x3840')
  assert.equal(req.body.get('quality'), 'high')
  assert.equal(req.body.get('moderation'), 'low')
})

test('EggfansImageAdapter rounds custom edit sizes up to multiples of 16', async () => {
  const ref = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gpt-image-2',
    },
    {
      id: 1,
      model: 'gpt-image-2',
      prompt: 'grid',
      size: '2880x1620',
      referenceImages: JSON.stringify([ref]),
    },
  )

  assert.equal(req.body.get('size'), '1K')
})

test('EggfansImageAdapter extracts OpenAI-style image URLs', () => {
  const result = { data: [{ url: 'https://cdn.example/image.png' }] }
  assert.deepEqual(adapter.parseGenerateResponse(result), {
    isAsync: false,
    imageUrl: 'https://cdn.example/image.png',
  })
  assert.equal(adapter.extractImageUrl(result), 'https://cdn.example/image.png')
})
