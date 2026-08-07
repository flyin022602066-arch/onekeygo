import test from 'node:test'
import assert from 'node:assert/strict'
import { createEggfansModelsRoute } from '../eggfansModels.js'
import type { NormalizedEggfansModel } from '../../services/eggfans/models.js'

function model(partial: Omit<NormalizedEggfansModel, 'endpoints'> & { endpoints?: NormalizedEggfansModel['endpoints'] }): NormalizedEggfansModel {
  return { endpoints: [], ...partial }
}

test('GET / returns filtered Eggfans model catalog', async () => {
  const app = createEggfansModelsRoute(async () => [
    model({
      name: 'qwen3.7-max',
      description: '',
      serviceType: 'text',
      modelType: '文本',
      tags: ['对话'],
      endpointTypes: ['openai'],
      groups: ['default'],
      ratio: 6,
      price: 0,
      completionRatio: 3,
      sortOrder: 525,
    }),
    model({
      name: 'gpt-5.5-pro',
      description: '',
      serviceType: 'text',
      modelType: '文本',
      tags: ['对话'],
      endpointTypes: ['openai-response'],
      groups: ['default'],
      ratio: 15,
      price: 0,
      completionRatio: 6,
      sortOrder: 526,
    }),
    model({
      name: 'gpt-image-2',
      description: '',
      serviceType: 'image',
      modelType: '图像',
      tags: ['绘画'],
      endpointTypes: ['image-generation'],
      groups: ['default'],
      ratio: 2.5,
      price: 0,
      completionRatio: 6,
      sortOrder: 525,
    }),
    model({
      name: 'doubao-seedance-2-0-pro-260215',
      description: '',
      serviceType: 'video',
      modelType: '音视频',
      tags: ['视频'],
      endpointTypes: ['豆包视频异步'],
      groups: ['default'],
      ratio: 0,
      price: 16,
      completionRatio: 0,
      sortOrder: 500,
    }),
  ])

  const resp = await app.request('/?service_type=image')
  assert.equal(resp.status, 200)
  const body = await resp.json()
  assert.equal(body.code, 200)
  assert.deepEqual(body.data.models.map((model: any) => model.name), ['gpt-image-2'])
})

test('GET / returns selectable Eggfans video models beyond HappyHorse', async () => {
  const app = createEggfansModelsRoute(async () => [
    model({
      name: 'happyhorse-1.0-i2v',
      description: '',
      serviceType: 'video',
      modelType: '音视频',
      tags: ['视频'],
      endpointTypes: ['happyhorse视频'],
      groups: ['default'],
      ratio: 0,
      price: 0.014,
      completionRatio: 0,
      sortOrder: 522,
    }),
    model({
      name: 'veo3.1',
      description: '',
      serviceType: 'video',
      modelType: '音视频',
      tags: ['视频', '异步', '首尾帧'],
      endpointTypes: ['视频统一格式'],
      groups: ['default'],
      ratio: 0,
      price: 0.7,
      completionRatio: 0,
      sortOrder: 501,
    }),
    model({
      name: 'veo_3_1-4K',
      description: '',
      serviceType: 'video',
      modelType: '音视频',
      tags: ['视频'],
      endpointTypes: ['openAI视频格式'],
      groups: ['default'],
      ratio: 0,
      price: 0.85,
      completionRatio: 0,
      sortOrder: 501,
    }),
    model({
      name: 'grok-video-3',
      description: '',
      serviceType: 'video',
      modelType: '音视频',
      tags: ['视频', '参考生视频'],
      endpointTypes: ['grok视频'],
      groups: ['default'],
      ratio: 0,
      price: 0.6,
      completionRatio: 0,
      sortOrder: 490,
    }),
    model({
      name: 'wan2.6-i2v',
      description: '',
      serviceType: 'video',
      modelType: '音视频',
      tags: ['视频', '首帧'],
      endpointTypes: ['wan视频生成'],
      groups: ['default'],
      ratio: 0,
      price: 0.12,
      completionRatio: 0,
      sortOrder: 488,
    }),
    model({
      name: 'MiniMax-Hailuo-02',
      description: '',
      serviceType: 'video',
      modelType: '音视频',
      tags: ['视频', '首尾帧'],
      endpointTypes: ['海螺视频生成'],
      groups: ['default'],
      ratio: 0,
      price: 0.1,
      completionRatio: 0,
      sortOrder: 487,
    }),
    model({
      name: 'viduq3-turbo',
      description: '',
      serviceType: 'video',
      modelType: '音视频',
      tags: ['视频', '首尾帧'],
      endpointTypes: ['vidu图生视频', 'vidu首尾帧', 'vidu文生视频'],
      groups: ['default'],
      ratio: 0,
      price: 0.09,
      completionRatio: 0,
      sortOrder: 486,
    }),
    model({
      name: 'doubao-seedance-2-0-pro-260215',
      description: '',
      serviceType: 'video',
      modelType: '音视频',
      tags: ['视频'],
      endpointTypes: ['豆包视频异步'],
      groups: ['default'],
      ratio: 0,
      price: 16,
      completionRatio: 0,
      sortOrder: 500,
    }),
  ])

  const resp = await app.request('/?service_type=video')
  const body = await resp.json()
  assert.deepEqual(body.data.models.map((model: any) => model.name), [
    'happyhorse-1.0-i2v',
    'veo3.1',
    'veo_3_1-4K',
    'grok-video-3',
    'wan2.6-i2v',
    'MiniMax-Hailuo-02',
    'viduq3-turbo',
  ])
})
