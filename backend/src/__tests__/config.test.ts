import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadConfig } from '../config.js'

test('loadConfig reads config.yaml values and resolves project-relative paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eggfans-config-'))
  const configDir = path.join(root, 'configs')
  fs.mkdirSync(configDir)
  const configPath = path.join(configDir, 'config.yaml')
  fs.writeFileSync(configPath, [
    'server:',
    '  port: 4321',
    '  host: "127.0.0.1"',
    '  cors_origins:',
    '    - "http://localhost:3013"',
    'database:',
    '  path: "./data/custom.db"',
    'storage:',
    '  local_path: "./data/assets"',
    '  base_url: "http://localhost:4321/static"',
    '',
  ].join('\n'))

  const config = loadConfig({ configPath, projectRoot: root, env: {} })

  assert.equal(config.server.port, 4321)
  assert.equal(config.server.host, '127.0.0.1')
  assert.deepEqual(config.server.corsOrigins, ['http://localhost:3013'])
  assert.equal(config.database.path, path.join(root, 'data/custom.db'))
  assert.equal(config.storage.localPath, path.join(root, 'data/assets'))
  assert.equal(config.storage.baseUrl, 'http://localhost:4321/static')
})

test('loadConfig lets environment variables override yaml defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eggfans-config-env-'))
  const config = loadConfig({
    projectRoot: root,
    env: {
      PORT: '9876',
      HOST: '127.0.0.1',
      DB_PATH: './tmp/test.db',
      STORAGE_PATH: './tmp/static',
      CORS_ORIGINS: 'http://localhost:1,http://localhost:2',
    },
  })

  assert.equal(config.server.port, 9876)
  assert.equal(config.server.host, '127.0.0.1')
  assert.deepEqual(config.server.corsOrigins, ['http://localhost:1', 'http://localhost:2'])
  assert.equal(config.database.path, path.join(root, 'tmp/test.db'))
  assert.equal(config.storage.localPath, path.join(root, 'tmp/static'))
})
