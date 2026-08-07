import type { EggfansServiceType } from './models.js'

export type EggfansRouteFamily =
  | 'openai-chat'
  | 'openai-image'
  | 'alibailian-video'
  | 'unified-video'
  | 'openai-video'
  | 'minimax-video'
  | 'vidu-video'
  | 'minimax-sync-tts'
  | 'openai-tts'
  | 'gemini-tts'

export interface EggfansRoute {
  family: EggfansRouteFamily
  reason: string
}

export function shouldUseOfficialVolcengineVideo(modelName: string) {
  const normalized = modelName.toLowerCase()
  return /^doubao-seedance[-_.]?2(?:[-_.]?0)?/.test(normalized)
}

export function resolveEggfansRoute(
  serviceType: EggfansServiceType,
  modelName: string,
  endpointTypes: string[],
): EggfansRoute {
  const endpointText = endpointTypes.join(',').toLowerCase()
  const normalizedEndpointTypes = endpointTypes.map(type => type.toLowerCase())

  if (serviceType === 'video' && shouldUseOfficialVolcengineVideo(modelName)) {
    throw new Error(`${modelName} must use the official VolcEngine Seedance 2.0 adapter, not Eggfans`)
  }

  if (serviceType === 'text' && normalizedEndpointTypes.includes('openai')) {
    return { family: 'openai-chat', reason: 'OpenAI-compatible chat endpoint' }
  }

  if (serviceType === 'image' && hasAny(endpointText, ['image-generation', 'images-generations', 'dall-e-3', 'openai'])) {
    return { family: 'openai-image', reason: 'Eggfans image endpoint accepts OpenAI image generation shape' }
  }

  if (serviceType === 'video' && hasAny(endpointText, ['happyhorse视频', 'wan视频生成'])) {
    return { family: 'alibailian-video', reason: 'AliBailian-compatible video synthesis endpoint' }
  }

  if (serviceType === 'video' && hasAny(endpointText, ['视频统一格式', 'grok视频'])) {
    return { family: 'unified-video', reason: 'Eggfans unified video endpoint' }
  }

  if (serviceType === 'video' && hasAny(endpointText, ['openai视频格式', 'openai video', 'openai-video'])) {
    return { family: 'openai-video', reason: 'Model advertises Eggfans OpenAI video format' }
  }

  if (serviceType === 'video' && endpointText.includes('海螺视频生成')) {
    return { family: 'minimax-video', reason: 'Eggfans MiniMax/Hailuo video generation endpoint' }
  }

  if (serviceType === 'video' && hasAny(endpointText, ['vidu文生视频', 'vidu图生视频', 'vidu首尾帧', 'vidu参考生视频'])) {
    return { family: 'vidu-video', reason: 'Eggfans Vidu-compatible video endpoints' }
  }

  if (serviceType === 'audio' && endpointText.includes('同步语音')) {
    return { family: 'minimax-sync-tts', reason: 'Synchronous MiniMax-compatible TTS response' }
  }

  if (serviceType === 'audio' && endpointText.includes('geminitts')) {
    return { family: 'gemini-tts', reason: 'Gemini TTS generateContent endpoint' }
  }

  if (serviceType === 'audio' && endpointText.includes('openai')) {
    return { family: 'openai-tts', reason: 'OpenAI audio speech endpoint' }
  }

  throw new Error(`No Eggfans route for ${serviceType} model ${modelName} with endpoints: ${endpointTypes.join(', ')}`)
}

function hasAny(value: string, needles: string[]) {
  return needles.some(needle => value.includes(needle.toLowerCase()))
}
