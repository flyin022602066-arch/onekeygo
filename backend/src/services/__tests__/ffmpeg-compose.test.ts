import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildComposeOutputOptions,
  buildTTSBedMixFilter,
  normalizeComposeOptions,
} from '../ffmpeg-compose.js'

test('normalizeComposeOptions skips generated dubbing and subtitles for original-audio compose', () => {
  assert.deepEqual(normalizeComposeOptions({ audioMode: 'original' }), {
    audioMode: 'original',
    subtitleMode: 'none',
  })
})

test('buildComposeOutputOptions can keep source audio or produce silent output without TTS', () => {
  const originalAudioOptions = buildComposeOutputOptions({ audioMode: 'original', hasTtsAudio: false })
  assert.deepEqual(originalAudioOptions, [
    '-map', '0:v:0', '-c:v', 'copy',
    '-map', '0:a?', '-c:a', 'aac',
  ])

  const silentOptions = buildComposeOutputOptions({ audioMode: 'silent', hasTtsAudio: false })
  assert.deepEqual(silentOptions, [
    '-map', '0:v:0', '-c:v', 'copy',
    '-an',
  ])
})

test('buildComposeOutputOptions only re-encodes video when filters require it', () => {
  const filteredOptions = buildComposeOutputOptions({
    audioMode: 'tts',
    hasTtsAudio: true,
    reencodeVideo: true,
  })

  assert.deepEqual(filteredOptions, [
    '-map', '0:v:0',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16',
    '-map', '1:a:0', '-c:a', 'aac', '-shortest',
  ])
})

test('tts compose keeps original audio bed during voice silence', () => {
  const options = buildComposeOutputOptions({
    audioMode: 'tts',
    hasTtsAudio: true,
    mixOriginalAudio: true,
  })

  assert.deepEqual(options, [
    '-map', '0:v:0', '-c:v', 'copy',
    '-filter_complex', buildTTSBedMixFilter(),
    '-map', '[aout]',
    '-c:a', 'aac',
    '-ar', '48000',
    '-b:a', '192k',
  ])
  assert.match(buildTTSBedMixFilter(), /sidechaincompress/)
  assert.match(buildTTSBedMixFilter(), /apad/)
  assert.match(buildTTSBedMixFilter(), /amix=inputs=2:duration=first/)
})
