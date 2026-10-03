import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { isTkOverseasMode } from './overseas-visual.js'
import { compileLocalH3SpeechPrompt, isLikelyCharacterProfileLine, isLocalH3SpeechLine } from './local-h3-speech.js'
import { appendVideoNegativePrompt } from './video-negative-prompt.js'

const DIALOGUE_BEGIN = '视频对白约束（自动注入 BEGIN）'
const DIALOGUE_END = '视频对白约束（自动注入 END）'
const EMPTY_DIALOGUE = /^(?:无|无对白|无台词|无旁白|无需配音|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音乐|bgm|sfx|ambient|none|null|n\/a|na)$/i

export function normalizeVideoDialogue(dialogue: string | null | undefined, breakdownMode?: string | null) {
  const value = String(dialogue || '').trim()
  if (!value || EMPTY_DIALOGUE.test(value)) return ''
  const mixedLanguageValue = stripInlineChineseTranslation(value)
  const spokenLinesOnly = mixedLanguageValue
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !isLikelyCharacterProfileLine(line))
    .join('\n')
    .trim()
  if (!spokenLinesOnly) return ''
  if (!isTkOverseasMode(breakdownMode)) return spokenLinesOnly

  return spokenLinesOnly
    .split(/\r?\n/)
    .map(line => line
      // TK 剧本常把英文原台词和中文翻译放在同一行，只移除翻译括号。
      .replace(/(["”'])\s*[（(][^()（）]*[\u4e00-\u9fff][^()（）]*[）)]/g, '$1')
      .replace(/\s*[（(][^()（）]*[\u4e00-\u9fff][^()（）]*[）)]\s*$/g, '')
      .trim(),
    )
    .filter(line => line && !/^[（(][^()（）]*[\u4e00-\u9fff][^()（）]*[）)]$/.test(line))
    .join('\n')
    .trim()
}

export function normalizeLocalVideoDialogue(dialogue: string | null | undefined, breakdownMode?: string | null) {
  return normalizeVideoDialogue(dialogue, breakdownMode)
    .replace(/[ \t]+[\/／][ \t]+(?=[^:：\r\n/／]{1,40}[:：](?!\/\/))/g, '\n')
    .split(/\r?\n/).filter(isLocalH3SpeechLine).join('\n')
}

/**
 * When a screenplay line contains an English original followed by a Chinese
 * translation in parentheses, keep the English as the spoken line. Pure
 * Chinese dialogue is intentionally left untouched; translating it here would
 * change the user's screenplay rather than merely selecting the canonical
 * bilingual line.
 */
export function stripInlineChineseTranslation(value: string) {
  const hasEnglish = /[A-Za-z]/.test(value)
  const hasChinese = /[\u4e00-\u9fff]/.test(value)
  if (!hasEnglish || !hasChinese) return value

  return value
    .split(/\r?\n/)
    .map(line => line
      .replace(/(["”'])\s*[（(][^()（）]*[\u4e00-\u9fff][^()（）]*[）)]/g, '$1')
      .replace(/\s*[（(][^()（）]*[\u4e00-\u9fff][^()（）]*[）)]\s*$/g, '')
      .trim(),
    )
    .filter(line => line && !/^[（(][^()（）]*[\u4e00-\u9fff][^()（）]*[）)]$/.test(line))
    .join('\n')
    .trim()
}

export function appendVideoDialoguePrompt(
  prompt: string | null | undefined,
  dialogue: string | null | undefined,
  breakdownMode?: string | null,
  characterVoiceBindings: CharacterVoiceBinding[] = [],
  forceNativeAudioLock = false,
) {
  const basePrompt = stripInjectedVideoDialogue(String(prompt || '').trim())
  const normalizedDialogue = forceNativeAudioLock
    ? normalizeLocalVideoDialogue(dialogue, breakdownMode)
    : normalizeVideoDialogue(dialogue, breakdownMode)
  if (forceNativeAudioLock) return compileLocalH3SpeechPrompt(basePrompt, normalizedDialogue, characterVoiceBindings)
  if (!normalizedDialogue) {
    const nativeAudioLock = buildMiniMaxNativeAudioLock('', breakdownMode, basePrompt, characterVoiceBindings, forceNativeAudioLock)
    return [basePrompt, nativeAudioLock].filter(Boolean).join('\n')
  }

  // The storyboard extractor may describe the spoken line in video_prompt
  // (for example, “Eli says \"Wait\"”).  In that case appending the complete
  // dialogue block again makes the provider receive the same line twice.  Use
  // the dialogue column as the source of truth, but only include lines that
  // are not already present in the prompt.  This keeps the prompt idempotent
  // while still filling in a line that the extractor omitted.
  const dialogueLines = normalizedDialogue.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const missingDialogue = dialogueLines.filter(line => !promptContainsDialogueLine(basePrompt, line))
  const includeFullDialogue = missingDialogue.length > 0
  const linesToInject = includeFullDialogue ? missingDialogue : []

  const overseas = isTkOverseasMode(breakdownMode)
  const interactionLock = buildDialogueInteractionLock(normalizedDialogue)
  const nativeAudioLock = buildMiniMaxNativeAudioLock(normalizedDialogue, breakdownMode, basePrompt, characterVoiceBindings, forceNativeAudioLock)
  const lines = includeFullDialogue
    ? (overseas
    ? [
      DIALOGUE_BEGIN,
      '本镜头必须使用以下英文对白原文，仅使用英文发声：',
      linesToInject.join('\n'),
      '对白语言：English。说话人必须与原文一致并按原文顺序说出；禁止翻译成中文、改写、省略或添加剧本外对白，禁止错配说话人。',
      interactionLock,
      nativeAudioLock,
      DIALOGUE_END,
    ]
    : [
      DIALOGUE_BEGIN,
      '本镜头必须使用以下对白/旁白原文：',
      linesToInject.join('\n'),
      '对白或旁白必须按原文表达；不得省略、翻译、改写或添加剧本外内容，禁止错配说话人。',
      interactionLock,
      nativeAudioLock,
      DIALOGUE_END,
    ])
    : [
      DIALOGUE_BEGIN,
      '对白唯一来源：storyboard dialogue 字段。video_prompt 中已有对白时，每条对白只能按原文发声一次，不得重复朗读、补说或改配说话人。',
      overseas ? '对白语言：English。' : '对白语言按原剧本。',
      interactionLock,
      nativeAudioLock,
      DIALOGUE_END,
    ]

  return [basePrompt, lines.join('\n')].filter(Boolean).join('\n')
}

/** H3 Ref2VA generates audio in the same sampling pass as video.  Make the
 * allowed speakers and the silent tail explicit to prevent improvised voices. */
export type CharacterVoiceBinding = {
  id?: number
  name?: string | null
  aliases?: string[] | null
  gender?: string | null
  voiceStyle?: string | null
  voice_style?: string | null
  voiceProvider?: string | null
  voice_provider?: string | null
}

function buildMiniMaxNativeAudioLock(
  dialogue: string,
  breakdownMode?: string | null,
  prompt?: string | null,
  characterVoiceBindings: CharacterVoiceBinding[] = [],
  forceNativeAudioLock = false,
) {
  if (!forceNativeAudioLock && String(breakdownMode || '').trim().toLowerCase() !== 'minimax_local_8s') return ''
  const speakers = String(dialogue || '')
    .split(/\r?\n/)
    .map(extractDialogueSpeaker)
    .filter(Boolean)
  // A storyboard may carry the speaker in a <voice> tag while the dialogue
  // column contains only the spoken words. Include both sources so H3 cannot
  // assign an otherwise unlabelled line to a different referenced character.
  const promptVoiceNames = [...String(prompt || '').matchAll(/<voice>\s*([^<]+?)\s*<\/voice>/gi)]
    .map(match => String(match[1] || '').trim())
    .filter(Boolean)
  // Dialogue is authoritative. Legacy <voice> tags are only a fallback when
  // no speaker prefix exists, so a stale tag cannot add another role's voice.
  const uniqueSpeakers = [...new Set(speakers.length ? speakers : promptVoiceNames)]
  const speakerText = uniqueSpeakers.length ? uniqueSpeakers.join('、') : '对白字段中指定的说话人'
  const voiceRows = uniqueSpeakers.map(speaker => {
    const binding = characterVoiceBindings.find(item => voiceBindingMatches(item, speaker))
    const configuredVoice = String(binding?.voiceStyle || binding?.voice_style || '').trim()
    const provider = String(binding?.voiceProvider || binding?.voice_provider || '').trim()
    const gender = normalizeVoiceGender(binding?.gender, configuredVoice, binding?.name || speaker)
    // A project may not have manually assigned a TTS profile yet. Still emit
    // a deterministic gender-specific fallback instead of leaving H3 free to
    // choose a new voice on every shot.
    const voice = configuredVoice || defaultVoiceForGender(gender)
    return `- ${speaker}: gender=${gender}; voice_id=${voice}${provider ? `; provider=${provider}` : ''}`
  })
  return [
    '【MiniMax H3 原生音频硬约束 / NATIVE AUDIO CONTRACT】',
    `原生音轨只允许对白字段指定的说话人发声：${speakerText}；每句对白按原文只说一次，禁止任何未列出的男声、女声、旁白、群众、耳语、重复、应答或人声拟声。`,
    voiceRows.length
      ? ['角色音色锁定（跨分镜保持不变） / VOICE IDENTITY LOCK:', ...voiceRows, '每个说话人只能使用其对应的 gender 和 voice_id；后续分镜不得改变性别、音色 ID、音高身份或将台词交给另一角色。'].join('\n')
      : '',
    '禁止把环境音、音乐、动作声或提示词中的其他人物描述转成语音；对白结束后立即保持绝对静音直到本镜结束，不得在尾部补一句听不清的话、哼唱、喃喃自语或新的角色声音。',
    'The native H3 audio track must contain only the named dialogue speaker(s) and the exact dialogue text once. Use the declared speaker-to-gender-to-voice_id mapping exactly and keep it unchanged across shots. No extra male or female voice, narrator, crowd speech, whisper, vocalization, repeated line, or improvised words. After the final scripted syllable, keep absolute silence until the end of the clip.',
  ].join('\n')
}

/** Storyboard extraction accepts both `角色：台词` and the screenplay style
 * `角色（情绪）台词`. Keep the speaker identity in either form; otherwise a
 * parenthetical line is treated as anonymous and H3 is free to pick a voice. */
function extractDialogueSpeaker(line: string) {
  const value = String(line || '').trim()
  return value.match(/^([^:：\n（）()]{1,40})\s*[:：]/)?.[1]?.trim()
    || value.match(/^([^:：\n（）()]{1,40})\s*[（(][^）)]{1,32}[）)]/)?.[1]?.trim()
    || ''
}

function voiceBindingMatches(binding: CharacterVoiceBinding, speaker: string) {
  const target = normalizeVoiceBindingText(speaker)
  return !!target && [binding?.name, ...(Array.isArray(binding?.aliases) ? binding.aliases : [])]
    .map(normalizeVoiceBindingText)
    .filter(Boolean)
    .some(value => value === target)
}

function normalizeVoiceBindingText(value: unknown) {
  return String(value || '').trim().replace(/[\s\u3000]+/g, '').toLocaleLowerCase()
}

function normalizeVoiceGender(gender: unknown, voice: string, name?: unknown) {
  const explicit = String(gender || '').trim().toLocaleLowerCase()
  if (/female|woman|girl|女/.test(explicit)) return 'female'
  if (/male|man|boy|男/.test(explicit)) return 'male'
  const voiceText = String(voice || '').trim().toLocaleLowerCase()
  if (/^female[-_]/.test(voiceText) || /女/.test(voiceText)) return 'female'
  if (/^male[-_]/.test(voiceText) || /男/.test(voiceText)) return 'male'
  const nameText = String(name || '')
  if (/(女性|女声|少女|女生|女主|女孩|夫人|小姐|母亲|daughter|woman|girl|female|\bshe\b)/i.test(nameText)) return 'female'
  if (/(男性|男声|男生|男主|男孩|父亲|先生|儿子|son|man|boy|male|\bhe\b)/i.test(nameText)) return 'male'
  return 'unspecified'
}

function defaultVoiceForGender(gender: string) {
  if (gender === 'female') return 'female-shaonv'
  if (gender === 'male') return 'male-qn-qingse'
  return 'neutral-fixed'
}

function buildDialogueInteractionLock(dialogue: string) {
  const lines = String(dialogue || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const hasOnscreenDialogue = lines.some(line => !/^(?:旁白|画外音|内心独白|narrator|voice[- ]?over|off[- ]?screen)\s*[:：]/i.test(line))
  if (!hasOnscreenDialogue) return ''
  return [
    '【对白互动与视线硬约束 / DIALOGUE EYELINE CONTRACT】',
    '每句画内对白都必须明确表现说话者正在对剧情中的听者说话：说话者的眼睛、面部、下颌和上半身朝向听者，视线落在听者眼睛或脸部，严禁无理由看向摄影机镜头；听者看向说话者并以眨眼、呼吸、表情、重心或手部动作作出同步反应。',
    '多人对话按当前说话人自然切换视线，优先使用双人构图、过肩或反打，并保持180度轴线、左右站位和匹配视线。只有分镜原文明确要求“对镜头、面向观众或独白”时才允许直视镜头。',
    'The speaker addresses and looks into the eyes of the intended on-screen listener, never into the camera lens unless the shot explicitly requires direct address. The listener returns the eyeline and visibly reacts; preserve screen direction and the 180-degree axis in two-shots, over-the-shoulder shots and shot/reverse-shot.',
  ].join('\n')
}

/**
 * Detect a dialogue line that has already been described in a video prompt.
 * Extractors commonly omit the speaker prefix or wrap the spoken text in
 * quotes, so compare both the complete line and a speaker/quote-free variant.
 */
function promptContainsDialogueLine(prompt: string, dialogueLine: string) {
  const haystack = compactDialogueText(prompt)
  const spokenLine = stripDialogueSpeaker(dialogueLine)
  const candidate = compactDialogueText(spokenLine)
  // Empty speaker-only lines do not represent spoken content.  Keep the
  // one-character case (e.g. “啊？”) because those short reactions are
  // common and are just as easy to duplicate as a longer sentence.
  return candidate.length > 0 && haystack.includes(candidate)
}

function stripDialogueSpeaker(line: string) {
  return line
    .replace(/^\s*[^:：\n]{1,40}\s*[:：]\s*/, '')
    .replace(/^\s*[^：:\n]{1,40}\s*[：:]\s*/, '')
    .trim()
}

function compactDialogueText(value: string) {
  return String(value || '')
    .replace(/[“”「」『』"'‘’]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？；：、,.!?;:]+/g, '')
    .toLocaleLowerCase()
}

export function stripInjectedVideoDialogue(prompt: string | null | undefined) {
  return String(prompt || '')
    .replace(
      new RegExp(`(?:^|\\n)${escapeRegExp(DIALOGUE_BEGIN)}[\\s\\S]*?${escapeRegExp(DIALOGUE_END)}\\s*`, 'g'),
      '\n',
    )
    .trim()
}

export function getStoryboardVideoDialogue(storyboardId?: number | null) {
  const id = Number(storyboardId || 0)
  if (!Number.isFinite(id) || id <= 0) return { dialogue: '', breakdownMode: null as string | null }
  const [storyboard] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, id)).all()
  if (!storyboard) return { dialogue: '', breakdownMode: null as string | null }
  const [episode] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, storyboard.episodeId)).all()
  return {
    dialogue: String(storyboard.dialogue || ''),
    breakdownMode: episode?.breakdownMode || null,
  }
}

export function appendStoryboardDialoguePrompt(
  prompt: string | null | undefined,
  storyboardId?: number | null,
  breakdownMode?: string | null,
  forceNativeAudioLock = false,
) {
  const context = getStoryboardVideoDialogue(storyboardId)
  const characterVoiceBindings = getStoryboardCharacterVoiceBindings(storyboardId)
  const dialoguePrompt = appendVideoDialoguePrompt(
    prompt,
    context.dialogue,
    breakdownMode || context.breakdownMode,
    characterVoiceBindings,
    forceNativeAudioLock,
  )
  return appendVideoNegativePrompt(dialoguePrompt)
}

function getStoryboardCharacterVoiceBindings(storyboardId?: number | null): CharacterVoiceBinding[] {
  const id = Number(storyboardId || 0)
  if (!Number.isFinite(id) || id <= 0) return []
  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!storyboard) return []
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).all()
  const [drama] = episode ? db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).all() : []
  // Resolve from the current drama/episode character pool rather than relying
  // only on storyboard_character link rows. Those links can be stale or absent
  // immediately after re-decomposition; the speaker names below still select
  // only the characters that actually speak, so carrying the full voice table
  // cannot create an extra voice in the rendered shot.
  const characters = db.select().from(schema.characters).all().filter(character =>
    !character.deletedAt && character.dramaId === (drama?.id || episode?.dramaId))
  const sourceText = String(episode?.scriptContent || episode?.content || '')
  return characters.map(character => ({
    id: character.id,
    name: character.name,
    aliases: parseCharacterAliases(character.aliases),
    gender: inferVoiceGender(character, sourceText),
    voiceStyle: character.voiceStyle || defaultVoiceForGender(inferVoiceGender(character, sourceText)),
    voiceProvider: character.voiceProvider,
  }))
}

function parseCharacterAliases(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  const raw = String(value || '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(item => String(item || '').trim()).filter(Boolean)
  } catch { /* legacy comma-separated aliases */ }
  return raw.split(/[,，、|]/).map(item => item.trim()).filter(Boolean)
}

function inferVoiceGender(character: any, sourceText = '') {
  const voice = String(character?.voiceStyle || '').trim()
  const name = String(character?.name || '').trim()
  const roleText = String(character?.role || '')
  const text = [name, character?.role, character?.description, character?.appearance, character?.personality]
    .map(value => String(value || '')).join(' ')
  // Prefer explicit voice/profile and unambiguous character titles. Do not
  // treat relationship words in a description as the character's own gender:
  // 凤溪's description mentions five 师兄, but凤溪 is female.
  if (/^female[-_]/i.test(voice) || /(女主|女配|女性|女声|少女|女生|女孩|夫人|小姐|姑娘|圣女|师姐|母亲|daughter|woman|girl|female)/i.test(text)) return 'female'
  if (/^male[-_]/i.test(voice) || /(男主|男性|男声|少年|男生|男孩|先生|长老|师父|店主|首领|son|man|boy|male)/i.test(text)) return 'male'
  // Generic group labels are resolved before screenplay context. Their nearby
  // prose often contains a pronoun for a different person (e.g. “弟子甲：
  // 她疯了”), which must never change the speaker's own profile.
  if (/(弟子|追兵|食客|顾客|守卫)/i.test(roleText)) return 'male'
  // Extracted character rows do not always carry a gender marker (for
  // example 凤溪 is stored simply as “主角”). Use the original screenplay as
  // a deterministic tie-breaker: pronouns immediately around the canonical
  // name identify the role without guessing from the model's generated shot.
  if (name && sourceText) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const windows = [...String(sourceText).matchAll(new RegExp(`.{0,140}${escaped}.{0,140}`, 'gi'))].map(match => match[0])
    const femaleScore = windows.reduce((score, value) => score + (value.match(/她|姑娘|小姐|woman|girl|female|\\bshe\\b/gi) || []).length, 0)
    const maleScore = windows.reduce((score, value) => score + (value.match(/他(?!们)|先生|小伙|man|boy|male|\\bhe\\b/gi) || []).length, 0)
    if (femaleScore > maleScore && femaleScore > 0) return 'female'
    if (maleScore > femaleScore && maleScore > 0) return 'male'
  }
  return 'unspecified'
}

export function hasInjectedVideoDialogue(prompt: string | null | undefined) {
  return String(prompt || '').includes(DIALOGUE_BEGIN)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
