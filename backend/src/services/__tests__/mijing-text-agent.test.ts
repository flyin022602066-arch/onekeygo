import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMijingStoryboardContext,
  buildStoryboardScriptChunks,
  distributeStoryboardQuota,
  estimateCompactShotLimit,
  getMijingAgentTimeoutMs,
  normalizeStoryboards,
  requestMijingPlainChat,
  splitScriptForMijing,
  supportsMijingPlainAgent,
} from '../mijing-text-agent.js'
import { getStoryboardBreakdownModeRule } from '../../agents/storyboard-video-rules.js'

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

test('storyboard quota helper distributes values across buckets', () => {
  assert.deepEqual(distributeStoryboardQuota(10, 3), [4, 3, 3])
  assert.deepEqual(distributeStoryboardQuota(10, 1), [10])
})

test('TK storyboard generation keeps the complete script in one global pass', () => {
  const source = `## S1 | Moon Hall | Night\n${'Ayla and Rowan continue the same confrontation. '.repeat(80)}`.trim()
  const chunks = buildStoryboardScriptChunks(source, { mode: 'tk_overseas' })
  assert.deepEqual(chunks, [source])
})

test('TK storyboard rules preserve a global scene view and merge continuous dialogue', () => {
  const rule = getStoryboardBreakdownModeRule({ mode: 'tk_overseas' })
  assert.match(rule, /整场主画面/)
  assert.match(rule, /3-5 个镜头是软目标/)
  assert.match(rule, /不要把每句对白或每次说话人切换机械拆成新镜头/)
  assert.match(rule, /空间轴线、人物位置、道具状态/)
  assert.match(rule, /12-15 秒/)
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
  assert.equal(requests[0].body.stream, true)
})

test('requestMijingPlainChat assembles SSE delta content and does not impose a total request timeout', async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"part-1 "}}]}\n\n'))
      setTimeout(() => {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"part-2"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }, 20)
    },
  })
  let requestBody: any
  const result = await requestMijingPlainChat(config, 'system', 'user', {
    fetchImpl: async (_url: any, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || '{}'))
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
    retryDelaysMs: [],
    streamIdleTimeoutMs: 100,
  })

  assert.equal(requestBody.stream, true)
  assert.equal(result, 'part-1 part-2')
})

test('requestMijingPlainChat falls back to JSON when a legacy gateway rejects stream=true', async () => {
  const requests: any[] = []
  const fetchImpl = async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'))
    requests.push(body)
    if (body.stream === true) {
      return new Response('<h1>variable type error： object</h1>', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'compat-ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const result = await requestMijingPlainChat(config, 'system', 'user', {
    fetchImpl: fetchImpl as typeof fetch,
    retryDelaysMs: [],
  })

  assert.equal(result, 'compat-ok')
  assert.deepEqual(requests.map(item => item.stream), [true, false])
})

test('requestMijingPlainChat fails an SSE stream after the configured idle timeout', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
    },
  })

  await assert.rejects(
    requestMijingPlainChat(config, 'system', 'user', {
      fetchImpl: async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      retryDelaysMs: [],
      streamIdleTimeoutMs: 20,
    }),
    /请求失败|璇锋眰澶辫触|timeout/i,
  )
})

test('Mijing text requests keep the gateway saved in the configuration', async () => {
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
  assert.equal(requestUrl, 'https://api.magine.work/v1/chat/completions')
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
