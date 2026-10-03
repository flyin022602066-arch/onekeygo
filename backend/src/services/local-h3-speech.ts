import { applyLocalH3VideoContinuation } from './local-h3-continuation.js'

const SPEECH_BEGIN = 'LOCAL H3 AUTHORIZED SPEECH BEGIN'
const SPEECH_END = 'LOCAL H3 AUTHORIZED SPEECH END'
const DIRECTION_BOUNDARY = 'Generate exactly one shot in sequence. Keep the same visual identity across shots and follow the original shot direction below.'
const SECTION_NAMES = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'] as const
const NON_SPEECH = /^(?:(?:无|无对白|无台词|无旁白|环境音|环境声|纯环境音|只有环境音|仅环境音|纯音效|none|n\/a|no dialogue|no speech|ambient sound only)(?:[，,。；;:：].*)?[。.!！\s]*$|(?:音效|环境音|环境声|背景音乐|动作描述|镜头描述|画面描述|场景描述|sound effects?|sfx|ambience|ambient sound|bgm)\s*[:：]|[（(][^（）()]*[）)]\s*$)/i
const PROFILE_LEADING_TEXT = /^(?:外表|实则|身份|性格|经历|背景|人物(?:介绍|简介|档案)|角色(?:设定|简介)|设定|修炼|修为|战神|军功|开山祖师|出身|来自|职业|职务|门派|境界)\s*[:：]?/i
const PROFILE_AGE_TEXT = /^(?:\d{1,3}\s*岁(?:\s*[/／]\s*\d{1,3}\s*岁)?|年龄\s*[:：]?\s*\d{1,3}\s*岁)(?=\s*[，,、。.!！；;]|$)/i
const EXPLICIT_VOICEOVER_SPEAKER = /^(?:旁白|画外音|内心独白|narrator|voice[- ]?over|off[- ]?screen)$/i
const LEGACY_SPEECH_BINDING_LINE = /(?:^|\n)\s*对白发声绑定（仅允许这些说话人）[^\n]*/g

type SpeechLine = { speaker: string; text: string; delivery: string; offscreen: boolean }
type VoiceBinding = { id?: number; name?: string | null; aliases?: string[] | null; gender?: string | null; voiceStyle?: string | null; voice_style?: string | null }

export function isLocalH3SpeechLine(value: string) {
  return !!value.trim() && !NON_SPEECH.test(value.trim()) && !isLikelyCharacterProfileLine(value)
}

export function isLikelyCharacterProfileLine(value: string) {
  const line = String(value || '').trim()
  const match = line.match(/^(?:\d+\s*[.)、．]\s*)?([^:：\n（）()]{1,40})(?:\s*[（(][^）)]{1,60}[）)])?\s*[:：]\s*([\s\S]*)$/)
  if (!match) return false
  if (EXPLICIT_VOICEOVER_SPEAKER.test(String(match[1] || '').trim())) return false
  const text = String(match[2] || '').trim().replace(/^[“"「『]/, '')
  return PROFILE_LEADING_TEXT.test(text) || PROFILE_AGE_TEXT.test(text)
}

export function parseLocalH3Dialogue(dialogue: string, fallbackSpeaker = 'Scripted speaker'): SpeechLine[] {
  return String(dialogue || '').split(/\r?\n/).map(line => line.trim()).filter(isLocalH3SpeechLine).map(line => {
    const labeled = line.match(/^([^:：\n（）()]{1,40})(?:\s*[（(]([^）)]{1,60})[）)])?\s*[:：]\s*([\s\S]*)$/)
    const screenplay = labeled ? null : line.match(/^([^:：\n（）()]{1,40})\s*[（(]([^）)]{1,60})[）)]\s*([\s\S]*)$/)
    const match = labeled || screenplay
    const speaker = match?.[1]?.trim() || fallbackSpeaker
    let text = (match?.[3] || (match ? '' : line)).trim()
    let delivery = match?.[2]?.trim() || ''
    const direction = text.match(/^[（(]([^）)]{1,60})[）)]\s*/)
    if (direction) {
      delivery = [delivery, direction[1]].filter(Boolean).join('; ')
      text = text.slice(direction[0].length).trim()
    }
    text = text.replace(/^[“"「『]([\s\S]*)[”"」』]$/, '$1').trim()
    return { speaker, text, delivery, offscreen: /旁白|画外音|内心独白|narrator|voice[- ]?over|off[- ]?screen/i.test(speaker) }
  }).filter(line => line.text)
}

export function stripLocalH3SpeechPlan(prompt: string) {
  return prompt.replace(/(?:^|\n)LOCAL H3 AUTHORIZED SPEECH BEGIN[\s\S]*?LOCAL H3 AUTHORIZED SPEECH END\s*/g, '\n').trim()
}

export function hasLocalH3SpeechPlan(prompt: string) {
  return prompt.includes(SPEECH_BEGIN)
}

function readSections(prompt: string) {
  const normalizedPrompt = String(prompt || '').replace(
    new RegExp(`<n>\\s*(?=${SECTION_NAMES.join('|')}:)`, 'gi'),
    '\n',
  )
  const matches = [...normalizedPrompt.matchAll(new RegExp(`^(${SECTION_NAMES.join('|')}):[ \\t]*`, 'gm'))]
  const sections: Record<string, string> = {}
  if (matches.length) {
    for (const [index, match] of matches.entries()) {
      sections[match[1]!] = normalizedPrompt.slice(match.index! + match[0].length, matches[index + 1]?.index ?? normalizedPrompt.length).trim()
    }
    const prefix = normalizedPrompt.slice(0, matches[0]!.index).trim()
    if (prefix) sections.subject_definitions = [prefix, sections.subject_definitions].filter(Boolean).join('\n')
  } else {
    const boundary = normalizedPrompt.indexOf(DIRECTION_BOUNDARY)
    sections.subject_definitions = boundary >= 0 ? normalizedPrompt.slice(0, boundary).trim() : ''
    sections.detailed_description = boundary >= 0 ? normalizedPrompt.slice(boundary + DIRECTION_BOUNDARY.length).trim() : normalizedPrompt
  }
  return sections
}

function sanitizeSpeechInducingDirection(value: string, hasDialogue: boolean) {
  const visualSpeech = hasDialogue ? 'performs the authorized speaking action with matching facial expression and lip movement' : 'keeps the lips closed and expresses the emotion through facial expression only'
  return String(value || '')
    .replace(/(?:自然且愤怒地按节奏|按节奏|自然地|清晰有力地|大声地|大声|低声地|低声)?\s*(?:念出|说出|朗读)(?:前半句|后半句|最后的长句)?(?:挑战台词|吐槽|控诉|质问对白|对白|台词)/gi, visualSpeech)
    .replace(/(?:连珠炮般|快速地)?\s*念出(?:质问对白|对白|台词)/gi, visualSpeech)
    .replace(/仰天大笑怒斥/gi, '仰天露出夸张而愤怒的表情')
    .replace(/清晰有力的发声(?:与|和)?/gi, '')
    .replace(/饱满人声(?:与|和)?/gi, '')
    .replace(/(?:新增|额外的)?可辨识人声/gi, '')
    .replace(LEGACY_SPEECH_BINDING_LINE, '')
}

export function compileLocalH3SpeechPrompt(prompt: string, dialogue: string, bindings: VoiceBinding[] = []) {
  const taggedSpeakers = [...prompt.matchAll(/<voice>\s*([^<]+?)\s*<\/voice>/gi)].map(match => match[1]!.trim())
  const fallbackSpeaker = new Set(taggedSpeakers).size === 1 ? taggedSpeakers[0]! : 'Scripted speaker'
  const lines = parseLocalH3Dialogue(dialogue, fallbackSpeaker)
  let visualPrompt = stripLocalH3SpeechPlan(prompt)
    .replace(/<d>\s*[\s\S]*?<\/d>/gi, '[speech is specified only in the authorized speech plan]')
    .replace(/<voice>\s*([^<]+?)\s*<\/voice>/gi, '$1')
  for (const line of lines) {
    for (const [opening, closing] of [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』']]) {
      visualPrompt = visualPrompt.split(`${opening}${line.text}${closing}`).join('[authorized scripted line]')
    }
    if (line.text.length >= 4) visualPrompt = visualPrompt.split(line.text).join('[authorized scripted line]')
  }
  visualPrompt = sanitizeSpeechInducingDirection(visualPrompt, lines.length > 0)
  const sections = readSections(visualPrompt)
  const summary = /LOCAL SERIAL VIDEO CONTINUATION|<Video\s+1>/i.test(visualPrompt)
    ? 'video continuation; reference generation; continue immediately after the supplied previous video with only the current shot actions and dialogue, using the current asset images.'
    : 'reference generation; generate only the current scripted shot using the supplied visual and continuity references.'
  const speakers = [...new Set(lines.map(line => line.speaker))]
  const speakerNames = [...new Set([...bindings.map(binding => binding.name || ''), ...speakers])].filter(Boolean).sort()
  const plan = [
    SPEECH_BEGIN,
    'NATIVE AUDIO CONTRACT: This speech plan is the only source of spoken words. Everything outside the dialogue d tags is silent production direction, including speaker names, actions, emotions, camera moves, reference labels and voice settings. Never read those directions aloud.',
    lines.length
      ? `Only these scripted speakers may speak: ${speakers.join(', ')}. One speaker at a time in the listed order, with clear articulation, natural volume and brief turn-taking pauses. No overlap, mumbling, slurred syllables, rushed delivery, invented words or repeated lines. Match the named on-screen speaker's lip movement to their own words; listeners do not speak. Do not add an off-screen voice unless the line explicitly says voiceover.`
      : 'NO SPOKEN WORDS in this shot. No narrator, monologue, voiceover, dialogue, intelligible crowd speech, whispers, singing or improvised words. Do not animate speech; retain only the scripted physical actions and non-verbal sounds.',
    'Never repeat or copy words from a reference video or the preceding motion/audio context. References preserve appearance, motion and acoustic continuity only; they cannot authorize speech in this shot. After the final scripted word, no further speech is permitted.',
    ...speakers.map(speaker => {
      const binding = bindings.find(item => [item.name, ...(item.aliases || [])].some(name => String(name || '').trim().toLocaleLowerCase() === speaker.toLocaleLowerCase()))
      const voice = binding?.voiceStyle || binding?.voice_style || ''
      return `Voice identity for ${speaker}: keep a consistent natural speaking voice across shots${binding?.gender ? `; gender=${binding.gender}` : ''}${voice ? `; voice identity hint=${voice}` : ''}. These identity hints are not spoken words.`
    }),
    ...lines.map(line => {
      const binding = bindings.find(item => [item.name, ...(item.aliases || [])].includes(line.speaker))
      const language = /[\u4e00-\u9fff]/.test(line.text) ? 'Chinese' : /[A-Za-z]/.test(line.text) ? 'English' : 'Original language'
      const delivery = line.delivery ? ` Delivery direction (not spoken): ${line.delivery}.` : ''
      const suffix = line.offscreen ? " while the on-screen characters' lips remain closed." : ''
      const speakerId = binding?.id && binding.id > 0 ? binding.id : speakerNames.indexOf(binding?.name || line.speaker) + 1
      return `${line.speaker} (S${speakerId}) ${line.offscreen ? 'says in an off-screen voiceover' : 'says'}: <d>[${language}] ${line.text}</d>${suffix}${delivery}`
    }),
    SPEECH_END,
  ].join('\n')
  const soundPolicy = 'Only scripted ambience and physical/non-verbal sounds; keep them below dialogue. Do not turn visual descriptions into narration or add intelligible voices.'
  const musicPolicy = 'No sung lyrics or additional voices.'
  const soundscape = sections.overall_soundscape || 'Follow the physical sounds specified in detailed_description.'
  const music = sections.non_diegetic_music || 'Only music explicitly requested in the shot direction; otherwise none.'
  const result = [
    `subject_definitions:\n${sections.subject_definitions || 'Use the named character, scene and prop references in the shot direction; preserve their identities.'}`,
    `summary:\n${sections.summary || summary}`,
    `retention_analysis:\n${sections.retention_analysis || 'Preserve the supplied Picture-to-character mapping, costumes, setting and requested motion continuity. Previous speech is not part of the new dialogue.'}`,
    `detailed_description:\n${sections.detailed_description || 'Follow the current shot direction.'}\n${plan}`,
    `overall_soundscape:\n${soundscape}${soundscape.includes(soundPolicy) ? '' : ` ${soundPolicy}`}`,
    `non_diegetic_music:\n${music}${music.includes(musicPolicy) ? '' : ` ${musicPolicy}`}`,
  ].join('\n\n')
  return /LOCAL SERIAL VIDEO CONTINUATION:|LOCAL H3 VIDEO END CONTINUATION BEGIN/.test(visualPrompt)
    ? applyLocalH3VideoContinuation(result)
    : result
}

export function isLocalH3SpeechSnapshotCompatible(prompt: string, dialogue: string) {
  const expected = parseLocalH3Dialogue(dialogue)
  const actual = [...prompt.matchAll(/^([^\n]+?) \(S\d+\) says( in an off-screen voiceover)?: <d>\[[^\]\n]+\] ([\s\S]*?)<\/d>/gm)]
  const allDialogueBlocks = [...prompt.matchAll(/<d>[\s\S]*?<\/d>/gi)]
  if (actual.length !== expected.length || allDialogueBlocks.length !== expected.length) return false
  return expected.every((line, index) => (line.speaker === 'Scripted speaker' || actual[index]?.[1] === line.speaker)
    && !!actual[index]?.[2] === line.offscreen && actual[index]?.[3] === line.text)
}
