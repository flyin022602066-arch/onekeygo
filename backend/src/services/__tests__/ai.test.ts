import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { getConfigById, getTextProviderBaseUrl } from '../ai.js'
import { EggfansTTSAdapter } from '../adapters/eggfans-tts.js'
import { db, schema } from '../../db/index.js'

test('getTextProviderBaseUrl appends /v1 for Eggfans text configs', () => {
  assert.equal(
    getTextProviderBaseUrl({
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'key',
      model: 'qwen3.7-max',
    }),
    'https://api.eggfans.com/v1',
  )
})

test('getTextProviderBaseUrl does not duplicate /v1 for Eggfans text configs', () => {
  assert.equal(
    getTextProviderBaseUrl({
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com/v1',
      apiKey: 'key',
      model: 'qwen3.7-max',
    }),
    'https://api.eggfans.com/v1',
  )
})

test('getTextProviderBaseUrl appends /v1 for Mijing text configs', () => {
  assert.equal(
    getTextProviderBaseUrl({
      provider: 'mijing',
      baseUrl: 'https://api.mjing.cc',
      apiKey: 'key',
      model: '豆包2.0-pro',
    }),
    'https://api.mjing.cc/v1',
  )
})

test('Eggfans audio request uses the selected model override instead of the locked config model', () => {
  const adapter = new EggfansTTSAdapter()
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'speech-2.8-hd',
      endpoint: '/v1beta/models/{model}:generateContent',
      settings: { eggfans: { routeFamily: 'gemini-tts', endpointTypes: ['geminitts'] } },
    },
    {
      text: '测试配音',
      voice: 'female-shaonv',
      model: 'gemini-3.1-flash-tts-preview',
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent')
})

test('getConfigById falls back to an active same-provider same-base-url API key', () => {
  const now = new Date().toISOString()
  const fallback = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'audio',
    provider: 'eggfans',
    name: `Fallback key ${Date.now()}`,
    baseUrl: 'https://unit-test-eggfans.example',
    apiKey: 'sk-fallback-unit-test',
    model: JSON.stringify(['speech-2.8-hd']),
    priority: 10,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run()
  const target = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'audio',
    provider: 'eggfans',
    name: `Target no key ${Date.now()}`,
    baseUrl: 'https://unit-test-eggfans.example',
    apiKey: '',
    model: JSON.stringify(['gemini-3.1-flash-tts-preview']),
    priority: 0,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run()

  try {
    const config = getConfigById(Number(target.lastInsertRowid))
    assert.equal(config?.apiKey, 'sk-fallback-unit-test')
    assert.equal(config?.model, 'gemini-3.1-flash-tts-preview')
  } finally {
    db.delete(schema.aiServiceConfigs).where(eqId(Number(target.lastInsertRowid))).run()
    db.delete(schema.aiServiceConfigs).where(eqId(Number(fallback.lastInsertRowid))).run()
  }
})

function eqId(id: number) {
  return eq(schema.aiServiceConfigs.id, id)
}
