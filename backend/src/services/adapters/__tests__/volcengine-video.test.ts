import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SEEDANCE_2_MODEL, VolcEngineVideoAdapter } from '../volcengine-video.js'

const adapter = new VolcEngineVideoAdapter()

test('VolcEngineVideoAdapter requests Seedance output with audio and without watermark', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'volcengine',
      baseUrl: 'https://ark.cn-beijing.volces.com',
      apiKey: 'secret',
      model: DEFAULT_SEEDANCE_2_MODEL,
    },
    {
      id: 1,
      model: DEFAULT_SEEDANCE_2_MODEL,
      prompt: 'snowy street at night',
      referenceMode: 'single',
      imageUrl: 'https://cdn.example/frame.png',
      duration: 5,
      aspectRatio: '16:9',
    },
  )

  assert.equal(req.url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')
  assert.equal(req.body.generate_audio, true)
  assert.equal(req.body.watermark, false)
  assert.equal(req.body.ratio, '16:9')
  assert.equal(req.body.model, DEFAULT_SEEDANCE_2_MODEL)
})

test('VolcEngineVideoAdapter keeps asset id references in text and omits local image content', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'volcengine',
      baseUrl: 'https://ark.cn-beijing.volces.com',
      apiKey: 'secret',
      model: DEFAULT_SEEDANCE_2_MODEL,
    },
    {
      id: 1,
      model: DEFAULT_SEEDANCE_2_MODEL,
      prompt: 'snowy street\n火山素材参考：首帧参考 @asset://asset-123 ；角色参考 @asset://asset-456 ',
      referenceMode: 'first_last',
      firstFrameUrl: 'static/images/local.png',
      lastFrameUrl: null,
      duration: 5,
      aspectRatio: '16:9',
    },
  )

  assert.deepEqual(req.body.content, [
    { type: 'text', text: 'snowy street\n火山素材参考：首帧参考 @asset://asset-123 ；角色参考 @asset://asset-456 ' },
  ])
})

test('VolcEngineVideoAdapter falls back to current Seedance 2.0 model', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'volcengine',
      baseUrl: 'https://ark.cn-beijing.volces.com',
      apiKey: 'secret',
      model: '',
    },
    {
      id: 1,
      prompt: 'snowy street at night',
    },
  )

  assert.equal(req.body.model, DEFAULT_SEEDANCE_2_MODEL)
})
