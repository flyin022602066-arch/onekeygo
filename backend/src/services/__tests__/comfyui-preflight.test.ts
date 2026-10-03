import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_COMFYUI_MODELS,
  ensureComfyUiGenerationReady,
  resetComfyUiPreflightCache,
} from '../comfyui-preflight.js'

const config = {
  provider: 'comfyui',
  baseUrl: 'http://127.0.0.1:8188',
  apiKey: '',
  model: 'MiniMax-H3-local',
  settings: {},
}

const requiredNodes = [
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'LoadImage',
  'MiniMaxH3Director',
  'MiniMaxH3DirectorGroupReferenceToVideo',
  'MiniMaxH3DirectorGroupImageToVideo',
  'MiniMaxH3TurboLoRA',
  'CreateVideo',
  'SaveVideo',
]
const requiredR2vNodes = [
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'LoadImage',
  'MiniMaxH3ReferenceToVideo',
  'MiniMaxH3TurboLoRA',
  'RandomNoise',
  'KSamplerSelect',
  'BasicGuider',
  'BasicScheduler',
  'SamplerCustomAdvanced',
  'VAEDecode',
  'VAEDecodeAudio',
  'CreateVideo',
  'SaveVideo',
]
const requiredR2vPlusNodes = [
  ...requiredR2vNodes,
  'MiniMaxH3MotionContext',
  'MiniMaxH3MotionContextTrim',
  'MiniMaxH3MotionContextSaveLatent',
  'MiniMaxH3MotionContextLoadLatent',
]

function nodeInfo(name: string, missingModel?: string) {
  const choices: Record<string, string[]> = {
    UNETLoader: [DEFAULT_COMFYUI_MODELS.unet, DEFAULT_COMFYUI_MODELS.ref2vaUnet],
    CLIPLoader: [DEFAULT_COMFYUI_MODELS.clip],
    VAELoader: [DEFAULT_COMFYUI_MODELS.videoVae, DEFAULT_COMFYUI_MODELS.audioVae],
    MiniMaxH3TurboLoRA: [DEFAULT_COMFYUI_MODELS.lora],
  }
  if (missingModel && choices[name]) choices[name] = choices[name].filter(value => value !== missingModel)
  const fields: Record<string, string> = {
    UNETLoader: 'unet_name',
    CLIPLoader: 'clip_name',
    VAELoader: 'vae_name',
    MiniMaxH3TurboLoRA: 'lora_name',
  }
  return {
    [name]: {
      input: fields[name]
        ? { required: { [fields[name]]: [choices[name] || []] } }
        : { required: {} },
    },
  }
}

function healthyFetch(options: { missingNode?: string, missingModel?: string, counts?: Map<string, number> } = {}) {
  return async (input: string | URL | Request) => {
    const url = String(input)
    options.counts?.set(url, (options.counts.get(url) || 0) + 1)
    if (url.endsWith('/system_stats')) return Response.json({ system: {} })
    const name = decodeURIComponent(url.split('/object_info/')[1] || '')
    if (name === 'PathchSageAttentionKJ') {
      return Response.json(options.missingNode === name ? {} : {
        PathchSageAttentionKJ: {
          input: {
            required: { model: ['MODEL'], sage_attention: [['auto', 'disabled']] },
            optional: { allow_compile: ['BOOLEAN'] },
          },
        },
      })
    }
    if (!requiredNodes.includes(name) && !requiredR2vNodes.includes(name) && !requiredR2vPlusNodes.includes(name)) return new Response('not found', { status: 404 })
    return Response.json(options.missingNode === name ? {} : nodeInfo(name, options.missingModel))
  }
}

test.beforeEach(() => resetComfyUiPreflightCache())

test('ComfyUI preflight defaults to the official R2V graph', async () => {
  await assert.doesNotReject(() => ensureComfyUiGenerationReady(config, {
    fetchImpl: healthyFetch() as typeof fetch,
    repair: null,
  }))
})

test('ComfyUI preflight requires ref2va for R2V mode', async () => {
  await assert.doesNotReject(() => ensureComfyUiGenerationReady(config, {
    fetchImpl: healthyFetch() as typeof fetch,
    repair: null,
    mode: 'r2v',
  }))
  await assert.rejects(
    () => ensureComfyUiGenerationReady(config, {
      fetchImpl: healthyFetch({ missingModel: DEFAULT_COMFYUI_MODELS.ref2vaUnet }) as typeof fetch,
      repair: null,
      mode: 'r2v',
      skipCache: true,
    }),
    new RegExp(DEFAULT_COMFYUI_MODELS.ref2vaUnet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  )
})

test('R2V model requirements canonicalize a persisted basename for UNETLoader', async () => {
  const { resolveComfyUiModelRequirements } = await import('../comfyui-preflight.js')
  const requirements = resolveComfyUiModelRequirements({
    settings: { comfyui: { ref2vaUnet: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors' } },
  }, 'r2v')
  assert.equal(requirements.unet, DEFAULT_COMFYUI_MODELS.ref2vaUnet)
})

test('selected MiniMax H3 main model overrides the mode default', async () => {
  const { resolveComfyUiModelRequirements } = await import('../comfyui-preflight.js')
  const requirements = resolveComfyUiModelRequirements({ settings: {} }, 'r2v', 'minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors')
  assert.equal(requirements.unet, 'minimax-h3\\minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors')
})

test('local H3 settings select the configured UNET and Turbo LoRA', async () => {
  const { resolveComfyUiModelRequirements } = await import('../comfyui-preflight.js')
  const requirements = resolveComfyUiModelRequirements({ settings: { comfyui: {
    ref2vaUnet: 'minimax-h3\\minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors',
    lora: 'minimaxh3\\minimax_h3_turbo_4STEPS_comfyui.safetensors',
  } } }, 'r2v')
  assert.equal(requirements.unet, 'minimax-h3\\minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors')
  assert.equal(requirements.lora, 'minimaxh3\\minimax_h3_turbo_4STEPS_comfyui.safetensors')
})

test('unknown legacy preflight mode is normalized to standard R2V', async () => {
  const { resolveComfyUiModelRequirements, ensureComfyUiGenerationReady } = await import('../comfyui-preflight.js')
  const requirements = resolveComfyUiModelRequirements({ settings: {} }, 'i2v' as any)
  assert.equal(requirements.unet, DEFAULT_COMFYUI_MODELS.ref2vaUnet)
  const counts = new Map<string, number>()
  await assert.doesNotReject(() => ensureComfyUiGenerationReady(config, {
    fetchImpl: healthyFetch({ counts }) as typeof fetch,
    repair: null,
    mode: 'i2v' as any,
    skipCache: true,
  }))
  assert.equal(counts.get('http://127.0.0.1:8188/object_info/MiniMaxH3Director'), undefined)
  assert.equal(counts.get('http://127.0.0.1:8188/object_info/MiniMaxH3ReferenceToVideo'), 1)
})

test('ComfyUI preflight repairs a startup race and rechecks the Worker', async () => {
  let systemChecks = 0
  let repairs = 0
  const fetchImpl = async (input: string | URL | Request) => {
    if (String(input).endsWith('/system_stats') && ++systemChecks === 1) {
      throw new TypeError('fetch failed')
    }
    return healthyFetch()(input)
  }
  await ensureComfyUiGenerationReady(config, {
    fetchImpl: fetchImpl as typeof fetch,
    repair: async () => { repairs += 1 },
  })
  assert.equal(repairs, 1)
  assert.equal(systemChecks, 2)
})

test('ComfyUI preflight reports a missing required R2V node without restarting a healthy Worker', async () => {
  let repairs = 0
  await assert.rejects(
    () => ensureComfyUiGenerationReady(config, {
      fetchImpl: healthyFetch({ missingNode: 'MiniMaxH3ReferenceToVideo' }) as typeof fetch,
      repair: async () => { repairs += 1 },
    }),
    /缺少必要节点 MiniMaxH3ReferenceToVideo/,
  )
  assert.equal(repairs, 0)
})

test('ComfyUI preflight identifies the exact missing MiniMax H3 model', async () => {
  await assert.rejects(
    () => ensureComfyUiGenerationReady(config, {
      fetchImpl: healthyFetch({ missingModel: DEFAULT_COMFYUI_MODELS.lora }) as typeof fetch,
      repair: null,
    }),
    new RegExp(DEFAULT_COMFYUI_MODELS.lora.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  )
})

test('ComfyUI preflight surfaces automatic repair failures', async () => {
  await assert.rejects(
    () => ensureComfyUiGenerationReady(config, {
      fetchImpl: (async () => { throw new TypeError('fetch failed') }) as typeof fetch,
      repair: async () => { throw new Error('worker exited') },
    }),
    /本地 MiniMax H3 自动修复失败：worker exited/,
  )
})

test('successful preflight cache skips repeated node/model inspection', async () => {
  const counts = new Map<string, number>()
  const fetchImpl = healthyFetch({ counts }) as typeof fetch
  await ensureComfyUiGenerationReady(config, { fetchImpl, repair: null })
  await ensureComfyUiGenerationReady(config, { fetchImpl, repair: null })
  assert.equal(counts.get('http://127.0.0.1:8188/system_stats'), 2)
  for (const name of requiredR2vNodes) {
    assert.equal(counts.get(`http://127.0.0.1:8188/object_info/${name}`), 1)
  }
  assert.equal(counts.get('http://127.0.0.1:8188/object_info/MiniMaxH3Director'), undefined)
})

test('R2V preflight checks the official ReferenceToVideo sampler graph', async () => {
  const counts = new Map<string, number>()
  const fetchImpl = healthyFetch({ counts }) as typeof fetch
  await ensureComfyUiGenerationReady(config, { fetchImpl, repair: null, mode: 'r2v' })
  for (const name of requiredR2vNodes) {
    assert.equal(counts.get(`http://127.0.0.1:8188/object_info/${name}`), 1)
  }
})

test('ComfyUI preflight confirms the required Sage Attention node', async () => {
  const result = await ensureComfyUiGenerationReady(config, {
    fetchImpl: healthyFetch() as typeof fetch,
    repair: null,
    skipCache: true,
  })
  assert.equal(result.sageAttentionNode, 'PathchSageAttentionKJ')
})

test('ComfyUI preflight blocks local H3 when the required Sage node is absent', async () => {
  await assert.rejects(() => ensureComfyUiGenerationReady(config, {
    fetchImpl: healthyFetch({ missingNode: 'PathchSageAttentionKJ' }) as typeof fetch,
    repair: null,
    skipCache: true,
  }), /PathchSageAttentionKJ/)
})

test('R2V Plus preflight requires Motion Context nodes', async () => {
  const counts = new Map<string, number>()
  const fetchImpl = healthyFetch({ counts }) as typeof fetch
  await ensureComfyUiGenerationReady(config, { fetchImpl, repair: null, mode: 'r2v_plus' })
  for (const name of requiredR2vPlusNodes) {
    assert.equal(counts.get(`http://127.0.0.1:8188/object_info/${name}`), 1)
  }
})

test('R2V Plus preflight reports a missing Motion Context node', async () => {
  await assert.rejects(
    () => ensureComfyUiGenerationReady(config, {
      fetchImpl: healthyFetch({ missingNode: 'MiniMaxH3MotionContext' }) as typeof fetch,
      repair: null,
      mode: 'r2v_plus',
      skipCache: true,
    }),
    /MiniMaxH3MotionContext/,
  )
})

test('forceRepair invokes the desktop repair hook even when health check responds', async () => {
  let repairs = 0
  await ensureComfyUiGenerationReady(config, {
    fetchImpl: healthyFetch() as typeof fetch,
    repair: async options => {
      repairs += 1
      assert.equal(options.forceRestart, true)
    },
    forceRepair: true,
  })
  assert.equal(repairs, 1)
})
