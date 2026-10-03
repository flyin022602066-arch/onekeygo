import type { AIConfig } from './adapters/types.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188'
const PREFLIGHT_CACHE_MS = 5 * 60_000
// The R2V path follows Comfy-Org's official MiniMax H3 template.  It is a
// separate graph from the Director convenience wrapper: ReferenceToVideo
// returns the conditioning + AV latent, then the stock custom sampler and
// audio/video VAE decode nodes finish the job.
const REQUIRED_R2V_NODES = [
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
] as const

const REQUIRED_R2V_PLUS_NODES = [
  ...REQUIRED_R2V_NODES,
  'MiniMaxH3MotionContext',
  'MiniMaxH3MotionContextTrim',
  'MiniMaxH3MotionContextSaveLatent',
  'MiniMaxH3MotionContextLoadLatent',
] as const

export type ComfyUiSageAttentionNode = 'PathchSageAttentionKJ'

export const DEFAULT_COMFYUI_MODELS = {
  unet: 'minimax-h3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  // ComfyUI's UNETLoader choices contain the folder-qualified value. The
  // request must use that exact value even though preflight matching accepts
  // equivalent basenames.
  ref2vaUnet: 'minimax-h3\\minimax_h3_ref2va_pruned_int8_convrot.safetensors',
  clip: 'minimax-h3\\qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVae: 'minimax-h3\\minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax-h3\\minimax_h3_audio_vae_fp32.safetensors',
  lora: 'minimaxh3\\minimax_h3_turbo_v4_step600_ema.safetensors',
} as const

/**
 * Main MiniMax H3 checkpoints exposed by the Studio local-video selector.
 * The unpruned FL2VA checkpoint is intentionally excluded: it is the large
 * 34 GB variant and is not suitable for the supported desktop workflow.
 */
export const COMFYUI_MAIN_MODEL_OPTIONS = [
  'minimax-h3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  'minimax-h3\\minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors',
  'minimax-h3\\minimax_h3_ref2va_pruned_int8_convrot.safetensors',
] as const

export const COMFYUI_TURBO_LORA_OPTIONS = [
  'minimaxh3\\minimax_h3_turbo_v4_step600_ema.safetensors',
  'minimaxh3\\minimax_h3_turbo_4STEPS_comfyui.safetensors',
] as const

// The local MiniMax H3 integration is deliberately R2V-only.  Keep the
// legacy i2v type out of the public contract so a new caller cannot select the
// retired first/last-frame graph by accident.
export type ComfyUiGenerationMode = 'r2v' | 'r2v_plus'

type RepairHook = (options: {
  baseUrl: string
  forceRestart?: boolean
  reason?: string
}) => Promise<unknown>

type PreflightOptions = {
  fetchImpl?: typeof fetch
  repair?: RepairHook | null
  forceRepair?: boolean
  skipCache?: boolean
  mode?: ComfyUiGenerationMode
  /** Optional UNET checkpoint selected in the Studio video panel. */
  modelOverride?: string | null
}

type Inspection = {
  ready: boolean
  connectionFailed: boolean
  message?: string
  sageAttentionNode?: ComfyUiSageAttentionNode | null
}

const successfulChecks = new Map<string, { cachedAt: number; sageAttentionNode: ComfyUiSageAttentionNode }>()

export function resolveComfyUiModelRequirements(
  config: Pick<AIConfig, 'settings'>,
  mode: ComfyUiGenerationMode = 'r2v',
  modelOverride?: string | null,
) {
  // JavaScript callers may still pass a stale `i2v` value. Normalize all
  // unknown values to the supported standard R2V graph.
  const normalizedMode: ComfyUiGenerationMode = mode === 'r2v_plus' ? 'r2v_plus' : 'r2v'
  const settings = config.settings?.comfyui || {}
  const configuredRef2vaUnet = String(settings.ref2vaUnet || settings.r2vUnet || settings.unet || '').trim()
  const configuredLora = String(settings.lora || '').trim()
  const selectedMainModel = resolveSelectableMainModel(modelOverride) || resolveSelectableMainModel(configuredRef2vaUnet)
  return {
    unet: selectedMainModel || (normalizedMode === 'r2v' || normalizedMode === 'r2v_plus'
      ? DEFAULT_COMFYUI_MODELS.ref2vaUnet
      : DEFAULT_COMFYUI_MODELS.unet),
    clip: String(settings.clip || '').trim() || DEFAULT_COMFYUI_MODELS.clip,
    videoVae: String(settings.videoVae || '').trim() || DEFAULT_COMFYUI_MODELS.videoVae,
    audioVae: String(settings.audioVae || '').trim() || DEFAULT_COMFYUI_MODELS.audioVae,
    lora: configuredLora || DEFAULT_COMFYUI_MODELS.lora,
  }
}

export async function ensureComfyUiGenerationReady(config: AIConfig, options: PreflightOptions = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const repair = options.repair === undefined
    ? (globalThis as any).__mijingEnsureComfyUiWorker as RepairHook | undefined
    : options.repair || undefined
  const mode: ComfyUiGenerationMode = options.mode === 'r2v_plus' ? 'r2v_plus' : 'r2v'
  const first = await inspectComfyUi(config, fetchImpl, options.skipCache === true, mode, options.modelOverride)
  if (first.ready && (!options.forceRepair || !repair)) return first

  if (repair && (first.connectionFailed || options.forceRepair)) {
    try {
      await repair({
        baseUrl: normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL),
        forceRestart: options.forceRepair === true,
        reason: first.message,
      })
    } catch (error: any) {
      throw new Error(`本地 MiniMax H3 自动修复失败：${String(error?.message || error)}`)
    }
    const repaired = await inspectComfyUi(config, fetchImpl, true, mode, options.modelOverride)
    if (repaired.ready) return repaired
    throw new Error(repaired.message || '本地 MiniMax H3 自检失败：Worker 自动修复后仍不可用')
  }

  throw new Error(first.message || '本地 MiniMax H3 自检失败')
}

export function resetComfyUiPreflightCache() {
  successfulChecks.clear()
}

async function inspectComfyUi(
  config: AIConfig,
  fetchImpl: typeof fetch,
  skipCache: boolean,
  mode: ComfyUiGenerationMode = 'r2v',
  modelOverride?: string | null,
): Promise<Inspection> {
  const baseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL)
  try {
    const response = await fetchImpl(`${baseUrl}/system_stats`, {
      signal: AbortSignal.timeout(4_000),
    })
    if (!response.ok) {
      return {
        ready: false,
        connectionFailed: true,
        message: `本地 MiniMax H3 Worker 未就绪：${baseUrl}/system_stats 返回 HTTP ${response.status}`,
      }
    }
  } catch (error: any) {
    return {
      ready: false,
      connectionFailed: true,
      message: `本地 MiniMax H3 Worker 无法连接（${baseUrl}）：${String(error?.message || error)}。软件将尝试自动启动或修复 Worker。`,
    }
  }

  const requirements = resolveComfyUiModelRequirements(config, mode, modelOverride)
  const signature = JSON.stringify([baseUrl, mode, requirements])
  const cached = successfulChecks.get(signature)
  if (!skipCache && cached && Date.now() - cached.cachedAt < PREFLIGHT_CACHE_MS) {
    return { ready: true, connectionFailed: false, sageAttentionNode: cached.sageAttentionNode }
  }

  try {
    // R2V does not use the I2V/first-last group at all. Do not make a
    // disabled legacy node a prerequisite for the serial R2V pipeline.
    const requiredNodes = mode === 'r2v_plus' ? REQUIRED_R2V_PLUS_NODES : REQUIRED_R2V_NODES
    const nodeEntries = await Promise.all(requiredNodes.map(async nodeName => {
      const response = await fetchImpl(`${baseUrl}/object_info/${encodeURIComponent(nodeName)}`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`${nodeName} HTTP ${response.status}`)
      const body = await response.json() as Record<string, any>
      return [nodeName, body?.[nodeName]] as const
    }))
    const nodes = Object.fromEntries(nodeEntries) as Record<string, any>
    const missingNodes = requiredNodes.filter(nodeName => !nodes[nodeName])
    if (missingNodes.length) {
      return {
        ready: false,
        connectionFailed: false,
        message: `本地 MiniMax H3 自检失败：缺少必要节点 ${missingNodes.join('、')}（R2V）。请检查 MiniMax H3 R2V/Turbo 插件。`,
      }
    }

    const missingModels: string[] = []
    checkModel(nodes.UNETLoader, 'unet_name', requirements.unet, '主模型 UNET', missingModels)
    checkModel(nodes.CLIPLoader, 'clip_name', requirements.clip, '文本编码器 CLIP', missingModels)
    checkModel(nodes.VAELoader, 'vae_name', requirements.videoVae, '视频 VAE', missingModels)
    checkModel(nodes.VAELoader, 'vae_name', requirements.audioVae, '音频 VAE', missingModels)
    checkModel(nodes.MiniMaxH3TurboLoRA, 'lora_name', requirements.lora, '加速 LoRA', missingModels)
    if (missingModels.length) {
      return {
        ready: false,
        connectionFailed: false,
        message: `本地 MiniMax H3 自检失败：${missingModels.join('；')}。请确认模型位于 D:\\ComfyUI-aki-v1.4\\ComfyUI-aki-v1.4\\models 对应目录。`,
      }
    }

    const sageResponse = await fetchImpl(`${baseUrl}/object_info/PathchSageAttentionKJ`, {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null)
    const sageBody = sageResponse?.ok
      ? await sageResponse.json() as Record<string, any>
      : null
    const sageNode = sageBody?.PathchSageAttentionKJ
    const sageModes = sageNode?.input?.required?.sage_attention?.[0]
    const compileType = sageNode?.input?.optional?.allow_compile?.[0]
    if (!sageNode || !Array.isArray(sageModes) || !sageModes.includes('auto') || compileType !== 'BOOLEAN') {
      return {
        ready: false,
        connectionFailed: false,
        message: 'Required ComfyUI-KJNodes PathchSageAttentionKJ is missing or incompatible (requires auto mode and allow_compile). Install/enable ComfyUI-KJNodes and restart ComfyUI before local H3 generation.',
      }
    }
    const sageAttentionNode: ComfyUiSageAttentionNode = 'PathchSageAttentionKJ'
    successfulChecks.set(signature, { cachedAt: Date.now(), sageAttentionNode })
    return { ready: true, connectionFailed: false, sageAttentionNode }
  } catch (error: any) {
    return {
      ready: false,
      connectionFailed: true,
      message: `本地 MiniMax H3 节点自检失败：${String(error?.message || error)}`,
    }
  }
}

function checkModel(node: any, field: string, required: string, label: string, missing: string[]) {
  const choices = node?.input?.required?.[field]?.[0]
  const normalizedRequired = normalizeModelName(required)
  const requiredBasename = normalizedRequired.split('\\').pop() || normalizedRequired
  const found = Array.isArray(choices)
    && choices.some(choice => {
      const normalizedChoice = normalizeModelName(String(choice))
      return normalizedChoice === normalizedRequired || normalizedChoice.split('\\').pop() === requiredBasename
    })
  if (!found) missing.push(`${label} ${required}`)
}

function resolveSelectableMainModel(value?: string | null) {
  const normalized = normalizeModelName(String(value || '').trim())
  if (!normalized) return ''
  const match = COMFYUI_MAIN_MODEL_OPTIONS.find(option => {
    const normalizedOption = normalizeModelName(option)
    return normalized === normalizedOption || normalized.split('\\').pop() === normalizedOption.split('\\').pop()
  })
  return match || ''
}

function normalizeModelName(value: string) {
  return String(value || '').replace(/\//g, '\\').toLowerCase()
}

/**
 * ComfyUI returns folder-qualified model choices from `/object_info`, and
 * UNETLoader validates the submitted value against those choices. Older
 * Studio settings persisted only the basename, so translate the built-in
 * MiniMax checkpoints to the folder-qualified names before constructing a
 * prompt. Custom paths are preserved (with slash normalization only).
 */
function canonicalizeMiniMaxModelPath(value: string, basename: string) {
  const normalized = normalizeModelName(value)
  const normalizedBasename = basename.toLowerCase()
  if (normalized === normalizedBasename) return `minimax-h3\\${basename}`
  return String(value || '').trim().replace(/\//g, '\\')
}

function normalizeBaseUrl(value: string) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '')
}
