import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMijingStoryboardContext,
  distributeStoryboardQuota,
  estimateCompactShotLimit,
  getMijingAgentTimeoutMs,
  normalizeStoryboards,
  requestMijingPlainChat,
  splitScriptForMijing,
  supportsMijingPlainAgent,
} from '../mijing-text-agent.js'

const config = {
  provider: 'mijing',
  baseUrl: 'https://api.mjing.cc',
  apiKey: 'test-key',
  model: 'deepseek-v4-pro',
}

test('supportsMijingPlainAgent covers the local production text pipeline', () => {
  assert.equal(supportsMijingPlainAgent('script_rewriter'), true)
  assert.equal(supportsMijingPlainAgent('extractor'), true)
  assert.equal(supportsMijingPlainAgent('storyboard_breaker'), true)
  assert.equal(supportsMijingPlainAgent('voice_assigner'), false)
})

test('storyboard breakdown requests allow up to ten minutes for the upstream model', () => {
  assert.equal(getMijingAgentTimeoutMs('storyboard_breaker'), 600_000)
  assert.equal(getMijingAgentTimeoutMs('extractor'), 240_000)
})

test('splitScriptForMijing preserves long screenplay text in bounded chunks', () => {
  const source = '第一场\n\n' + '甲'.repeat(1600) + '\n\n第二场\n\n' + '乙'.repeat(1600)
  const chunks = splitScriptForMijing(source, 1800)
  assert.ok(chunks.length >= 2)
  assert.equal(chunks.join('').replace(/\s/g, ''), source.replace(/\s/g, ''))
  assert.ok(chunks.every(chunk => chunk.length <= 1800))
})

test('compact storyboard limits scale with script content without targeting twelve shots', () => {
  assert.equal(estimateCompactShotLimit('短场景'), 3)
  assert.equal(estimateCompactShotLimit('甲'.repeat(1500)), 5)
  assert.equal(estimateCompactShotLimit('甲'.repeat(5000)), 10)
})

test('TK storyboard minimum shot quota is distributed across screenplay chunks', () => {
  assert.deepEqual(distributeStoryboardQuota(10, 3), [4, 3, 3])
  assert.deepEqual(distributeStoryboardQuota(10, 1), [10])
})

test('Mijing full storyboard context excludes old storyboards', () => {
  const context = buildMijingStoryboardContext({
    episode: { id: 68 },
    script: '## S1 | 出租屋 | 夜',
    characters: [{ id: 1, name: '林凡' }],
    scenes: [{ id: 29, location: '出租屋', time: '夜' }],
    existing_storyboards: [{ id: 242, title: '旧分镜' }],
  })

  assert.equal('existing_storyboards' in context, false)
  assert.equal(context.scenes[0].location, '出租屋')
})

test('normal storyboard output clamps duration and removes scenes outside the script', () => {
  const context = {
    script: '## S1 | 出租屋 | 夜\n林凡在出租屋醒来。',
    characters: [{ id: 1, name: '林凡' }],
    scenes: [{ id: 29, location: '出租屋', time: '夜' }],
  }
  const storyboards = normalizeStoryboards([
    { title: '过短', location: '昏暗出租屋', scene_id: null, character_ids: [1], duration: 2 },
    { title: '过长', location: '出租屋', scene_id: 29, character_ids: [1], duration: 12 },
    { title: '剧本外', location: '城市天台', scene_id: 29, character_ids: [1], duration: 15 },
  ], context, null)

  assert.deepEqual(storyboards.map(item => item.duration), [4, 7])
  assert.deepEqual(storyboards.map(item => item.location), ['出租屋', '出租屋'])
  assert.deepEqual(storyboards.map(item => item.scene_id), [29, 29])
})

test('Grok storyboard output remains fixed at ten seconds', () => {
  const context = {
    script: '## S1 | 客厅 | 日',
    characters: [],
    scenes: [{ id: 1, location: '客厅', time: '日' }],
  }
  const storyboards = normalizeStoryboards([
    { title: 'Grok', location: '客厅', scene_id: 1, duration: 5 },
  ], context, { mode: 'grok_10s', shotDuration: 10 })

  assert.equal(storyboards[0].duration, 10)
})

test('requestMijingPlainChat retries a saturated upstream and returns content', async () => {
  const requests: Array<{ url: string; body: any }> = []
  const responses = [
    new Response(JSON.stringify({ error: { message: '当前分组上游负载已饱和' } }), { status: 502 }),
    new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
  ]
  const fetchImpl = async (url: any, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) })
    return responses.shift()!
  }

  const result = await requestMijingPlainChat(config, 'system', 'user', {
    fetchImpl: fetchImpl as typeof fetch,
    retryDelaysMs: [0],
    maxOutputTokens: 1234,
  })

  assert.equal(result, 'ok')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://api.mjing.cc/v1/chat/completions')
  assert.equal(requests[0].body.max_tokens, 1234)
  assert.equal(requests[0].body.tools, undefined)
})

test('Mijing text requests use the standard gateway when a video gateway is configured', async () => {
  let requestUrl = ''
  const result = await requestMijingPlainChat(
    { ...config, baseUrl: 'https://api.magine.work' },
    'system',
    'user',
    {
      fetchImpl: async (url: any) => {
        requestUrl = String(url)
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
      },
      retryDelaysMs: [],
    },
  )

  assert.equal(result, 'ok')
  assert.equal(requestUrl, 'https://api.mjing.cc/v1/chat/completions')
})

test('requestMijingPlainChat reports a useful saturated-upstream error', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ error: { message: '当前分组上游负载已饱和' } }),
    { status: 502 },
  )

  await assert.rejects(
    requestMijingPlainChat(config, 'system', 'user', {
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [],
    }),
    /上游当前负载已饱和/,
  )
})

test('requestMijingPlainChat retries an empty model response', async () => {
  const responses = [
    new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), { status: 200 }),
  ]
  const result = await requestMijingPlainChat(config, 'system', 'user', {
    fetchImpl: async () => responses.shift()!,
    retryDelaysMs: [0],
  })

  assert.equal(result, 'recovered')
})

test('Mijing platform field failures are explained as an upstream compatibility problem', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ error: { message: 'fields not exists:[platform_model_ratio_source]' } }),
    { status: 500 },
  )

  await assert.rejects(
    requestMijingPlainChat(config, 'system', 'user', {
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [],
    }),
    /接口版本不兼容.*platform_model_ratio_source/,
  )
})

test('Mijing gateway timeouts return a concise actionable error', async () => {
  const fetchImpl = async () => new Response(
    '<html><head><title>502 Bad Gateway</title></head><body><center>nginx</center></body></html>',
    { status: 502 },
  )

  await assert.rejects(
    requestMijingPlainChat(config, 'system', 'user', {
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [],
    }),
    /上游生成超时或网关暂时不可用/,
  )
})
