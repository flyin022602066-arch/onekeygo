import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MINIMAX_VOICES, isMinimaxLikeTTSProvider, normalizeTTSVoiceForProvider } from '../tts-voices.js'

test('normalizes legacy OpenAI voices for Eggfans MiniMax TTS', () => {
  assert.equal(normalizeTTSVoiceForProvider('nova', 'eggfans'), 'female-tianmei')
  assert.equal(normalizeTTSVoiceForProvider('fable', 'eggfans'), 'male-qn-qingse')
  assert.equal(normalizeTTSVoiceForProvider('onyx', 'minimax'), 'male-qn-badao')
})

test('keeps provider-native voices and non-MiniMax providers unchanged', () => {
  assert.equal(normalizeTTSVoiceForProvider('female-yujie', 'eggfans'), 'female-yujie')
  assert.equal(normalizeTTSVoiceForProvider('nova', 'openai'), 'nova')
})

test('default MiniMax voices are Chinese production-ready voices', () => {
  assert.ok(isMinimaxLikeTTSProvider('eggfans'))
  assert.ok(DEFAULT_MINIMAX_VOICES.length >= 8)
  assert.ok(DEFAULT_MINIMAX_VOICES.every(voice => voice.language === '中文'))
  assert.ok(DEFAULT_MINIMAX_VOICES.some(voice => voice.id === 'male-qn-jingying'))
  assert.ok(DEFAULT_MINIMAX_VOICES.some(voice => voice.id === 'female-tianmei'))
})
