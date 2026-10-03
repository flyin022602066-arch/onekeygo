import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OFFICIAL_SEEDANCE_2_MODEL,
  buildOfficialSeedanceConfigMetadata,
  buildProbe,
  getPresetPriority,
  isParameterValidationResponse,
  resolveOfficialSeedanceApiKey,
} from '../aiConfigs.js'

test('buildProbe uses Eggfans OpenAI model list endpoint', () => {
  const probe = buildProbe('text', 'eggfans', 'https://api.eggfans.com', 'qwen3.7-max', 'key')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.url, 'https://api.eggfans.com/v1/models')
  assert.equal(probe.headers.Authorization, 'Bearer key')
})

test('buildProbe uses the OpenAI-compatible model list endpoint for Grok Imagine', () => {
  const probe = buildProbe('video', 'grok_openai', 'https://api.aigcly.top', 'grok-imagine-video', 'key')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.url, 'https://api.aigcly.top/v1/models')
  assert.equal(probe.headers.Authorization, 'Bearer key')
})

test('buildProbe avoids paid Eggfans media generation probes', () => {
  const probe = buildProbe('video', 'eggfans', 'https://api.eggfans.com', 'veo3.1', 'key', '/v1/video/create')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.url, 'https://api.eggfans.com/v1/models')
  assert.equal(probe.headers.Authorization, 'Bearer key')
  assert.equal(probe.body, undefined)
})

test('buildProbe keeps Eggfans image config tests read-only', () => {
  const probe = buildProbe('image', 'eggfans', 'https://api.eggfans.com', 'gpt-image-2', 'key', '/v1/images/edits')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.url, 'https://api.eggfans.com/v1/models')
  assert.equal(probe.body, undefined)
})

test('buildProbe uses Mijing aimodels endpoint for all Mijing service configs', () => {
  const probe = buildProbe('video', 'mijing', 'https://api.mjing.cc', 'seedance2.0创作版', 'key', '/v1/video/generations')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.url, 'https://api.mjing.cc/v1/aimodels')
  assert.equal(probe.headers.Authorization, 'Bearer key')
  assert.equal(probe.body, undefined)
})

test('buildProbe keeps VolcEngine probe for Seedance official configs', () => {
  const probe = buildProbe('video', 'volcengine', 'https://ark.cn-beijing.volces.com', OFFICIAL_SEEDANCE_2_MODEL, 'key')
  assert.equal(probe.method, 'POST')
  assert.equal(probe.url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')
  assert.deepEqual(probe.body, {
    model: OFFICIAL_SEEDANCE_2_MODEL,
    content: [],
    generate_audio: true,
    watermark: false,
  })
})

test('buildProbe validates Volc asset upload key against assets group endpoint', () => {
  const probe = buildProbe('asset', 'volcengine_asset', 'https://20nbifxd.magine.work', '', 'key')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.url, 'https://20nbifxd.magine.work/v1/assets/groups?page=1&page_size=1')
  assert.equal(probe.headers.Authorization, 'Bearer key')
})

test('buildProbe validates Eggfans image host by uploading a tiny image', () => {
  const probe = buildProbe('image_host', 'eggfans_image_host', 'https://imageproxy.zhongzhuan.chat/api/upload', '', 'key')
  assert.equal(probe.method, 'POST')
  assert.equal(probe.url, 'https://imageproxy.zhongzhuan.chat/api/upload')
  assert.equal(probe.headers.Authorization, 'Bearer key')
  assert.ok(probe.body instanceof FormData)
  assert.deepEqual(Array.from((probe.body as FormData).keys()), ['file'])
})

test('VolcEngine auth and model errors do not pass config test', () => {
  assert.equal(isParameterValidationResponse(401, '{"error":{"code":"AuthenticationError"}}'), false)
  assert.equal(isParameterValidationResponse(403, '{"error":{"code":"PermissionDenied"}}'), false)
  assert.equal(isParameterValidationResponse(404, '{"error":{"code":"InvalidEndpointOrModel.NotFound"}}'), false)
  assert.equal(isParameterValidationResponse(400, '{"error":{"message":"content is required"}}'), true)
})

test('preset priorities prefer Mijing, then official Seedance, then Eggfans video', () => {
  assert.equal(getPresetPriority('video', 'mijing') > getPresetPriority('video', 'volcengine'), true)
  assert.equal(getPresetPriority('video', 'volcengine') > getPresetPriority('video', 'eggfans'), true)
})

test('buildProbe supports the current Eggfans .org gateway', () => {
  const probe = buildProbe('text', 'eggfans', 'https://api.eggfans.org', 'gpt-5.6-sol', 'key')
  assert.equal(probe.url, 'https://api.eggfans.org/v1/models')
})

test('buildProbe uses ComfyUI system stats endpoint without model probing', () => {
  const probe = buildProbe('video', 'comfyui', 'http://127.0.0.1:8188', 'MiniMax-H3-local')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.url, 'http://127.0.0.1:8188/system_stats')
  assert.equal(probe.body, undefined)
})

test('buildProbe keeps AutoDL ComfyUI configuration tests read-only', () => {
  const probe = buildProbe('video', 'autodl_comfyui', 'https://autodl.art', 'minimax_h3_lightx2v_no_pic', 'autodl-token')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.url, 'https://autodl.art/')
  assert.equal(probe.headers.Authorization, 'autodl-token')
  assert.equal(probe.body, undefined)
})

test('preset priorities prefer Mijing text and image over Eggfans', () => {
  assert.equal(getPresetPriority('text', 'mijing') > getPresetPriority('text', 'eggfans'), true)
  assert.equal(getPresetPriority('image', 'mijing') > getPresetPriority('image', 'eggfans'), true)
})

test('Eggfans preset does not reuse Eggfans key for official Seedance', () => {
  assert.equal(resolveOfficialSeedanceApiKey('', 'sk-eggfans'), '')
  assert.equal(resolveOfficialSeedanceApiKey(undefined, 'sk-eggfans'), '')
  assert.equal(resolveOfficialSeedanceApiKey('  ark-key  ', 'sk-eggfans'), 'ark-key')
})

test('official Seedance metadata keeps VolcEngine task paths and defaults', () => {
  const metadata = buildOfficialSeedanceConfigMetadata()
  const settings = JSON.parse(metadata.settings)

  assert.equal(metadata.endpoint, '/api/v3/contents/generations/tasks')
  assert.equal(metadata.queryEndpoint, '/api/v3/contents/generations/tasks/{task_id}')
  assert.equal(settings.seedance.provider, 'volcengine')
  assert.equal(settings.seedance.modelName, OFFICIAL_SEEDANCE_2_MODEL)
  assert.equal(settings.seedance.defaults.generate_audio, true)
  assert.equal(settings.seedance.defaults.watermark, false)
  assert.deepEqual(settings.seedance.transmissionParameters.requiredFields, ['model', 'content'])
})
