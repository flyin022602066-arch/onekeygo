import assert from 'node:assert/strict'
import test from 'node:test'

import { findAvailablePort, replaceAsarWithUnpacked } from '../runtime-utils.mjs'

test('findAvailablePort returns a loopback port', async () => {
  const port = await findAvailablePort(0)
  assert.ok(Number.isInteger(port))
  assert.ok(port > 0 && port <= 65535)
})

test('replaceAsarWithUnpacked keeps development paths and unwraps packaged paths', () => {
  assert.equal(replaceAsarWithUnpacked('C:\\project\\node_modules\\ffmpeg.exe'), 'C:\\project\\node_modules\\ffmpeg.exe')
  assert.equal(
    replaceAsarWithUnpacked('C:\\Program Files\\OneKeyGo\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe'),
    'C:\\Program Files\\OneKeyGo\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe',
  )
})
