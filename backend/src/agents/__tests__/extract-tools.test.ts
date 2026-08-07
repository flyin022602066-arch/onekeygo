import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getEpisodeExtractionContent,
  resolveExtractionSource,
} from '../tools/extract-tools.js'

test('extraction source defaults to formatted screenplay', () => {
  const episode = {
    content: '原始剧本：林凡在雨夜回家',
    scriptContent: '格式化剧本：## S1 | 外景 · 街道 | 夜\n林凡走回家。',
  }

  assert.equal(resolveExtractionSource(undefined), 'script')
  assert.equal(getEpisodeExtractionContent(episode), episode.scriptContent)
})

test('raw extraction reads the current original content even when an old screenplay exists', () => {
  const episode = {
    content: '新原始内容：苏清雪走进客厅',
    scriptContent: '旧格式化内容：林凡独自在办公室',
  }

  assert.equal(resolveExtractionSource('raw'), 'raw')
  assert.equal(getEpisodeExtractionContent(episode, 'raw'), episode.content)
})

test('empty raw content does not silently fall back to stale screenplay', () => {
  const episode = {
    content: '   ',
    scriptContent: '旧格式化内容',
  }

  assert.equal(getEpisodeExtractionContent(episode, 'raw'), '')
})
