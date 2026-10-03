import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMijingStoryboardContext,
  buildStoryboardScriptChunks,
  distributeStoryboardQuota,
  estimateCompactShotLimit,
  getStoryboardOutputTokenBudget,
  getMijingAgentTimeoutMs,
  parseJsonObjectWithRepair,
  normalizeExtractedProps,
  repairMissingStoryboardDialogue,
  normalizeStoryboards,
  requestMijingPlainChat,
  resolveStoryboardChunkLimit,
  splitScriptForMijing,
  supportsPlainTextAgentProvider,
  supportsMijingPlainAgent,
  validateStoryboardCompleteness,
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

test('plain streaming agent covers Eggfans and Mijing text without affecting unrelated providers', () => {
  assert.equal(supportsPlainTextAgentProvider('eggfans', 'storyboard_breaker'), true)
  assert.equal(supportsPlainTextAgentProvider('Mijing', 'extractor'), true)
  assert.equal(supportsPlainTextAgentProvider('openai', 'storyboard_breaker'), false)
  assert.equal(supportsPlainTextAgentProvider('eggfans', 'voice_assigner'), false)
})

test('local MiniMax storyboard planning allows a complete episode up to 120 shots', () => {
  assert.equal(resolveStoryboardChunkLimit('短场景', { mode: 'minimax_local_8s', shotDuration: 5 }), 120)
  assert.equal(resolveStoryboardChunkLimit('短场景', null), 3)
})

test('normalizeExtractedProps keeps only props mentioned at least twice', () => {
  assert.deepEqual(normalizeExtractedProps([
    { name: '钥匙', type: '随身物品', description: '铜钥匙', mention_count: 2 },
    { name: '纸杯', mention_count: 1 },
    { name: '  手机  ', mentionCount: 3 },
    { name: '', mention_count: 8 },
  ]), [
    { name: '钥匙', type: '随身物品', description: '铜钥匙', prompt: '铜钥匙', mention_count: 2 },
    { name: '手机', type: '', description: '', prompt: '手机', mention_count: 3 },
  ])
})

test('extractor JSON parsing retries once in non-streaming mode after a non-JSON response', async () => {
  let retries = 0
  const parsed = await parseJsonObjectWithRepair('I will analyze the screenplay first.', '角色场景道具提取', async () => {
    retries++
    return [
      '`json',
      JSON.stringify({ characters: [{ name: 'test-character' }], scenes: [], props: [] }),
      '`',
    ].join('\\n')
  })

  assert.equal(retries, 1)
  assert.equal(parsed.characters[0].name, 'test-character')
})

test('extractor JSON parsing does not retry when the first response is valid', async () => {
  let retries = 0
  const parsed = await parseJsonObjectWithRepair(JSON.stringify({ characters: [], scenes: [], props: [] }), '角色场景道具提取', async () => {
    retries++
    return '{}'
  })

  assert.equal(retries, 0)
  assert.deepEqual(parsed, { characters: [], scenes: [], props: [] })
})

test('storyboard JSON parsing repairs a missing comma between array objects', async () => {
  let retries = 0
  const parsed = await parseJsonObjectWithRepair(
    '{"storyboards":[{"shot_number":1}{"shot_number":2}]}',
    'storyboard',
    async () => {
      retries++
      return '{}'
    },
  )

  assert.equal(retries, 0)
  assert.equal(parsed.storyboards.length, 2)
})

test('TK storyboard generation keeps the complete script in one global pass', () => {
  const source = `## S1 | Moon Hall | Night\n${'Ayla and Rowan continue the same confrontation. '.repeat(80)}`.trim()
  const chunks = buildStoryboardScriptChunks(source, { mode: 'tk_overseas' })
  assert.deepEqual(chunks, [source])
})

test('local MiniMax adaptive-duration storyboard generation keeps the complete script in one global continuity pass', () => {
  const source = `第一场｜夜｜客厅\n${'甲和乙继续同一段连续动作与对白。'.repeat(900)}`.trim()
  const chunks = buildStoryboardScriptChunks(source, { mode: 'minimax_local_8s', shotDuration: 8 })
  assert.deepEqual(chunks, [source])
})

test('MiniMax Chinese storyboard budget scales with long source scripts', () => {
  const source = '中'.repeat(1791)
  assert.ok(getStoryboardOutputTokenBudget(undefined, source, { mode: 'minimax_local_8s' }) > 12000)
  assert.equal(getStoryboardOutputTokenBudget(50000, source, { mode: 'minimax_local_8s' }), 50000)
})

test('storyboard completeness rejects a short but valid JSON response for a long local episode', () => {
  const context = {
    original_script: `## S1 | 厨房 | 日\n${'苏小小：继续做饭。\n'.repeat(250)}`,
    characters: [{ id: 1, name: '苏小小' }],
    scenes: [{ id: 10, location: '厨房', time: '日' }],
  }
  const short = Array.from({ length: 5 }, (_, index) => ({
    shot_number: index + 1,
    scene_id: 10,
    location: '厨房',
    character_ids: [1],
    dialogue: index === 0 ? '苏小小：继续做饭。' : '',
  }))
  const result = validateStoryboardCompleteness(short, context, { mode: 'minimax_local_8s' })
  assert.equal(result.valid, false)
  assert.ok(result.minimumCount > short.length)
  assert.match(result.reasons.join('；'), /镜头|对白/)
})

test('storyboard completeness accepts a covered local storyboard', () => {
  const context = {
    original_script: '## S1 | 厨房 | 日\n苏小小：继续做饭。',
    characters: [{ id: 1, name: '苏小小' }],
    scenes: [{ id: 10, location: '厨房', time: '日' }],
  }
  const result = validateStoryboardCompleteness([{
    shot_number: 1,
    scene_id: 10,
    location: '厨房',
    character_ids: [1],
    dialogue: '苏小小：继续做饭。',
  }], context, { mode: 'minimax_local_8s' })
  assert.equal(result.valid, true)
})

test('automatic storyboard repair inserts a missing source dialogue without regenerating the episode', () => {
  const context = {
    original_script: '## S1 | 厨房 | 日\n甲：先别走。\n乙：我马上回来。',
    characters: [{ id: 1, name: '甲' }, { id: 2, name: '乙' }],
    scenes: [{ id: 10, location: '厨房', time: '日' }],
  }
  const repaired = repairMissingStoryboardDialogue([{
    shot_number: 1,
    scene_id: 10,
    location: '厨房',
    character_ids: [1, 2],
    dialogue: '甲：先别走。',
  }], context, { mode: 'minimax_local_8s' })

  assert.ok(repaired)
  assert.equal(repaired[0].dialogue, '甲：先别走。\n乙：我马上回来。')
  assert.equal(validateStoryboardCompleteness(repaired, context, { mode: 'minimax_local_8s' }).valid, true)
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

test('normalizeStoryboards removes duplicated dialogue when the source contains one occurrence', () => {
  const context = {
    script: '## S1 | 厨房 | 夜\n苏小小：火候到了。她继续颠锅。',
    original_script: '## S1 | 厨房 | 夜\n苏小小：火候到了。她继续颠锅。',
    characters: [{ id: 1, name: '苏小小' }],
    scenes: [{ id: 29, location: '厨房', time: '夜' }],
  }
  const storyboards = normalizeStoryboards([
    { location: '厨房', scene_id: 29, character_ids: [1], dialogue: '苏小小：火候到了。' },
    { location: '厨房', scene_id: 29, character_ids: [1], dialogue: '苏小小：火候到了。' },
  ], context, null)
  assert.equal(storyboards[0].dialogue, '苏小小：火候到了。')
  assert.equal(storyboards[1].dialogue, '')
})

test('normalizeStoryboards keeps explicit scene_id when location text conflicts', () => {
  const context = {
    script: '客厅与厨房发生连续动作',
    characters: [],
    scenes: [
      { id: 10, location: '客厅', time: '日' },
      { id: 11, location: '厨房', time: '日' },
    ],
  }
  const [storyboard] = normalizeStoryboards([
    { location: '厨房', scene_id: 10, duration: 5 },
  ], context, null)
  assert.equal(storyboard.scene_id, 10)
  assert.equal(storyboard.location, '客厅')
})

test('normalizeStoryboards repairs character ids from exact role tags', () => {
  const context = {
    script: '## S1 | 烧烤店 | 夜\n苏小小在炉前颠锅。',
    characters: [
      { id: 18, name: '苏小小' },
      { id: 19, name: '苏大强' },
    ],
    scenes: [{ id: 29, location: '烧烤店', time: '夜' }],
  }
  const [storyboard] = normalizeStoryboards([
    {
      location: '烧烤店',
      scene_id: 29,
      character_ids: [19],
      video_prompt: '<role>苏小小</role>在炉前颠锅。',
    },
  ], context, null)

  assert.deepEqual(storyboard.character_ids, [18])
})

test('normalizeStoryboards canonicalizes a mismatched dialogue speaker and voice binding from the source script', () => {
  const context = {
    script: '## S1 | 厨房 | 夜\n苏小小：（着急）火候到了。\n苏大强：别急。',
    original_script: '## S1 | 厨房 | 夜\n苏小小：（着急）火候到了。\n苏大强：别急。',
    characters: [
      { id: 18, name: '苏小小', role: '女主', voice_style: 'female-shaonv' },
      { id: 19, name: '苏大强', role: '父亲', voice_style: 'male-qn-badao' },
    ],
    scenes: [{ id: 29, location: '厨房', time: '夜' }],
  }
  const [storyboard] = normalizeStoryboards([{
    location: '厨房',
    scene_id: 29,
    character_ids: [19],
    dialogue: '苏大强：火候到了。',
    video_prompt: '<role>苏小小</role><voice>苏大强</voice>在灶台前说话。',
  }], context, null)

  assert.equal(storyboard.dialogue, '苏小小：火候到了。')
  assert.deepEqual(storyboard.character_ids, [18])
  assert.match(storyboard.video_prompt, /<voice>苏小小<\/voice> \(S1;/)
  assert.doesNotMatch(storyboard.video_prompt, /<voice>苏大强<\/voice>/)
})

test('speaker gender inference does not misclassify English descriptions by substring', () => {
  const context = {
    script: '## S1 | 厨房 | 夜\n苏小小：开始。',
    original_script: '## S1 | 厨房 | 夜\n苏小小：开始。',
    characters: [{ id: 18, name: '苏小小', description: 'the young woman with a clear voice' }],
    scenes: [{ id: 29, location: '厨房', time: '夜' }],
  }
  const [storyboard] = normalizeStoryboards([{
    location: '厨房',
    scene_id: 29,
    character_ids: [18],
    dialogue: '苏小小：开始。',
    video_prompt: '<role>苏小小</role><voice>苏小小</voice>开始说话。',
  }], context, null)
  assert.match(storyboard.video_prompt, /gender=female/)
})

test('storyboard completeness treats dialogue as an ordered multiset', () => {
  const context = {
    original_script: '## S1 | 厨房 | 夜\n苏小小：先说。\n苏大强：后说。\n苏小小：先说。',
    characters: [{ id: 18, name: '苏小小' }, { id: 19, name: '苏大强' }],
    scenes: [{ id: 29, location: '厨房', time: '夜' }],
  }
  const result = validateStoryboardCompleteness([
    { scene_id: 29, dialogue: '苏小小：先说。' },
    { scene_id: 29, dialogue: '苏小小：先说。' },
    { scene_id: 29, dialogue: '苏大强：后说。' },
  ], context, { mode: 'minimax_local_8s' })
  assert.equal(result.valid, false)
  assert.match(result.reasons.join('；'), /错序/)
})

test('normalizeStoryboards recognizes natural Chinese speech markers and narration', () => {
  const context = {
    original_script: '## S1 | 厨房 | 夜\n苏小小说：“火候到了。”\n旁白：锅里的油开始冒烟。\n地点：厨房',
    characters: [{ id: 18, name: '苏小小' }],
    scenes: [{ id: 29, location: '厨房', time: '夜' }],
  }
  const storyboards = normalizeStoryboards([
    { scene_id: 29, location: '厨房', dialogue: '苏小小：火候到了。' },
    { scene_id: 29, location: '厨房', dialogue: '旁白：锅里的油开始冒烟。' },
  ], context, null)
  assert.equal(storyboards[0].dialogue, '苏小小：火候到了。')
  assert.equal(storyboards[1].dialogue, '旁白：锅里的油开始冒烟。')
})

test('normalizeStoryboards supplies varied cinematic fallbacks when model omits shot design', () => {
  const context = {
    script: '## S1 | 客厅 | 夜\n人物发生对话',
    characters: [{ id: 1, name: '甲' }],
    scenes: [{ id: 29, location: '客厅', time: '夜' }],
  }
  const storyboards = normalizeStoryboards([
    { location: '客厅', scene_id: 29, character_ids: [1] },
    { location: '客厅', scene_id: 29, character_ids: [1] },
    { location: '客厅', scene_id: 29, character_ids: [1] },
    { location: '客厅', scene_id: 29, character_ids: [1] },
  ], context, null)
  assert.equal(new Set(storyboards.map(item => item.shot_type)).size, 4)
  assert.equal(new Set(storyboards.map(item => item.movement)).size, 4)
  assert.match(storyboards[0].shot_type, /远景|全景/)
  assert.match(storyboards[3].shot_type, /近景|特写/)
})

test('requestMijingPlainChat retries ECONNRESET and keeps Eggfans streaming enabled', async () => {
  const eggfansConfig = {
    ...config,
    provider: 'eggfans',
    baseUrl: 'https://api.eggfans.org',
    model: 'gpt-5.6-sol',
  }
  const requestBodies: any[] = []
  let attempt = 0
  const result = await requestMijingPlainChat(eggfansConfig, 'system', 'user', {
    fetchImpl: async (_url: any, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body || '{}')))
      attempt += 1
      if (attempt === 1) throw new Error('read ECONNRESET')
      return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), { status: 200 })
    },
    retryDelaysMs: [0],
  })

  assert.equal(result, 'recovered')
  assert.equal(attempt, 2)
  assert.deepEqual(requestBodies.map(body => body.stream), [true, true])
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
