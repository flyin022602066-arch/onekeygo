/**
 * FFmpeg 单镜头合成 — 视频 + TTS音频 + 烧录字幕
 */
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { v4 as uuid } from 'uuid'
import { appConfig } from '../config.js'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { generateTTSSequence } from './tts-generation.js'
import { buildDialogueTTSSegments, parseDialogueForTTS } from './dialogue-tts.js'
import { ensureVideoLocalCopy } from './video-generation.js'
import { getStoryboardVideoSource } from './storyboard-video-source.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const STORAGE_ROOT = appConfig.storage.localPath
const DATA_ROOT = path.dirname(STORAGE_ROOT)
let subtitleFilterSupport: boolean | null = null

export type ComposeAudioMode = 'tts' | 'original' | 'silent'
export type ComposeSubtitleMode = 'auto' | 'none'

export type ComposeStoryboardOptions = {
  audioMode?: ComposeAudioMode
  subtitleMode?: ComposeSubtitleMode
}

export function normalizeComposeOptions(options: ComposeStoryboardOptions = {}): Required<ComposeStoryboardOptions> {
  const audioMode = ['tts', 'original', 'silent'].includes(String(options.audioMode || ''))
    ? options.audioMode!
    : 'tts'
  const subtitleMode = options.subtitleMode === 'none' || audioMode !== 'tts' ? 'none' : 'auto'
  return { audioMode, subtitleMode }
}

export function buildComposeOutputOptions(params: {
  audioMode: ComposeAudioMode
  hasTtsAudio: boolean
  reencodeVideo?: boolean
  mixOriginalAudio?: boolean
}) {
  const outputOptions = ['-map', '0:v:0']
  if (params.reencodeVideo) {
    outputOptions.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '16')
  } else {
    outputOptions.push('-c:v', 'copy')
  }

  if (params.audioMode === 'original') {
    outputOptions.push('-map', '0:a?', '-c:a', 'aac')
    return outputOptions
  }

  if (params.audioMode === 'tts' && params.hasTtsAudio) {
    if (params.mixOriginalAudio) {
      outputOptions.push(
        '-filter_complex', buildTTSBedMixFilter(),
        '-map', '[aout]',
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
      )
      return outputOptions
    }
    outputOptions.push('-map', '1:a:0', '-c:a', 'aac', '-shortest')
    return outputOptions
  }

  outputOptions.push('-an')
  return outputOptions
}

export function buildTTSBedMixFilter() {
  return [
    '[0:a:0]aresample=48000,volume=0.42[bed]',
    '[1:a:0]aresample=48000,volume=1.0,apad,asplit=2[voice_sc][voice_mix]',
    '[bed][voice_sc]sidechaincompress=threshold=0.015:ratio=8:attack=20:release=280[ducked]',
    '[ducked][voice_mix]amix=inputs=2:duration=first:dropout_transition=0[aout]',
  ].join(';')
}

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

function isRemoteUrl(value?: string | null) {
  return /^https?:\/\//i.test(String(value || ''))
}

async function resolveStoryboardVideoPath(storyboardId: number, videoUrl: string): Promise<string> {
  if (!isRemoteUrl(videoUrl)) return toAbsPath(videoUrl)

  const generations = db.select().from(schema.videoGenerations)
    .where(eq(schema.videoGenerations.storyboardId, storyboardId))
    .orderBy(schema.videoGenerations.id)
    .all()
  const generation = generations.reverse().find(item => item.videoUrl === videoUrl || item.status === 'completed')
  if (!generation) throw new Error(`Storyboard ${storyboardId} video is remote but has no completed generation record`)

  const localPath = await ensureVideoLocalCopy(generation.id)
  if (!localPath) throw new Error(`Storyboard ${storyboardId} remote video could not be downloaded locally`)
  return toAbsPath(localPath)
}

function supportsSubtitleFilter(): boolean {
  if (subtitleFilterSupport != null) return subtitleFilterSupport
  try {
    const output = execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
    subtitleFilterSupport = /\bsubtitles\b/.test(output)
  } catch {
    subtitleFilterSupport = false
  }
  return subtitleFilterSupport
}

function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        resolve(false)
        return
      }
      resolve(!!metadata.streams?.some(stream => stream.codec_type === 'audio'))
    })
  })
}

/**
 * 合成单个镜头：视频 + 可选TTS对白音频 + 可选烧录字幕
 */
export async function composeStoryboard(storyboardId: number, options: ComposeStoryboardOptions = {}): Promise<string> {
  let composeOptions = normalizeComposeOptions(options)
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)
  const generations = db.select().from(schema.videoGenerations)
    .where(eq(schema.videoGenerations.storyboardId, storyboardId))
    .orderBy(schema.videoGenerations.id)
    .all()
  const videoSource = getStoryboardVideoSource(sb, generations)
  if (!videoSource) throw new Error(`Storyboard ${storyboardId} has no video`)
  db.update(schema.storyboards)
    .set({ status: 'compose_processing', composedVideoUrl: null, videoUrl: videoSource.videoUrl, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()

  logTaskStart('ComposeTask', 'storyboard-compose', {
    storyboardId,
    storyboardNumber: sb.storyboardNumber,
    episodeId: sb.episodeId,
    audioMode: composeOptions.audioMode,
    subtitleMode: composeOptions.subtitleMode,
  })

  const videoPath = await resolveStoryboardVideoPath(storyboardId, videoSource.videoUrl)
  const videoHasAudio = await hasAudioStream(videoPath)
  let audioPath: string | null = null
  let subtitlePath: string | null = null
  const parsedDialogue = parseDialogueForTTS(sb.dialogue)
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  if (!ep?.dubbingEnabled && composeOptions.audioMode === 'tts') {
    composeOptions = { audioMode: 'original', subtitleMode: 'none' }
  }
  const chars = ep
    ? db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all()
    : []
  const ttsSegments = buildDialogueTTSSegments(sb.dialogue, chars)

  // 1. 生成 TTS 音频（如果有对白）
  try {
    if (composeOptions.audioMode === 'tts' && !parsedDialogue.ignorable) {
      if (sb.ttsAudioUrl) {
        const existingAudioPath = toAbsPath(sb.ttsAudioUrl)
        if (fs.existsSync(existingAudioPath)) {
          audioPath = existingAudioPath
        }
      }

      if (!audioPath) {
        if (ttsSegments.length) {
          logTaskProgress('ComposeTask', 'generate-inline-tts', {
            storyboardId,
            voices: ttsSegments.map(segment => `${segment.speaker || '旁白'}:${segment.voice}`),
            textPreview: parsedDialogue.pureText.slice(0, 40),
          })
          const ttsPath = await generateTTSSequence({ segments: ttsSegments, configId: ep?.audioConfigId ?? undefined })
          audioPath = toAbsPath(ttsPath)
          db.update(schema.storyboards).set({ ttsAudioUrl: ttsPath, updatedAt: now() })
            .where(eq(schema.storyboards.id, storyboardId)).run()
        }
      }
    }

    // 2. 生成字幕文件（SRT）
    if (composeOptions.subtitleMode === 'auto' && !parsedDialogue.ignorable) {
      const srtDir = path.join(STORAGE_ROOT, 'subtitles')
      fs.mkdirSync(srtDir, { recursive: true })
      const srtFilename = `${uuid()}.srt`
      subtitlePath = path.join(srtDir, srtFilename)

      const duration = sb.duration || 10
      const subtitleText = parsedDialogue.subtitleText || parsedDialogue.pureText
      const srtContent = `1\n00:00:00,500 --> 00:00:${String(Math.min(duration - 1, 59)).padStart(2, '0')},000\n${subtitleText}\n`
      fs.writeFileSync(subtitlePath, srtContent, 'utf-8')

      const srtRelative = `static/subtitles/${srtFilename}`
      db.update(schema.storyboards).set({ subtitleUrl: srtRelative, updatedAt: now() })
        .where(eq(schema.storyboards.id, storyboardId)).run()
    }

    // 3. FFmpeg 合成
    const outputDir = path.join(STORAGE_ROOT, 'composed')
    fs.mkdirSync(outputDir, { recursive: true })
    const outputFilename = `${uuid()}.mp4`
    const outputPath = path.join(outputDir, outputFilename)

    await new Promise<void>((resolve, reject) => {
      let cmd = ffmpeg(videoPath)

      if (audioPath) {
        cmd = cmd.input(audioPath)
      }

      const filters: string[] = []

      if (subtitlePath && supportsSubtitleFilter()) {
        const escapedPath = subtitlePath
          .replace(/\\/g, '/')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")
        const forceStyle = 'FontSize=20\\,PrimaryColour=&HFFFFFF&\\,OutlineColour=&H000000&\\,Outline=2'
        filters.push(`subtitles=filename='${escapedPath}':force_style='${forceStyle}'`)
      } else if (subtitlePath) {
        logTaskProgress('ComposeTask', 'subtitle-filter-unavailable', {
          storyboardId,
          subtitlePath,
        })
      }

      if (filters.length > 0) {
        cmd = cmd.videoFilter(filters)
      }

      const outputOptions = buildComposeOutputOptions({
        audioMode: composeOptions.audioMode,
        hasTtsAudio: !!audioPath,
        reencodeVideo: filters.length > 0,
        mixOriginalAudio: composeOptions.audioMode === 'tts' && !!audioPath && videoHasAudio,
      })

      cmd.outputOptions(outputOptions)
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })

    const composedRelative = `static/composed/${outputFilename}`
    db.update(schema.storyboards).set({ composedVideoUrl: composedRelative, status: 'compose_completed', updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId)).run()

    logTaskSuccess('ComposeTask', 'storyboard-compose', {
      storyboardId,
      storyboardNumber: sb.storyboardNumber,
      audioMode: composeOptions.audioMode,
      output: composedRelative,
    })
    return composedRelative
  } catch (err) {
    db.update(schema.storyboards)
      .set({ status: 'compose_failed', composedVideoUrl: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
    throw err
  }
}
