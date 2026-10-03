/**
 * Pure helpers for the per-shot video reference summary.  Serial runs expose
 * semantic `asset_refs` bindings, while one-off generations only persist an
 * ordered URL list; this module handles both shapes and keeps the Vue page
 * free of provider-specific parsing details.
 */

export function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (value == null || value === '') return []
  try {
    const parsed = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function valueOf(item, snake, camel) {
  return item?.[snake] ?? item?.[camel]
}

export function hasPreviousVideoReference(record) {
  return Boolean(String(valueOf(record, 'reference_video_local_path', 'referenceVideoLocalPath') || '').trim())
}

function normalizeUrl(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+/, '')
    .split('?')[0]
    .toLowerCase()
}

function normalizeText(value) {
  return String(value || '').trim().replace(/[\s\u3000]+/g, '').toLowerCase()
}

function aliasesFor(entity) {
  const aliases = parseJsonArray(valueOf(entity, 'aliases', 'aliases'))
  return [entity?.name, entity?.location, entity?.english_name, entity?.englishName, ...aliases]
    .map(normalizeText)
    .filter(Boolean)
}

function entityImageUrls(entity) {
  return [
    valueOf(entity, 'image_url', 'imageUrl'),
    valueOf(entity, 'local_path', 'localPath'),
  ].map(normalizeUrl).filter(Boolean)
}

function emptyCounts() {
  return { characters: 0, scenes: 0, props: 0, total: 0, references: 0 }
}

/**
 * Return unique character/scene/prop counts for a storyboard card.
 *
 * `asset_refs` is authoritative for serial runs.  For direct video requests
 * we match persisted reference URLs to known assets and finally fall back to
 * the storyboard's explicit character/scene bindings and prop mentions.
 */
export function assetReferenceCounts({
  storyboard,
  step,
  generation,
  characters = [],
  scenes = [],
  props = [],
} = {}) {
  const counts = emptyCounts()
  const seen = { character: new Set(), scene: new Set(), prop: new Set() }
  const bindings = parseJsonArray(valueOf(step, 'asset_refs', 'assetRefs'))

  for (const binding of bindings) {
    const role = String(binding?.role || binding?.category || '').trim().toLowerCase()
    const kind = role === 'character' ? 'character' : role === 'scene' ? 'scene' : role === 'prop' ? 'prop' : ''
    if (!kind) continue
    const key = String(
      binding?.asset_id || binding?.assetId || binding?.entity_id || binding?.entityId
      || binding?.entity_name || binding?.entityName || binding?.name || `${kind}:${counts[kind + 's']}`,
    ).trim()
    if (seen[kind].has(key)) continue
    seen[kind].add(key)
    counts[`${kind}s`] += 1
  }

  // Keep the complete submitted reference count separate from the three
  // semantic asset buckets; continuity/reference-image entries are real
  // inputs but do not belong to character, scene, or prop totals.
  counts.references = new Set(bindings.map((binding) => {
    const url = binding?.url || binding?.asset_uri || binding?.assetUri
    return normalizeUrl(url) || String(binding?.asset_id || binding?.assetId || binding?.name || '')
  }).filter(Boolean)).size
  if (bindings.length && !counts.references) counts.references = bindings.length

  // A current serial snapshot contains semantic bindings. Do not supplement
  // it from stale storyboard fields; the bindings represent the exact list
  // submitted to the provider.
  if (bindings.some(item => ['character', 'scene', 'prop'].includes(String(item?.role || item?.category || '').toLowerCase()))) {
    counts.total = counts.characters + counts.scenes + counts.props
    return counts
  }

  const referenceUrls = parseJsonArray(valueOf(generation, 'reference_image_urls', 'referenceImageUrls'))
  counts.references = new Set(referenceUrls.map(normalizeUrl).filter(Boolean)).size
  const urlKinds = [
    ...characters.map(entity => ({ kind: 'character', entity })),
    ...scenes.map(entity => ({ kind: 'scene', entity })),
    ...props.map(entity => ({ kind: 'prop', entity })),
  ]
  for (const url of referenceUrls) {
    const normalized = normalizeUrl(url)
    if (!normalized) continue
    const match = urlKinds.find(({ entity }) => entityImageUrls(entity).includes(normalized))
    if (!match) continue
    const id = String(match.entity?.id || match.entity?.name || normalized)
    if (seen[match.kind].has(id)) continue
    seen[match.kind].add(id)
    counts[`${match.kind}s`] += 1
  }

  // If URL matching cannot identify public/uploaded copies, use the explicit
  // storyboard bindings as a deterministic semantic fallback.
  if (!counts.characters) {
    const ids = parseJsonArray(valueOf(storyboard, 'character_ids', 'characterIds'))
    const selected = ids.length ? characters.filter(entity => ids.map(Number).includes(Number(entity?.id))) : []
    counts.characters = selected.length
  }
  if (!counts.scenes) {
    const sceneId = valueOf(storyboard, 'scene_id', 'sceneId')
    if (sceneId && scenes.some(entity => Number(entity?.id) === Number(sceneId))) counts.scenes = 1
  }
  if (!counts.props) {
    const text = normalizeText([
      storyboard?.title,
      storyboard?.location,
      storyboard?.action,
      storyboard?.description,
      storyboard?.result,
      storyboard?.dialogue,
      storyboard?.image_prompt,
      storyboard?.imagePrompt,
      storyboard?.video_prompt,
      storyboard?.videoPrompt,
    ].filter(Boolean).join('\n'))
    counts.props = props.filter(entity => aliasesFor(entity).some(alias => text.includes(alias))).length
  }
  counts.total = counts.characters + counts.scenes + counts.props
  if (!counts.references) counts.references = counts.total
  return counts
}

export function generationElapsedMs(record, now = Date.now()) {
  if (!record) return 0
  const start = Date.parse(String(valueOf(record, 'created_at', 'createdAt') || ''))
  if (!Number.isFinite(start)) return 0
  const status = String(record.status || '').trim().toLowerCase()
  const endValue = valueOf(record, 'completed_at', 'completedAt')
    || (['completed', 'failed', 'cancelled'].includes(status) ? valueOf(record, 'updated_at', 'updatedAt') : null)
  const end = endValue ? Date.parse(String(endValue)) : now
  return Math.max(0, (Number.isFinite(end) ? end : now) - start)
}

export function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
