import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertRequiredToolCompleted,
  assertStoryboardPersistenceVerified,
  buildAgentGenerateCallOptions,
  buildAgentGenerateOptions,
  buildMijingTextFallbackConfig,
  formatAgentProviderError,
  normalizeToolName,
  normalizeToolResult,
  normalizeEggfansTextFallbackBaseUrl,
  normalizeStoryboardDurationPolicy,
} from '../agent.js'

test('buildAgentGenerateOptions maps agent max_tokens and max_iterations to model options', () => {
  assert.deepEqual(
    buildAgentGenerateOptions({
      maxTokens: 12000,
      maxIterations: 16,
      temperature: 0.4,
    }),
    {
      maxSteps: 16,
      maxOutputTokens: 12000,
      temperature: 0.4,
    },
  )
})

test('buildAgentGenerateOptions uses safe storyboard defaults when agent config is missing', () => {
  assert.deepEqual(buildAgentGenerateOptions({ agentType: 'storyboard_breaker' }), {
    maxSteps: 20,
    maxOutputTokens: 12000,
    temperature: 0.7,
  })
})

test('buildAgentGenerateOptions raises storyboard output budget above the old 4096 default', () => {
  assert.deepEqual(
    buildAgentGenerateOptions({
      agentType: 'storyboard_breaker',
      maxTokens: 4096,
      maxIterations: 10,
      temperature: 0.7,
    }),
    {
      maxSteps: 20,
      maxOutputTokens: 12000,
      temperature: 0.7,
    },
  )
})

test('buildAgentGenerateCallOptions maps the output budget to Mastra maxTokens', () => {
  assert.deepEqual(buildAgentGenerateCallOptions({
    maxSteps: 20,
    maxOutputTokens: 12000,
    temperature: 0.7,
  }), {
    maxSteps: 20,
    maxTokens: 12000,
    temperature: 0.7,
  })
})

test('assertRequiredToolCompleted rejects storyboard runs that never saved storyboards', () => {
  assert.throws(
    () => assertRequiredToolCompleted('storyboard_breaker', [
      { toolName: 'read_storyboard_context', result: '{}' },
    ]),
    /没有真正保存结果.*save_storyboards/,
  )
})

test('assertRequiredToolCompleted accepts storyboard runs that saved storyboards', () => {
  assert.doesNotThrow(() => assertRequiredToolCompleted('storyboard_breaker', [
    { toolName: 'read_storyboard_context', result: '{}' },
    { toolName: 'save_storyboards', result: '{"count":18}' },
  ]))
})

test('assertRequiredToolCompleted rejects script rewrite that did not save content', () => {
  assert.throws(
    () => assertRequiredToolCompleted('script_rewriter', [
      { toolName: 'read_episode_script', result: '{}' },
    ]),
    /没有真正保存结果/,
  )
})

test('assertRequiredToolCompleted requires all extraction save operations', () => {
  assert.throws(
    () => assertRequiredToolCompleted('extractor', [
      { toolName: 'save_dedup_characters', result: '{}' },
    ]),
    /save_dedup_scenes/,
  )
  assert.throws(
    () => assertRequiredToolCompleted('extractor', [
      { toolName: 'save_dedup_characters', result: '{}' },
      { toolName: 'save_dedup_scenes', result: '{}' },
    ]),
    /save_dedup_props/,
  )
})

test('storyboard completion requires the persistence read-back flag', () => {
  assert.doesNotThrow(() => assertStoryboardPersistenceVerified([
    { toolName: 'save_storyboards', result: '{"count":2,"persistence_verified":true}' },
  ]))
  assert.throws(
    () => assertStoryboardPersistenceVerified([
      { toolName: 'save_storyboards', result: '{"count":2,"persistence_verified":false}' },
    ]),
    /校验未通过/,
  )
  assert.throws(
    () => assertStoryboardPersistenceVerified([
      { toolName: 'save_storyboards', result: '{"count":2}' },
    ]),
    /校验未通过/,
  )
})

test('local MiniMax storyboard mode ignores caller duration overrides', () => {
  assert.deepEqual(normalizeStoryboardDurationPolicy({
    storyboard_policy: { mode: 'minimax_local_8s', shot_duration: 5, language: 'en' },
  }), {
    mode: 'minimax_local_8s',
    shotDuration: 8,
    shotDurationMin: 8,
    shotDurationMax: 10,
    language: 'en',
  })
})

test('MiniMax storyboard language falls back to Chinese for unsupported values', () => {
  assert.equal(normalizeStoryboardDurationPolicy({
    storyboard_policy: { mode: 'minimax_local_8s', language: 'fr' },
  })?.language, 'zh')
})

test('normalizes direct MiniMax language aliases without leaking provider frame modes', () => {
  assert.deepEqual(normalizeStoryboardDurationPolicy({
    storyboard_mode: 'minimax_local_8s_en',
  }), {
    mode: 'minimax_local_8s',
    shotDuration: 8,
    shotDurationMin: 8,
    shotDurationMax: 10,
    language: 'en',
  })
  assert.deepEqual(normalizeStoryboardDurationPolicy({
    breakdown_mode: 'minimax_local_8s_zh',
  }), {
    mode: 'minimax_local_8s',
    shotDuration: 8,
    shotDurationMin: 8,
    shotDurationMax: 10,
    language: 'zh',
  })
})

test('explicit storyboard modes stay isolated from the selected video model', () => {
  assert.deepEqual(normalizeStoryboardDurationPolicy({
    breakdown_mode: 'standard',
    video_model: 'grok-video-3-10s',
    video_provider: 'eggfans',
  }), { mode: 'standard' })
  assert.deepEqual(normalizeStoryboardDurationPolicy({
    breakdown_mode: 'full',
    video_model: 'grok-video-3-10s',
    video_provider: 'eggfans',
  }), { mode: 'full' })
  assert.deepEqual(normalizeStoryboardDurationPolicy({
    breakdown_mode: 'grok_3min',
    video_model: 'veo3.1',
  }), {
    mode: 'grok_3min',
    shotDuration: 10,
    maxTotalDuration: 180,
    maxShots: 18,
  })
  assert.deepEqual(normalizeStoryboardDurationPolicy({
    breakdown_mode: 'unrecognized_mode',
    video_model: 'grok-video-3-10s',
  }), { mode: 'standard' })
})

test('normalizes Mastra stream chunks from the payload envelope', () => {
  const resultChunk = {
    type: 'tool-result',
    payload: {
      toolCallId: 'call-1',
      toolName: 'save_dedup_characters',
      result: { created: 1, merged: 2 },
    },
  }
  assert.equal(normalizeToolName(resultChunk), 'save_dedup_characters')
  assert.equal(normalizeToolResult(resultChunk), '{"created":1,"merged":2}')
})

test('normalizes Mastra camelCase tool ids to registered snake_case ids', () => {
  assert.equal(normalizeToolName({ payload: { toolName: 'saveDedupCharacters' } }), 'save_dedup_characters')
  assert.equal(normalizeToolName({ payload: { toolName: 'saveDedupScenes' } }), 'save_dedup_scenes')
  assert.equal(normalizeToolName({ payload: { toolName: 'saveDedupProps' } }), 'save_dedup_props')
})

test('does not mistake Mastra chunk types for tool names', () => {
  assert.equal(normalizeToolName({ type: 'tool-result', payload: {} }), null)
  assert.equal(normalizeToolName({ type: 'tool-call', payload: {} }), null)
})

test('Mijing schema failure can use configured Eggfans text without changing active flags', () => {
  const fallback = buildMijingTextFallbackConfig([
    {
      id: 91,
      serviceType: 'text',
      provider: 'eggfans',
      name: 'Eggfans text',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'test-key',
      model: JSON.stringify(['gpt-5.5']),
      endpoint: '/v1/chat/completions',
      queryEndpoint: null,
      priority: 100,
      isDefault: false,
      isActive: false,
      settings: JSON.stringify({ eggfans: { routeFamily: 'openai-chat' } }),
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    },
  ], {
    provider: 'mijing',
    baseUrl: 'https://api.mjing.cc',
    apiKey: 'mijing-key',
    model: 'deepseek-v4-pro',
  }, new Error('fields not exists:[platform_model_ratio_source]'))

  assert.equal(fallback?.provider, 'eggfans')
  assert.equal(fallback?.model, 'gpt-5.5')
  assert.equal(fallback?.baseUrl, 'https://api.eggfans.org')
})

test('Mijing fallback stays disabled for unrelated provider failures', () => {
  assert.equal(buildMijingTextFallbackConfig([], {
    provider: 'mijing',
    baseUrl: 'https://api.mjing.cc',
    apiKey: 'key',
    model: 'deepseek-v4-pro',
  }, new Error('AuthenticationError')), null)
  assert.equal(normalizeEggfansTextFallbackBaseUrl('https://custom.example/v1'), 'https://custom.example/v1')
})

test('formatAgentProviderError explains Cloudflare 524 instead of exposing none', () => {
  assert.match(formatAgentProviderError({
    message: '<none>',
    statusCode: 524,
    responseHeaders: { 'retry-after': '120' },
    responseBody: '<title>eggfans.com | 524: A timeout occurred</title>',
  }), /HTTP 524.*Eggfans.*120 秒后重试/)
})

test('formatAgentProviderError keeps useful non-placeholder provider errors', () => {
  assert.equal(formatAgentProviderError(new Error('模型暂时不可用')), '模型暂时不可用')
})
