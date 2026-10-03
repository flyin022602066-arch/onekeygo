export type StoryboardVideoCandidate = {
  id?: number | null
  videoUrl?: string | null
  updatedAt?: string | null
  updated_at?: string | null
  deletedAt?: string | null
  deleted_at?: string | null
}

export type VideoGenerationCandidate = {
  id?: number | null
  storyboardId?: number | null
  status?: string | null
  videoUrl?: string | null
  localPath?: string | null
  completedAt?: string | null
  updatedAt?: string | null
  createdAt?: string | null
  created_at?: string | null
  deletedAt?: string | null
  deleted_at?: string | null
  provider?: string | null
  referenceMode?: string | null
  reference_mode?: string | null
  imageUrl?: string | null
  image_url?: string | null
  firstFrameUrl?: string | null
  first_frame_url?: string | null
  lastFrameUrl?: string | null
  last_frame_url?: string | null
  continuityMode?: string | null
  continuity_mode?: string | null
  prompt?: string | null
  finalPrompt?: string | null
  final_prompt?: string | null
}

export type StoryboardVideoSource = {
  videoUrl: string
  source: 'generation-local' | 'generation-remote' | 'storyboard'
  generation?: VideoGenerationCandidate
}

export function isCompletedVideoGeneration(record: VideoGenerationCandidate | null | undefined) {
  if (!record) return false
  if (record.deletedAt || record.deleted_at) return false
  const status = String(record.status || '').trim().toLowerCase()
  return status === 'completed' && !!String(record.localPath || record.videoUrl || '').trim()
}

export function pickLatestCompletedVideoGeneration(
  generations: VideoGenerationCandidate[] = [],
  storyboardId?: number | null,
) {
  return generations
    .filter(item => {
      if (!isCompletedVideoGeneration(item)) return false
      if (!storyboardId) return true
      return Number(item.storyboardId || 0) === Number(storyboardId)
    })
    .sort((a, b) => {
      // ID is the generation order. Completion time is deliberately not used:
      // an older request can finish after a newer request was submitted.
      return Number(b.id || 0) - Number(a.id || 0)
    })[0] || null
}

export function getStoryboardVideoSource(
  storyboard: StoryboardVideoCandidate | null | undefined,
  generations: VideoGenerationCandidate[] = [],
): StoryboardVideoSource | null {
  const currentGenerations = generations.filter(item => isGenerationCurrentForStoryboard(item, storyboard))
  const latestAny = pickLatestVideoGeneration(currentGenerations, storyboard?.id)
  // 新一轮任务存在时，禁止回退到上一轮已完成视频。
  if (latestAny && String(latestAny.status || '').trim().toLowerCase() !== 'completed') return null

  const latest = pickLatestCompletedVideoGeneration(currentGenerations, storyboard?.id)
  if (latest) {
    const localPath = String(latest.localPath || '').trim()
    if (localPath) return { videoUrl: localPath, source: 'generation-local', generation: latest }

    const remoteUrl = String(latest.videoUrl || '').trim()
    if (remoteUrl) return { videoUrl: remoteUrl, source: 'generation-remote', generation: latest }

    // 最新记录已经结束但没有媒体地址时，也不能再回退到更旧的镜头文件。
    return null
  }

  const storyboardUrl = String(storyboard?.videoUrl || '').trim()
  // A storyboard URL is a legacy/manual fallback. If generation history
  // exists but every row predates the current storyboard revision, the URL is
  // also stale and must not resurrect the previous decomposition's video.
  // Keep the fallback only for storyboards that have never had a generation
  // row (the supported manual-upload/legacy case).
  const hasLocalH3History = generations.some(item => String(item.provider || '').trim().toLowerCase() === 'comfyui')
  if (storyboardUrl && (generations.length === 0 || !hasLocalH3History)) return { videoUrl: storyboardUrl, source: 'storyboard' }

  return null
}

export function pickLatestVideoGeneration(
  generations: VideoGenerationCandidate[] = [],
  storyboardId?: number | null,
) {
  return generations
    .filter(item => !item.deletedAt && !item.deleted_at && (!storyboardId || Number(item.storyboardId || 0) === Number(storyboardId)))
    .sort((a, b) => {
      return Number(b.id || 0) - Number(a.id || 0)
    })[0] || null
}

/**
 * Generation rows are immutable snapshots of storyboard content. A row
 * created before the storyboard's latest edit/re-decomposition is historical
 * only and must never be selected for playback, compose, merge, or export.
 * Missing timestamps are retained for compatibility with pre-versioned rows.
 */
export function isGenerationCurrentForStoryboard(
  generation: VideoGenerationCandidate | null | undefined,
  storyboard: StoryboardVideoCandidate | null | undefined,
) {
  if (!generation || generation.deletedAt || generation.deleted_at) return false
  const provider = String(generation.provider || '').trim().toLowerCase()
  if (provider === 'comfyui') {
    const mode = String(generation.referenceMode || generation.reference_mode || '').trim().toLowerCase()
    const continuityMode = String(generation.continuityMode || generation.continuity_mode || '').trim().toLowerCase()
    // Local MiniMax H3 history is valid only for the two explicit serial R2V
    // pipelines. Missing metadata is an ambiguous legacy row and must never
    // be selected for playback/compose/merge.
    if (mode !== 'multiple' || !['standard_r2v', 'latent_plus'].includes(continuityMode)) return false
    if (String(generation.imageUrl || generation.image_url || '').trim()) return false
    if (String(generation.firstFrameUrl || generation.first_frame_url || '').trim()
      || String(generation.lastFrameUrl || generation.last_frame_url || '').trim()) return false
    const prompt = String(generation.finalPrompt || generation.final_prompt || generation.prompt || '')
    if (/(?:\bfirst(?:[-_ ]frame)\b|\blast(?:[-_ ]frame)\b|\btail(?:[-_ ]frame)\b|\bprevious\s+shot['’]?s?\s+tail\b|\bframe[-_ ]?0\b|首尾帧|首帧|第一帧|尾帧|第\s*0\s*帧)/i.test(prompt)) return false
  }
  const storyboardRevision = Date.parse(String(storyboard?.updatedAt || storyboard?.updated_at || ''))
  // `updated_at` is a lifecycle timestamp (polling/download/finalisation).
  // It can move forward after a re-decomposition and therefore cannot prove
  // that the immutable generation snapshot was created from the current
  // storyboard.  Revision gating must use creation time only.
  const generationRevision = Date.parse(String(generation.createdAt || generation.created_at || ''))
  // Only local H3 rows are revision-gated here. Remote providers historically
  // advance storyboard.updated_at during their async lifecycle; applying this
  // check to them would hide otherwise valid legacy outputs.
  return !(provider === 'comfyui' && Number.isFinite(storyboardRevision) && Number.isFinite(generationRevision)
    && generationRevision < storyboardRevision)
}

export function groupVideoGenerationsByStoryboard(generations: VideoGenerationCandidate[] = []) {
  const grouped = new Map<number, VideoGenerationCandidate[]>()
  for (const generation of generations) {
    const storyboardId = Number(generation.storyboardId || 0)
    if (!storyboardId) continue
    const items = grouped.get(storyboardId) || []
    items.push(generation)
    grouped.set(storyboardId, items)
  }
  return grouped
}

function rowTimestamp(record: VideoGenerationCandidate) {
  const values = [record.completedAt, record.updatedAt, record.createdAt]
    .map(value => Date.parse(String(value || '')))
    .filter(Number.isFinite)
  return values.length ? Math.max(...values) : 0
}
