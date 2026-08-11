import test from 'node:test'
import assert from 'node:assert/strict'
import { EggfansVideoAdapter } from '../eggfans-video.js'

const adapter = new EggfansVideoAdapter()

test('EggfansVideoAdapter builds HappyHorse AliBailian video requests', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'happyhorse-1.0-i2v',
    },
    {
      id: 1,
      model: 'happyhorse-1.0-i2v',
      prompt: 'cat running',
      referenceMode: 'single',
      imageUrl: 'https://cdn.example/cat.png',
      duration: 5,
      aspectRatio: '16:9',
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/alibailian/api/v1/services/aigc/video-generation/video-synthesis')
  assert.equal(req.method, 'POST')
  assert.equal(req.body.model, 'happyhorse-1.0-i2v')
  assert.deepEqual(req.body.input.media, [{ type: 'first_frame', url: 'https://cdn.example/cat.png' }])
  assert.equal(req.body.parameters.duration, 5)
  assert.equal(req.body.parameters.resolution, '720P')
  assert.equal(req.body.parameters.aspect_ratio, '16:9')
  assert.equal(req.body.parameters.watermark, false)
  assert.equal(req.body.parameters.generate_audio, true)
})

test('EggfansVideoAdapter forwards a manually selected portrait ratio', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'happyhorse-1.0-i2v',
    },
    {
      id: 2,
      model: 'happyhorse-1.0-i2v',
      prompt: 'portrait subject',
      aspectRatio: '9:16',
    },
  )

  assert.equal(req.body.parameters.aspect_ratio, '9:16')
})

test('EggfansVideoAdapter refuses Seedance 2.0 models', () => {
  assert.throws(
    () => adapter.buildGenerateRequest(
      {
        provider: 'eggfans',
        baseUrl: 'https://api.eggfans.com',
        apiKey: 'secret',
        model: 'doubao-seedance-2-0-pro-260215',
      },
      { id: 1, prompt: 'scene', model: 'doubao-seedance-2-0-pro-260215' },
    ),
    /official VolcEngine/i,
  )
})

test('EggfansVideoAdapter builds unified video requests for Veo and Grok models', () => {
  const veoReq = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'veo3.1',
    },
    {
      id: 1,
      model: 'veo3.1',
      prompt: 'city sunrise',
      referenceMode: 'first_last',
      firstFrameUrl: 'https://cdn.example/start.png',
      lastFrameUrl: 'https://cdn.example/end.png',
      duration: 8,
      aspectRatio: '16:9',
    },
  )

  assert.equal(veoReq.url, 'https://api.eggfans.com/v1/video/create')
  assert.equal(veoReq.method, 'POST')
  assert.equal(veoReq.body.model, 'veo3.1')
  assert.equal(veoReq.body.duration, 8)
  assert.equal(veoReq.body.aspect_ratio, '16:9')
  assert.equal(veoReq.body.enhance_prompt, true)
  assert.equal(veoReq.body.enable_upsample, true)
  assert.equal(veoReq.body.watermark, false)
  assert.equal(veoReq.body.generate_audio, true)
  assert.deepEqual(veoReq.body.images, ['https://cdn.example/start.png', 'https://cdn.example/end.png'])

  const grokReq = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'grok-video-3',
    },
    {
      id: 2,
      model: 'grok-video-3',
      prompt: 'character walking',
      referenceMode: 'single',
      imageUrl: 'https://cdn.example/ref.png',
    },
  )

  assert.equal(grokReq.url, 'https://api.eggfans.com/v1/video/create')
  assert.equal(grokReq.body.model, 'grok-video-3')
  assert.equal(grokReq.body.aspect_ratio, '3:2')
  assert.equal(grokReq.body.size, '720P')
  assert.equal('duration' in grokReq.body, false)
  assert.equal('generate_audio' in grokReq.body, false)
  assert.equal('watermark' in grokReq.body, false)
  assert.deepEqual(grokReq.body.images, ['https://cdn.example/ref.png'])
})

test('EggfansVideoAdapter caps Grok video references at seven images', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'grok-video-3-10s',
      endpoint: '/v1/video/create',
      queryEndpoint: '/v1/video/query',
      settings: { eggfans: { routeFamily: 'unified-video', endpointTypes: ['grok视频'] } },
    },
    {
      id: 27,
      model: 'grok-video-3-10s',
      prompt: 'character walking through the office',
      referenceMode: 'multiple',
      imageUrl: 'https://cdn.example/composed-shot.png',
      firstFrameUrl: 'https://cdn.example/first-frame.png',
      referenceImageUrls: JSON.stringify([
        'https://cdn.example/grid-1.png',
        'https://cdn.example/grid-2.png',
        'https://cdn.example/grid-3.png',
        'https://cdn.example/grid-4.png',
        'https://cdn.example/character.png',
        'https://cdn.example/scene.png',
        'https://cdn.example/extra-1.png',
        'https://cdn.example/extra-2.png',
      ]),
    },
  )

  assert.deepEqual(req.body.images, [
    'https://cdn.example/grid-1.png',
    'https://cdn.example/grid-2.png',
    'https://cdn.example/grid-3.png',
    'https://cdn.example/grid-4.png',
    'https://cdn.example/character.png',
    'https://cdn.example/scene.png',
    'https://cdn.example/extra-1.png',
  ])
})

test('EggfansVideoAdapter uses saved Eggfans route metadata for Hailuo and Vidu', () => {
  const hailuoConfig = {
    provider: 'eggfans',
    baseUrl: 'https://api.eggfans.com',
    apiKey: 'secret',
    model: 'MiniMax-Hailuo-02',
    endpoint: '/minimax/v1/video_generation',
    queryEndpoint: '/minimax/v1/query/video_generation',
    settings: { eggfans: { routeFamily: 'minimax-video', endpointTypes: ['海螺视频生成'] } },
  }
  const hailuoRecord = {
    id: 3,
    model: 'MiniMax-Hailuo-02',
    prompt: 'ocean wave',
    referenceMode: 'first_last',
    firstFrameUrl: 'https://cdn.example/start.png',
    lastFrameUrl: 'https://cdn.example/end.png',
    duration: 10,
  }
  const hailuoReq = adapter.buildGenerateRequest(hailuoConfig, hailuoRecord)

  assert.equal(hailuoReq.url, 'https://api.eggfans.com/minimax/v1/video_generation')
  assert.equal(hailuoReq.body.model, 'MiniMax-Hailuo-02')
  assert.equal(hailuoReq.body.duration, 10)
  assert.equal(hailuoReq.body.watermark, false)
  assert.equal(hailuoReq.body.generate_audio, true)
  assert.equal(hailuoReq.body.first_frame_image, 'https://cdn.example/start.png')
  assert.equal(hailuoReq.body.last_frame_image, 'https://cdn.example/end.png')
  assert.deepEqual(adapter.parseGenerateResponse({ task_id: '306792606023824' }, hailuoConfig, hailuoRecord), {
    isAsync: true,
    taskId: 'eggfans:minimax:306792606023824',
  })

  const minimaxPoll = adapter.buildPollRequest(hailuoConfig, 'eggfans:minimax:306792606023824')
  assert.equal(minimaxPoll.url, 'https://api.eggfans.com/minimax/v1/query/video_generation?task_id=306792606023824')
  assert.equal(minimaxPoll.method, 'GET')

  const viduConfig = {
    provider: 'eggfans',
    baseUrl: 'https://api.eggfans.com',
    apiKey: 'secret',
    model: 'viduq3-turbo',
    endpoint: '/ent/v2/img2video',
    queryEndpoint: '/ent/v2/tasks/{id}/creations',
    settings: {
      eggfans: {
        routeFamily: 'vidu-video',
        endpoints: [
          { type: 'vidu图生视频', path: '/ent/v2/img2video', method: 'POST' },
          { type: 'vidu首尾帧', path: '/ent/v2/start-end2video', method: 'POST' },
          { type: 'vidu文生视频', path: '/ent/v2/text2video', method: 'POST' },
        ],
      },
    },
  }
  const viduRecord = {
    id: 4,
    model: 'viduq3-turbo',
    prompt: 'door opens',
    referenceMode: 'first_last',
    firstFrameUrl: 'https://cdn.example/first.png',
    lastFrameUrl: 'https://cdn.example/last.png',
    duration: 5,
    aspectRatio: '16:9',
  }
  const viduReq = adapter.buildGenerateRequest(viduConfig, viduRecord)

  assert.equal(viduReq.url, 'https://api.eggfans.com/ent/v2/start-end2video')
  assert.equal(viduReq.headers.Authorization, 'Bearer secret')
  assert.equal(viduReq.body.watermark, false)
  assert.equal(viduReq.body.generate_audio, true)
  assert.deepEqual(viduReq.body.images, ['https://cdn.example/first.png', 'https://cdn.example/last.png'])
  assert.deepEqual(adapter.parseGenerateResponse({ task_id: 'vidu-task-1' }, viduConfig, viduRecord), {
    isAsync: true,
    taskId: 'eggfans:vidu:vidu-task-1',
  })

  const viduPoll = adapter.buildPollRequest(viduConfig, 'eggfans:vidu:vidu-task-1')
  assert.equal(viduPoll.url, 'https://api.eggfans.com/ent/v2/tasks/vidu-task-1/creations')
  assert.equal(viduPoll.method, 'GET')
})

test('EggfansVideoAdapter routes Wan video models through AliBailian metadata', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'wan2.6-i2v',
      endpoint: '/alibailian/api/v1/services/aigc/video-generation/video-synthesis',
      queryEndpoint: '/alibailian/api/v1/tasks/{task_id}',
      settings: { eggfans: { routeFamily: 'alibailian-video', endpointTypes: ['wan视频生成'] } },
    },
    {
      id: 5,
      model: 'wan2.6-i2v',
      prompt: 'river',
      referenceMode: 'single',
      imageUrl: 'https://cdn.example/frame.png',
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/alibailian/api/v1/services/aigc/video-generation/video-synthesis')
  assert.equal(req.body.model, 'wan2.6-i2v')
  assert.equal(req.body.parameters.watermark, false)
  assert.equal(req.body.parameters.generate_audio, true)
  assert.deepEqual(req.body.input.media, [{ type: 'first_frame', url: 'https://cdn.example/frame.png' }])
})

test('EggfansVideoAdapter parses AliBailian task responses', () => {
  assert.deepEqual(adapter.parseGenerateResponse({ output: { task_id: 'task-1', task_status: 'PENDING' } }), {
    isAsync: true,
    taskId: 'task-1',
  })
  assert.deepEqual(adapter.parsePollResponse({ output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example/v.mp4' } }), {
    status: 'completed',
    videoUrl: 'https://cdn.example/v.mp4',
  })
})

test('EggfansVideoAdapter builds unified video poll requests', () => {
  const config = {
    provider: 'eggfans',
    baseUrl: 'https://api.eggfans.com',
    apiKey: 'secret',
    model: 'veo3.1',
  }
  const record = { id: 1, model: 'veo3.1', prompt: 'scene' }

  adapter.buildGenerateRequest(config, record)
  assert.deepEqual(adapter.parseGenerateResponse({ data: { task_id: 'task-123', status: 'processing' } }, config, record), {
    isAsync: true,
    taskId: 'eggfans:unified:task-123',
  })

  const req = adapter.buildPollRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'veo3.1',
    },
    'eggfans:unified:task-123',
  )

  assert.equal(req.url, 'https://api.eggfans.com/v1/video/query?id=task-123')
  assert.equal(req.method, 'GET')
  assert.equal(req.body, undefined)

  const legacyReq = adapter.buildPollRequest(config, 'task-legacy-grok')
  assert.equal(legacyReq.url, 'https://api.eggfans.com/v1/video/query?id=task-legacy-grok')
  assert.equal(legacyReq.method, 'GET')
})

test('EggfansVideoAdapter encodes Grok task ids from the current request, not shared adapter state', () => {
  const grokConfig = {
    provider: 'eggfans',
    baseUrl: 'https://api.eggfans.com',
    apiKey: 'secret',
    model: 'grok-video-3-10s',
    endpoint: '/v1/video/create',
    queryEndpoint: '/v1/video/query',
    settings: { eggfans: { routeFamily: 'unified-video', endpointTypes: ['grok视频'] } },
  }
  const grokRecord = {
    id: 27,
    model: 'grok-video-3-10s',
    prompt: 'night knock',
    referenceMode: 'single',
    imageUrl: 'https://cdn.example/door.png',
  }

  adapter.buildGenerateRequest(grokConfig, grokRecord)
  adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'happyhorse-1.0-i2v',
      settings: { eggfans: { routeFamily: 'alibailian-video', endpointTypes: ['happyhorse视频'] } },
    },
    { id: 28, model: 'happyhorse-1.0-i2v', prompt: 'other shot' },
  )

  assert.deepEqual(adapter.parseGenerateResponse({ task_id: 'task-grok-27' }, grokConfig, grokRecord), {
    isAsync: true,
    taskId: 'eggfans:unified:task-grok-27',
  })
})

test('EggfansVideoAdapter adds output preference switches to OpenAI-style videos', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'sora-2',
      endpoint: '/v1/videos',
      queryEndpoint: '/v1/videos/{id}',
      settings: { eggfans: { routeFamily: 'openai-video', endpointTypes: ['openAI官方视频格式'] } },
    },
    {
      id: 6,
      model: 'sora-2',
      prompt: 'cinematic dialogue',
      duration: 8,
      aspectRatio: '1280x720',
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/v1/videos')
  assert.equal(req.body.watermark, false)
  assert.equal(req.body.generate_audio, true)
})
