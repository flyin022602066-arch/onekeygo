export type StoryboardVideoCandidate = {
  id?: number | null
  videoUrl?: string | null
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
  deletedAt?: string | null
}

export type StoryboardVideoSource = {
  videoUrl: string
  source: 'generation-local' | 'generation-remote' | 'storyboard'
  generation?: VideoGenerationCandidate
}

export function isCompletedVideoGeneration(record: VideoGenerationCandidate | null | undefined) {
  if (!record) return false
  if (record.deletedAt) return false
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
  const latestAny = pickLatestVideoGeneration(generations, storyboard?.id)
  // 新一轮任务存在时，禁止回退到上一轮已完成视频。
  if (latestAny && String(latestAny.status || '').trim().toLowerCase() !== 'completed') return null

  const latest = pickLatestCompletedVideoGeneration(generations, storyboard?.id)
  if (latest) {
    const localPath = String(latest.localPath || '').trim()
    if (localPath) return { videoUrl: localPath, source: 'generation-local', generation: latest }

    const remoteUrl = String(latest.videoUrl || '').trim()
    if (remoteUrl) return { videoUrl: remoteUrl, source: 'generation-remote', generation: latest }

    // 最新记录已经结束但没有媒体地址时，也不能再回退到更旧的镜头文件。
    return null
  }

  const storyboardUrl = String(storyboard?.videoUrl || '').trim()
  if (storyboardUrl) return { videoUrl: storyboardUrl, source: 'storyboard' }

  return null
}

export function pickLatestVideoGeneration(
  generations: VideoGenerationCandidate[] = [],
  storyboardId?: number | null,
) {
  return generations
    .filter(item => !item.deletedAt && (!storyboardId || Number(item.storyboardId || 0) === Number(storyboardId)))
    .sort((a, b) => {
      return Number(b.id || 0) - Number(a.id || 0)
    })[0] || null
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
