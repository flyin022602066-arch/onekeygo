const ACTIVE_GENERATION_STATUSES = new Set(['pending', 'processing', 'running', 'queued'])
// Local MiniMax H3 is R2V-only in both standard and Motion Context Plus
// modes.  Keep the legacy status in the parser for old remote rows, but it is
// normalized to `processing` before it reaches the UI so no local run shows a
// misleading tail-frame phase.
const ACTIVE_STEP_STATUSES = new Set(['preparing', 'submitting', 'processing'])

/**
 * Video rows are immutable snapshots of one storyboard revision.  A row from
 * before the latest decomposition must never be surfaced as the current
 * prompt/video, even when it has the largest generation id.  Local MiniMax H3
 * additionally rejects snapshots that still contain the retired frame-slot
 * wording; both supported local modes are multi-reference R2V only.
 */
export function isCurrentVideoGeneration(generation, storyboard, providerFallback = '', continuityModeFallback = '') {
  if (!generation || generation.deleted_at || generation.deletedAt) return false
  const provider = String(generation.provider || providerFallback || '').trim().toLowerCase()
  if (provider !== 'comfyui') return true
  const storyboardRevision = Date.parse(String(storyboard?.updated_at || storyboard?.updatedAt || ''))
  // Generation updated_at changes during polling/download.  Only creation
  // time identifies the storyboard revision captured by the request.
  const generationRevision = Date.parse(String(
    generation.created_at || generation.createdAt || '',
  ))
  if (Number.isFinite(storyboardRevision) && Number.isFinite(generationRevision)
    && generationRevision < storyboardRevision) return false
  const mode = String(generation.reference_mode || generation.referenceMode || '').trim().toLowerCase()
  // Local records must carry an explicit R2V mode. Missing metadata is an
  // ambiguous legacy snapshot and is never safe to show as the current clip.
  if (mode !== 'multiple') return false
  // Standard R2V and Motion Context Plus are separate local pipelines.  A
  // result produced by one pipeline must never be displayed/reused while the
  // other one is selected, otherwise a stale clip can look like the current
  // generation even though its continuity parameters are incompatible.
  const requestedContinuity = String(continuityModeFallback || '').trim().toLowerCase()
  if (requestedContinuity) {
    const generationContinuity = String(generation.continuity_mode || generation.continuityMode || '').trim().toLowerCase()
    if (!generationContinuity || generationContinuity !== requestedContinuity) return false
  }
  if (String(generation.image_url || generation.imageUrl || '').trim()
    || String(generation.first_frame_url || generation.firstFrameUrl || '').trim()
    || String(generation.last_frame_url || generation.lastFrameUrl || '').trim()) return false
  const prompt = String(generation.final_prompt || generation.finalPrompt || generation.prompt || '')
  return !/(?:\bfirst(?:[-_ ]frame)\b|\blast(?:[-_ ]frame)\b|\btail(?:[-_ ]frame)\b|\bprevious\s+shot['’]?s?\s+tail\b|\bframe[-_ ]?0\b|\u9996\u5c3e\u5e27|\u9996\u5e27|\u7b2c\u4e00\u5e27|\u5c3e\u5e27|\u7b2c\s*0\s*\u5e27)/i.test(prompt)
}

export function selectLatestVideoGeneration(generations, storyboard, providerFallback = '', continuityModeFallback = '') {
  const valid = (Array.isArray(generations) ? generations : [])
    .filter(item => isCurrentVideoGeneration(item, storyboard, providerFallback, continuityModeFallback))
    .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))
  if (!valid.length) return null
  return valid[0]
}

function generationId(step) {
  return Number(step?.video_generation_id || step?.videoGenerationId || 0)
}

function stepStatus(step) {
  return String(step?.status || '').toLowerCase()
}

export function sequenceGenerationIdsToRefresh(steps, generations, finalizedIds) {
  const localById = new Map((Array.isArray(generations) ? generations : [])
    .map(item => [Number(item?.id || 0), item]))
  const ids = []

  for (const step of Array.isArray(steps) ? steps : []) {
    const id = generationId(step)
    if (!id || ids.includes(id)) continue
    const local = localById.get(id)
    const localStatus = String(local?.status || '').toLowerCase()
    const status = stepStatus(step)
    const needsFinalizedRefresh = status === 'completed' && !finalizedIds.has(id)

    if (!local || ACTIVE_GENERATION_STATUSES.has(localStatus) || ACTIVE_STEP_STATUSES.has(status) || needsFinalizedRefresh) {
      ids.push(id)
    }
  }

  return ids
}

// Public snapshots are sanitized by the backend, but keep this helper
// defensive for cached/optimistic responses so a stale extracting_tail row or
// first/last-frame snapshot cannot reappear after a page refresh.
export function sanitizeSequenceSnapshot(sequence) {
  if (!sequence) return sequence
  const provider = String(sequence.provider || '').toLowerCase()
  if (provider && provider !== 'comfyui') return sequence
  const plus = String(sequence.continuity_mode || sequence.continuityMode || '').toLowerCase() === 'latent_plus'
  const parseArray = value => {
    if (!value) return []
    try {
      const parsed = Array.isArray(value) ? value : JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  const steps = Array.isArray(sequence.steps) ? sequence.steps.map(step => {
    const rawAssetRefs = step.asset_refs ?? step.assetRefs
    const parsedAssetRefs = parseArray(rawAssetRefs)
    const rawImages = step.reference_image_urls ?? step.referenceImageUrls
    const parsedImages = parseArray(rawImages)
    const rawPrompt = String(step.prompt || step.final_prompt || step.finalPrompt || '')
    const hasLegacyFrameRef = parsedAssetRefs.some(item => ['first_frame', 'last_frame'].includes(String(item?.role || '').trim().toLowerCase()))
    const hasLegacyFramePrompt = /(?:first(?:[-_ ]frame)|last(?:[-_ ]frame)|tail(?:[-_ ]frame)|previous\s+shot['’]?s?\s+tail|frame[-_ ]?0|首尾帧|首帧|尾帧|第一帧|第\s*0\s*帧|提取尾帧|extracting_tail|FL2VA|I2V)/i.test(rawPrompt)
    const legacySnapshot = hasLegacyFrameRef || hasLegacyFramePrompt
    const cleanRefs = legacySnapshot ? [] : parsedAssetRefs.filter(item => !['first_frame', 'last_frame'].includes(String(item?.role || '').trim().toLowerCase()))
    const cleanImages = legacySnapshot ? [] : parsedImages
    return {
      ...step,
      status: String(step.status || '').toLowerCase() === 'extracting_tail' ? 'processing' : (legacySnapshot ? 'pending' : step.status),
      first_frame_local_path: null,
      first_frame_url: null,
      first_frame_asset_id: null,
      first_frame_asset_uri: null,
      tail_frame_local_path: null,
      tail_frame_url: null,
      tail_frame_asset_id: null,
      tail_frame_asset_uri: null,
      firstFrameLocalPath: null,
      firstFrameUrl: null,
      firstFrameAssetId: null,
      firstFrameAssetUri: null,
      tailFrameLocalPath: null,
      tailFrameUrl: null,
      tailFrameAssetId: null,
      tailFrameAssetUri: null,
      continuity_reference_local_path: plus || legacySnapshot ? null : (step.continuity_reference_local_path || step.continuityReferenceLocalPath || null),
      continuity_reference_url: plus || legacySnapshot ? null : (step.continuity_reference_url || step.continuityReferenceUrl || null),
      continuity_reference_asset_id: plus || legacySnapshot ? null : (step.continuity_reference_asset_id || step.continuityReferenceAssetId || null),
      continuity_reference_asset_uri: plus || legacySnapshot ? null : (step.continuity_reference_asset_uri || step.continuityReferenceAssetUri || null),
      continuityReferenceLocalPath: plus || legacySnapshot ? null : (step.continuity_reference_local_path || step.continuityReferenceLocalPath || null),
      continuityReferenceUrl: plus || legacySnapshot ? null : (step.continuity_reference_url || step.continuityReferenceUrl || null),
      continuityReferenceAssetId: plus || legacySnapshot ? null : (step.continuity_reference_asset_id || step.continuityReferenceAssetId || null),
      continuityReferenceAssetUri: plus || legacySnapshot ? null : (step.continuity_reference_asset_uri || step.continuityReferenceAssetUri || null),
      prompt: legacySnapshot ? null : sanitizeLocalH3PromptText(step.prompt),
      final_prompt: legacySnapshot ? null : sanitizeLocalH3PromptText(step.final_prompt),
      finalPrompt: legacySnapshot ? null : sanitizeLocalH3PromptText(step.finalPrompt),
      asset_refs: rawAssetRefs == null ? rawAssetRefs : JSON.stringify(cleanRefs),
      assetRefs: rawAssetRefs == null ? rawAssetRefs : JSON.stringify(cleanRefs),
      reference_image_urls: rawImages == null ? rawImages : JSON.stringify(cleanImages),
      referenceImageUrls: rawImages == null ? rawImages : JSON.stringify(cleanImages),
      ...(legacySnapshot ? { video_generation_id: null, videoGenerationId: null } : {}),
    }
  }) : sequence.steps
  return { ...sequence, steps }
}

function sanitizeLocalH3PromptText(value) {
  if (value == null) return value
  return String(value)
    .replace(/R2V\s+OPENING\s+FRAME(?:\s+CONTRACT)?/gi, 'ordered R2V picture mapping')
    .replace(/\b(?:previous\s+shot['’]?s?\s+)?tail(?:[-_ ]+frame)\b/gi, 'continuity image')
    .replace(/\b(?:first|last|opening|tail)[-_ ]+frame(?:_url)?\b/gi, 'continuity image')
    .replace(/\b(?:previous\s+shot['’]?s?\s+)?tail\b/gi, 'continuity image')
    .replace(/\bframe[-_ ]?0\b/gi, 'opening composition')
    .replace(/首尾帧/g, '连续参考图')
    .replace(/首帧硬约束/g, '开场构图约束')
    .replace(/首帧|第一帧/g, '开场构图')
    .replace(/尾帧/g, '连续参考图')
    .replace(/第\s*0\s*帧/g, '开场构图')
    .replace(/\b(?:FL2VA|I2V)\b/gi, 'legacy video path')
}

export function markFinalizedSequenceGeneration(step, finalizedIds) {
  const id = generationId(step)
  if (id && stepStatus(step) === 'completed') finalizedIds.add(id)
}

export function videoGenerationPlaybackPath(generation) {
  const videoUrl = generation?.video_url || generation?.videoUrl || null
  if (String(generation?.provider || '').trim().toLowerCase() !== 'comfyui') return videoUrl
  const localPath = String(generation?.local_path || generation?.localPath || '').trim()
  return localPath || videoUrl
}

export function versionedLocalVideoPath(localPath, generation) {
  const value = String(localPath || '').trim()
  if (!value || !/^\/?static\//.test(value)) return value
  const version = generation?.updated_at || generation?.updatedAt || generation?.id || ''
  return version ? `${value}?v=${encodeURIComponent(version)}` : value
}

export function sequenceVideoElementKey(storyboardId, videoPath, generation) {
  const version = generation?.updated_at || generation?.updatedAt || generation?.id || ''
  return [Number(storyboardId || 0), Number(generation?.id || 0), String(version), String(videoPath || '')].join('|')
}

export function sequenceVideoPosterPath(generation) {
  if (String(generation?.status || '').toLowerCase() !== 'completed') return ''
  // Local MiniMax H3 has no provider first-frame field.  Let the video element
  // render its own poster from the current generation rather than reviving a
  // stale frame URL from a legacy row.
  const firstFrame = String(generation?.first_frame_url || generation?.firstFrameUrl || '').trim()
  return String(generation?.provider || '').toLowerCase() === 'comfyui'
    ? ''
    : versionedLocalVideoPath(firstFrame, generation)
}
