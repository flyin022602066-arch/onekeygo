/**
 * Shared asset-name handling for bilingual screenplay breakdowns.
 *
 * Asset records keep one stable display name and a JSON encoded `aliases`
 * array.  Storyboard text may use either the display name or any alias (for
 * example `玉佩` / `jade pendant`).  Keeping this logic in one module avoids
 * provider- or project-specific translation tables in the generation path.
 */

export const DEFAULT_ASSET_ALIASES: Record<string, string[]> = {
  '苏小小': ['Su Xiaoxiao', 'Su Xiao Xiao', 'Xiaoxiao'],
  '苏大强': ['Su Daqiang', 'Su Da Qiang'],
  '顾承渊': ['Gu Chengyuan', 'Gu Cheng Yuan'],
  '林婉约': ['Lin Wanyue', 'Lin Wan Yue'],
  '胖顾客': ['胖子顾客', '胖客人', 'fat customer', 'fat customer man'],
  '食客们': ['顾客们', '客人们', '食客', 'diners'],
  '爆炒腰花': ['stir-fried pork kidney', 'stir fried pork kidney', 'pork kidney', 'kidney dish'],
  '啤酒瓶': ['beer bottle', 'beer bottles', 'bottle of beer'],
  '啤酒': ['beer', 'beer liquid', 'beer drink', 'brew'],
  '酒杯': ['beer glass', 'drinking glass', 'glass of beer'],
  '皮带': ['belt', 'leather belt', 'waist belt'],
}

export function normalizeAssetText(value: unknown) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/[\s\u3000]+/g, '')
    .toLocaleLowerCase()
}

/** Accept arrays, JSON arrays, or the common comma/semicolon separated form. */
export function parseAssetAliases(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => parseAssetAliases(item))
  }
  const raw = String(value ?? '').trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parseAssetAliases(parsed)
    } catch {
      // Fall through to delimiter parsing for legacy/non-JSON values.
    }
  }
  return raw
    .split(/[\n,，;；、|]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function defaultAliasesFor(name: unknown, defaults = DEFAULT_ASSET_ALIASES) {
  const normalized = normalizeAssetText(name)
  const direct = Object.entries(defaults).find(([canonical]) => normalizeAssetText(canonical) === normalized)
  if (direct) return direct[1]
  const reverse = Object.entries(defaults).find(([, aliases]) => aliases.some(alias => normalizeAssetText(alias) === normalized))
  return reverse ? [reverse[0], ...reverse[1]] : []
}

export type AssetAliasRecord = {
  name?: unknown
  aliases?: unknown
  alias?: unknown
  englishName?: unknown
  english_name?: unknown
}

/** Return normalized canonical name + aliases, with duplicates removed. */
export function assetBindingTerms(
  asset: AssetAliasRecord | unknown,
  defaults = DEFAULT_ASSET_ALIASES,
) {
  const row = asset && typeof asset === 'object' ? asset as AssetAliasRecord : { name: asset }
  const name = String(row.name || '').trim()
  const explicit = parseAssetAliases(row.aliases ?? row.alias)
  const englishName = row.englishName ?? row.english_name
  const values = [name, ...explicit, ...parseAssetAliases(englishName), ...defaultAliasesFor(name, defaults)]
  const terms = new Map<string, string>()
  for (const value of values) {
    const normalized = normalizeAssetText(value)
    if (normalized && !terms.has(normalized)) terms.set(normalized, String(value).trim())
  }
  return [...terms.keys()]
}

export function assetNamesMatch(left: AssetAliasRecord | unknown, right: AssetAliasRecord | unknown) {
  const rightTerms = new Set(assetBindingTerms(right))
  return assetBindingTerms(left).some(term => rightTerms.has(term))
}

/** Merge aliases from old and new rows, excluding the stable display name. */
export function mergeAssetAliases(name: unknown, ...values: unknown[]) {
  const canonical = normalizeAssetText(name)
  const result = new Map<string, string>()
  for (const value of values.flatMap(item => parseAssetAliases(item))) {
    const normalized = normalizeAssetText(value)
    if (normalized && normalized !== canonical && !result.has(normalized)) result.set(normalized, value.trim())
  }
  return [...result.values()]
}

export function serializeAssetAliases(name: unknown, ...values: unknown[]) {
  const aliases = mergeAssetAliases(name, ...values)
  return aliases.length ? JSON.stringify(aliases) : null
}

export function assetAliasesForPrompt(asset: AssetAliasRecord | unknown) {
  const terms = assetBindingTerms(asset)
  const canonical = normalizeAssetText(asset && typeof asset === 'object' ? (asset as AssetAliasRecord).name : asset)
  return terms.filter(term => term !== canonical)
}
