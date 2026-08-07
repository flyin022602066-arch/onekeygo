import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveEggfansRoute,
  shouldUseOfficialVolcengineVideo,
} from '../routing.js'

test('resolveEggfansRoute maps endpoint families for supported models', () => {
  assert.equal(resolveEggfansRoute('text', 'qwen3.7-max', ['openai']).family, 'openai-chat')
  assert.equal(resolveEggfansRoute('image', 'gpt-image-2', ['image-generation']).family, 'openai-image')
  assert.equal(resolveEggfansRoute('video', 'happyhorse-1.0-i2v', ['happyhorse视频']).family, 'alibailian-video')
  assert.equal(resolveEggfansRoute('video', 'wan2.6-i2v', ['wan视频生成']).family, 'alibailian-video')
  assert.equal(resolveEggfansRoute('video', 'veo3.1', ['视频统一格式']).family, 'unified-video')
  assert.equal(resolveEggfansRoute('video', 'grok-video-3', ['grok视频']).family, 'unified-video')
  assert.equal(resolveEggfansRoute('video', 'veo_3_1', ['openAI视频格式']).family, 'openai-video')
  assert.equal(resolveEggfansRoute('video', 'MiniMax-Hailuo-02', ['海螺视频生成']).family, 'minimax-video')
  assert.equal(resolveEggfansRoute('video', 'viduq3-turbo', ['vidu图生视频', 'vidu首尾帧', 'vidu文生视频']).family, 'vidu-video')
  assert.equal(resolveEggfansRoute('audio', 'speech-2.8-hd', ['同步语音']).family, 'minimax-sync-tts')
})

test('Seedance 2.0 video models stay on official VolcEngine provider', () => {
  assert.equal(shouldUseOfficialVolcengineVideo('doubao-seedance-2-0-pro-260215'), true)
  assert.equal(shouldUseOfficialVolcengineVideo('doubao-seedance-2.0-pro'), true)
  assert.equal(shouldUseOfficialVolcengineVideo('doubao-seedance-1-5-pro-251215'), false)
  assert.equal(shouldUseOfficialVolcengineVideo('happyhorse-1.0-i2v'), false)
})

test('resolveEggfansRoute rejects Seedance 2.0 as an Eggfans video route', () => {
  assert.throws(
    () => resolveEggfansRoute('video', 'doubao-seedance-2-0-pro-260215', ['豆包视频异步']),
    /official VolcEngine/i,
  )
})

test('resolveEggfansRoute rejects Responses-only text models for chat completions', () => {
  assert.throws(
    () => resolveEggfansRoute('text', 'gpt-5.5-pro', ['openai-response']),
    /No Eggfans route/i,
  )
})
