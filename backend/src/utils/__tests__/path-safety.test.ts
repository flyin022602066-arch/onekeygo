import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { normalizeRelativeId, resolveInside } from '../path-safety.js'

test('normalizeRelativeId accepts nested ids made of safe path segments', () => {
  assert.equal(normalizeRelativeId('extractor/custom_skill-1.0'), 'extractor/custom_skill-1.0')
})

test('normalizeRelativeId rejects traversal, absolute paths, and unsafe characters', () => {
  assert.throws(() => normalizeRelativeId('../README'))
  assert.throws(() => normalizeRelativeId('/tmp/secret'))
  assert.throws(() => normalizeRelativeId('agent/../../secret'))
  assert.throws(() => normalizeRelativeId('agent\\secret'))
  assert.throws(() => normalizeRelativeId('agent/<script>'))
})

test('resolveInside rejects paths that escape the configured root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eggfans-root-'))
  assert.equal(resolveInside(root, 'skills/demo'), path.join(root, 'skills/demo'))
  assert.throws(() => resolveInside(root, '../outside'))
})
