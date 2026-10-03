import test from 'node:test'
import assert from 'node:assert/strict'
import { ComfyUiVideoAdapter } from '../comfyui-video.js'

const safeConfig = { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: '', settings: { comfyui: { steps: 6, lora: 'unchanged-lora.safetensors', refinement: { enabled: true } } } }
const safeRecord = {
  id: 51, model: 'MiniMax-H3-local', prompt: '<Picture 1> is the customer. <Picture 2> is the father.',
  referenceMode: 'multiple', comfyImageNames: { referenceImages: ['customer.png', 'father.png'] },
  sequenceStepIndex: 4, sequenceRunId: 15, continuityMode: 'standard_r2v', comfyVideoName: 'previous.mp4',
  duration: 5, megapixels: 0.5, comfyH3RefinementAvailable: true, comfyH3VideoTailAvailable: true,
}

test('serial R2V shots pass the complete previous video and current reference order', () => {
  const adapter = new ComfyUiVideoAdapter()
  for (const step of [1, 4, 5, 12]) {
    const graph = adapter.buildGenerateRequest(safeConfig, { ...safeRecord, sequenceStepIndex: step }).body.prompt
    assert.equal(graph.h3_video_tail, undefined)
    assert.deepEqual(graph['5'].inputs['ref_videos.ref_video_0'], ['21', 0])
    assert.equal(graph['5'].inputs['ref_video_audios.ref_video_audio_0'], undefined)
    assert.deepEqual(graph.h3_refine.inputs.reference_video, ['21', 0])
    assert.equal(graph.h3_refine.inputs.reference_audio, undefined)
    assert.deepEqual(graph.h3_refine.inputs.reference_image_0, graph['5'].inputs['ref_images.ref_image_0'])
    assert.deepEqual(graph.h3_refine.inputs.reference_image_1, graph['5'].inputs['ref_images.ref_image_1'])
    assert.equal(graph.h3_refine.inputs.prompt, graph['5'].inputs.prompt)
    assert.match(graph['5'].inputs.prompt, /LOCAL H3 VIDEO END HANDOFF/)
    assert.deepEqual(graph.h3_refine.inputs.base_video, ['h3_base_save', 0])
    assert.deepEqual(graph.h3_base_save.inputs.video, ['14', 0])
    assert.equal(graph['10'].inputs.steps, 6)
    assert.equal(graph['8'].inputs.lora_name, 'unchanged-lora.safetensors')
    assert.equal(graph['7'].inputs.sampler_name, 'euler')
    assert.equal(graph['10'].inputs.scheduler, 'simple')
    assert.ok(Object.values(graph).every((node: any) => !node.class_type.includes('MotionContext')))
  }
})

test('refinement off or unavailable leaves base graph unchanged; Plus never gains a video reference', () => {
  const adapter = new ComfyUiVideoAdapter()
  const graph = adapter.buildGenerateRequest(safeConfig, { ...safeRecord, comfyH3RefinementAvailable: false }).body.prompt
  assert.equal(graph.h3_refine, undefined)
  assert.equal(graph.h3_base_save, undefined)
  assert.deepEqual(graph['15'].inputs.video, ['14', 0])
  const remote = adapter.buildGenerateRequest({ ...safeConfig, baseUrl: 'https://example.com' }, safeRecord).body.prompt
  assert.equal(remote.h3_refine, undefined)
  const plus = adapter.buildGenerateRequest(safeConfig, { ...safeRecord, continuityMode: 'latent_plus', latentPath: 'h3_context/run15', latentClipIndex: 5 }).body.prompt
  assert.equal(plus.h3_video_tail, undefined)
  assert.equal(plus.h3_refine.inputs.reference_video, undefined)
  assert.deepEqual(plus.h3_refine.inputs.positive, ['17', 0])
  assert.deepEqual(plus.h3_refine.inputs.trim_frames, ['17', 1])
})

test('refinement results prefer final output and never complete on an early base snapshot', () => {
  const adapter = new ComfyUiVideoAdapter()
  const outputs = {
    h3_base_save: { images: [{ filename: 'mijing-studio-51-base_00001_.mp4', subfolder: 'video', type: 'output' }] },
    '15': { images: [{ filename: 'mijing-studio-51_00001_.mp4', subfolder: 'video', type: 'output' }] },
  }
  const done = adapter.parsePollResponse({ task: { status: { completed: true }, outputs } }, safeConfig)
  assert.equal(done.status, 'completed')
  assert.ok(done.videoUrl?.includes('filename=mijing-studio-51_00001_'))
  assert.equal(adapter.parsePollResponse({ task: { status: { completed: false }, outputs } }, safeConfig).status, 'processing')
  for (const [node_id, node_type] of [['15', 'SaveVideo'], ['h3_refine', 'MijingH3SafeRefine']]) {
    const status = { status_str: 'error', messages: [['execution_error', { node_id, node_type, exception_type: 'RuntimeError', exception_message: 'out of memory' }]] }
    const fallback = adapter.parsePollResponse({ task: { status, outputs: { h3_base_save: outputs.h3_base_save } } }, safeConfig)
    assert.equal(fallback.status, 'completed')
    assert.ok(fallback.videoUrl?.includes('-base_'))
    assert.ok(fallback.warning)
    status.messages[0]![1] = { node_id, node_type, exception_type: 'InterruptProcessingException', exception_message: 'cancelled' }
    assert.equal(adapter.parsePollResponse({ task: { status, outputs } }, safeConfig).status, 'failed')
  }
})

test('ComfyUI adapter builds the official MiniMax H3 R2V workflow', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188',
    apiKey: '',
    model: 'MiniMax-H3-local',
    endpoint: '/prompt',
    settings: { comfyui: { lora: 'minimaxh3\\minimax_h3_turbo_v4_step600_ema.safetensors', steps: 6 } },
  }, {
    id: 1,
    model: 'MiniMax-H3-local',
    prompt: 'A cinematic shot',
    referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['ref.png'] },
    duration: 0.2,
    aspectRatio: '16:9',
  } as any)

  assert.equal(request.url, 'http://127.0.0.1:8188/prompt')
  assert.equal(request.method, 'POST')
  assert.equal(request.body.prompt['5'].class_type, 'MiniMaxH3ReferenceToVideo')
  assert.equal(request.body.prompt['8_sage'].class_type, 'PathchSageAttentionKJ')
  assert.deepEqual(request.body.prompt['8_sage'].inputs.model, ['8', 0])
  assert.equal(request.body.prompt['8_sage'].inputs.sage_attention, 'auto')
  assert.equal(request.body.prompt['8_sage'].inputs.allow_compile, true)
  assert.deepEqual(request.body.prompt['9'].inputs.model, ['8_sage', 0])
  assert.deepEqual(request.body.prompt['10'].inputs.model, ['8_sage', 0])
  assert.deepEqual(request.body.prompt['5'].inputs.clip, ['2', 0])
  assert.deepEqual(request.body.prompt['5'].inputs.vae, ['3', 0])
  assert.deepEqual(request.body.prompt['5'].inputs.audio_vae, ['4', 0])
  assert.deepEqual(request.body.prompt['12'].inputs.vae, ['3', 0])
  assert.deepEqual(request.body.prompt['13'].inputs.vae, ['4', 0])
  assert.equal(request.body.prompt['7'].inputs.sampler_name, 'euler')
  assert.equal(request.body.prompt['10'].inputs.scheduler, 'simple')
  assert.equal(request.body.prompt['10'].inputs.steps, 6)
  assert.equal(request.body.prompt['1'].inputs.unet_name, 'minimax-h3\\minimax_h3_ref2va_pruned_int8_convrot.safetensors')
  assert.equal(request.body.prompt['2'].inputs.device, 'default')
  assert.equal(request.body.prompt['8'].inputs.lora_name, 'minimaxh3\\minimax_h3_turbo_v4_step600_ema.safetensors')
  assert.equal(request.body.prompt['8'].inputs.strength, 1)
  assert.equal(request.body.prompt['8'].inputs.low_vram, false)
  assert.equal(request.body.prompt['15'].inputs.format, 'mp4')
})

test('ComfyUI adapter applies selected local H3 UNET and Turbo LoRA', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188',
    apiKey: '',
    model: 'MiniMax-H3-local',
    endpoint: '/prompt',
    settings: { comfyui: {
      ref2vaUnet: 'minimax-h3\\minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors',
      lora: 'minimaxh3\\minimax_h3_turbo_4STEPS_comfyui.safetensors',
    } },
  }, {
    id: 2,
    model: 'MiniMax-H3-local',
    prompt: 'A cinematic shot',
    referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['ref.png'] },
    duration: 5,
    aspectRatio: '16:9',
  } as any)
  assert.equal(request.body.prompt['1'].inputs.unet_name, 'minimax-h3\\minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors')
  assert.equal(request.body.prompt['8'].inputs.lora_name, 'minimaxh3\\minimax_h3_turbo_4STEPS_comfyui.safetensors')
})

test('ComfyUI adapter uses the previous full video only for standard serial continuation', () => {
  const adapter = new ComfyUiVideoAdapter()
  const config = {
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
  }
  const first = adapter.buildGenerateRequest(config, {
    id: 1001, model: 'MiniMax-H3-local', prompt: 'opening shot', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['shot1-scene.png'] }, duration: 5, aspectRatio: '16:9', sequenceStepIndex: 0,
  } as any).body.prompt
  assert.equal(first['20'], undefined)
  assert.equal(first['5'].inputs['ref_videos.ref_video_0'], undefined)
  assert.deepEqual(first['5'].inputs['ref_images.ref_image_0'], ['r1', 0])
  assert.equal(first['5'].inputs.prompt, '<Picture 1> opening shot')

  const second = adapter.buildGenerateRequest(config, {
    id: 1002, model: 'MiniMax-H3-local', prompt: 'extend the action', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['shot2-character.png', 'shot2-scene.png'] },
    comfyVideoName: 'mijing-previous-video-1002.mp4', duration: 5, aspectRatio: '16:9', sequenceStepIndex: 1,
  } as any).body.prompt
  assert.equal(second['20'].class_type, 'LoadVideo')
  assert.equal(second['20'].inputs.file, 'mijing-previous-video-1002.mp4')
  assert.deepEqual(second['21'].inputs.video, ['20', 0])
  assert.deepEqual(second['5'].inputs['ref_videos.ref_video_0'], ['21', 0])
  assert.equal(second['5'].inputs['ref_video_audios.ref_video_audio_0'], undefined)
  assert.equal(second['17'], undefined)
  assert.equal(second['18'], undefined)
  assert.deepEqual(second['9'].inputs.conditioning, ['5', 0])
  assert.deepEqual(second['14'].inputs.images, ['12', 0])
  assert.deepEqual(second['14'].inputs.audio, ['13', 0])
  assert.deepEqual(second['5'].inputs['ref_images.ref_image_0'], ['r1', 0])
  assert.deepEqual(second['5'].inputs['ref_images.ref_image_1'], ['r2', 0])
  assert.match(second['5'].inputs.prompt, /^subject_definitions:\nMANDATORY SERIAL VIDEO EXTENSION \(all shots after the first\):/)
  assert.match(second['5'].inputs.prompt, /本分镜为 <Video 1> 参考视频的延长和继承/)
  assert.match(second['5'].inputs.prompt, /final visible instant of <Video 1>/)
  assert.match(second['5'].inputs.prompt, /At 0\.00s, inherit the exact ending view/)
  assert.match(second['5'].inputs.prompt, /<Picture 1> <Picture 2>/)
  assert.equal(second['5'].inputs.length, 5 + Math.ceil((5 * 24 - 5) / 17) * 17)
  assert.equal(second['10'].inputs.steps, first['10'].inputs.steps)

  const plus = adapter.buildGenerateRequest(config, {
    id: 1003, model: 'MiniMax-H3-local', prompt: 'latent continuation', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['shot3-scene.png'] }, comfyVideoName: 'must-not-leak.mp4',
    duration: 5, aspectRatio: '16:9', sequenceStepIndex: 1, continuityMode: 'latent_plus', sequenceRunId: 7,
    latentPath: 'h3_context/mijing-studio-run-7', latentClipIndex: 2,
  } as any).body.prompt
  assert.equal(plus['20'], undefined)
  assert.equal(plus['5'].inputs['ref_videos.ref_video_0'], undefined)
  assert.equal(plus['16'].class_type, 'MiniMaxH3MotionContextLoadLatent')
  assert.equal(plus['5'].inputs.prompt, '<Picture 1> latent continuation')
})

test('standard continuation request is stable on retries and does not leak to shots without a video', () => {
  const adapter = new ComfyUiVideoAdapter()
  const config = { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt' }
  const record = {
    id: 1004, model: 'MiniMax-H3-local', prompt: '0-2s: 0-second opening continuity image state: Ava near a bottle.',
    referenceMode: 'multiple', comfyImageNames: { referenceImages: ['ava.png', 'room.png'] },
    comfyVideoName: 'shot2.mp4', duration: 5, aspectRatio: '16:9', sequenceStepIndex: 2, continuityMode: 'standard_r2v',
  }
  const graph = adapter.buildGenerateRequest(config, record as any).body.prompt
  const prompt = graph['5'].inputs.prompt
  assert.equal(graph['20'].inputs.file, 'shot2.mp4')
  assert.equal((prompt.match(/LOCAL H3 VIDEO END CONTINUATION BEGIN/g) || []).length, 1)
  assert.match(prompt, /TARGET STAGING TO REACH THROUGH CONTINUOUS MOTION/)
  const retried = adapter.buildGenerateRequest(config, { ...record, prompt } as any).body.prompt
  assert.deepEqual(retried, graph)
  const noVideo = adapter.buildGenerateRequest(config, { ...record, comfyVideoName: null } as any).body.prompt
  assert.equal(noVideo['5'].inputs.prompt, `<Picture 1> <Picture 2> ${record.prompt}`)
  assert.equal(noVideo['20'], undefined)
})

test('ComfyUI adapter uses the per-generation LoRA strength and preserves zero', () => {
  const adapter = new ComfyUiVideoAdapter()
  const base = {
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
    settings: { comfyui: { loraStrength: 1 } },
  }
  const request = adapter.buildGenerateRequest(base, {
    id: 901, model: 'MiniMax-H3-local', prompt: 'test', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['ref.png'] }, loraStrength: 0.5,
  } as any)
  assert.equal(request.body.prompt['8'].inputs.strength, 0.5)
  const disabled = adapter.buildGenerateRequest(base, {
    id: 902, model: 'MiniMax-H3-local', prompt: 'test', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['ref.png'] }, loraStrength: 0,
  } as any)
  assert.equal(disabled.body.prompt['8'].inputs.strength, 0)
})

test('ComfyUI adapter inserts optional MiniMax H3 Sage Attention after LoRA', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest(safeConfig, {
    ...safeRecord,
    sequenceStepIndex: 0,
    comfyVideoName: null,
    comfyH3SageAttentionNode: 'PathchSageAttentionKJ',
  } as any)
  const graph = request.body.prompt
  assert.equal(graph['8_sage'].class_type, 'PathchSageAttentionKJ')
  assert.deepEqual(graph['8_sage'].inputs.model, ['8', 0])
  assert.equal(graph['8_sage'].inputs.sage_attention, 'auto')
  assert.equal(graph['8_sage'].inputs.allow_compile, true)
  assert.deepEqual(graph['9'].inputs.model, ['8_sage', 0])
  assert.deepEqual(graph['10'].inputs.model, ['8_sage', 0])
  assert.equal(graph['8'].inputs.lora_name, 'unchanged-lora.safetensors')
  assert.equal(graph['7'].inputs.sampler_name, 'euler')
  assert.equal(graph['10'].inputs.scheduler, 'simple')
})

test('ComfyUI adapter builds latent Plus chaining nodes without changing R2V references', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
    settings: { comfyui: { contextLength: '22', audioContextLength: 24 } },
  }, {
    id: 300, model: 'MiniMax-H3-local', prompt: 'Continue the shot', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['tail.png', 'scene.png'] }, duration: 8, aspectRatio: '16:9',
    continuityMode: 'latent_plus', sequenceRunId: 7, sequenceStepIndex: 1,
    latentPath: 'h3_context/mijing-studio-run-7', latentClipIndex: 2,
  } as any)
  const graph = request.body.prompt
  assert.equal(graph['5'].class_type, 'MiniMaxH3ReferenceToVideo')
  assert.equal(graph['16'].class_type, 'MiniMaxH3MotionContextLoadLatent')
  assert.equal(graph['16'].inputs.clip_index, 1)
  assert.equal(graph['17'].class_type, 'MiniMaxH3MotionContext')
  assert.deepEqual(graph['17'].inputs.context_latent, ['16', 0])
  assert.equal(graph['18'].class_type, 'MiniMaxH3MotionContextTrim')
  assert.equal(graph['19'].class_type, 'MiniMaxH3MotionContextSaveLatent')
  assert.equal(graph['19'].inputs.clip_index, 2)
  assert.equal(graph['19'].inputs.filename_prefix, 'h3_context/mijing-studio-run-7/clip')
  // 8 seconds is 192 legal H3 frames. Motion Context follows the official
  // target + context - 5 rule, so the sampled graph is 209 frames before the
  // 22-frame pinned head is trimmed.
  assert.equal(graph['5'].inputs.length, 209)
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_0'], ['r1', 0])
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_1'], ['r2', 0])
})

test('first Plus shot saves a latent but does not load a missing previous slot', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({ provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt' }, {
    id: 301, model: 'MiniMax-H3-local', prompt: 'Opening shot', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['scene.png'] }, duration: 8, aspectRatio: '16:9',
    continuityMode: 'latent_plus', sequenceRunId: 7, sequenceStepIndex: 0,
    latentPath: 'h3_context/mijing-studio-run-7', latentClipIndex: 1,
  } as any)
  const graph = request.body.prompt
  assert.equal(graph['16'], undefined)
  assert.equal(graph['19'].class_type, 'MiniMaxH3MotionContextSaveLatent')
  assert.equal(graph['19'].inputs.clip_index, 1)
  assert.equal(graph['5'].inputs.length, 192)
})

test('Plus mode normalizes unsupported motion and audio context settings', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
    settings: { comfyui: { contextLength: '17', audioContextLength: 999 } },
  }, {
    id: 302, model: 'MiniMax-H3-local', prompt: 'Continue safely', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['tail.png'] }, duration: 8, aspectRatio: '16:9',
    continuityMode: 'latent_plus', sequenceRunId: 7, sequenceStepIndex: 2,
    latentPath: 'h3_context/mijing-studio-run-7', latentClipIndex: 3,
  } as any)
  const graph = request.body.prompt
  assert.equal(graph['17'].inputs.context_length, '22')
  assert.equal(graph['17'].inputs.audio_context_length, 240)
  assert.equal(graph['5'].inputs.length, 209)
})

test('ComfyUI adapter parses prompt id and history video output', () => {
  const adapter = new ComfyUiVideoAdapter()
  assert.deepEqual(adapter.parseGenerateResponse({ prompt_id: 'abc' }), { isAsync: true, taskId: 'comfyui:abc' })
  const parsed = adapter.parsePollResponse({ abc: { status: { status_str: 'success', completed: true }, outputs: { '7': { videos: [{ filename: 'video.mp4', subfolder: 'video', type: 'output' }] } } } }, { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: '' })
  assert.equal(parsed.status, 'completed')
  assert.match(parsed.videoUrl || '', /127\.0\.0\.1:8188\/view\?/)
})

test('ComfyUI adapter parses SaveVideo MP4 serialized under images', () => {
  const adapter = new ComfyUiVideoAdapter()
  const result = {
    abc: {
      status: { status_str: 'success', completed: true },
      outputs: {
        '7': {
          images: [{ filename: 'mijing-studio-900001_00001_.mp4', subfolder: 'video', type: 'output' }],
          animated: [true],
        },
      },
    },
  }
  const parsed = adapter.parsePollResponse(result, { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: '' })
  assert.equal(parsed.status, 'completed')
  assert.match(parsed.videoUrl || '', /view\?filename=mijing-studio-900001_00001_\.mp4/)
})

test('ComfyUI adapter does not treat image previews as videos', () => {
  const adapter = new ComfyUiVideoAdapter()
  const parsed = adapter.parsePollResponse({ abc: { status: { status_str: 'success', completed: true }, outputs: { '7': { images: [{ filename: 'preview.png', subfolder: 'video', type: 'output' }] } } } }, { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: '' })
  assert.equal(parsed.status, 'failed')
})

test('ComfyUI adapter keeps multi-reference jobs on the dedicated R2V checkpoint', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({ provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt' }, {
    id: 2, model: 'MiniMax-H3-local', prompt: 'Use the references', referenceMode: 'multiple', referenceImageUrls: JSON.stringify(['ref.png']), comfyImageNames: { referenceImages: ['ref.png'] }, duration: 0.2, aspectRatio: '16:9',
  } as any)
  assert.equal(request.body.prompt['1'].inputs.unet_name, 'minimax-h3\\minimax_h3_ref2va_pruned_int8_convrot.safetensors')
  assert.equal(request.body.prompt['2'].inputs.device, 'default')
  assert.equal(request.body.prompt['5'].class_type, 'MiniMaxH3ReferenceToVideo')
  assert.equal(request.body.prompt['5'].inputs.r2v_groups, undefined)
  assert.equal(request.body.prompt['5'].inputs.i2v_groups, undefined)
  assert.equal(request.body.prompt['5'].inputs.first_frame, undefined)
  assert.equal(request.body.prompt['5'].inputs.last_frame, undefined)
  assert.equal(Object.values(request.body.prompt).some((node: any) => JSON.stringify(node?.inputs || {}).includes('first_frame')), false)
  assert.equal(Object.values(request.body.prompt).some((node: any) => JSON.stringify(node?.inputs || {}).includes('last_frame')), false)
  assert.equal(Object.values(request.body.prompt).some((node: any) => node?.class_type === 'MiniMaxH3Director'), false)
  assert.equal(request.body.prompt['9'].class_type, 'BasicGuider')
  assert.equal(request.body.prompt['11'].class_type, 'SamplerCustomAdvanced')
  assert.deepEqual(request.body.prompt['5'].inputs['ref_images.ref_image_0'], ['r1', 0])
  assert.deepEqual(request.body.prompt['11'].inputs.latent_image, ['5', 1])
})

test('ComfyUI adapter uses the selected MiniMax H3 main checkpoint for R2V', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188',
    apiKey: '',
    model: 'MiniMax-H3-local',
    endpoint: '/prompt',
  }, {
    id: 201,
    model: 'minimax-h3\\minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors',
    prompt: 'Use the selected hybrid checkpoint',
    referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['ref.png'] },
    duration: 0.2,
    aspectRatio: '16:9',
  } as any)
  assert.equal(request.body.prompt['1'].inputs.unet_name, 'minimax-h3\\minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors')
})

test('ComfyUI adapter preserves caller-ordered R2V picture slots without a first_frame input', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
  }, {
    id: 7,
    model: 'MiniMax-H3-local',
    prompt: 'Continue the action from picture 1',
    referenceMode: 'multiple',
    firstFrameUrl: null,
    referenceImageUrls: JSON.stringify(['tail.png', 'character.png', 'scene.png']),
    comfyImageNames: { referenceImages: ['tail.png', 'character.png', 'scene.png'] },
    duration: 8,
    aspectRatio: '16:9',
  } as any)

  const graph = request.body.prompt
  assert.equal(graph['5'].class_type, 'MiniMaxH3ReferenceToVideo')
  assert.equal(graph['5'].inputs.r2v_groups, undefined)
  assert.equal(graph['5'].inputs.i2v_groups, undefined)
  assert.equal(graph['5'].inputs.i2v_groups, undefined)
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_0'], ['r1', 0])
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_1'], ['r2', 0])
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_2'], ['r3', 0])
  assert.deepEqual(graph['11'].inputs.latent_image, ['5', 1])
})

test('ComfyUI adapter removes a duplicated persisted tail before assigning R2V picture indexes', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
  }, {
    id: 8,
    model: 'MiniMax-H3-local',
    prompt: 'Continue from picture 1',
    referenceMode: 'multiple',
    firstFrameUrl: null,
    referenceImageUrls: JSON.stringify(['tail.png', 'scene.png', 'role.png']),
    comfyImageNames: { referenceImages: ['tail.png', 'scene.png', 'role.png'] },
    duration: 8,
    aspectRatio: '16:9',
  } as any)
  const graph = request.body.prompt
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_0'], ['r1', 0])
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_1'], ['r2', 0])
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_2'], ['r3', 0])
  assert.deepEqual(graph.r1.inputs, { image: 'tail.png' })
  assert.deepEqual(graph.r2.inputs, { image: 'scene.png' })
  assert.deepEqual(graph.r3.inputs, { image: 'role.png' })
})

test('ComfyUI adapter removes duplicate semantic images before assigning Picture indexes', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
  }, {
    id: 81,
    model: 'MiniMax-H3-local',
    prompt: 'Continue from picture 1',
    referenceMode: 'multiple',
    firstFrameUrl: null,
    referenceImageUrls: JSON.stringify(['tail.png', 'scene.png', 'scene.png', 'role.png']),
    comfyImageNames: { referenceImages: ['tail.png', 'scene.png', 'scene.png', 'role.png'] },
    duration: 8,
    aspectRatio: '16:9',
  } as any)
  const graph = request.body.prompt
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_0'], ['r1', 0])
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_1'], ['r2', 0])
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_2'], ['r3', 0])
  assert.deepEqual(graph.r1.inputs, { image: 'tail.png' })
  assert.deepEqual(graph.r2.inputs, { image: 'scene.png' })
  assert.deepEqual(graph.r3.inputs, { image: 'role.png' })
})

test('ComfyUI adapter refuses more than nine final R2V images instead of dropping the scene slot', () => {
  const adapter = new ComfyUiVideoAdapter()
  assert.throws(() => adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
  }, {
    id: 82, model: 'MiniMax-H3-local', prompt: 'too many refs', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: Array.from({ length: 10 }, (_, i) => `ref-${i}.png`) }, duration: 8,
  } as any), /最多允许 9 张参考图/)
})

test('ComfyUI adapter allows explicitly selecting the CPU text encoder in R2V', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
    settings: { comfyui: { clipDevice: 'cpu', lowVram: true } },
  }, {
    id: 6, model: 'MiniMax-H3-local', prompt: 'gpu encoder', referenceMode: 'multiple', comfyImageNames: { referenceImages: ['ref.png'] }, duration: 0.2, aspectRatio: '16:9',
  } as any)
  assert.equal(request.body.prompt['2'].inputs.device, 'cpu')
  assert.equal(request.body.prompt['8'].inputs.low_vram, true)
})

test('ComfyUI adapter preserves an 11 second storyboard as one official R2V graph', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
  }, {
    id: 22, model: 'MiniMax-H3-local', prompt: 'long reference shot', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['actor.png', 'room.png'] }, duration: 11, aspectRatio: '9:16', megapixels: 1,
  } as any)
  const graph = request.body.prompt
  assert.equal(graph['5'].class_type, 'MiniMaxH3ReferenceToVideo')
  assert.equal(graph['5'].inputs.length, 5 + Math.ceil((11 * 24 - 5) / 17) * 17)
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_0'], ['r1', 0])
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_1'], ['r2', 0])
  assert.equal(graph['11'].inputs.latent_image[0], '5')
})

test('ComfyUI adapter preserves a 15 second storyboard as one official R2V graph', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
  }, {
    id: 24, model: 'MiniMax-H3-local', prompt: '15 second reference shot', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['actor.png', 'room.png'] }, duration: 15, aspectRatio: '9:16', megapixels: 0.5,
  } as any)
  const graph = request.body.prompt
  assert.equal(graph['5'].class_type, 'MiniMaxH3ReferenceToVideo')
  assert.equal(graph['5'].inputs.length, 5 + Math.ceil((15 * 24 - 5) / 17) * 17)
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_0'], ['r1', 0])
  assert.deepEqual(graph['11'].inputs.latent_image[0], '5')
})

test('ComfyUI adapter also preserves an eight second MiniMax storyboard as one R2V graph', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
  }, {
    id: 23, model: 'MiniMax-H3-local', prompt: 'short reference shot', referenceMode: 'multiple',
    comfyImageNames: { referenceImages: ['actor.png'] }, duration: 8, aspectRatio: '9:16', megapixels: 1,
  } as any)
  const graph = request.body.prompt
  assert.equal(graph['5'].class_type, 'MiniMaxH3ReferenceToVideo')
  assert.equal(graph['5'].inputs.length, 5 + Math.ceil((8 * 24 - 5) / 17) * 17)
  assert.deepEqual(graph['5'].inputs['ref_images.ref_image_0'], ['r1', 0])
  assert.equal(graph['11'].class_type, 'SamplerCustomAdvanced')
})

test('ComfyUI adapter refuses to silently downgrade an empty multi-reference request to t2v', () => {
  const adapter = new ComfyUiVideoAdapter()
  assert.throws(() => adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
  }, {
    id: 5, model: 'MiniMax-H3-local', prompt: 'must use references', referenceMode: 'multiple', referenceImageUrls: JSON.stringify([]),
    duration: 0.2, aspectRatio: '16:9',
  } as any), /多图参考模式/)
})

test('ComfyUI adapter rejects legacy single/first-frame jobs', () => {
  const adapter = new ComfyUiVideoAdapter()
  assert.throws(() => adapter.buildGenerateRequest({ provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt' }, {
    id: 3, model: 'MiniMax-H3-local', prompt: 'Continue from the previous tail', referenceMode: 'single',
    firstFrameUrl: 'tail.png', comfyImageNames: { firstFrame: 'tail.png', referenceImages: [] }, duration: 0.2, aspectRatio: '16:9',
  } as any), /只支持多参考 R2V/)
})

test('ComfyUI adapter rejects legacy frame fields even when the mode says multiple', () => {
  const adapter = new ComfyUiVideoAdapter()
  const base = {
    id: 91,
    model: 'MiniMax-H3-local',
    prompt: 'Use the ordered references',
    referenceMode: 'multiple',
    referenceImageUrls: JSON.stringify(['scene.png']),
    comfyImageNames: { referenceImages: ['scene.png'] },
    duration: 5,
    aspectRatio: '16:9',
  }
  const config = { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt' }
  assert.throws(() => adapter.buildGenerateRequest(config, { ...base, firstFrameUrl: 'legacy-first.png' } as any), /禁止 image_url\/first_frame_url\/last_frame_url/)
  assert.throws(() => adapter.buildGenerateRequest(config, { ...base, lastFrameUrl: 'legacy-last.png' } as any), /禁止 image_url\/first_frame_url\/last_frame_url/)
  assert.throws(() => adapter.buildGenerateRequest(config, { ...base, imageUrl: 'legacy-image.png' } as any), /禁止 image_url\/first_frame_url\/last_frame_url/)
})

test('ComfyUI adapter rejects an unknown isolated continuity mode', () => {
  const adapter = new ComfyUiVideoAdapter()
  assert.throws(() => adapter.buildGenerateRequest({ provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt' }, {
    id: 92,
    model: 'MiniMax-H3-local',
    prompt: 'Use the ordered references',
    referenceMode: 'multiple',
    referenceImageUrls: JSON.stringify(['scene.png']),
    comfyImageNames: { referenceImages: ['scene.png'] },
    continuityMode: 'first_last',
    duration: 5,
    aspectRatio: '16:9',
  } as any), /仅支持标准 R2V 或 Motion Context Plus/)
})

test('ComfyUI adapter maps the selected megapixel budget to aligned dimensions', () => {
  const adapter = new ComfyUiVideoAdapter()
  const request = adapter.buildGenerateRequest({ provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt' }, {
    id: 4, model: 'MiniMax-H3-local', prompt: 'low memory', referenceMode: 'multiple', comfyImageNames: { referenceImages: ['ref.png'] }, duration: 0.2, aspectRatio: '16:9', megapixels: 0.2,
  } as any)
  const inputs = request.body.prompt['5'].inputs
  assert.equal(inputs.width % 16, 0)
  assert.equal(inputs.height % 16, 0)
  assert.ok(inputs.width * inputs.height < 400_000)
})

test('ComfyUI adapter uses the ResolutionSelector megapixel formula for every aspect ratio', () => {
  const adapter = new ComfyUiVideoAdapter()
  const make = (aspectRatio: string, megapixels: number) => adapter.buildGenerateRequest({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'MiniMax-H3-local', endpoint: '/prompt',
  }, {
    id: 5, model: 'MiniMax-H3-local', prompt: 'resolution check', referenceMode: 'multiple', comfyImageNames: { referenceImages: ['ref.png'] }, duration: 0.2, aspectRatio, megapixels,
  } as any).body.prompt['5'].inputs
  assert.deepEqual({ width: make('16:9', 0.5).width, height: make('16:9', 0.5).height }, { width: 960, height: 544 })
  assert.deepEqual({ width: make('9:16', 0.5).width, height: make('9:16', 0.5).height }, { width: 544, height: 960 })
  assert.deepEqual({ width: make('1:1', 0.3).width, height: make('1:1', 0.3).height }, { width: 576, height: 576 })
})
