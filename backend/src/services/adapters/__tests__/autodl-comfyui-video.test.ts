import test from 'node:test'
import assert from 'node:assert/strict'
import { AutoDlComfyUiVideoAdapter } from '../autodl-comfyui-video.js'
import { ComfyUiVideoAdapter } from '../comfyui-video.js'

const base = {
  id: 7,
  model: 'my-h3-r2v',
  prompt: 'A woman walks through the kitchen',
  referenceMode: 'multiple',
  referenceImageUrls: JSON.stringify(['https://img.example/continuity.png', 'https://img.example/character.png']),
  duration: 8,
  aspectRatio: '9:16',
  megapixels: 1,
}

test('AutoDL adapter uses its hosted two-step API and isolated settings', () => {
  const adapter = new AutoDlComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'autodl_comfyui',
    baseUrl: 'https://autodl.art',
    apiKey: 'autodl-token',
    model: 'fallback-workflow',
    settings: {
      autodlComfyui: {
        workflowId: 'stale-workflow-id',
        resolution: '768p竖',
        extraParams: { steps: 6 },
      },
      comfyui: { lora: 'must-not-leak.safetensors', steps: 4 },
    },
  }, base)

  assert.equal(request.method, 'POST')
  assert.equal(request.url, 'https://autodl.art/api/v1/comfyui/comfyui_workflow/stale-workflow-id')
  assert.equal(request.headers.Authorization, 'autodl-token')
  assert.deepEqual(request.body, {
    steps: 6,
    prompt: base.prompt,
    duration: 8,
    resolution: '768p竖',
    ref_image_0: 'https://img.example/continuity.png',
    ref_image_1: 'https://img.example/character.png',
  })

  assert.deepEqual(adapter.parseGenerateResponse({ code: 'Success', data: { task_id: 'task-1', status: 'QUEUED' } }), {
    isAsync: true,
    taskId: 'autodl_comfyui:task-1',
  })
  const poll = adapter.buildPollRequest({
    provider: 'autodl_comfyui', baseUrl: 'https://autodl.art', apiKey: 'autodl-token', model: '',
  }, 'autodl_comfyui:task-1')
  assert.equal(poll.url, 'https://autodl.art/api/v1/comfyui/comfyui_workflow/result/task-1')
  assert.deepEqual(adapter.parsePollResponse({ code: 'Success', data: { status: 'SUCCESS', results: [{ url: 'https://cdn.example/out.mp4' }] } }), {
    status: 'completed', videoUrl: 'https://cdn.example/out.mp4',
  })
  assert.deepEqual(adapter.parsePollResponse({ code: 'Success', data: { status: 'SUCCESS', results: [{ download_url: 'https://cdn.example/out-2.mp4' }] } }), {
    status: 'completed', videoUrl: 'https://cdn.example/out-2.mp4',
  })
})

test('AutoDL adapter matches the MiniMax H3 image-audio-to-video contract', () => {
  const adapter = new AutoDlComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'autodl_comfyui',
    baseUrl: 'https://autodl.art',
    apiKey: 'autodl-token',
    model: '',
  }, {
    id: 8,
    model: '',
    prompt: 'A woman walks through the kitchen',
    referenceMode: 'multiple',
    referenceImageUrls: JSON.stringify(['https://img.example/one.png', 'https://img.example/two.png']),
    referenceAudioUrls: JSON.stringify(['https://audio.example/voice.mp3', 'https://audio.example/music.wav']),
  })

  assert.equal(request.url, 'https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_image_audio_to_video_v2_15s')
  assert.deepEqual(request.body, {
    prompt: 'A woman walks through the kitchen',
    duration: 5,
    resolution: '768p竖',
    ref_image_0: 'https://img.example/one.png',
    ref_image_1: 'https://img.example/two.png',
    ref_audio_0: 'https://audio.example/voice.mp3',
    ref_audio_1: 'https://audio.example/music.wav',
  })

  assert.deepEqual(adapter.parsePollResponse({
    msg: '',
    code: 'Success',
    data: {
      status: 'completed',
      results: [{ url: 'https://cdn.example/minimax.mp4', type: 'video', file_type: 'mp4', output_type: 'output' }],
      task_id: '671ce5ca-80b3-4a18-8b5c-af6013f0f03d',
      client_id: '158a0bba46b6a42f9b175ecdeaea2ac4',
    },
    request_id: '0782accb6b05116890256ffaa01cb283',
  }), { status: 'completed', videoUrl: 'https://cdn.example/minimax.mp4' })
})

test('AutoDL adapter rejects prompts outside the documented MiniMax range', () => {
  const adapter = new AutoDlComfyUiVideoAdapter()
  assert.throws(() => adapter.buildGenerateRequest({
    provider: 'autodl_comfyui', baseUrl: 'https://autodl.art', apiKey: '', model: '',
  }, { id: 9, prompt: '', referenceMode: 'none' }), /prompt 必须为 1-10000 个字符/)
})

test('AutoDL status/error parsing is independent from local ComfyUI history format', () => {
  const adapter = new AutoDlComfyUiVideoAdapter()
  assert.deepEqual(adapter.parsePollResponse({ data: { status: 'RUNNING' } }), { status: 'processing' })
  assert.deepEqual(adapter.parsePollResponse({ data: { status: 'FAILED', message: 'workflow failed' } }), { status: 'failed', error: 'workflow failed' })
  assert.throws(() => adapter.parseGenerateResponse({ code: 'Error', msg: 'workflow not found' }), /workflow not found/)
  const local = new ComfyUiVideoAdapter()
  assert.deepEqual(local.parseGenerateResponse({ prompt_id: 'local-1' }), { isAsync: true, taskId: 'comfyui:local-1' })
})
