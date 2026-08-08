import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveMediaBinary } from '../media-tools.js'

test('resolveMediaBinary uses configured desktop binary paths', () => {
  assert.equal(resolveMediaBinary('  C:\\tools\\ffmpeg.exe  ', 'ffmpeg'), 'C:\\tools\\ffmpeg.exe')
})

test('resolveMediaBinary falls back for blank values', () => {
  assert.equal(resolveMediaBinary('   ', 'ffprobe'), 'ffprobe')
  assert.equal(resolveMediaBinary(undefined, 'ffprobe'), 'ffprobe')
})
