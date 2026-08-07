import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeEggfansCatalog,
  filterEggfansModels,
  type EggfansPricingResponse,
} from '../models.js'

const sample: EggfansPricingResponse = {
  success: true,
  auto_groups: ['default'],
  supported_endpoint: {
    openai: { path: '/v1/chat/completions', method: 'POST' },
    'image-generation': { path: '/v1/images/generations', method: 'POST' },
    'happyhorse视频': { path: '/alibailian/api/v1/services/aigc/video-generation/video-synthesis', method: 'POST' },
    'wan视频生成': { path: '/alibailian/api/v1/services/aigc/video-generation/video-synthesis', method: 'POST' },
    'grok视频': { path: '/v1/video/create', method: 'POST' },
    '海螺视频生成': { path: '/minimax/v1/video_generation', method: 'POST' },
    'vidu图生视频': { path: '/ent/v2/img2video', method: 'POST' },
    'vidu首尾帧': { path: '/ent/v2/start-end2video', method: 'POST' },
    'vidu文生视频': { path: '/ent/v2/text2video', method: 'POST' },
    '同步语音': { path: '/minimax/v1/t2a_v2', method: 'POST' },
  },
  data: [
    {
      model_name: 'qwen3.7-max',
      model_type: '文本',
      tags: '对话,工具',
      supported_endpoint_types: ['openai'],
      model_ratio: 6,
      model_price: 0,
      enable_groups: ['default'],
      vendor_id: 96,
      quota_type: 0,
      sort_order: 526,
    },
    {
      model_name: 'gpt-image-2',
      model_type: '图像',
      tags: '绘画,dall-e-3格式',
      supported_endpoint_types: ['image-generation', 'openai编辑图片'],
      model_ratio: 2.5,
      model_price: 0,
      enable_groups: ['default'],
      vendor_id: 52,
      quota_type: 0,
      sort_order: 525,
    },
    {
      model_name: 'happyhorse-1.0-i2v',
      model_type: '音视频',
      tags: '视频',
      supported_endpoint_types: ['happyhorse视频'],
      model_ratio: 0,
      model_price: 0.014,
      enable_groups: ['default'],
      vendor_id: 96,
      quota_type: 4,
      sort_order: 522,
    },
    {
      model_name: 'MiniMax-Hailuo-02',
      model_type: '音视频',
      tags: '视频,首尾帧,参考生视频',
      supported_endpoint_types: ['海螺视频生成'],
      model_ratio: 0,
      model_price: 0.09,
      enable_groups: ['default'],
      vendor_id: 95,
      quota_type: 4,
      sort_order: 521,
    },
    {
      model_name: 'grok-video-3-10s',
      model_type: '音视频',
      tags: '视频',
      supported_endpoint_types: ['grok视频'],
      model_ratio: 0,
      model_price: 0.08,
      enable_groups: ['default'],
      vendor_id: 97,
      quota_type: 4,
      sort_order: 520.5,
    },
    {
      model_name: 'viduq3-turbo',
      model_type: '音视频',
      tags: '视频,首尾帧,参考生视频',
      supported_endpoint_types: ['vidu图生视频', 'vidu首尾帧', 'vidu文生视频'],
      model_ratio: 0,
      model_price: 0.04,
      enable_groups: ['default'],
      vendor_id: 94,
      quota_type: 4,
      sort_order: 520,
    },
    {
      model_name: 'speech-2.8-hd',
      model_type: '音视频',
      tags: '音频',
      supported_endpoint_types: ['同步语音', '异步语音'],
      model_ratio: 0,
      model_price: 0,
      enable_groups: ['default'],
      vendor_id: 95,
      quota_type: 0,
      sort_order: 500,
    },
  ],
}

test('normalizeEggfansCatalog keeps endpoint metadata and derives service types', () => {
  const models = normalizeEggfansCatalog(sample)

  assert.deepEqual(models.map(m => m.name), [
    'qwen3.7-max',
    'gpt-image-2',
    'happyhorse-1.0-i2v',
    'MiniMax-Hailuo-02',
    'grok-video-3-10s',
    'viduq3-turbo',
    'speech-2.8-hd',
  ])
  assert.equal(models[0].serviceType, 'text')
  assert.equal(models[1].serviceType, 'image')
  assert.equal(models[2].serviceType, 'video')
  assert.equal(models[3].serviceType, 'video')
  assert.equal(models[4].serviceType, 'video')
  assert.equal(models[5].serviceType, 'video')
  assert.equal(models[6].serviceType, 'audio')
  assert.deepEqual(models[1].endpointTypes, ['image-generation', 'openai编辑图片'])
  assert.equal(models[1].endpointPath, '/v1/images/edits')
  assert.equal(models[1].primaryEndpointType, 'openai编辑图片')
  assert.equal(models[1].transmissionParameters?.requestShape, 'OpenAI images edits/generations')
  assert.equal(models[1].transmissionParameters?.imageField, 'multipart image[]')
  assert.equal(models[2].endpointPath, '/alibailian/api/v1/services/aigc/video-generation/video-synthesis')
  assert.equal(models[2].routeFamily, 'alibailian-video')
  assert.equal(models[3].endpointPath, '/minimax/v1/video_generation')
  assert.equal(models[3].queryEndpointPath, '/minimax/v1/query/video_generation')
  assert.equal(models[4].endpointPath, '/v1/video/create')
  assert.equal(models[4].queryEndpointPath, '/v1/video/query')
  assert.equal(models[4].transmissionParameters?.requestShape, 'Eggfans Grok video create')
  assert.deepEqual(models[4].transmissionParameters?.optionalFields, ['images', 'aspect_ratio', 'size'])
  assert.equal(models[4].transmissionParameters?.durationField, undefined)
  assert.equal(models[5].routeFamily, 'vidu-video')
  assert.deepEqual(models[5].endpoints.map(endpoint => endpoint.path), ['/ent/v2/img2video', '/ent/v2/start-end2video', '/ent/v2/text2video'])
})

test('filterEggfansModels returns only models useful for the requested service', () => {
  const models = normalizeEggfansCatalog(sample)

  assert.deepEqual(filterEggfansModels(models, 'text').map(m => m.name), ['qwen3.7-max'])
  assert.deepEqual(filterEggfansModels(models, 'image').map(m => m.name), ['gpt-image-2'])
  assert.deepEqual(filterEggfansModels(models, 'video').map(m => m.name), ['happyhorse-1.0-i2v', 'MiniMax-Hailuo-02', 'grok-video-3-10s', 'viduq3-turbo'])
  assert.deepEqual(filterEggfansModels(models, 'audio').map(m => m.name), ['speech-2.8-hd'])
})

test('normalizeEggfansCatalog routes gpt-image-2-c to the image edits endpoint', () => {
  const models = normalizeEggfansCatalog({
    supported_endpoint: sample.supported_endpoint,
    data: [{
      model_name: 'gpt-image-2-c',
      model_type: '图像',
      tags: '绘画',
      supported_endpoint_types: ['image-generation'],
    }],
  })

  assert.equal(models[0].name, 'gpt-image-2-c')
  assert.equal(models[0].routeFamily, 'openai-image')
  assert.equal(models[0].endpointPath, '/v1/images/edits')
  assert.equal(models[0].endpointMethod, 'POST')
})
