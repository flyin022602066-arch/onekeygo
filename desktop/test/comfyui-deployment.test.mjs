import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureBundledH3Nodes } from '../comfyui-worker.mjs'

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mijing-h3-deploy-'))
  context.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const workspace = path.join(root, 'ComfyUI')
  const source = path.join(root, 'source')
  fs.mkdirSync(workspace)
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, '__init__.py'), 'node_v1 = True\n')
  return { root, workspace, source }
}

test('bundled H3 deployment is idempotent and backs up only replaced code', context => {
  const { workspace, source } = fixture(context)
  const first = ensureBundledH3Nodes({ workspace }, source)
  assert.equal(first.changed, true)
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'node_v1 = True\n')
  assert.equal(ensureBundledH3Nodes({ workspace }, source).changed, false)
  fs.writeFileSync(path.join(source, '__init__.py'), 'node_v2 = True\n')
  assert.equal(ensureBundledH3Nodes({ workspace }, source).changed, true)
  const backups = fs.readdirSync(path.dirname(first.path)).filter(name => name.includes('.backup-'))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(path.dirname(first.path), backups[0]), 'utf8'), 'node_v1 = True\n')
})

test('bundled H3 deployment refuses redirected custom_nodes directories', context => {
  const { root, workspace, source } = fixture(context)
  const other = path.join(root, 'other-project')
  fs.mkdirSync(other)
  fs.symlinkSync(other, path.join(workspace, 'custom_nodes'), 'junction')
  assert.throws(() => ensureBundledH3Nodes({ workspace }, source), /redirected/)
  assert.deepEqual(fs.readdirSync(other), [])
  fs.unlinkSync(path.join(workspace, 'custom_nodes'))
})
