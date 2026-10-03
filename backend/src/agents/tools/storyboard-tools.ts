/**
 * 分镜拆解 Agent 工具
 * 工厂函数模式 — 注入 episodeId + dramaId
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess, logTaskWarn } from '../../utils/task-logger.js'
import {
  haveStoryboardGenerationInputsChanged,
  invalidateStoryboardGenerations,
  cancelStaleVideoSequenceRuns,
  storyboardGenerationResetValues,
} from '../../services/storyboard-generation-invalidation.js'
import { buildVisualStyleLock, withVisualStyleLock } from '../../services/visual-style.js'
import { withTkOverseasVisualLock } from '../../services/overseas-visual.js'
import { assetBindingTerms } from '../../services/asset-aliases.js'

export function selectStoryboardScriptSource(episode: {
  breakdownMode?: unknown
  scriptContent?: unknown
  content?: unknown
}) {
  const original = String(episode.content || '').trim()
  const rewritten = String(episode.scriptContent || '').trim()
  // Storyboard facts must always come from the text pasted by the user. The
  // formatted/re-written field is a presentation aid only: it can contain
  // paraphrases or translations and must never silently change the plot,
  // dialogue, character relations, or event order during re-breakdown.
  // Keep the fallback for legacy episodes that only have script_content.
  return original || rewritten
}

type StoryboardCharacter = {
  id: number
  name?: string | null
  aliases?: unknown
  englishName?: unknown
  english_name?: unknown
  role?: unknown
  description?: unknown
  appearance?: unknown
  deletedAt?: string | null
}

function normalizeCharacterBindingName(value: unknown) {
  const normalized = String(value || '').trim().replace(/[\s\u3000]+/g, '').toLocaleLowerCase()
  const aliases: Record<string, string> = {
    'suxiaoxiao': '苏小小',
    'suxiao-xiao': '苏小小',
    'sudaqiang': '苏大强',
    'guchengyuan': '顾承渊',
    'linwanyue': '林婉约',
    'fatcustomer': '胖顾客',
    'fatcustomerman': '胖顾客',
    'diners': '食客们',
  }
  if (aliases[normalized]) return aliases[normalized]
  // The breaker occasionally says "胖子顾客" in dialogue while the
  // extracted asset is canonically named "胖顾客".  Treat this as a safe
  // alias for the existing asset; never create a second character identity.
  if (normalized === '胖子顾客' || normalized === '胖客人') return '胖顾客'
  if (normalized === '顾客们' || normalized === '客人们' || normalized === '食客') return '食客们'
  return normalized
}

export function extractStoryboardRoleNames(videoPrompt: unknown) {
  const names: string[] = []
  const pattern = /<role>\s*([^<]+?)\s*<\/role>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(videoPrompt || '')))) {
    const name = String(match[1] || '').trim().replace(/^[\s\u3000\u25b3\u25b2\u25c7\u25c6\u2022>*#-]+/, '').trim()
    if (name && !names.some(item => normalizeCharacterBindingName(item) === normalizeCharacterBindingName(name))) {
      names.push(name)
    }
  }
  return names
}

function extractCurrentShotReferenceText(videoPrompt: unknown) {
  const prompt = String(videoPrompt || '')
  const progressIndex = prompt.search(/CURRENT_SHOT_PROGRESS\s*:/i)
  return progressIndex >= 0 ? prompt.slice(progressIndex) : prompt
}

function normalizeStoryboardSpeakerName(value: unknown) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s*(?:OS|旁白|画外音|narration|narrator|voiceover)$/i, '')
    .trim()
}

function isNonCharacterStoryboardSpeaker(value: unknown) {
  return /^(?:旁白|画外音|narration|narrator|voiceover)$/i.test(normalizeStoryboardSpeakerName(value))
}

export function extractStoryboardVoiceNames(videoPrompt: unknown) {
  const names: string[] = []
  const pattern = /<voice>\s*([^<]+?)\s*<\/voice>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(videoPrompt || '')))) {
    const name = normalizeStoryboardSpeakerName(match[1])
    if (name && !isNonCharacterStoryboardSpeaker(name)
      && !names.some(item => normalizeCharacterBindingName(item) === normalizeCharacterBindingName(name))) {
      names.push(name)
    }
  }
  return names
}

export function extractStoryboardDialogueSpeakerNames(dialogue: unknown) {
  const names: string[] = []
  const pattern = /(?:^|[\r\n]|[。！？.!?]\s+)\s*([^:\r\n]{1,40}?)\s*[:\uFF1A]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(dialogue || '')))) {
    const name = normalizeStoryboardSpeakerName(match[1])
    if (name && !isNonCharacterStoryboardSpeaker(name)
      && !names.some(item => normalizeCharacterBindingName(item) === normalizeCharacterBindingName(name))) {
      names.push(name)
    }
  }
  return names
}

/**
 * Resolve the character assets from the exact role tags emitted in a shot.
 * Relationship phrases such as "X 的女儿" are plot facts, never aliases for
 * the character asset and must not influence this mapping.
 */
export function resolveStoryboardCharacterIds(
  requestedIds: unknown,
  videoPrompt: unknown,
  characters: StoryboardCharacter[],
  dialogue?: unknown,
) {
  const validById = new Map(
    characters
      .filter(item => !item.deletedAt && Number(item.id))
      .map(item => [Number(item.id), item]),
  )
  const requested = Array.isArray(requestedIds)
    ? [...new Set(requestedIds.map(Number).filter(id => validById.has(id)))]
    : []
  const currentShotText = extractCurrentShotReferenceText(videoPrompt)
  const roleNames = extractStoryboardRoleNames(currentShotText)
  const voiceNames = extractStoryboardVoiceNames(currentShotText)
  const dialogueNames = extractStoryboardDialogueSpeakerNames(dialogue)
  const explicitNames = [...roleNames, ...voiceNames]
  const bindingNames = [...explicitNames, ...dialogueNames]
  if (!bindingNames.length) return requested

  const idByName = new Map<string, number>()
  for (const character of validById.values()) {
    for (const term of assetBindingTerms(character)) {
      const normalized = normalizeCharacterBindingName(term)
      if (normalized && !idByName.has(normalized)) idByName.set(normalized, Number(character.id))
    }
  }
  const resolveCharacterId = (name: string) => {
    const normalized = normalizeCharacterBindingName(name)
    const exactId = idByName.get(normalized)
    if (exactId) return exactId

    const withoutLeadingOrdinal = name
      .replace(/^\s*[\u25b3\u25b2\u25c7\u25c6\u2022>*#-]+\s*/, '')
      .replace(/^\s*\d+\s*[、.．:：)）\]】-]?\s*/, '')
      .trim()
    const ordinalId = idByName.get(normalizeCharacterBindingName(withoutLeadingOrdinal))
    if (ordinalId) return ordinalId

    // Some model responses put a short action after the role name inside the
    // role tag, for example "△ 沈昭宁捡起". Resolve an unambiguous character
    // prefix, but never treat relationship phrases such as "苏大强的女儿"
    // as the character itself.
    const relationshipSuffix = /^(?:的|之|与|和|及|是|女儿|儿子|父亲|母亲|妹妹|哥哥|姐姐|弟弟|妻子|丈夫|朋友|下属|老板)/
    const prefixMatches = [...idByName.entries()]
      .filter(([term]) => normalizeCharacterBindingName(withoutLeadingOrdinal).startsWith(term))
      .filter(([term]) => !relationshipSuffix.test(normalizeCharacterBindingName(withoutLeadingOrdinal).slice(term.length)))
      .sort((left, right) => right[0].length - left[0].length)
    return prefixMatches.length === 1 ? prefixMatches[0]![1] : undefined
  }
  const unknownNames = explicitNames.filter(name => !resolveCharacterId(name))
  if (unknownNames.length) {
    throw new Error(`video_prompt 中的角色标签不属于当前角色资产：${unknownNames.join('、')}。请使用上下文中的精确角色名称。`)
  }
  const resolved = [...new Set(bindingNames
    .map(resolveCharacterId)
    .filter((id): id is number => Number.isFinite(id)))]
  return resolved.length ? resolved : requested
}

/** Resolve a bilingual prop/location reference to a single persisted asset id. */
export function resolveAssetIdByName<T extends { id: number; name?: unknown; aliases?: unknown; english_name?: unknown; englishName?: unknown }>(value: unknown, assets: T[]) {
  const input = String(value || '').trim()
  if (!input) return null
  const match = assets.filter(item => assetBindingTerms(item).some(term => {
    const left = normalizeSceneBindingText(input)
    const right = normalizeSceneBindingText(term)
    return left === right || left.includes(right) || right.includes(left)
  }))
  return match.length === 1 ? Number(match[0].id) : null
}

type ExistingStoryboardForPlan = {
  id: number
  storyboardNumber?: number | null
  deletedAt?: string | null
}

type IncomingStoryboardForPlan = {
  shot_number: number
}

export interface StoryboardDurationPolicy {
  mode?: string | null
  /** Output language for MiniMax storyboard decomposition. */
  language?: 'zh' | 'en' | string | null
  shotDuration?: number | null
  shotDurationMin?: number | null
  shotDurationMax?: number | null
  minTotalDuration?: number | null
  maxTotalDuration?: number | null
  minShots?: number | null
  maxShots?: number | null
}

type StoryboardWithDuration = {
  shot_number: number
  duration?: number | null
}

type MiniMaxContinuityStoryboard = {
  shot_number: number
  action?: unknown
  description?: unknown
  result?: unknown
  video_prompt?: unknown
}

type MiniMaxLocalCastStoryboard = MiniMaxContinuityStoryboard & {
  dialogue?: unknown
  image_prompt?: unknown
  character_ids?: unknown
}

function normalizePositiveInteger(value?: number | string | null) {
  const parsed = Math.round(Number(value || 0))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function validateStoryboardDurationPolicy(
  storyboards: StoryboardWithDuration[],
  policy: StoryboardDurationPolicy | null | undefined,
) {
  if (!policy) return

  if (isMiniMaxLocalEightSecondDurationPolicy(policy)) {
    const minShotDuration = 8
    const maxShotDuration = 10
    const invalidDurations = storyboards
      .filter(sb => {
        const duration = sb.duration == null ? minShotDuration : Number(sb.duration)
        return !Number.isInteger(duration) || duration < minShotDuration || duration > maxShotDuration
      })
      .map(sb => sb.shot_number)
    if (invalidDurations.length) {
      throw new Error(`本地 MiniMax H3 拆解每个镜头时长必须为 ${minShotDuration}-${maxShotDuration} 秒的整数（8、9 或 10），异常镜头：${invalidDurations.join(', ')}`)
    }
    return
  }

  if (isTkOverseasDurationPolicy(policy)) {
    const minShotDuration = normalizePositiveInteger(policy.shotDurationMin) || 4
    const maxShotDuration = normalizePositiveInteger(policy.shotDurationMax) || 15
    const minTotalDuration = normalizePositiveInteger(policy.minTotalDuration) || 60
    const maxTotalDuration = normalizePositiveInteger(policy.maxTotalDuration) || 100
    const minShots = normalizePositiveInteger(policy.minShots)
    const maxShots = normalizePositiveInteger(policy.maxShots)
    const invalidDurations = storyboards
      .filter(sb => {
        const duration = sb.duration == null ? minShotDuration : Number(sb.duration)
        return duration < minShotDuration || duration > maxShotDuration
      })
      .map(sb => sb.shot_number)
    if (minShots && storyboards.length < minShots) {
      throw new Error(`TK海外剧拆解至少需要 ${minShots} 个镜头，当前 ${storyboards.length} 个。请按每个场景和叙事节拍完整拆解后重新保存。`)
    }
    if (maxShots && storyboards.length > maxShots) {
      throw new Error(`TK海外剧拆解最多允许 ${maxShots} 个镜头，当前 ${storyboards.length} 个。请按真实叙事节拍合并镜头后重新保存。`)
    }
    if (invalidDurations.length) {
      throw new Error(`TK海外剧每个镜头时长必须为 ${minShotDuration}-${maxShotDuration} 秒，异常镜头：${invalidDurations.join(', ')}`)
    }
    const totalDuration = storyboards.reduce((sum, sb) => sum + Number(sb.duration || 0), 0)
    if (totalDuration < minTotalDuration || totalDuration > maxTotalDuration) {
      throw new Error(`TK海外剧拆解总时长必须为 ${minTotalDuration}-${maxTotalDuration} 秒，当前 ${totalDuration} 秒。请保持原剧本内容并调整镜头节拍。`)
    }
    return
  }

  if (!isGrokDurationPolicy(policy)) return

  const shotDuration = normalizePositiveInteger(policy.shotDuration) || 10
  const invalidDurations = storyboards
    .filter(sb => Number(sb.duration || shotDuration) !== shotDuration)
    .map(sb => sb.shot_number)
  if (invalidDurations.length) {
    throw new Error(`Grok 10s 拆解每个镜头时长必须为 ${shotDuration} 秒，异常镜头：${invalidDurations.join(', ')}`)
  }
  if (policy.mode !== 'grok_3min') return

  const maxShots = normalizePositiveInteger(policy.maxShots) || 18
  const maxTotalDuration = normalizePositiveInteger(policy.maxTotalDuration) || maxShots * shotDuration

  if (storyboards.length > maxShots) {
    throw new Error(`Grok 3分钟拆解最多 ${maxShots} 个镜头，当前 ${storyboards.length} 个。请压缩剧情后重新保存。`)
  }

  const totalDuration = storyboards.reduce((sum, sb) => sum + Number(sb.duration || shotDuration), 0)
  if (totalDuration > maxTotalDuration) {
    throw new Error(`Grok 3分钟拆解总时长不能超过 ${maxTotalDuration} 秒，当前 ${totalDuration} 秒。请合并或删减镜头。`)
  }
}

export function isGrokDurationPolicy(policy: StoryboardDurationPolicy | null | undefined) {
  return policy?.mode === 'grok_3min' || policy?.mode === 'grok_10s'
}

export function isTkOverseasDurationPolicy(policy: StoryboardDurationPolicy | null | undefined) {
  return policy?.mode === 'tk_overseas'
}

export function isMiniMaxLocalEightSecondDurationPolicy(policy: StoryboardDurationPolicy | null | undefined) {
  return policy?.mode === 'minimax_local_8s'
}

const MINIMAX_CONTINUITY_LABELS = [
  'CONTINUITY_START:',
  'CURRENT_SHOT_PROGRESS:',
  'CURRENT_SHOT_END:',
] as const

const MINIMAX_RESET_LANGUAGE = /全新开场|重新开场|重新构图|从头开始|重新开始|独立开场|另起开场|重置|new opening|fresh opening|independent opening|re-establish(?:ing)? the scene|restarting? from the beginning|start(?:ing)? over|reset/i
const MINIMAX_COPIED_END_LANGUAGE = /上一镜结尾作为本镜结尾|复制上一镜(?:最后画面|结尾)|保持上一镜(?:最后画面|结尾)不变作为本镜结尾|same as the previous shot(?:'s)? ending|copy the previous shot(?:'s)? ending|previous ending remains the ending/i
const MINIMAX_GENERIC_RESULT = /^(?:承接上一镜|延续上一镜|保持一致|与上一镜相同|same as previous(?: shot)?|continue previous(?: shot)?|continuation only)$/i

function nonEmptyStoryboardField(value: unknown) {
  return String(value ?? '').trim()
}

function normalizeContinuityText(value: unknown) {
  return nonEmptyStoryboardField(value).toLocaleLowerCase().replace(/\s+/g, '')
}

function stripMiniMaxContinuityLabels(value: unknown) {
  return nonEmptyStoryboardField(value)
    .replace(/CONTINUITY_START:|CURRENT_SHOT_PROGRESS:|CURRENT_SHOT_END:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasValidMiniMaxContinuityPrompt(videoPrompt: string) {
  const positions = MINIMAX_CONTINUITY_LABELS.map(label => videoPrompt.indexOf(label))
  if (positions.some(position => position < 0)) return false
  if (MINIMAX_CONTINUITY_LABELS.some(label => videoPrompt.split(label).length - 1 !== 1)) return false
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) return false
  return MINIMAX_CONTINUITY_LABELS.every((label, index) => {
    const sectionStart = positions[index] + label.length
    const sectionEnd = index + 1 < MINIMAX_CONTINUITY_LABELS.length
      ? positions[index + 1]
      : videoPrompt.length
    return Boolean(videoPrompt.slice(sectionStart, sectionEnd).trim())
  })
}

/**
 * Repair a local MiniMax continuity wrapper before persistence instead of
 * aborting the whole breakdown when the model omits or duplicates a marker.
 */
export function normalizeMiniMaxLocalContinuityContract<T extends MiniMaxContinuityStoryboard>(
  storyboards: T[],
  policy: StoryboardDurationPolicy | null | undefined,
) {
  if (!isMiniMaxLocalEightSecondDurationPolicy(policy)) return storyboards

  const resultByShot = new Map(storyboards.map(storyboard => [Number(storyboard.shot_number), storyboard.result]))
  return storyboards.map(storyboard => {
    const shotNumber = Number(storyboard.shot_number)
    if (shotNumber === 1) return storyboard

    const action = nonEmptyStoryboardField(storyboard.action) || '按本镜剧情动作继续推进。'
    const previousResult = nonEmptyStoryboardField(resultByShot.get(shotNumber - 1)) || '上一镜最后可见状态'
    const currentResult = nonEmptyStoryboardField(storyboard.result)
    const copiedResult = normalizeContinuityText(currentResult) === normalizeContinuityText(previousResult)
    const result = !currentResult || MINIMAX_GENERIC_RESULT.test(currentResult) || copiedResult
      ? `${currentResult || action}；继续推进当前镜头动作并形成新的稳定尾帧。`
      : currentResult
    const originalPrompt = stripMiniMaxContinuityLabels(storyboard.video_prompt)
      .replace(MINIMAX_RESET_LANGUAGE, '从上一镜最后状态连续推进')
      .replace(MINIMAX_COPIED_END_LANGUAGE, '继续形成新的当前镜头尾帧')
      .trim()
    const continuityText = [storyboard.action, storyboard.description, storyboard.result, storyboard.video_prompt]
      .map(nonEmptyStoryboardField)
      .join('\n')
    const prompt = hasValidMiniMaxContinuityPrompt(nonEmptyStoryboardField(storyboard.video_prompt))
      && !MINIMAX_RESET_LANGUAGE.test(continuityText)
      && !MINIMAX_COPIED_END_LANGUAGE.test(continuityText)
      && !copiedResult
      ? nonEmptyStoryboardField(storyboard.video_prompt)
      : [
          `CONTINUITY_START: 继承分镜 ${shotNumber - 1} 的最后可见状态作为本镜 0 秒起点：${previousResult}。`,
          `CURRENT_SHOT_PROGRESS: ${originalPrompt || action}`,
          `CURRENT_SHOT_END: ${result}`,
        ].join('\n')

    return {
      ...storyboard,
      action,
      result,
      video_prompt: prompt,
    }
  })
}

function compactAssetText(value: unknown) {
  return normalizeContinuityText(value).normalize('NFKC')
}

function characterStoryText(character: StoryboardCharacter) {
  return [
    character.name,
    character.aliases,
    character.englishName,
    character.english_name,
    character.role,
    character.description,
    character.appearance,
  ].flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ')
}

function isCustomerCharacter(character: StoryboardCharacter) {
  return /顾客|食客|客人|customer|diner|patron/i.test(characterStoryText(character))
}

function isFatherCharacter(character: StoryboardCharacter) {
  return /苏大强|sudaqiang|父亲|爸爸|father/i.test(characterStoryText(character))
}

function containsCharacterReference(text: string, character: StoryboardCharacter) {
  const compact = compactAssetText(text)
  return assetBindingTerms({
    name: character.name,
    aliases: character.aliases,
    englishName: character.englishName || character.english_name,
  }).some(term => compact.includes(term))
}

function hasCustomerDiningPlacement(text: string, customer: StoryboardCharacter) {
  const compact = compactAssetText(text)
  const customerMentioned = assetBindingTerms({
    name: customer.name,
    aliases: customer.aliases,
    englishName: customer.englishName || customer.english_name,
  }).some(term => compact.includes(term))
  return customerMentioned && /餐桌|桌旁|桌边|桌前|桌子|旁桌|diningtable|diningarea|seatedatthetable|sittingatthetable/i.test(compact)
}

function hasCustomerMovement(text: string, customer: StoryboardCharacter) {
  const compact = compactAssetText(text)
  const customerMentioned = assetBindingTerms({
    name: customer.name,
    aliases: customer.aliases,
    englishName: customer.englishName || customer.english_name,
  }).some(term => compact.includes(term))
  return customerMentioned && /走|跑|冲|离开|起身|站起|进入|入画|walk|run|leave|standup|rise|enter|approach/i.test(compact)
}

const MINIMAX_CUSTOMER_CONFLICT_LAYOUT = /(?:顾客|食客|客人|customer|diner|patron)[^\n。！？.!?]{0,80}(?:灶台|炉前|烤炉|吧台|柜台|操作台|后厨|挡在.{0,12}之间|foreground|infront|blocks?|between|stove|grill|counter|cookingworktop|kitchen)/i
const MINIMAX_CUSTOMER_FOCUS_LAYOUT = /(?:镜头|运镜|焦点|特写|主体|camera|focus|close[- ]?up|ends?)[^\n。！？.!?]{0,60}(?:顾客|食客|客人|customer|diner|patron)/i
const MINIMAX_FATHER_FEMALE_BINDING = /(?:苏大强|sudaqiang|father)[^\n。！？.!?]{0,60}(?:gender\s*[:=：]\s*female|female|woman|girl|女性|女人|女孩|女声)|(?:gender\s*[:=：]\s*female|female|woman|girl|女性|女人|女孩|女声)[^\n。！？.!?]{0,60}(?:苏大强|sudaqiang|father)/i

/**
 * Diagnose the known local MiniMax identity/layout failure before persistence.
 * The save path records a warning and continues; other providers do not use
 * this contract.
 */
export function validateMiniMaxLocalCastContract(
  storyboards: MiniMaxLocalCastStoryboard[],
  characters: StoryboardCharacter[],
  policy: StoryboardDurationPolicy | null | undefined,
) {
  if (!isMiniMaxLocalEightSecondDurationPolicy(policy)) return true

  const activeCharacters = (storyboard: MiniMaxLocalCastStoryboard) => {
    const ids = new Set(Array.isArray(storyboard.character_ids)
      ? storyboard.character_ids.map(Number).filter(Number.isFinite)
      : [])
    const roleNames = extractStoryboardRoleNames(extractCurrentShotReferenceText(storyboard.video_prompt))
    return characters.filter(character => ids.has(Number(character.id)) || roleNames.some(name => containsCharacterReference(name, character)))
  }

  for (const storyboard of storyboards) {
    const active = activeCharacters(storyboard)
    const customers = active.filter(isCustomerCharacter)
    const fathers = active.filter(isFatherCharacter)
    const visualText = [
      storyboard.action,
      storyboard.description,
      storyboard.result,
      storyboard.image_prompt,
      storyboard.video_prompt,
    ].map(nonEmptyStoryboardField).join('\n')
    if (fathers.length && MINIMAX_FATHER_FEMALE_BINDING.test(visualText)) {
      throw new Error(`本地 MiniMax H3 分镜 ${storyboard.shot_number} 将苏大强绑定为女性；请按角色资产保持苏大强为男性。`)
    }
    if (!customers.length) continue

    if (MINIMAX_CUSTOMER_CONFLICT_LAYOUT.test(visualText)) {
      throw new Error(`本地 MiniMax H3 分镜 ${storyboard.shot_number} 的顾客站位越界；顾客必须在独立旁桌，不能靠近灶台/吧台/操作台、挡在冲突中心或替代主要角色。`)
    }
    if (fathers.length) {
      const hasDiningPlacement = customers.some(customer => hasCustomerDiningPlacement(visualText, customer))
      const hasMovement = customers.some(customer => hasCustomerMovement(visualText, customer))
      if (!hasDiningPlacement && !hasMovement) {
        throw new Error(`本地 MiniMax H3 分镜 ${storyboard.shot_number} 未明确顾客的独立旁桌位置；有顾客参与时必须写清旁桌/餐桌隔离，不能让模型自由补位。`)
      }

      if (MINIMAX_CUSTOMER_FOCUS_LAYOUT.test(visualText)) {
        throw new Error(`本地 MiniMax H3 分镜 ${storyboard.shot_number} 把顾客写成了镜头主体；苏大强与顾客同镜时必须由苏大强承担冲突动作和视觉焦点。`)
      }

      const videoPrompt = nonEmptyStoryboardField(storyboard.video_prompt)
      const endIndex = videoPrompt.indexOf('CURRENT_SHOT_END:')
      const endText = endIndex >= 0 ? videoPrompt.slice(endIndex) : nonEmptyStoryboardField(storyboard.result)
      if (!fathers.some(father => containsCharacterReference(endText, father))) {
        throw new Error(`本地 MiniMax H3 分镜 ${storyboard.shot_number} 的 CURRENT_SHOT_END 未落在苏大强的动作结果上；顾客只能作为旁桌反应，不能成为结尾主体。`)
      }
    }

  }

  return true
}

function validateMiniMaxContinuityPrompt(shotNumber: number, videoPrompt: string) {
  const missingLabels = MINIMAX_CONTINUITY_LABELS.filter(label => !videoPrompt.includes(label))
  if (missingLabels.length) {
    throw new Error(`本地 MiniMax H3 分镜 ${shotNumber} 缺少 ${missingLabels.join('、')}，已拒绝保存；第 2 镜起必须严格继承上一镜并继续推进。`)
  }

  const labelPositions = MINIMAX_CONTINUITY_LABELS.map(label => videoPrompt.indexOf(label))
  const hasDuplicateLabel = MINIMAX_CONTINUITY_LABELS.some(label => videoPrompt.split(label).length - 1 !== 1)
  if (hasDuplicateLabel || labelPositions.some((position, index) => index > 0 && position <= labelPositions[index - 1])) {
    throw new Error(`本地 MiniMax H3 分镜 ${shotNumber} 的连续性标记顺序或数量不正确，已拒绝保存；必须按 CONTINUITY_START -> CURRENT_SHOT_PROGRESS -> CURRENT_SHOT_END 各出现一次。`)
  }

  for (let index = 0; index < MINIMAX_CONTINUITY_LABELS.length; index += 1) {
    const sectionStart = labelPositions[index] + MINIMAX_CONTINUITY_LABELS[index].length
    const sectionEnd = index + 1 < MINIMAX_CONTINUITY_LABELS.length
      ? labelPositions[index + 1]
      : videoPrompt.length
    if (!videoPrompt.slice(sectionStart, sectionEnd).trim()) {
      throw new Error(`本地 MiniMax H3 分镜 ${shotNumber} 的 ${MINIMAX_CONTINUITY_LABELS[index]} 内容不能为空，已拒绝保存。`)
    }
  }
}

/**
 * Enforce the source-of-truth continuity contract before a local MiniMax
 * storyboard snapshot can reach persistence. This intentionally rejects the
 * whole snapshot instead of filling missing text or repairing one shot.
 */
export function validateMiniMaxLocalContinuityContract(
  storyboards: MiniMaxContinuityStoryboard[],
  policy: StoryboardDurationPolicy | null | undefined,
) {
  if (!isMiniMaxLocalEightSecondDurationPolicy(policy)) return true

  const resultByShot = new Map(storyboards.map(storyboard => [Number(storyboard.shot_number), storyboard.result]))
  for (const storyboard of storyboards) {
    const shotNumber = Number(storyboard.shot_number)
    if (shotNumber === 1) continue

    const missingFields = ['action', 'result', 'video_prompt']
      .filter(field => !nonEmptyStoryboardField(storyboard[field as keyof MiniMaxContinuityStoryboard]))
    if (missingFields.length) {
      throw new Error(`本地 MiniMax H3 分镜 ${shotNumber} 缺少 ${missingFields.join('、')}，已拒绝保存；第 2 镜起必须写出继承起点、当前推进和新尾帧。`)
    }

    const continuityText = [storyboard.action, storyboard.description, storyboard.result, storyboard.video_prompt]
      .map(nonEmptyStoryboardField)
      .join('\n')
    if (MINIMAX_RESET_LANGUAGE.test(continuityText)) {
      throw new Error(`本地 MiniMax H3 分镜 ${shotNumber} 含有独立开场或重置镜头语义，已拒绝保存；第 2 镜起必须从上一镜最后状态继续。`)
    }
    if (MINIMAX_COPIED_END_LANGUAGE.test(continuityText) || MINIMAX_GENERIC_RESULT.test(nonEmptyStoryboardField(storyboard.result))) {
      throw new Error(`本地 MiniMax H3 分镜 ${shotNumber} 没有形成新的尾帧结果，已拒绝保存；上一镜结尾只能作为本镜 0 秒起点。`)
    }
    if (normalizeContinuityText(storyboard.result) === normalizeContinuityText(resultByShot.get(shotNumber - 1))) {
      throw new Error(`本地 MiniMax H3 分镜 ${shotNumber} 的 result 与分镜 ${shotNumber - 1} 完全相同，已拒绝保存；必须在继承起点后继续推进并形成新尾帧。`)
    }

    validateMiniMaxContinuityPrompt(shotNumber, nonEmptyStoryboardField(storyboard.video_prompt))
  }

  return true
}

export function validateTkSceneCoverage(
  storyboards: Array<{ scene_id?: number | null }>,
  requiredSceneIds: Iterable<number>,
) {
  const required = [...new Set([...requiredSceneIds].map(Number).filter(Boolean))]
  if (!required.length) return
  const used = new Set(storyboards.map(item => Number(item.scene_id || 0)).filter(Boolean))
  const missing = required.filter(sceneId => !used.has(sceneId))
  if (missing.length) {
    throw new Error(`TK海外剧拆解未覆盖当前集的场景：${missing.join(', ')}。请按每个场景完整拆解后重新保存。`)
  }
}

export function normalizeStoryboardDuration(value: unknown, policy: StoryboardDurationPolicy | null | undefined) {
  if (isMiniMaxLocalEightSecondDurationPolicy(policy)) {
    const parsed = Math.round(Number(value || 0))
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.max(parsed, 8), 10) : 8
  }
  if (isGrokDurationPolicy(policy)) return normalizePositiveInteger(policy?.shotDuration) || 10
  if (isTkOverseasDurationPolicy(policy)) {
    const min = normalizePositiveInteger(policy?.shotDurationMin) || 4
    const max = normalizePositiveInteger(policy?.shotDurationMax) || 15
    const parsed = Math.round(Number(value || 0))
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.max(parsed, min), max) : min
  }
  const parsed = Math.round(Number(value || 0))
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.max(parsed, 4), 7) : 5
}

export function normalizeStoryboardDurationsForPolicy<T extends StoryboardWithDuration>(
  storyboards: T[],
  policy: StoryboardDurationPolicy | null | undefined,
) {
  return storyboards.map(storyboard => ({
    ...storyboard,
    duration: normalizeStoryboardDuration(storyboard.duration, policy),
  }))
}

export function buildStoryboardPersistencePlan<
  TExisting extends ExistingStoryboardForPlan,
  TIncoming extends IncomingStoryboardForPlan,
>(existingStoryboards: TExisting[], incomingStoryboards: TIncoming[]) {
  const activeExisting = existingStoryboards.filter(item => !item.deletedAt)
  const existingByShotNumber = new Map<number, TExisting>()
  const duplicateExistingIds: number[] = []

  for (const item of activeExisting) {
    const shotNumber = Number(item.storyboardNumber || 0)
    if (!shotNumber) {
      duplicateExistingIds.push(item.id)
      continue
    }
    const current = existingByShotNumber.get(shotNumber)
    if (current) {
      // Prefer the newest active row as the canonical snapshot. Older active
      // duplicates are retired below; choosing the oldest row here was the
      // reason a partial re-breakdown could keep stale shot 1-5 data alive.
      const currentStamp = Date.parse(String((current as any).updatedAt || ''))
      const itemStamp = Date.parse(String((item as any).updatedAt || ''))
      if ((Number.isFinite(itemStamp) && (!Number.isFinite(currentStamp) || itemStamp > currentStamp))
        || (itemStamp === currentStamp && Number(item.id) > Number(current.id))) {
        duplicateExistingIds.push(current.id)
        existingByShotNumber.set(shotNumber, item)
      } else {
        duplicateExistingIds.push(item.id)
      }
      continue
    }
    existingByShotNumber.set(shotNumber, item)
  }

  const usedExistingIds = new Set<number>()
  const updates: Array<{ id: number; storyboard: TIncoming }> = []
  const creates: Array<{ storyboard: TIncoming }> = []

  for (const storyboard of incomingStoryboards) {
    const shotNumber = Number(storyboard.shot_number || 0)
    const existing = shotNumber ? existingByShotNumber.get(shotNumber) : null
    if (existing && !usedExistingIds.has(existing.id)) {
      updates.push({ id: existing.id, storyboard })
      usedExistingIds.add(existing.id)
    } else {
      creates.push({ storyboard })
    }
  }

  const retireIds = [
    ...activeExisting
      .filter(item => !usedExistingIds.has(item.id))
      .map(item => item.id),
    ...duplicateExistingIds,
  ].filter((id, index, arr) => arr.indexOf(id) === index)

  return { updates, creates, retireIds }
}

function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()

  const uniqueIds = [...new Set(characterIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    }).run()
  }
}

function getStoryboardCharacterIds(storyboardId: number) {
  return db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
    .map(link => link.characterId)
}

function getEpisodeSceneIds(episodeId: number) {
  const linkedIds = new Set(
    db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
      .map(link => link.sceneId),
  )
  const [episode] = db.select({ dramaId: schema.episodes.dramaId }).from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) return linkedIds
  for (const scene of db.select({ id: schema.scenes.id, deletedAt: schema.scenes.deletedAt }).from(schema.scenes)
    .where(eq(schema.scenes.dramaId, episode.dramaId)).all()) {
    if (!scene.deletedAt) linkedIds.add(scene.id)
  }
  return linkedIds
}

function getEpisodeCharacterIds(episodeId: number) {
  const linkedIds = new Set(
    db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      .map(link => link.characterId),
  )
  const [episode] = db.select({ dramaId: schema.episodes.dramaId }).from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) return linkedIds
  for (const character of db.select({ id: schema.characters.id, deletedAt: schema.characters.deletedAt }).from(schema.characters)
    .where(eq(schema.characters.dramaId, episode.dramaId)).all()) {
    if (!character.deletedAt) linkedIds.add(character.id)
  }
  return linkedIds
}

function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined) {
  const episodeSceneIds = getEpisodeSceneIds(episodeId)
  const episodeCharacterIds = getEpisodeCharacterIds(episodeId)

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error(`scene_id ${sceneId} 不属于当前集`)
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error(`character_ids 不属于当前集: ${invalidCharacterIds.join(', ')}`)
  }
}

function storyboardDbValues(episodeId: number, sb: {
  shot_number: number
  title?: string
  shot_type?: string
  angle?: string
  movement?: string
  location?: string
  time?: string
  action?: string
  dialogue?: string
  description?: string
  result?: string
  atmosphere?: string
  image_prompt?: string
  video_prompt?: string
  bgm_prompt?: string
  sound_effect?: string
  duration?: number
  scene_id?: number | null
}, ts: string) {
  return {
    storyboardNumber: sb.shot_number,
    title: sb.title ?? null,
    shotType: sb.shot_type ?? null,
    angle: sb.angle ?? null,
    movement: sb.movement ?? null,
    location: sb.location ?? null,
    time: sb.time ?? null,
    action: sb.action ?? null,
    dialogue: sb.dialogue ?? null,
    description: sb.description ?? null,
    result: sb.result ?? null,
    atmosphere: sb.atmosphere ?? null,
    imagePrompt: sb.image_prompt ?? null,
    videoPrompt: sb.video_prompt ?? null,
    bgmPrompt: sb.bgm_prompt ?? null,
    soundEffect: sb.sound_effect ?? null,
    sceneId: sb.scene_id ?? null,
    duration: sb.duration || 5,
    deletedAt: null,
    updatedAt: ts,
  }
}

function storyboardCreateValues(episodeId: number, sb: Parameters<typeof storyboardDbValues>[1], ts: string) {
  return {
    ...storyboardDbValues(episodeId, sb, ts),
    episodeId,
    createdAt: ts,
  }
}

/** Resolve a missing scene_id against the current episode's scene whitelist.
 * Re-decomposition often returns a correct location string but omits the
 * numeric id. Persisting null in that case makes video generation unable to
 * load the scene image, even though the episode has a matching scene asset.
 * Only an unambiguous location/time match (or a single linked scene) is
 * auto-filled; ambiguous scenes remain null instead of guessing an old one. */
export function resolveStoryboardSceneId(
  episodeId: number,
  input: {
    scene_id?: number | null
    location?: string | null
    time?: string | null
    video_prompt?: string | null
    description?: string | null
    action?: string | null
    image_prompt?: string | null
    result?: string | null
    title?: string | null
    atmosphere?: string | null
  },
) {
  const linkedIds = db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
    .map(link => Number(link.sceneId)).filter(Boolean)
  if (input.scene_id != null) {
    const explicitId = Number(input.scene_id)
    // Preserve a valid current-episode binding. If it is a stale id from a
    // previous decomposition, fall through to location/time repair instead
    // of rejecting the whole save or carrying the old scene into generation.
    if (linkedIds.includes(explicitId)) return explicitId
    if (!linkedIds.length) {
      const [scene] = db.select().from(schema.scenes)
        .where(eq(schema.scenes.id, explicitId)).all()
      // Legacy projects may not have episode_scenes rows yet. Preserve an
      // explicit scene binding only when the scene still belongs to this
      // episode or drama; never resurrect an unrelated project's scene.
      if (scene && !scene.deletedAt) {
        const [episode] = db.select().from(schema.episodes)
          .where(eq(schema.episodes.id, episodeId)).all()
        // A same-drama scene belonging to another episode is stale whenever
        // this episode already has its own scene rows. Keep drama-level rows
        // as a compatibility fallback only when no episode-scoped row exists.
        const hasEpisodeScopedScene = db.select().from(schema.scenes).all()
          .some(item => !item.deletedAt && item.episodeId === episodeId)
        if (scene.episodeId === episodeId
          || (!hasEpisodeScopedScene && scene.episodeId == null && scene.dramaId === episode?.dramaId)) return explicitId
      }
    }
  }
  // Legacy/manual scenes may carry episode_id but have no episode_scenes row.
  // Do not return null before examining those rows: that early return is what
  // caused valid scene assets to disappear even when the reference budget had
  // room.  Prefer the current episode rows; only fall back to drama rows when
  // the project has no episode-scoped scenes at all.
  const allScenes = db.select().from(schema.scenes).all().filter(scene => !scene.deletedAt)
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const episodeScenes = allScenes.filter(scene => linkedIds.includes(Number(scene.id)) || scene.episodeId === episodeId)
  const scenes = episodeScenes.length
    ? episodeScenes
    // Legacy rows without episode_id are still safe to use within this drama;
    // rows explicitly belonging to another episode are never candidates.
    : allScenes.filter(scene => scene.dramaId === episode?.dramaId && scene.episodeId == null)
  if (!scenes.length) return null
  if (scenes.length === 1) return Number(scenes[0].id)
  // Models occasionally omit the top-level location while still emitting
  // the canonical <location>...</location> tag in video_prompt.  Resolve
  // from that tag (and the other persisted shot text) before giving up; a
  // null scene_id is what ultimately causes a white/empty video background.
  const taggedLocations = extractStoryboardLocationNames(input.video_prompt)
  const directLocationText = [input.location, ...taggedLocations].filter(Boolean).join(' ')
  const descriptiveLocationText = [
    input.description,
    input.action,
    input.image_prompt,
    input.result,
    input.title,
    input.atmosphere,
  ].filter(Boolean).join('\n')
  // Prefer explicit location fields/tags.  Descriptive action text can name
  // a destination (for example “from the kitchen to the dining room”) and
  // must not make the resolver choose two scenes or drop the real one.
  const location = normalizeSceneBindingText(directLocationText || descriptiveLocationText)
  const time = normalizeSceneBindingText(input.time)
  if (!location) return null
  const matches = scenes.filter(scene => {
    const sceneTime = normalizeSceneBindingText(scene.time)
    const locationMatch = sceneLocationMatchesAsset(location, scene)
    const timeMatch = !time || !sceneTime || sceneTime === time || sceneTime.includes(time) || time.includes(sceneTime)
    return locationMatch && timeMatch
  })
  if (matches.length === 1) return Number(matches[0].id)

  // If the model wrote a descriptive location instead of the scene heading,
  // use the persisted scene prompt as a second, deterministic signal.  Only
  // accept a unique best match so an ambiguous scene can never borrow another
  // scene's asset by guesswork.
  const ranked = scenes.map(scene => ({
    scene,
    score: sceneBindingScore(scene, directLocationText || descriptiveLocationText, time),
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score)
  if (ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score)) {
    return Number(ranked[0].scene.id)
  }
  return null
}

function normalizeSceneBindingText(value: unknown) {
  return String(value || '').trim().replace(/[\s\u3000]+/g, '').toLocaleLowerCase()
}

function extractStoryboardLocationNames(value: unknown) {
  const names: string[] = []
  const pattern = /<location>\s*([^<]+?)\s*<\/location>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(value || '')))) {
    const name = String(match[1] || '').trim()
    if (name && !names.some(item => normalizeSceneBindingText(item) === normalizeSceneBindingText(name))) names.push(name)
  }
  return names
}

function sceneLocationVariants(value: unknown) {
  const normalized = normalizeSceneBindingText(value)
  const variants = new Set(normalized ? [normalized] : [])
  const aliases: Array<[string, string]> = [
    ['厨房', '后厨'],
    ['店内', '店里'],
    ['室内', '屋内'],
    ['起居室', '客厅'],
    ['卧房', '卧室'],
  ]
  for (const [left, right] of aliases) {
    if (normalized.includes(left)) variants.add(normalized.replaceAll(left, right))
    if (normalized.includes(right)) variants.add(normalized.replaceAll(right, left))
  }
  return [...variants]
}

function sceneLocationMatchesBinding(left: string, right: string) {
  if (!left || !right) return false
  return sceneLocationVariants(left).some(a => sceneLocationVariants(right).some(b => a === b || a.includes(b) || b.includes(a)))
}

function sceneBindingScore(scene: { location?: string | null; aliases?: unknown; english_name?: unknown; englishName?: unknown; time?: string | null; prompt?: string | null }, text: string, normalizedTime: string) {
  const source = normalizeSceneBindingText(text)
  const location = normalizeSceneBindingText(scene.location)
  const prompt = normalizeSceneBindingText(scene.prompt)
  let score = sceneLocationMatchesAsset(source, scene) ? 100 : 0
  if (location && sceneLocationVariants(location).some(variant => source.includes(variant))) score += 30
  if (prompt && sceneLocationVariants(prompt).some(variant => source.includes(variant))) score += 20
  const sceneTime = normalizeSceneBindingText(scene.time)
  if (normalizedTime && sceneTime && (sceneTime === normalizedTime || sceneTime.includes(normalizedTime) || normalizedTime.includes(sceneTime))) score += 20
  return score
}

function sceneLocationMatchesAsset(left: unknown, scene: { location?: unknown; aliases?: unknown; english_name?: unknown; englishName?: unknown }) {
  const normalizedLeft = normalizeSceneBindingText(left)
  if (!normalizedLeft) return false
  return assetBindingTerms({ name: scene.location, aliases: scene.aliases, english_name: scene.english_name, englishName: scene.englishName })
    .some(term => sceneLocationMatchesBinding(normalizedLeft, normalizeSceneBindingText(term)))
}

type StoryboardPersistenceVerification = {
  verified: boolean
  repaired: boolean
  expectedCount: number
  actualCount: number
  revision: string
  mismatches: string[]
}

type StoryboardPersistenceInput = Parameters<typeof storyboardDbValues>[1] & {
  character_ids?: number[]
}

/**
 * A decomposition save is a complete episode snapshot. Accepting a partial
 * array here is unsafe: the persistence planner intentionally preserves rows
 * by shot number, so a partial retry can leave shot 1-5 from the old
 * decomposition and shot 6+ from the new one. Reject the payload before any
 * database write unless it contains one unique, contiguous 1..N shot set.
 */
export function validateCompleteStoryboardSet(storyboards: Array<{ shot_number?: unknown }>) {
  if (!Array.isArray(storyboards) || storyboards.length === 0) {
    throw new Error('分镜保存结果不能为空；必须一次提交当前集的完整分镜集合')
  }
  const numbers = storyboards.map(item => Number(item?.shot_number))
  if (numbers.some(number => !Number.isInteger(number) || number <= 0)) {
    throw new Error('分镜 shot_number 必须是从 1 开始的正整数')
  }
  const unique = [...new Set(numbers)].sort((a, b) => a - b)
  if (unique.length !== numbers.length || unique.some((number, index) => number !== index + 1)) {
    throw new Error('分镜保存必须包含从 1 开始连续且不重复的完整镜号，禁止提交部分分镜或重复镜号')
  }
  return true
}

const STORYBOARD_VISUAL_APPEARANCE_FIELDS = [
  'title', 'shot_type', 'action', 'description', 'result', 'atmosphere', 'image_prompt', 'video_prompt',
] as const

const STORYBOARD_WARDROBE_DESCRIPTION_PATTERN = /(?:穿着|身穿|穿戴|着装|衣着|服装|衣服|衣裳|衣袍|衣裙|袍服|嫁衣|喜服|婚服|道袍|麻衣|长袍|长裙|短裙|裙装|裙子|衬衫|夹克|外套|披风|盔甲|铠甲|制服|袈裟|风衣|西装|连衣裙|服饰|换装|换衣|脱下|脱掉|裸露|赤裸|袖口|衣袖|\b(?:wearing|wears|wore|outfit|clothing|costume|dress|robe|gown|jacket|coat|shirt|uniform|armor|armour|cloak|cape|garment|vest|suit)\b)/i

const STORYBOARD_STATIC_APPEARANCE_PATTERN = /(?:外貌|外形|长相|容貌|五官|脸型|面容|脸庞|肤色|肌肤|身材|体型|身高|年龄感|发型|发色|头发|长发|短发|黑发|白发|银发|乌发|卷发|直发|马尾|发髻|发辫|刘海|鬓发|剑眉|丹凤眼|高鼻梁|薄唇|少年感|少女感|苍老|白皙|黝黑|清秀|俊美|美艳|高挑|纤瘦|魁梧|瘦削|棱角分明|\b(?:hair|hairstyle|hair color|facial features|face shape|complexion|skin tone|slender|muscular|tall|short-haired|long-haired|black-haired|silver-haired)\b)/i

const STORYBOARD_WARDROBE_INTRODUCER_PATTERN = /(?:身穿|穿着|穿戴|身着|穿上|换上|披着|身披|裹着|着装为|衣着为|衣着|穿的是|换穿)\s*(?:一身|一袭)?[^，。；！？,;.!?]{1,36}?(?=(?:缓缓|轻轻|微微|突然|渐渐|转身|抬头|低头|看向|望向|注视|走进|走出|走入|走|跑|站|坐|跪|退后|后退|靠近|停下|伸手|抬手|握住|举起|放下|转向|凝视|皱眉|微笑|开口|说|喊|沉默|回头|离开|进入|面向|朝向|飘动|出现|落下)|[，。；！？,;.!?]|$)/gi

const STORYBOARD_BARE_WARDROBE_PATTERN = /(?:(?:一袭|一身|纯白|雪白|素白|玄红|血红|深红|浅红|鲜红|红色|白色|黑色|墨色|乌黑|淡蓝|深蓝|青色|灰色|金色|银色|旧|破旧|整洁)\s*)+(?:嫁衣|喜服|婚服|道袍|麻衣|长袍|长裙|短裙|裙装|裙子|衬衫|夹克|外套|披风|盔甲|铠甲|制服|袈裟|风衣|西装|连衣裙|衣袍|衣裙|衣服|衣裳|衣物|衣袖|服饰)(?:微敞|飘动|摆动|下摆|袖口)?[，,]?/gi

const STORYBOARD_ENGLISH_WARDROBE_INTRODUCER_PATTERN = /\b(?:wearing|dressed in|clad in)\s+[^,.!?;]{1,80}?(?=\b(?:walks?|runs?|stands?|sits?|turns?|looks?|looks? toward|faces?|raises?|lowers?|reaches?|holds?|steps?|moves?|speaks?|says?|shouts?|pauses?|glances?|nods?)\b|[,.;!?]|$)/gi

const STORYBOARD_APPEARANCE_INTRODUCER_PATTERN = /(?:有着|拥有|留着|长着|披散着|梳着|扎着|束着|盘着|垂着|一头|一双|a\s+pair\s+of|has|with)\s*[^，。；！？,;.!?]{1,36}?(?=(?:缓缓|轻轻|微微|突然|渐渐|转身|抬头|低头|看向|望向|注视|走进|走出|走入|走|跑|站|坐|跪|退后|后退|靠近|停下|伸手|抬手|握住|举起|放下|转向|凝视|皱眉|微笑|开口|说|喊|沉默|回头|离开|进入|面向|朝向|飘动|出现|落下|眉头|眼神|目光|眼睑|嘴角|下颌|呼吸|眨眼|停顿|\b(?:walks?|runs?|stands?|sits?|turns?|looks?|faces?|raises?|lowers?|reaches?|holds?|steps?|moves?|speaks?|says?|pauses?|glances?|frowns?|smiles?|breathes?|blinks?)\b)|[，。；！？,;.!?]|$)/gi

const STORYBOARD_STATIC_APPEARANCE_FRAGMENT_PATTERN = /(?:(?:乌黑|浓密|及腰|披肩|银白|雪白|纯黑|黑色|白色|银色|金色|棕色|卷曲|笔直|柔顺|凌乱)\s*)+(?:长发|短发|黑发|白发|银发|乌发|卷发|直发|头发|马尾|发髻|发辫|刘海|鬓发)|(?:精致|清秀|俊美|美艳|冷峻|苍白|白皙|黝黑|高挑|纤瘦|魁梧|瘦削|棱角分明)(?:的)?(?:五官|面容|脸庞|脸型|肌肤|肤色|身材|体型)|(?:高鼻梁|薄唇|剑眉|丹凤眼|杏眼|凤眼)|(?:少年感|少女感|苍老|年迈|稚嫩)(?:的)?(?:面容|脸庞|外貌|外形)?/gi

const STORYBOARD_ENGLISH_STATIC_APPEARANCE_PATTERN = /\b(?:(?:long|short|black|white|silver|blonde|blond|brown|curly|straight|wavy)\s+hair|(?:sharp|delicate|pale|fair|dark|slender|muscular|tall|petite)\s+(?:features|face|skin|complexion|figure|build))\b/gi

function cleanRewrittenVisualText(value: string) {
  return value
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;!?，。；！？])/g, '$1')
    .replace(/([，,；;、])\s*([，,；;、])+/g, '$1')
    .replace(/^[，,；;、\s]+|[，,；;、\s]+$/g, '')
    .trim()
}

function rewriteStoryboardVisualAppearance(value: string) {
  let rewritten = value.replace(STORYBOARD_WARDROBE_INTRODUCER_PATTERN, match => (
    STORYBOARD_WARDROBE_DESCRIPTION_PATTERN.test(match) ? '' : match
  ))
  rewritten = rewritten.replace(STORYBOARD_ENGLISH_WARDROBE_INTRODUCER_PATTERN, match => (
    STORYBOARD_WARDROBE_DESCRIPTION_PATTERN.test(match) ? '' : match
  ))
  rewritten = rewritten.replace(STORYBOARD_BARE_WARDROBE_PATTERN, '')
  rewritten = rewritten.replace(STORYBOARD_APPEARANCE_INTRODUCER_PATTERN, match => (
    STORYBOARD_STATIC_APPEARANCE_PATTERN.test(match) ? '' : match
  ))
  rewritten = rewritten.replace(STORYBOARD_STATIC_APPEARANCE_FRAGMENT_PATTERN, '')
  rewritten = rewritten.replace(STORYBOARD_ENGLISH_STATIC_APPEARANCE_PATTERN, '')
  return cleanRewrittenVisualText(rewritten)
}

export function optimizeStoryboardCharacterAppearance<T extends Record<string, unknown>>(storyboards: T[]) {
  const rewrittenFields: string[] = []
  const optimizedStoryboards = storyboards.map(storyboard => {
    const optimized: Record<string, unknown> = { ...storyboard }
    const shotNumber = Number(storyboard?.shot_number) || '?'
    for (const field of STORYBOARD_VISUAL_APPEARANCE_FIELDS) {
      const value = storyboard?.[field]
      if (typeof value !== 'string' || (
        !STORYBOARD_WARDROBE_DESCRIPTION_PATTERN.test(value)
        && !STORYBOARD_STATIC_APPEARANCE_PATTERN.test(value)
      )) continue
      const rewritten = rewriteStoryboardVisualAppearance(value)
      if (rewritten !== value) {
        optimized[field] = rewritten
        rewrittenFields.push(`镜头${shotNumber}.${field}`)
      }
    }
    return optimized as T
  })
  return { storyboards: optimizedStoryboards, rewrittenFields }
}

const STORYBOARD_PERSISTENCE_FIELDS = [
  'storyboardNumber', 'title', 'shotType', 'angle', 'movement', 'location', 'time',
  'action', 'dialogue', 'description', 'result', 'atmosphere', 'imagePrompt',
  'videoPrompt', 'bgmPrompt', 'soundEffect', 'duration', 'sceneId',
] as const

function samePersistedValue(left: unknown, right: unknown) {
  // SQLite returns null for omitted optional fields while the model payload may
  // contain an empty string. Treat both as the same only when both are empty;
  // non-empty stale values must still be repaired.
  const a = left == null ? '' : String(left)
  const b = right == null ? '' : String(right)
  return a === b
}

function inspectStoryboardPersistence(
  episodeId: number,
  expectedStoryboards: StoryboardPersistenceInput[],
): StoryboardPersistenceVerification {
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()
  const activeRows = rows.filter(row => !row.deletedAt)
  const expectedByShot = new Map(expectedStoryboards.map(sb => [Number(sb.shot_number), sb]))
  const actualByShot = new Map<number, typeof activeRows[number]>()
  const mismatches: string[] = []

  for (const row of activeRows) {
    const shot = Number(row.storyboardNumber || 0)
    if (!shot) {
      mismatches.push(`duplicate_or_invalid_shot:${row.id}`)
      continue
    }
    const current = actualByShot.get(shot)
    if (current) {
      const currentStamp = Date.parse(String((current as any).updatedAt || ''))
      const rowStamp = Date.parse(String((row as any).updatedAt || ''))
      const newer = (Number.isFinite(rowStamp) && (!Number.isFinite(currentStamp) || rowStamp > currentStamp))
        || (rowStamp === currentStamp && Number(row.id) > Number(current.id))
      if (newer) actualByShot.set(shot, row)
      mismatches.push(`duplicate_or_invalid_shot:${newer ? current.id : row.id}`)
      continue
    }
    actualByShot.set(shot, row)
  }

  for (const [shot, expected] of expectedByShot) {
    const row = actualByShot.get(shot)
    if (!row) {
      mismatches.push(`missing_shot:${shot}`)
      continue
    }
    const expectedValues = storyboardDbValues(episodeId, expected, String(row.updatedAt || now()))
    for (const field of STORYBOARD_PERSISTENCE_FIELDS) {
      if (!samePersistedValue((row as any)[field], (expectedValues as any)[field])) {
        mismatches.push(`field:${shot}.${field}`)
      }
    }
    const expectedCharacterIds = [...new Set((expected as any).character_ids || [])].map(Number).sort((a, b) => a - b)
    const actualCharacterIds = getStoryboardCharacterIds(Number(row.id)).map(Number).sort((a, b) => a - b)
    if (JSON.stringify(actualCharacterIds) !== JSON.stringify(expectedCharacterIds)) {
      mismatches.push(`characters:${shot}`)
    }
  }

  for (const row of activeRows) {
    const shot = Number(row.storyboardNumber || 0)
    if (!expectedByShot.has(shot)) mismatches.push(`stale_shot:${shot || row.id}`)
  }

  const expectedTotal = expectedStoryboards.reduce((sum, sb) => sum + Number(sb.duration || 5), 0)
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (episode && Number(episode.duration || 0) !== Math.ceil(expectedTotal / 60)) {
    mismatches.push('episode_duration')
  }

  return {
    verified: mismatches.length === 0 && activeRows.length === expectedStoryboards.length,
    repaired: false,
    expectedCount: expectedStoryboards.length,
    actualCount: activeRows.length,
    revision: activeRows.reduce((latest, row) => String(row.updatedAt || '') > latest ? String(row.updatedAt || '') : latest, ''),
    mismatches: [...new Set(mismatches)],
  }
}

/**
 * Read the rows back after a decomposition save and repair any stale rows or
 * character links left by a previous decomposition. This is deliberately
 * independent from video generation so an Agent can never report success on
 * data that is only eventually consistent in the database.
 */
export function verifyAndRepairStoryboardPersistence(
  episodeId: number,
  expectedStoryboards: StoryboardPersistenceInput[],
  options: { maxRepairAttempts?: number } = {},
): StoryboardPersistenceVerification {
  let report = inspectStoryboardPersistence(episodeId, expectedStoryboards)
  const maxRepairAttempts = Math.max(1, Math.round(options.maxRepairAttempts || 1))
  if (report.verified) return report

  for (let attempt = 0; attempt < maxRepairAttempts && !report.verified; attempt++) {
    const ts = now()
    const existingStoryboards = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)).all()
    const plan = buildStoryboardPersistencePlan(existingStoryboards, expectedStoryboards)

    for (const storyboardId of plan.retireIds) {
      invalidateStoryboardGenerations(storyboardId, ts)
      db.delete(schema.storyboardCharacters)
        .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).run()
      db.update(schema.storyboards)
        .set({ deletedAt: ts, updatedAt: ts })
        .where(eq(schema.storyboards.id, storyboardId)).run()
    }

    for (const { id, storyboard: sb } of plan.updates) {
      validateStoryboardBindings(episodeId, sb.scene_id, sb.character_ids)
      const existing = existingStoryboards.find(item => item.id === id)
      if (!existing) continue
      const values = storyboardDbValues(episodeId, sb, ts)
      const changed = haveStoryboardGenerationInputsChanged(
        existing,
        values,
        getStoryboardCharacterIds(id),
        sb.character_ids || [],
      )
      if (changed) invalidateStoryboardGenerations(id, ts)
      db.update(schema.storyboards)
        .set({ ...values, ...(changed ? storyboardGenerationResetValues(ts) : {}) })
        .where(eq(schema.storyboards.id, id)).run()
      syncStoryboardCharacters(id, sb.character_ids || [])
    }

    for (const { storyboard: sb } of plan.creates) {
      validateStoryboardBindings(episodeId, sb.scene_id, sb.character_ids)
      const res = db.insert(schema.storyboards)
        .values(storyboardCreateValues(episodeId, sb, ts)).run()
      syncStoryboardCharacters(Number(res.lastInsertRowid), sb.character_ids || [])
    }

    const totalDuration = expectedStoryboards.reduce((sum, sb) => sum + Number(sb.duration || 5), 0)
    db.update(schema.episodes)
      .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
      .where(eq(schema.episodes.id, episodeId)).run()

    report = inspectStoryboardPersistence(episodeId, expectedStoryboards)
    report.repaired = true
  }

  if (!report.verified) {
    throw new Error(`分镜拆解结果写库校验失败，最新结果未完全落稳：${report.mismatches.join('、')}`)
  }
  return report
}

export function createStoryboardTools(
  episodeId: number,
  dramaId: number,
  durationPolicy: StoryboardDurationPolicy | null = null,
) {
  const readStoryboardContext = createTool({
    id: 'read_storyboard_context',
    description: 'Read the screenplay, characters, and scenes for storyboard breakdown.',
    inputSchema: z.object({}),
    execute: async () => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: 'Episode not found' }
      const script = selectStoryboardScriptSource(ep)
      if (!script) return { error: 'Episode has no script' }

      const charLinks = db.select().from(schema.episodeCharacters)
        .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      const sceneLinks = db.select().from(schema.episodeScenes)
        .where(eq(schema.episodeScenes.episodeId, episodeId)).all()

      const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
      const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))

      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
      const scns = db.select().from(schema.scenes)
        .where(eq(schema.scenes.dramaId, dramaId)).all()
      const [drama] = db.select().from(schema.dramas)
        .where(eq(schema.dramas.id, dramaId)).all()
      const characters = chars
        .filter(c => !c.deletedAt)
        .map(c => ({
          id: c.id,
          name: c.name,
          aliases: c.aliases || '',
          role: c.role || '',
          description: c.description || '',
          appearance: c.appearance || '',
          personality: c.personality || '',
          voice_style: c.voiceStyle || '',
          image_url: c.imageUrl || '',
          reference_images: c.referenceImages || '',
        }))

      const scenes = scns
        .filter(s => !s.deletedAt)
        .map(s => ({
          id: s.id,
          location: s.location,
          aliases: s.aliases || '',
          time: s.time,
          prompt: s.prompt || '',
          image_url: s.imageUrl || '',
          storyboard_count: s.storyboardCount || 0,
        }))

      const propLinks = db.select().from(schema.episodeProps)
        .where(eq(schema.episodeProps.episodeId, episodeId)).all()
      const linkedPropIds = new Set(propLinks.map(link => link.propId))
      const props = db.select().from(schema.props)
        .where(eq(schema.props.dramaId, dramaId)).all()
        .filter(p => !p.deletedAt)
        .map(p => ({
          id: p.id,
          name: p.name,
          aliases: p.aliases || '',
          type: p.type || '',
          description: p.description || '',
          prompt: p.prompt || '',
          image_url: p.imageUrl || '',
        }))

      const payload = {
        episode: {
          id: ep.id,
          title: ep.title,
          episode_number: ep.episodeNumber,
          description: ep.description || '',
          visual_style: drama?.style || 'realistic',
          visual_style_lock: buildVisualStyleLock(drama?.style, '整部短剧'),
        },
        script,
        // Keep both representations available to the breaker. `script` is
        // the authoritative source; `storyboard_script` may be used only to
        // understand scene headings/formatting and must not add facts.
        original_script: String(ep.content || '').trim() || script,
        storyboard_script: String(ep.scriptContent || '').trim() || script,
        characters,
        scenes,
        props,
      }
      logTaskSuccess('StoryboardTool', 'read-context', {
        episodeId,
        dramaId,
        characters: characters.length,
        scenes: scenes.length,
        scriptLength: script.length,
        visualStyle: drama?.style || 'realistic',
      })
      return payload
    },
  })

  const saveStoryboards = createTool({
    id: 'save_storyboards',
    description: 'Save generated storyboards. Updates existing storyboards by shot number to preserve generated assets.',
    inputSchema: z.object({
      storyboards: z.array(z.object({
        shot_number: z.number(),
        title: z.string().optional(),
        shot_type: z.string().optional(),
        angle: z.string().optional(),
        movement: z.string().optional(),
        location: z.string().optional(),
        time: z.string().optional(),
        action: z.string().optional(),
        dialogue: z.string().optional(),
        description: z.string().optional(),
        result: z.string().optional(),
        atmosphere: z.string().optional(),
        image_prompt: z.string().optional(),
        video_prompt: z.string().optional(),
        bgm_prompt: z.string().optional(),
        sound_effect: z.string().optional(),
        duration: z.number().optional(),
        scene_id: z.number().nullable().optional(),
        character_ids: z.array(z.number()).optional(),
      })),
    }),
    execute: async ({ storyboards }) => {
      // Validate the complete snapshot before normalising, resolving assets or
      // touching the database. This is the guard that prevents a late partial
      // model response from producing a mixed old/new episode.
      validateCompleteStoryboardSet(storyboards)
      const appearanceOptimization = optimizeStoryboardCharacterAppearance(storyboards)
      const continuityStoryboards = normalizeMiniMaxLocalContinuityContract(appearanceOptimization.storyboards, durationPolicy)
      try {
        validateMiniMaxLocalContinuityContract(continuityStoryboards, durationPolicy)
      } catch (error: any) {
        logTaskWarn('StoryboardTool', 'minimax-continuity-quality-warning', {
          episodeId,
          shots: continuityStoryboards.length,
          reason: error?.message || String(error),
        })
      }
      const ts = now()
      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
      const episodeCharacters = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
      const normalizedStoryboards = normalizeStoryboardDurationsForPolicy(continuityStoryboards, durationPolicy).map(storyboard => ({
        ...storyboard,
        scene_id: resolveStoryboardSceneId(episodeId, storyboard),
        character_ids: resolveStoryboardCharacterIds(
          storyboard.character_ids,
          storyboard.video_prompt,
          episodeCharacters,
          storyboard.dialogue,
        ),
        image_prompt: withTkOverseasVisualLock(
          withVisualStyleLock(storyboard.image_prompt, drama?.style, '分镜静态画面'),
          durationPolicy?.mode,
          '分镜静态画面',
        ),
        video_prompt: withTkOverseasVisualLock(
          withVisualStyleLock(storyboard.video_prompt, drama?.style, '分镜动态画面'),
          durationPolicy?.mode,
          '分镜动态画面',
        ),
      }))
      try {
        validateMiniMaxLocalCastContract(normalizedStoryboards, episodeCharacters, durationPolicy)
      } catch (error: any) {
        logTaskWarn('StoryboardTool', 'minimax-cast-quality-warning', {
          episodeId,
          shots: normalizedStoryboards.length,
          reason: error?.message || String(error),
        })
      }
      validateStoryboardDurationPolicy(normalizedStoryboards, durationPolicy)
      if (isTkOverseasDurationPolicy(durationPolicy)) {
        validateTkSceneCoverage(normalizedStoryboards, getEpisodeSceneIds(episodeId))
      }
      logTaskProgress('StoryboardTool', 'save-begin', {
        episodeId,
        dramaId,
        count: normalizedStoryboards.length,
        shotNumbers: normalizedStoryboards.map(sb => sb.shot_number).join(','),
      })
      const existingStoryboards = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()
      const plan = buildStoryboardPersistencePlan(existingStoryboards, normalizedStoryboards)

      for (const storyboardId of plan.retireIds) {
        invalidateStoryboardGenerations(storyboardId, ts)
        db.delete(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
          .run()
        db.update(schema.storyboards)
          .set({ deletedAt: ts, updatedAt: ts })
          .where(eq(schema.storyboards.id, storyboardId))
          .run()
      }

      let totalDuration = 0
      let generationInputsChangedAny = plan.retireIds.length > 0 || plan.creates.length > 0
      for (const { id, storyboard: sb } of plan.updates) {
        validateStoryboardBindings(episodeId, sb.scene_id, sb.character_ids)
        const existing = existingStoryboards.find(item => item.id === id)!
        const values = storyboardDbValues(episodeId, sb, ts)
        const generationInputsChanged = haveStoryboardGenerationInputsChanged(
          existing,
          values,
          getStoryboardCharacterIds(id),
          sb.character_ids || [],
        )
        if (generationInputsChanged) invalidateStoryboardGenerations(id, ts)
        generationInputsChangedAny ||= generationInputsChanged
        db.update(schema.storyboards)
          .set({
            ...values,
            ...(generationInputsChanged ? storyboardGenerationResetValues(ts) : {}),
          })
          .where(eq(schema.storyboards.id, id))
          .run()
        syncStoryboardCharacters(id, sb.character_ids || [])
        totalDuration += sb.duration || 5
      }

      for (const { storyboard: sb } of plan.creates) {
        validateStoryboardBindings(episodeId, sb.scene_id, sb.character_ids)
        const res = db.insert(schema.storyboards)
          .values(storyboardCreateValues(episodeId, sb, ts))
          .run()
        syncStoryboardCharacters(Number(res.lastInsertRowid), sb.character_ids || [])
        totalDuration += sb.duration || 5
      }

      db.update(schema.episodes)
        .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
        .where(eq(schema.episodes.id, episodeId)).run()

      if (generationInputsChangedAny) {
        cancelStaleVideoSequenceRuns(episodeId, ts)
      }

      // The model may have triggered a re-breakdown while older rows were
      // still present. Read the database back and repair/verify the complete
      // result before reporting the tool as successful.
      const persistence = verifyAndRepairStoryboardPersistence(episodeId, normalizedStoryboards)
      if (persistence.repaired && !generationInputsChangedAny) {
        cancelStaleVideoSequenceRuns(episodeId, ts)
      }

      logTaskSuccess('StoryboardTool', 'save-complete', {
        episodeId,
        count: normalizedStoryboards.length,
        updated: plan.updates.length,
        created: plan.creates.length,
        retired: plan.retireIds.length,
        totalDuration,
        appearanceRewrittenFields: appearanceOptimization.rewrittenFields,
        persistenceVerified: persistence.verified,
        persistenceRepaired: persistence.repaired,
      })
      return {
        message: `Saved ${normalizedStoryboards.length} storyboards`,
        count: normalizedStoryboards.length,
        updated: plan.updates.length,
        created: plan.creates.length,
        retired: plan.retireIds.length,
        appearance_rewritten_fields: appearanceOptimization.rewrittenFields,
        total_duration: totalDuration,
        persistence_verified: persistence.verified,
        persistence_repaired: persistence.repaired,
        persistence_revision: persistence.revision,
      }
    },
  })

  const updateStoryboard = createTool({
    id: 'update_storyboard',
    description: 'Update a specific storyboard shot.',
    inputSchema: z.object({
      storyboard_id: z.number(),
      title: z.string().optional(),
      shot_type: z.string().optional(),
      angle: z.string().optional(),
      movement: z.string().optional(),
      location: z.string().optional(),
      time: z.string().optional(),
      action: z.string().optional(),
      result: z.string().optional(),
      atmosphere: z.string().optional(),
      image_prompt: z.string().optional(),
      video_prompt: z.string().optional(),
      bgm_prompt: z.string().optional(),
      sound_effect: z.string().optional(),
      description: z.string().optional(),
      dialogue: z.string().optional(),
      scene_id: z.number().nullable().optional(),
      character_ids: z.array(z.number()).optional(),
      duration: z.number().optional(),
    }),
    execute: async ({ storyboard_id, ...fields }) => {
      const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).all()
      if (!storyboard) return { error: `Storyboard ${storyboard_id} not found` }
      logTaskProgress('StoryboardTool', 'update-begin', {
        episodeId,
        storyboardId: storyboard_id,
        fields: Object.keys(fields),
      })

      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
      const episodeCharacters = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
      const currentCharacterIds = getStoryboardCharacterIds(storyboard_id)
      const requestedCharacterIds = 'character_ids' in fields ? fields.character_ids || [] : currentCharacterIds
      const nextCharacterIds = resolveStoryboardCharacterIds(
        requestedCharacterIds,
        'video_prompt' in fields ? fields.video_prompt : storyboard.videoPrompt,
        episodeCharacters,
        'dialogue' in fields ? fields.dialogue : storyboard.dialogue,
      )

      // When an editor changes the location/time but leaves scene_id empty,
      // resolve the new scene from the current episode whitelist instead of
      // carrying the previous shot's scene asset forward. An explicit
      // scene_id remains authoritative; an explicit null still means "no
      // scene" and is not guessed unless location/time was also changed.
      const sceneTextChanged = ['location', 'time', 'video_prompt', 'description', 'action', 'image_prompt', 'result', 'title', 'atmosphere']
        .some(key => key in fields)
      const sceneBindingInput = {
        scene_id: 'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
        location: 'location' in fields ? fields.location : storyboard.location,
        time: 'time' in fields ? fields.time : storyboard.time,
        video_prompt: 'video_prompt' in fields ? fields.video_prompt : storyboard.videoPrompt,
        description: 'description' in fields ? fields.description : storyboard.description,
        action: 'action' in fields ? fields.action : storyboard.action,
        image_prompt: 'image_prompt' in fields ? fields.image_prompt : storyboard.imagePrompt,
        result: 'result' in fields ? fields.result : storyboard.result,
        title: 'title' in fields ? fields.title : storyboard.title,
        atmosphere: 'atmosphere' in fields ? fields.atmosphere : storyboard.atmosphere,
      }
      const nextSceneId = ('scene_id' in fields
        && fields.scene_id == null
        && !sceneTextChanged)
        ? null
        : resolveStoryboardSceneId(episodeId, sceneBindingInput)

      validateStoryboardBindings(
        episodeId,
        nextSceneId,
        nextCharacterIds,
      )

      const ts = now()
      const updates: Record<string, any> = { updatedAt: ts }
      if ('title' in fields) updates.title = fields.title
      if ('shot_type' in fields) updates.shotType = fields.shot_type
      if ('angle' in fields) updates.angle = fields.angle
      if ('movement' in fields) updates.movement = fields.movement
      if ('location' in fields) updates.location = fields.location
      if ('time' in fields) updates.time = fields.time
      if ('action' in fields) updates.action = fields.action
      if ('result' in fields) updates.result = fields.result
      if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
      if ('image_prompt' in fields) updates.imagePrompt = withTkOverseasVisualLock(
        withVisualStyleLock(fields.image_prompt, drama?.style, '分镜静态画面'),
        durationPolicy?.mode,
        '分镜静态画面',
      )
      if ('video_prompt' in fields) updates.videoPrompt = withTkOverseasVisualLock(
        withVisualStyleLock(fields.video_prompt, drama?.style, '分镜动态画面'),
        durationPolicy?.mode,
        '分镜动态画面',
      )
      if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
      if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
      if ('description' in fields) updates.description = fields.description
      if ('dialogue' in fields) updates.dialogue = fields.dialogue
      if ('scene_id' in fields || 'location' in fields || 'time' in fields) updates.sceneId = nextSceneId
      if ('duration' in fields) updates.duration = normalizeStoryboardDuration(fields.duration, durationPolicy)
      const generationInputsChanged = haveStoryboardGenerationInputsChanged(
        storyboard,
        { ...storyboard, ...updates },
        currentCharacterIds,
        nextCharacterIds,
      )
      if (generationInputsChanged) {
        invalidateStoryboardGenerations(storyboard_id, ts)
        cancelStaleVideoSequenceRuns(storyboard.episodeId, ts)
        Object.assign(updates, storyboardGenerationResetValues(ts))
      }
      db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id)).run()
      if ('character_ids' in fields || 'video_prompt' in fields) syncStoryboardCharacters(storyboard_id, nextCharacterIds)
      logTaskSuccess('StoryboardTool', 'update-complete', {
        episodeId,
        storyboardId: storyboard_id,
        updatedFields: Object.keys(updates),
        characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      })
      return { message: `Storyboard ${storyboard_id} updated` }
    },
  })

  // 为宫格图生成整体提示词（分析选中镜头的描述，生成一个连贯的画格布局描述）
  const generateGridPrompt = createTool({
    id: 'generate_grid_prompt',
    description: '为宫格图生成整体画面描述。根据选中的镜头列表及其描述，生成一个连贯的宫格图提示词，用于一次性生成完整的宫格拼图。',
    inputSchema: z.object({
      shots: z.array(z.object({
        shot_number: z.number(),
        description: z.string(),
        shot_type: z.string().optional(),
        dialogue: z.string().optional(),
      })),
      rows: z.number(),
      cols: z.number(),
      mode: z.string(), // 'first_frame' | 'first_last' | 'multi_ref'
    }),
    execute: async ({ shots, rows, cols, mode }) => {
      if (!shots.length) return { error: 'No shots provided' }
      logTaskProgress('StoryboardTool', 'grid-prompt-begin', {
        episodeId,
        shots: shots.length,
        rows,
        cols,
        mode,
      })

      if (mode === 'multi_ref') {
        const sb = shots[0]
        const payload = {
          grid_prompt: `电影级高质量参考图，${sb.description}，专业摄影，电影质感，4K分辨率，${rows}x${cols} 宫格统一风格参考图`,
          cell_prompts: shots.map(s => ({
            shot_number: s.shot_number,
            frame_type: 'reference',
            prompt: `电影级高质量参考图，${s.description}，专业摄影，电影质感，4K分辨率，统一风格`,
          })),
        }
        logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
        return payload
      }

      if (mode === 'first_last') {
        const cellPrompts = []
        for (const s of shots) {
          cellPrompts.push({
            shot_number: s.shot_number,
            frame_type: 'first_frame',
            prompt: `电影级高质量首帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
          })
          cellPrompts.push({
            shot_number: s.shot_number,
            frame_type: 'last_frame',
            prompt: `电影级高质量尾帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
          })
        }
        const payload = {
          grid_prompt: `${shots.length}个镜头首尾帧拼图，${shots.map(s => s.description).join(' | ')}，电影级画面，专业摄影，${rows}行${cols}列风格统一`,
          cell_prompts: cellPrompts,
        }
        logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
        return payload
      }

      // first_frame mode
      const cellPrompts = shots.slice(0, rows * cols).map(s => ({
        shot_number: s.shot_number,
        frame_type: 'first_frame',
        prompt: `电影级高质量首帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
      }))
      const payload = {
        grid_prompt: `${shots.length}个镜头首帧拼图，${shots.map(s => s.description).join(' | ')}，电影级画面，专业摄影，${rows}行${cols}列风格统一`,
        cell_prompts: cellPrompts,
      }
      logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
      return payload
    },
  })

  return { readStoryboardContext, saveStoryboards, updateStoryboard, generateGridPrompt }
}
