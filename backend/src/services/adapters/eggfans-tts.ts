import type { AIConfig, ProviderRequest, TTSProviderAdapter } from './types'
import { joinProviderUrl } from './url'
import {
  resolveEggfansRoute,
  type EggfansRouteFamily,
} from '../eggfans/routing.js'

interface TTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
}

export class EggfansTTSAdapter implements TTSProviderAdapter {
  provider = 'eggfans'

  buildGenerateRequest(config: AIConfig, params: TTSParams): ProviderRequest {
    const model = params.model || config.model || 'speech-2.8-hd'
    const routeFamily = getEggfansAudioRouteFamily(config, model)
    if (routeFamily === 'gemini-tts') return this.buildGeminiTTSRequest(config, params, model)
    if (routeFamily === 'openai-tts') return this.buildOpenAITTSRequest(config, params, model)
    return this.buildMiniMaxTTSRequest(config, params, model)
  }

  private buildMiniMaxTTSRequest(config: AIConfig, params: TTSParams, model: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '', config.endpoint || '/minimax/v1/t2a_v2'),
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'x-goog-api-key': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: {
        model,
        text: params.text,
        stream: false,
        voice_setting: {
          voice_id: params.voice,
          speed: params.speed ?? 1,
          vol: 1,
          pitch: 0,
          emotion: params.emotion || undefined,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
          channel: 1,
        },
        subtitle_enable: false,
      },
    }
  }

  private buildGeminiTTSRequest(config: AIConfig, params: TTSParams, model: string): ProviderRequest {
    const endpoint = String(config.endpoint || '/v1beta/models/{model}:generateContent').replace('{model}', encodeURIComponent(model))
    return {
      url: joinProviderUrl(config.baseUrl, '', endpoint),
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        contents: [
          {
            parts: [
              { text: params.text },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: params.voice,
              },
            },
          },
        },
      },
    }
  }

  private buildOpenAITTSRequest(config: AIConfig, params: TTSParams, model: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '', config.endpoint || '/v1/audio/speech'),
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        model,
        input: params.text,
        voice: params.voice,
        response_format: 'mp3',
        speed: params.speed ?? 1,
      },
    }
  }

  parseResponse(result: any) {
    const data = result.data || result.output || result
    const audioHex = data.audio || data.audio_hex
    const audioUrl = data.audio_url || data.url
    const inlineAudio = extractInlineAudio(result)
    if (!audioHex && !audioUrl && !inlineAudio?.data) {
      throw new Error(extractEggfansTTSError(result) || 'Eggfans TTS 未返回音频，请检查音色 ID、模型参数或账户额度')
    }

    return {
      audioHex,
      audioUrl,
      ...(inlineAudio?.data ? { audioBase64: inlineAudio.data } : {}),
      audioLength: data.extra_info?.audio_length || data.audio_length || 0,
      sampleRate: data.extra_info?.audio_sample_rate || data.sample_rate || (inlineAudio ? 24000 : 32000),
      bitrate: data.extra_info?.bitrate || data.bitrate || 128000,
      format: data.extra_info?.audio_format || data.format || inlineAudio?.format || 'mp3',
      channel: data.extra_info?.audio_channel || data.channel || 1,
    }
  }
}

function getEggfansAudioRouteFamily(config: AIConfig, model: string): EggfansRouteFamily {
  const routeFamily = config.settings?.eggfans?.routeFamily
  if (routeFamily) return routeFamily

  const endpointTypes = Array.isArray(config.settings?.eggfans?.endpointTypes)
    ? config.settings!.eggfans.endpointTypes
    : []
  if (endpointTypes.length) return resolveEggfansRoute('audio', model, endpointTypes).family
  if (/gemini/i.test(model) || /generateContent/i.test(String(config.endpoint || ''))) return 'gemini-tts'
  if (/audio\/speech/i.test(String(config.endpoint || ''))) return 'openai-tts'
  return 'minimax-sync-tts'
}

function extractInlineAudio(result: any): { data: string; format: string } | null {
  const candidates = [
    result?.candidates?.[0]?.content?.parts,
    result?.data?.candidates?.[0]?.content?.parts,
    result?.output?.candidates?.[0]?.content?.parts,
    result?.content?.parts,
    result?.parts,
  ].find(Array.isArray)
  if (!Array.isArray(candidates)) return null

  for (const part of candidates) {
    const inline = part?.inlineData || part?.inline_data
    const audio = inline?.data || inline?.audio || part?.audio
    if (!audio) continue
    const mimeType = String(inline?.mimeType || inline?.mime_type || part?.mimeType || 'audio/mpeg').toLowerCase()
    return {
      data: String(audio),
      format: audioFormatFromMimeType(mimeType),
    }
  }
  return null
}

function audioFormatFromMimeType(mimeType: string) {
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('aac')) return 'aac'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  return 'mp3'
}

function extractEggfansTTSError(result: any) {
  const candidates = [
    result?.base_resp?.status_msg,
    result?.data?.base_resp?.status_msg,
    result?.error?.message,
    result?.error_msg,
    result?.message,
    result?.msg,
    result?.data?.message,
    result?.data?.msg,
  ]
  const message = candidates.find(item => typeof item === 'string' && item.trim())
  if (message) return `Eggfans TTS 返回异常：${message.trim()}`

  const statusCode = result?.base_resp?.status_code ?? result?.data?.base_resp?.status_code ?? result?.code ?? result?.status_code
  if (statusCode && Number(statusCode) !== 0) return `Eggfans TTS 返回异常：status_code=${statusCode}`
  return ''
}
