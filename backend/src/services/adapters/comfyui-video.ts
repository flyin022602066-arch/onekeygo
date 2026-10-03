import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { resolveComfyUiModelRequirements } from '../comfyui-preflight.js'
import { applyLocalH3VideoContinuation } from '../local-h3-continuation.js'
import { localH3RefinementSettings } from '../local-h3-refinement.js'

/** Local MiniMax H3 adapter.
 *
 * The Studio local pipeline is R2V-only.  There is deliberately no fallback
 * to FL2VA, first-frame, last-frame, ordinary I2V, or text-to-video here.
 * Continuity uses the previous full video as the standard serial R2V video
 * reference. Motion Context is isolated to the explicit latent_plus mode;
 * the ordered image list remains reserved for the current shot's assets.
 */
export class ComfyUiVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const baseUrl = normalizeBaseUrl(config.baseUrl || 'http://127.0.0.1:8188')
    const inputs = record.comfyImageNames || {}
    // R2V accepts only the ordered reference image list. There is no
    // first-frame/last-frame compatibility path: stale records without their
    // tail in referenceImages are rejected instead of being upgraded to I2V.
    const refs = dedupeImageNames(inputs.referenceImages || [])
    const mode = String(record.referenceMode || '').trim().toLowerCase()
    if (mode !== 'multiple') {
      throw new Error('本地 MiniMax H3 只支持多参考 R2V；禁止首尾帧、普通 I2V、FL2VA 或文生视频路径')
    }
    // Keep the adapter fail-closed too. A stale/manual caller must not be able
    // to smuggle a retired image slot into the local request after the service
    // layer has normalized the record.
    if (String(record.imageUrl || '').trim()
      || String(record.firstFrameUrl || '').trim()
      || String(record.lastFrameUrl || '').trim()) {
      throw new Error('本地 MiniMax H3 R2V 请求禁止 image_url/first_frame_url/last_frame_url')
    }
    if (!refs.length) {
      throw new Error('多图参考模式（R2V）缺少参考图片，已拒绝降级为文生视频')
    }
    if (refs.length > 9) {
      throw new Error('最多允许 9 张参考图（Picture 1 为连续参考图）')
    }

    const size = dimensionsForAspect(record.aspectRatio, record.megapixels)
    const continuityMode = String(record.continuityMode || '').trim().toLowerCase()
    if (continuityMode && !['standard_r2v', 'latent_plus'].includes(continuityMode)) {
      throw new Error('本地 MiniMax H3 仅支持标准 R2V 或 Motion Context Plus')
    }
    const plus = continuityMode === 'latent_plus'
    const stepIndex = Number.isFinite(Number(record.sequenceStepIndex)) ? Number(record.sequenceStepIndex) : 0
    const previousVideo = !plus && stepIndex > 0 ? String(record.comfyVideoName || '').trim() : ''
    const contextLength = normalizeMotionContextLength(config.settings?.comfyui?.contextLength)
    const targetLength = frameCountForDuration(record.duration)
    // Motion Context pins a head run and Trim removes it from the delivered
    // clip.  The official H3 workflow therefore samples with the context
    // window included (target + context - 5 on the 17k+5 grid); otherwise
    // every Plus shot after the first is shorter than the storyboard target.
    const length = plus && stepIndex > 0
      ? frameCountForMotionContext(targetLength, contextLength)
      : targetLength
    const picturePrefix = refs.map((_, index) => `<Picture ${index + 1}>`).join(' ')
    const videoPrefix = previousVideo ? '<Video 1>' : ''
    const rawPrompt = String(record.prompt || '')
    const hasPictureTokens = /<Picture\s+\d+>/i.test(rawPrompt)
    const referencePrompt = rawPrompt
      ? `${[
          videoPrefix && !/<Video\s+\d+>/i.test(rawPrompt) ? videoPrefix : '',
          !hasPictureTokens ? picturePrefix : '',
          rawPrompt,
        ].filter(Boolean).join(' ')}`.trim()
      : `${[videoPrefix, picturePrefix].filter(Boolean).join(' ')}`.trim()
    const prompt = previousVideo && stepIndex > 0
      ? applyLocalH3VideoContinuation(referencePrompt)
      : referencePrompt
    const requiredModels = resolveComfyUiModelRequirements(config, plus ? 'r2v_plus' : 'r2v', record.model)
    return buildOfficialR2vRequest({
      baseUrl,
      config,
      record,
      refs,
      prompt,
      width: size.width,
      height: size.height,
      length,
      requiredModels,
      continuityMode,
      sequenceRunId: record.sequenceRunId,
      sequenceStepIndex: record.sequenceStepIndex,
      latentPath: record.latentPath,
      latentClipIndex: record.latentClipIndex,
      previousVideo,
    })
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = String(result?.prompt_id || result?.promptId || '').trim()
    if (!taskId) throw new Error(`ComfyUI 未返回 prompt_id：${JSON.stringify(result).slice(0, 500)}`)
    return { isAsync: true, taskId: `comfyui:${taskId}` }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const id = String(taskId || '').replace(/^comfyui:/, '')
    return {
      url: `${normalizeBaseUrl(config.baseUrl || 'http://127.0.0.1:8188')}/history/${encodeURIComponent(id)}`,
      method: 'GET',
      headers: {},
      body: undefined,
    }
  }

  parsePollResponse(result: any, config?: AIConfig): VideoPollResponse {
    const entries = result && typeof result === 'object' ? Object.values(result) as any[] : []
    if (!entries.length) return { status: 'processing' }
    const item = entries[0]
    const reports = Object.values(item?.outputs || {}).flatMap((output: any) => output?.text || [])
    const warning = reports.filter((report: any) => typeof report === 'string' && report.startsWith('base-only:')).join('; ')
    if (item?.status?.status_str === 'error'
      || (item?.status?.completed === false && item?.status?.messages?.some((message: any) => message?.[0] === 'execution_error'))) {
      const failure = item.status?.messages?.find((message: any) => message?.[0] === 'execution_error')?.[1]
      const baseFile = item?.outputs?.h3_base_save?.images?.[0] || item?.outputs?.h3_refine?.mijing_base_video?.[0]
      if ((String(failure?.node_id) === '15' && failure?.node_type === 'SaveVideo'
          || String(failure?.node_id) === 'h3_refine' && failure?.node_type === 'MijingH3SafeRefine')
        && !/interrupt|cancel/i.test(String(failure?.exception_type || '') + String(failure?.exception_message || ''))
        && baseFile?.filename && /^mijing-studio-.*-base_\d+_\.mp4$/.test(baseFile.filename)) {
        const fallback = this.extractVideoUrl({ saved: { outputs: { base: { videos: [baseFile] } } } }, config)
        if (fallback) return { status: 'completed', videoUrl: fallback, warning: '高清保存失败，已取回二采前保存的原视频。' }
      }
      return {
        status: 'failed',
        error: item.status?.messages?.map((message: any) => message?.[1]?.exception_message || message?.[1]?.message).filter(Boolean).join('; ')
          || 'ComfyUI execution failed',
      }
    }
    if (item?.status?.completed === false) return { status: 'processing' }
    const videoUrl = this.extractVideoUrl(result, config)
    if (videoUrl) return warning ? { status: 'completed', videoUrl, warning } : { status: 'completed', videoUrl }
    if (item?.status?.completed === true) return { status: 'failed', error: 'ComfyUI 已完成但没有视频输出' }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any, config?: AIConfig): string | null {
    const entries = result && typeof result === 'object' ? Object.values(result) as any[] : []
    const baseUrl = normalizeBaseUrl(config?.baseUrl || 'http://127.0.0.1:8188')
    const buildUrl = (file: any) => {
      const filename = String(file?.filename || '').trim()
      if (!filename) return null
      const params = new URLSearchParams({
        filename,
        subfolder: String(file.subfolder || ''),
        type: String(file.type || 'output'),
      })
      return `${baseUrl}/view?${params.toString()}`
    }
    const isVideoFilename = (filename: string) => /\.(?:mp4|webm|mov|mkv|avi|m4v)$/i.test(filename)
    for (const item of entries) {
      const outputs = item?.outputs || {}
      const ordered = [outputs['15'], ...Object.entries(outputs)
        .filter(([key]) => key !== '15' && key !== 'h3_base_save').map(([, output]) => output), outputs.h3_base_save]
      for (const output of ordered as any[]) {
        for (const key of ['videos', 'gifs', 'files']) {
          for (const file of (output as any)?.[key] || []) {
            const url = buildUrl(file)
            if (url) return url
          }
        }
        // Some ComfyUI versions serialize SaveVideo results under images.
        for (const file of (output as any)?.images || []) {
          const filename = String(file?.filename || '').trim()
          if (!isVideoFilename(filename)) continue
          const url = buildUrl(file)
          if (url) return url
        }
      }
    }
    return null
  }
}

function dedupeImageNames(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values || []) {
    const normalized = String(value || '').trim()
    const key = normalized.replace(/\\/g, '/').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function buildOfficialR2vRequest(options: {
  baseUrl: string
  config: AIConfig
  record: VideoGenerationRecord
  refs: string[]
  prompt: string
  width: number
  height: number
  length: number
  requiredModels: ReturnType<typeof resolveComfyUiModelRequirements>
  continuityMode?: string | null
  sequenceRunId?: number | null
  sequenceStepIndex?: number | null
  latentPath?: string | null
  latentClipIndex?: number | null
  previousVideo?: string | null
}): ProviderRequest {
  const { baseUrl, config, record, refs, prompt, width, height, length, requiredModels } = options
  const comfy = config.settings?.comfyui || {}
  const plus = String(options.continuityMode || '').trim().toLowerCase() === 'latent_plus'
  const stepIndex = Number.isFinite(Number(options.sequenceStepIndex)) ? Number(options.sequenceStepIndex) : 0
  const clipIndex = Number.isFinite(Number(options.latentClipIndex))
    ? Math.max(1, Math.round(Number(options.latentClipIndex)))
    : stepIndex + 1
  const latentDirectory = String(options.latentPath || `h3_context/mijing-studio-run-${Number(options.sequenceRunId) || record.id}`).trim()
  const workflow: Record<string, any> = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: requiredModels.unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: requiredModels.clip, type: 'minimax', device: comfy.clipDevice || 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: requiredModels.videoVae } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: requiredModels.audioVae } },
    '5': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
      clip: ['2', 0],
      vae: ['3', 0],
      audio_vae: ['4', 0],
      prompt,
      width,
      height,
      length,
      ref_image_size: comfy.refImageSize === 'max' ? 'max' : 'match',
    } },
    '6': { class_type: 'RandomNoise', inputs: { noise_seed: Number(record.id) || Math.floor(Math.random() * 2 ** 31) } },
    '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '8': { class_type: 'MiniMaxH3TurboLoRA', inputs: {
      model: ['1', 0],
      lora_name: requiredModels.lora,
      // A serial run captures the UI-selected value on each generation row.
      // Fall back to channel defaults for older/manual records only.
      strength: normalizeLoraStrength(record.loraStrength ?? comfy.loraStrength),
      low_vram: Boolean(comfy.lowVram ?? false),
    } },
    '9': { class_type: 'BasicGuider', inputs: { model: ['8', 0], conditioning: ['5', 0] } },
    '10': { class_type: 'BasicScheduler', inputs: {
      model: ['8', 0],
      scheduler: 'simple',
      steps: normalizeSteps(record.steps ?? comfy.steps),
      denoise: 1,
    } },
    '11': { class_type: 'SamplerCustomAdvanced', inputs: {
      noise: ['6', 0],
      guider: ['9', 0],
      sampler: ['7', 0],
      sigmas: ['10', 0],
      latent_image: ['5', 1],
    } },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
    '13': { class_type: 'VAEDecodeAudio', inputs: { samples: ['11', 0], vae: ['4', 0] } },
    '14': { class_type: 'CreateVideo', inputs: { images: ['12', 0], audio: ['13', 0], fps: 24, bit_depth: 'auto', color_space: 'sRGB' } },
    '15': { class_type: 'SaveVideo', inputs: { video: ['14', 0], filename_prefix: `video/mijing-studio-${record.id}`, format: 'mp4', codec: 'h264' } },
  }

  const sampledModel: [string, number] = ['8', 0]
  workflow['8_sage'] = { class_type: 'PathchSageAttentionKJ', inputs: {
    model: ['8', 0],
    sage_attention: 'auto',
    allow_compile: true,
  } }
  sampledModel[0] = '8_sage'
  workflow['9'].inputs.model = sampledModel
  workflow['10'].inputs.model = sampledModel

  if (options.previousVideo) {
    workflow['20'] = { class_type: 'LoadVideo', inputs: { file: options.previousVideo } }
    workflow['21'] = { class_type: 'GetVideoComponents', inputs: { video: ['20', 0] } }
    // Standard R2V receives a short tail context clip prepared by the service.
    // The reference node accepts IMAGE frames for ref_videos. Keep the prior
    // soundtrack disconnected: feeding it as <Audio 1> makes H3 replay old
    // dialogue instead of generating only this shot's speech plan.
    workflow['5'].inputs['ref_videos.ref_video_0'] = ['21', 0]
  }

  if (plus) {
    if (stepIndex > 0) {
      if (!String(options.latentPath || '').trim()) {
        throw new Error('本地 MiniMax H3 Plus 缺少上一镜 latent 路径，已阻止退化为普通 R2V')
      }
      workflow['16'] = { class_type: 'MiniMaxH3MotionContextLoadLatent', inputs: {
        latent_path: latentDirectory,
        clip_index: Math.max(1, clipIndex - 1),
      } }
      workflow['17'] = { class_type: 'MiniMaxH3MotionContext', inputs: {
        conditioning: ['5', 0],
        vae: ['3', 0],
        latent: ['5', 1],
        context_length: String(normalizeMotionContextLength(comfy.contextLength)),
        audio_context_length: normalizeMotionAudioContextLength(comfy.audioContextLength),
        context_latent: ['16', 0],
      } }
      workflow['9'].inputs.conditioning = ['17', 0]
      workflow['18'] = { class_type: 'MiniMaxH3MotionContextTrim', inputs: {
        images: ['12', 0],
        trim_frames: ['17', 1],
        audio: ['13', 0],
        fps: 24,
        match_tail: true,
      } }
      workflow['14'].inputs.images = ['18', 0]
      workflow['14'].inputs.audio = ['18', 1]
    }
    // Save the sampler's complete AV latent for the next shot. This is an
    // output node, so ComfyUI executes it even though the video branch does
    // not consume its string output.
    workflow['19'] = { class_type: 'MiniMaxH3MotionContextSaveLatent', inputs: {
      latent: ['11', 0],
      // SaveLatent treats filename_prefix as a path + basename, while
      // LoadLatent accepts the directory. Keep one isolated directory per
      // serial run so clip_index remains deterministic and retry-safe.
      filename_prefix: `${latentDirectory.replace(/[\\/]+$/, '')}/clip`,
      clip_index: clipIndex,
    } }
  }

  refs.forEach((name, index) => {
    const nodeId = `r${index + 1}`
    workflow[nodeId] = { class_type: 'LoadImage', inputs: { image: name } }
    // This is the only image-conditioning interface for the local R2V path.
    workflow['5'].inputs[`ref_images.ref_image_${index}`] = [nodeId, 0]
  })

  const refinement = localH3RefinementSettings(config)
  if (refinement.enabled && record.comfyH3RefinementAvailable === true) {
    workflow['h3_base_save'] = { class_type: 'MijingH3PreserveVideo', inputs: {
      video: ['14', 0], filename_prefix: `video/mijing-studio-${record.id}`,
    } }
    workflow['h3_refine'] = { class_type: 'MijingH3SafeRefine', inputs: {
      base_video: ['h3_base_save', 0],
      latent: ['11', 0],
      positive: workflow['9'].inputs.conditioning,
      model: sampledModel,
      vae: ['3', 0],
      clip: ['2', 0],
      audio_vae: ['4', 0],
      prompt,
      seed: workflow['6'].inputs.noise_seed,
      scale: refinement.scale,
      steps: refinement.steps,
      denoise: refinement.denoise,
      trim_frames: plus && stepIndex > 0 ? ['17', 1] : 0,
    } }
    refs.forEach((_, index) => { workflow.h3_refine.inputs[`reference_image_${index}`] = [`r${index + 1}`, 0] })
    if (options.previousVideo) {
      workflow.h3_refine.inputs.reference_video = workflow['5'].inputs['ref_videos.ref_video_0']
    }
    workflow['15'].inputs.video = ['h3_refine', 0]
  }

  return {
    url: `${baseUrl}${config.endpoint || '/prompt'}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { prompt: workflow, client_id: `mijing-studio-${record.id}` },
  }
}

function normalizeBaseUrl(value: string) { return String(value || '').replace(/\/+$/, '') }

function normalizeSteps(value?: number | null) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(1, Math.min(200, Math.round(number))) : 4
}

function normalizeLoraStrength(value?: number | null) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, Math.round(number * 100) / 100)) : 1
}

function frameCountForDuration(value?: number | null) {
  const seconds = Math.max(0.2, Math.min(120, Number(value || 5)))
  const raw = Math.max(5, Math.round(seconds * 24))
  return 5 + Math.ceil(Math.max(0, raw - 5) / 17) * 17
}

function normalizeMotionContextLength(value?: unknown) {
  const number = Number(value)
  return [5, 22, 39, 56].includes(number) ? number : 22
}

function normalizeMotionAudioContextLength(value?: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(240, Math.round(number))) : 24
}

function frameCountForMotionContext(targetLength: number, contextLength: number) {
  const target = Math.max(5, Math.round(Number(targetLength) || 5))
  const context = normalizeMotionContextLength(contextLength)
  return alignH3FrameCount(Math.max(5, target + context - 5))
}

function alignH3FrameCount(value: number) {
  let number = Math.max(5, Math.round(Number(value) || 5))
  while (number % 17 !== 5) number += 1
  return number
}

function normalizeMegapixels(value?: number | null) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0.2, Math.min(2, Math.round(number * 100) / 100)) : 1
}

function dimensionsForAspect(value?: string | null, megapixels?: number | null) {
  const ratio = String(value || '16:9')
  const mp = normalizeMegapixels(megapixels)
  const ratios: Record<string, [number, number]> = {
    '1:1': [1, 1], '2:3': [2, 3], '3:2': [3, 2], '3:4': [3, 4],
    '4:3': [4, 3], '9:16': [9, 16], '16:9': [16, 9], '21:9': [21, 9],
  }
  const [widthRatio, heightRatio] = ratios[ratio] || ratios['16:9']
  const scale = Math.sqrt((mp * 1024 * 1024) / (widthRatio * heightRatio))
  const align = (number: number) => Math.max(32, Math.round(number / 32) * 32)
  return { width: align(widthRatio * scale), height: align(heightRatio * scale) }
}
