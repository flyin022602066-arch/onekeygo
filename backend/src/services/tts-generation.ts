/**
 * TTS 语音合成服务
 * 支持 MiniMax TTS (hex 音频响应) 和 OpenAI 兼容 /audio/speech
 */
import fs from 'fs'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { v4 as uuid } from 'uuid'
import { appConfig } from '../config.js'
import { getAudioConfigById } from './ai.js'
import { getTTSAdapter } from './adapters/registry.js'
import { normalizeTTSVoiceForProvider } from './tts-voices.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, redactUrl } from '../utils/task-logger.js'

const STORAGE_ROOT = appConfig.storage.localPath

interface TTSParams {
  text: string
  voice: string
  model?: string
  speed?: number
  emotion?: string
  configId?: number | null
}

export type TTSSegmentParams = {
  text: string
  voice: string
}

/**
 * 生成 TTS 音频，返回本地文件路径
 */
export async function generateTTS(params: TTSParams): Promise<string> {
  const config = getAudioConfigById(params.configId)
  const adapter = getTTSAdapter(config.provider)
  const effectiveVoice = normalizeTTSVoiceForProvider(params.voice, config.provider)
  const effectiveModel = params.model || config.model
  const requestParams = { ...params, voice: effectiveVoice, model: effectiveModel }

  logTaskStart('AudioTask', 'tts-generate', {
    provider: config.provider,
    voice: effectiveVoice,
    requestedVoice: params.voice,
    model: effectiveModel,
    textPreview: params.text.slice(0, 50),
    textLength: params.text.length,
  })
  logTaskPayload('AudioTask', 'tts params', {
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params: requestParams,
  })

  const { url, method, headers, body } = adapter.buildGenerateRequest(config, requestParams)
  logTaskProgress('AudioTask', 'request', {
    provider: config.provider,
    voice: effectiveVoice,
    requestedVoice: params.voice,
    method,
    url: redactUrl(url),
    model: effectiveModel,
  })
  logTaskPayload('AudioTask', 'request payload', {
    method,
    url,
    headers,
    body,
  })

  const resp = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    logTaskError('AudioTask', 'tts-generate', { provider: config.provider, voice: effectiveVoice, requestedVoice: params.voice, status: resp.status, error: errText })
    throw new Error(`TTS API error ${resp.status}: ${errText}`)
  }

  const result = await resp.json()
  let parsed: ReturnType<typeof adapter.parseResponse>
  try {
    parsed = adapter.parseResponse(result)
  } catch (err) {
    logTaskPayload('AudioTask', 'response payload without audio', result)
    throw err
  }

  let buffer: Buffer
  if (parsed.audioHex) {
    buffer = Buffer.from(parsed.audioHex, 'hex')
  } else if (parsed.audioBase64) {
    buffer = Buffer.from(parsed.audioBase64, 'base64')
  } else if (parsed.audioUrl) {
    const audioResp = await fetch(parsed.audioUrl)
    if (!audioResp.ok) {
      throw new Error(`TTS audio download error ${audioResp.status}: ${await audioResp.text()}`)
    }
    buffer = Buffer.from(await audioResp.arrayBuffer())
  } else {
    throw new Error('No audio data in TTS response')
  }

  // 保存到本地
  const audioDir = path.join(STORAGE_ROOT, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })
  const filename = `${uuid()}.${parsed.format || 'mp3'}`
  const filePath = path.join(audioDir, filename)
  fs.writeFileSync(filePath, buffer)

  const relativePath = `static/audio/${filename}`
  logTaskSuccess('AudioTask', 'tts-saved', {
    provider: config.provider,
    voice: effectiveVoice,
    requestedVoice: params.voice,
    path: relativePath,
    bytes: buffer.length,
    audioMs: parsed.audioLength,
  })
  return relativePath
}

export async function generateTTSSequence(params: {
  segments: TTSSegmentParams[]
  configId?: number | null
  model?: string | null
}): Promise<string> {
  const segments = params.segments
    .map(segment => ({
      text: String(segment.text || '').trim(),
      voice: String(segment.voice || '').trim() || 'alloy',
    }))
    .filter(segment => segment.text)

  if (!segments.length) throw new Error('未提取到可合成的文本')
  if (segments.length === 1) {
    return generateTTS({ ...segments[0], configId: params.configId, model: params.model || undefined })
  }

  logTaskStart('AudioTask', 'tts-sequence-generate', {
    count: segments.length,
    voices: segments.map(segment => segment.voice),
  })

  const audioPaths: string[] = []
  for (const segment of segments) {
    const audioPath = await generateTTS({ ...segment, configId: params.configId, model: params.model || undefined })
    audioPaths.push(audioPath)
  }

  const audioDir = path.join(STORAGE_ROOT, 'audio')
  const tempDir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(audioDir, { recursive: true })
  fs.mkdirSync(tempDir, { recursive: true })

  const listPath = path.join(tempDir, `${uuid()}.txt`)
  const filename = `${uuid()}.mp3`
  const outputPath = path.join(audioDir, filename)
  const listContent = audioPaths
    .map(audioPath => `file '${escapeConcatPath(toAbsAudioPath(audioPath))}'`)
    .join('\n')
  fs.writeFileSync(listPath, listContent, 'utf-8')

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c:a', 'libmp3lame', '-ar', '32000', '-ac', '1', '-b:a', '128k'])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', err => reject(err))
      .run()
  })

  try { fs.unlinkSync(listPath) } catch {}

  const relativePath = `static/audio/${filename}`
  logTaskSuccess('AudioTask', 'tts-sequence-saved', {
    path: relativePath,
    count: segments.length,
    bytes: fs.statSync(outputPath).size,
  })
  return relativePath
}

/**
 * 为角色生成试听音频
 */
export async function generateVoiceSample(
  characterName: string,
  voiceId: string,
  configId?: number | null,
  model?: string | null,
): Promise<string> {
  const sampleText = `你好，我是${characterName}。很高兴认识你，这是我的声音试听。`
  return generateTTS({ text: sampleText, voice: voiceId, configId, model: model || undefined })
}

function toAbsAudioPath(relativePath: string) {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(path.dirname(STORAGE_ROOT), relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

function escapeConcatPath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")
}
