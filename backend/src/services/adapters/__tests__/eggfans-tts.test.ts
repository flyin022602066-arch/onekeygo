import test from 'node:test'
import assert from 'node:assert/strict'
import { EggfansTTSAdapter } from '../eggfans-tts.js'

const adapter = new EggfansTTSAdapter()

test('EggfansTTSAdapter builds MiniMax sync TTS requests by default', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'speech-2.8-hd',
    },
    {
      text: '你好',
      voice: 'moss_audio_demo',
      speed: 1.1,
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/minimax/v1/t2a_v2')
  assert.equal(req.method, 'POST')
  assert.equal(req.body.model, 'speech-2.8-hd')
  assert.equal(req.body.text, '你好')
  assert.equal(req.body.stream, false)
  assert.equal(req.body.voice_setting.voice_id, 'moss_audio_demo')
  assert.equal(req.body.voice_setting.speed, 1.1)
  assert.deepEqual(req.body.audio_setting, {
    sample_rate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1,
  })
  assert.equal(req.body.subtitle_enable, false)
})

test('EggfansTTSAdapter builds Gemini TTS requests from route metadata', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gemini-3.1-flash-tts-preview',
      endpoint: '/v1beta/models/{model}:generateContent',
      settings: { eggfans: { routeFamily: 'gemini-tts', endpointTypes: ['geminitts'] } },
    },
    {
      text: '你好，欢迎来到 Eggfans。',
      voice: 'female-shaonv',
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent')
  assert.equal(req.method, 'POST')
  assert.equal(req.headers.Authorization, 'Bearer secret')
  assert.equal(req.body.contents[0].parts[0].text, '你好，欢迎来到 Eggfans。')
  assert.equal(req.body.generationConfig.responseModalities[0], 'AUDIO')
  assert.equal(req.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'female-shaonv')
  assert.equal('voice_setting' in req.body, false)
})

test('EggfansTTSAdapter parses hex audio response', () => {
  assert.deepEqual(adapter.parseResponse({
    data: {
      audio: 'ff00',
      extra_info: {
        audio_length: 1000,
        audio_sample_rate: 32000,
        audio_format: 'mp3',
        audio_channel: 1,
      },
    },
  }), {
    audioHex: 'ff00',
    audioUrl: undefined,
    audioLength: 1000,
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1,
  })
})

test('EggfansTTSAdapter parses URL audio response', () => {
  assert.deepEqual(adapter.parseResponse({ data: { audio_url: 'https://cdn.example/a.mp3' } }), {
    audioHex: undefined,
    audioUrl: 'https://cdn.example/a.mp3',
    audioLength: 0,
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1,
  })
})

test('EggfansTTSAdapter parses Gemini inline audio response', () => {
  assert.deepEqual(adapter.parseResponse({
    candidates: [{
      content: {
        parts: [{
          inlineData: {
            mimeType: 'audio/wav',
            data: Buffer.from('wav').toString('base64'),
          },
        }],
      },
    }],
  }), {
    audioBase64: Buffer.from('wav').toString('base64'),
    audioHex: undefined,
    audioUrl: undefined,
    audioLength: 0,
    sampleRate: 24000,
    bitrate: 128000,
    format: 'wav',
    channel: 1,
  })
})

test('EggfansTTSAdapter reports provider error when response has no audio', () => {
  assert.throws(
    () => adapter.parseResponse({ base_resp: { status_code: 1002, status_msg: 'voice_id invalid' } }),
    /voice_id invalid/,
  )
})
