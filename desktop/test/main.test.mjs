import assert from 'node:assert/strict'
import test from 'node:test'

import { applyBundledMediaEnvironment, findAvailablePort, replaceAsarWithUnpacked } from '../runtime-utils.mjs'
import {
  buildComfyUiLaunchArgs,
  comfyUiDefaults,
  createComfyUiWorkerManager,
  resolveComfyUiInstallation,
} from '../comfyui-worker.mjs'
import {
  markFinalizedSequenceGeneration,
  sequenceGenerationIdsToRefresh,
  versionedLocalVideoPath,
} from '../../frontend/app/utils/video-sequence-sync.mjs'

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

test('missing bundled media clears stale paths inherited from an older release', () => {
  const env = {
    FFMPEG_PATH: 'C:\\old-release\\ffmpeg.exe',
    FFPROBE_PATH: 'C:\\old-release\\ffprobe.exe',
  }
  applyBundledMediaEnvironment(env, { ffmpeg: '', ffprobe: '' })
  assert.equal(env.FFMPEG_PATH, undefined)
  assert.equal(env.FFPROBE_PATH, undefined)

  applyBundledMediaEnvironment(env, { ffmpeg: 'C:\\new\\ffmpeg.exe', ffprobe: 'C:\\new\\ffprobe.exe' })
  assert.equal(env.FFMPEG_PATH, 'C:\\new\\ffmpeg.exe')
  assert.equal(env.FFPROBE_PATH, 'C:\\new\\ffprobe.exe')
})

test('sequence generation sync refreshes a just-finalized video after backend post-processing', () => {
  const finalized = new Set()
  const generations = [{
    id: 65,
    status: 'completed',
    localPath: 'static/videos/raw-comfy-output.mp4',
  }]
  const completedStep = { videoGenerationId: 65, status: 'completed' }

  assert.deepEqual(sequenceGenerationIdsToRefresh([completedStep], generations, finalized), [65])
  markFinalizedSequenceGeneration(completedStep, finalized)
  assert.deepEqual(sequenceGenerationIdsToRefresh([completedStep], generations, finalized), [])
})

test('sequence generation sync keeps polling while local video processing is active', () => {
  const generations = [{ id: 65, status: 'completed' }]
  const processingStep = { video_generation_id: 65, status: 'processing' }
  assert.deepEqual(sequenceGenerationIdsToRefresh([processingStep], generations, new Set()), [65])
})

test('versioned local video paths bust Chromium media cache after finalization', () => {
  assert.equal(
    versionedLocalVideoPath('static/videos/shot.mp4', { id: 65, updatedAt: '2026-08-29T04:26:33.997Z' }),
    'static/videos/shot.mp4?v=2026-08-29T04%3A26%3A33.997Z',
  )
  assert.equal(versionedLocalVideoPath('https://cdn.example/shot.mp4', { id: 65 }), 'https://cdn.example/shot.mp4')
})

test('resolveComfyUiInstallation can be disabled for machines without a local worker', () => {
  assert.equal(resolveComfyUiInstallation({ MIJING_AUTO_START_COMFYUI: '0' }), null)
})

test('resolveComfyUiInstallation uses the configured workspace and Python runtime', () => {
  assert.equal(comfyUiDefaults.baseUrl, 'http://127.0.0.1:8188')
  const installation = resolveComfyUiInstallation({ MIJING_COMFYUI_WORKSPACE: 'Z:\\missing-comfyui' })
  assert.equal(installation?.workspace, 'D:\\ComfyUI-aki-v1.4\\ComfyUI-aki-v1.4')
  assert.match(installation?.python || '', /\.ext\\python\.exe$/i)
})

test('ComfyUI worker launch args preserve ComfyUI smart memory management', () => {
  assert.deepEqual(buildComfyUiLaunchArgs('http://127.0.0.1:8188'), [
    'main.py',
    '--listen', '127.0.0.1',
    '--port', '8188',
    '--disable-auto-launch',
    '--preview-method', 'auto',
  ])
  const overridden = buildComfyUiLaunchArgs('http://127.0.0.1:8188', ['--port', '8288', '--preview-method', 'none'])
  assert.equal(overridden.filter(value => value === '--port').length, 1)
  assert.equal(overridden.filter(value => value === '--preview-method').length, 1)
  assert.deepEqual(overridden.slice(-4), ['--port', '8288', '--preview-method', 'none'])
})

test('ComfyUI Worker manager serializes concurrent startup and repair calls', async () => {
  let starts = 0
  let releaseStart
  const started = new Promise(resolve => { releaseStart = resolve })
  const manager = createComfyUiWorkerManager({
    readyCheck: async () => false,
    ensureWorker: async ({ baseUrl }) => {
      starts += 1
      await started
      return { ready: true, started: true, owned: true, baseUrl, child: { killed: false } }
    },
    stopWorker: () => true,
  })
  const first = manager.ensure()
  const second = manager.ensure({ forceRestart: true, reason: 'fetch failed' })
  releaseStart()
  await Promise.all([first, second])
  assert.equal(starts, 1)
})

test('ComfyUI Worker manager only restarts a Worker owned by the app', async () => {
  let ready = true
  let starts = 0
  let stops = 0
  const manager = createComfyUiWorkerManager({
    readyCheck: async () => ready,
    ensureWorker: async ({ baseUrl }) => {
      starts += 1
      return { ready: true, started: true, owned: true, baseUrl, child: { killed: false } }
    },
    stopWorker: () => { stops += 1; return true },
  })

  await manager.ensure()
  ready = false
  await manager.ensure({ forceRestart: true })
  assert.equal(stops, 0, 'an external Worker must not be terminated')
  assert.equal(starts, 1)

  await manager.ensure({ forceRestart: true })
  assert.equal(stops, 1, 'the app-owned replacement may be restarted')
  assert.equal(starts, 2)
})

test('ComfyUI Worker manager force-restarts an app-owned Worker even when health is still green', async () => {
  let ready = false
  let starts = 0
  let stops = 0
  const manager = createComfyUiWorkerManager({
    readyCheck: async () => ready,
    ensureWorker: async ({ baseUrl }) => {
      starts += 1
      ready = true
      return { ready: true, started: true, owned: true, baseUrl, child: { killed: false } }
    },
    stopWorker: () => { stops += 1; ready = false; return true },
  })

  await manager.ensure()
  await manager.ensure({ forceRestart: true, reason: 'request connection reset' })
  assert.equal(starts, 2)
  assert.equal(stops, 1)
})
