/**
 * FFmpeg 多镜头拼接 — 将所有合成后的镜头视频拼接为一集
 */
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { v4 as uuid } from 'uuid'
import { appConfig } from '../config.js'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import {
  getStoryboardVideoSource,
  groupVideoGenerationsByStoryboard,
  type VideoGenerationCandidate,
} from './storyboard-video-source.js'

const STORAGE_ROOT = appConfig.storage.localPath
const DATA_ROOT = path.dirname(STORAGE_ROOT)
const execFile = promisify(execFileCallback)

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

function concatFileLine(filePath: string): string {
  return `file '${filePath.replace(/'/g, "'\\''")}'`
}

export function metadataHasAudio(metadata: { streams?: Array<{ codec_type?: string }> } | null | undefined): boolean {
  return !!metadata?.streams?.some(stream => stream.codec_type === 'audio')
}

export type SerialMergeStepCandidate = {
  runId?: number | null
  storyboardId?: number | null
  stepIndex?: number | null
  videoGenerationId?: number | null
}

export type SerialMergeRunCandidate = {
  id?: number | null
  totalCount?: number | null
}

export type SerialMergePlan = {
  runId: number
  trimLastFrameIndexes: number[]
}

export function resolveSerialMergePlan(
  storyboards: Array<{ id?: number | null; videoUrl?: string | null; composedVideoUrl?: string | null }>,
  generations: VideoGenerationCandidate[] = [],
  steps: SerialMergeStepCandidate[] = [],
  runs: SerialMergeRunCandidate[] = [],
): SerialMergePlan | null {
  if (storyboards.length === 0) return null
  const grouped = groupVideoGenerationsByStoryboard(generations)
  const matches = storyboards.map((storyboard, index) => {
    const source = getStoryboardVideoSource(storyboard, grouped.get(Number(storyboard.id || 0)) || [])
    const generationId = Number(source?.generation?.id || 0)
    if (!generationId) return null
    const matchingSteps = steps.filter(step => (
      Number(step.storyboardId || 0) === Number(storyboard.id || 0)
      && Number(step.videoGenerationId || 0) === generationId
    ))
    if (matchingSteps.length !== 1) return null
    const step = matchingSteps[0]
    return {
      index,
      runId: Number(step.runId || 0),
      stepIndex: Number(step.stepIndex ?? -1),
    }
  })

  if (matches.some(match => !match)) return null
  const resolved = matches as Array<{ index: number; runId: number; stepIndex: number }>
  const runIds = new Set(resolved.map(match => match.runId).filter(Boolean))
  if (runIds.size !== 1) return null
  const [runId] = [...runIds]
  const run = runs.find(item => Number(item.id || 0) === runId)
  if (run && Number(run.totalCount || 0) !== storyboards.length) return null
  if (resolved.some((match, index) => match.stepIndex !== index)) return null

  return {
    runId,
    trimLastFrameIndexes: storyboards.slice(0, -1).map((_, index) => index),
  }
}

export function buildMergeOutputOptions(): string[] {
  return [
    '-fflags', '+genpts',
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-movflags', '+faststart',
  ]
}

export function buildHighQualityMergeOutputOptions(): string[] {
  return [
    '-fflags', '+genpts',
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '16',
    '-c:a', 'aac',
    '-ar', '48000',
    '-b:a', '192k',
    '-movflags', '+faststart',
  ]
}

export function buildSilentAudioTrackArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ]
}

function buildNormalizeAudioTrackArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ]
}

export function parseFrameRate(value: string | number | null | undefined): number {
  const raw = String(value ?? '').trim()
  if (!raw) return 0
  if (raw.includes('/')) {
    const [numerator, denominator] = raw.split('/').map(Number)
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return numerator / denominator
    }
    return 0
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function buildTrimLastFrameArgs(
  inputPath: string,
  outputPath: string,
  frameCount: number,
  frameRate: number,
): string[] {
  const keepFrameCount = Math.floor(frameCount) - 1
  if (keepFrameCount < 1) throw new Error('视频至少需要包含两帧才能裁剪末帧')
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error('无法确定视频帧率，无法按帧裁剪末帧')
  const trimDuration = keepFrameCount / frameRate
  return [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-vf', `select=lt(n\\,${keepFrameCount}),setpts=N/${frameRate}/TB`,
    '-af', `atrim=end=${trimDuration},asetpts=N/SR/TB`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '16',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ]
}

function probeVideo(filePath: string): Promise<{ streams?: Array<{ codec_type?: string }> }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err)
        return
      }
      resolve(metadata as { streams?: Array<{ codec_type?: string }> })
    })
  })
}

async function normalizeMergeInput(inputPath: string, tempDir: string): Promise<string> {
  const metadata = await probeVideo(inputPath)
  const outputPath = path.join(tempDir, `${uuid()}-audio.mp4`)
  const args = metadataHasAudio(metadata)
    ? buildNormalizeAudioTrackArgs(inputPath, outputPath)
    : buildSilentAudioTrackArgs(inputPath, outputPath)

  await execFile('ffmpeg', args)
  return outputPath
}

async function normalizeMergeInputs(videoPaths: string[], tempDir: string): Promise<string[]> {
  const normalized: string[] = []
  try {
    for (const videoPath of videoPaths) {
      normalized.push(await normalizeMergeInput(videoPath, tempDir))
    }
    return normalized
  } catch (error) {
    for (const tempPath of normalized) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
      } catch {}
    }
    throw error
  }
}

type PreparedMergeInputs = {
  paths: string[]
  temporaryPaths: string[]
}

async function probeFrameInfo(filePath: string): Promise<{ frameCount: number; frameRate: number }> {
  const { stdout } = await execFile('ffprobe', [
    '-hide_banner',
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=nb_read_frames,nb_frames,avg_frame_rate,r_frame_rate',
    '-of', 'json',
    filePath,
  ])
  const metadata = JSON.parse(stdout) as {
    streams?: Array<{
      nb_read_frames?: string | number
      nb_frames?: string | number
      avg_frame_rate?: string | number
      r_frame_rate?: string | number
    }>
  }
  const stream = metadata.streams?.[0]
  const frameCount = Number(stream?.nb_read_frames || stream?.nb_frames || 0)
  const frameRate = parseFrameRate(stream?.avg_frame_rate) || parseFrameRate(stream?.r_frame_rate)
  if (!Number.isFinite(frameCount) || frameCount < 2) throw new Error('无法确定视频总帧数，无法裁剪串行视频末帧')
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error('无法确定视频帧率，无法裁剪串行视频末帧')
  return { frameCount, frameRate }
}

async function prepareMergeInputs(
  videoPaths: string[],
  tempDir: string,
  trimLastFrameIndexes: number[] = [],
): Promise<PreparedMergeInputs> {
  const normalizedPaths = await normalizeMergeInputs(videoPaths, tempDir)
  const trimIndexes = new Set(trimLastFrameIndexes)
  const paths: string[] = []
  const temporaryPaths = [...normalizedPaths]
  try {
    for (const [index, inputPath] of normalizedPaths.entries()) {
      if (!trimIndexes.has(index)) {
        paths.push(inputPath)
        continue
      }
      const frameInfo = await probeFrameInfo(inputPath)
      const outputPath = path.join(tempDir, `${uuid()}-trimmed.mp4`)
      temporaryPaths.push(outputPath)
      await execFile('ffmpeg', buildTrimLastFrameArgs(inputPath, outputPath, frameInfo.frameCount, frameInfo.frameRate))
      paths.push(outputPath)
    }
    return { paths, temporaryPaths }
  } catch (error) {
    for (const tempPath of temporaryPaths) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
      } catch {}
    }
    throw error
  }
}

function runMerge(listPath: string, outputPath: string, outputOptions: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

/** Empty legacy placeholders do not belong to the merge set. */
export function selectMergeCandidates(
  storyboards: Array<{ id?: number | null; videoUrl?: string | null; composedVideoUrl?: string | null }>,
  generations: VideoGenerationCandidate[] = [],
) {
  const grouped = groupVideoGenerationsByStoryboard(generations)
  return storyboards.filter((storyboard) => (
    !!String(storyboard.composedVideoUrl || '').trim()
    || !!getStoryboardVideoSource(storyboard, grouped.get(Number(storyboard.id || 0)) || [])
  ))
}

/**
 * 拼接一集的所有合成镜头视频
 */
export async function mergeEpisodeVideos(episodeId: number, dramaId: number): Promise<number> {
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const videoGenerations = db.select().from(schema.videoGenerations).all()
  const mergeCandidates = selectMergeCandidates(storyboards, videoGenerations)
  const composedStoryboards = mergeCandidates.filter(sb => !!String(sb.composedVideoUrl || '').trim())
  if (composedStoryboards.length !== mergeCandidates.length) {
    throw new Error(`Only composed storyboards can be merged (${composedStoryboards.length}/${mergeCandidates.length} ready)`)
  }
  const videos = composedStoryboards
    .map(sb => sb.composedVideoUrl)
    .filter(Boolean) as string[]

  if (videos.length === 0) throw new Error('No videos to merge')

  const serialMergePlan = resolveSerialMergePlan(
    composedStoryboards,
    videoGenerations,
    db.select().from(schema.videoSequenceSteps).all(),
    db.select().from(schema.videoSequenceRuns).all(),
  )

  logTaskStart('MergeTask', 'episode-merge', { episodeId, dramaId, clips: videos.length })

  // 创建 merge 记录
  const ts = now()
  const res = db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: `Episode ${episodeId} Merge`,
    provider: 'ffmpeg',
    model: serialMergePlan ? 'ffmpeg-concat-h264-aac-serial-trim-last-frame' : 'ffmpeg-concat-h264-aac',
    status: 'processing',
    scenes: JSON.stringify(videos),
    createdAt: ts,
  }).run()
  const mergeId = Number(res.lastInsertRowid)

  // 异步执行
  doMerge(mergeId, episodeId, videos, serialMergePlan).catch(err => {
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId, error: err.message })
    console.error(`[Merge] Failed:`, err)
    db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg: err.message })
      .where(eq(schema.videoMerges.id, mergeId)).run()
  })

  return mergeId
}

async function doMerge(mergeId: number, episodeId: number, videos: string[], serialMergePlan?: SerialMergePlan | null) {
  // 生成 concat 列表文件
  const listDir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(listDir, { recursive: true })
  const listPath = path.join(listDir, `${uuid()}.txt`)

  const videoPaths = videos.map(toAbsPath)
  let preparedInputs: PreparedMergeInputs | null = null
  let outputPath = ''
  let outputFilename = ''

  try {
    preparedInputs = await prepareMergeInputs(videoPaths, listDir, serialMergePlan?.trimLastFrameIndexes)
    const listContent = preparedInputs.paths
      .map(concatFileLine)
      .join('\n')
    fs.writeFileSync(listPath, listContent, 'utf-8')

    // 输出文件
    const outputDir = path.join(STORAGE_ROOT, 'merged')
    fs.mkdirSync(outputDir, { recursive: true })
    outputFilename = `${uuid()}.mp4`
    outputPath = path.join(outputDir, outputFilename)

    try {
      await runMerge(listPath, outputPath, buildMergeOutputOptions())
    } catch (err: any) {
      logTaskProgress('MergeTask', 'stream-copy-fallback', { mergeId, episodeId, error: err.message })
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
      } catch {}
      await runMerge(listPath, outputPath, buildHighQualityMergeOutputOptions())
    }
  } finally {
    for (const tempPath of [listPath, ...(preparedInputs?.temporaryPaths || [])]) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
      } catch {}
    }
  }

  // 获取时长
  const duration = await getVideoDuration(outputPath)

  const mergedRelative = `static/merged/${outputFilename}`

  // 更新 merge 记录
  db.update(schema.videoMerges)
    .set({ status: 'completed', mergedUrl: mergedRelative, duration, completedAt: now() })
    .where(eq(schema.videoMerges.id, mergeId)).run()

  // 更新 episode
  db.update(schema.episodes)
    .set({ videoUrl: mergedRelative, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId)).run()

  logTaskSuccess('MergeTask', 'episode-merge', { mergeId, episodeId, output: mergedRelative, duration, clips: videos.length })
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(0); return }
      resolve(Math.round(metadata.format.duration || 0))
    })
  })
}
