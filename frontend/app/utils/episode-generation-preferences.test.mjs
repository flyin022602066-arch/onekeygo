import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createEpisodeGenerationPreferences,
  getEpisodeGenerationPreferenceKey,
  normalizeEpisodeGenerationPreferences,
} from './episode-generation-preferences.mjs'

test('episode generation preferences use an episode-scoped key', () => {
  assert.equal(getEpisodeGenerationPreferenceKey(42), 'episode-generation-preferences:42')
  assert.equal(getEpisodeGenerationPreferenceKey(0), '')
})

test('episode generation preferences round-trip all generation controls', () => {
  const saved = createEpisodeGenerationPreferences({
    selectedImageModelKey: 'image:7',
    selectedGptImage2CSize: '2048x1152',
    selectedVideoModelKey: 'video:9',
    selectedVideoAspectRatio: '9:16',
    selectedLocalContinuityMode: 'latent_plus',
    selectedLocalUnetModel: 'minimax-h3/custom.safetensors',
    selectedLocalMegapixels: 0.5,
    selectedLocalSteps: 8,
    selectedLocalLoraStrength: 0.75,
    selectedSequenceStart: 3,
    selectedAudioModelKey: 'audio:2',
    frameMode: 'single_ref',
    composeAudioMode: 'tts',
  })

  assert.deepEqual(normalizeEpisodeGenerationPreferences(saved), saved)
  assert.equal(normalizeEpisodeGenerationPreferences(null), null)
})
