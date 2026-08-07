const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i
const NARRATOR_SPEAKER = /^(旁白|画外音|narrator)$/i

export type DialogueSegment = {
  speaker: string
  text: string
}
export type DialogueTTSSegment = DialogueSegment & {
  voice: string
}

type CharacterVoice = {
  name?: string | null
  voiceStyle?: string | null
  voice_style?: string | null
}

export function parseDialogueForTTS(dialogue?: string | null) {
  const raw = dialogue?.trim() || ''
  if (!raw) {
    return { speaker: '', pureText: '', subtitleText: '', segments: [] as DialogueSegment[], ignorable: true }
  }

  const segments = splitDialogue(raw)
    .map(segment => ({
      speaker: cleanSpeaker(segment.speaker),
      text: cleanText(segment.text),
    }))
    .filter(segment => segment.text && !isIgnorableSegment(segment))

  const pureText = segments.map(segment => segment.text).join('\n')
  const subtitleText = segments.map(formatSubtitleSegment).join('\n')

  return {
    speaker: segments[0]?.speaker || '',
    pureText,
    subtitleText,
    segments,
    ignorable: !segments.length || !pureText,
  }
}

export function buildDialogueTTSSegments(
  dialogue: string | null | undefined,
  characters: CharacterVoice[] = [],
  defaultVoice = 'alloy',
): DialogueTTSSegment[] {
  const parsed = parseDialogueForTTS(dialogue)
  if (parsed.ignorable) return []

  return parsed.segments.map(segment => ({
    ...segment,
    voice: resolveSegmentVoice(segment.speaker, characters, defaultVoice),
  }))
}

function splitDialogue(raw: string): DialogueSegment[] {
  const matches = [...raw.matchAll(/(?:^|\n)\s*([^：:\n]{1,40})[：:]\s*/g)]
  if (!matches.length) return [{ speaker: '', text: raw }]

  return matches.map((match, index) => {
    const next = matches[index + 1]
    const textStart = (match.index || 0) + match[0].length
    const textEnd = next?.index ?? raw.length
    return {
      speaker: match[1] || '',
      text: raw.slice(textStart, textEnd),
    }
  })
}

function cleanSpeaker(value: string) {
  return String(value || '')
    .replace(/[（(].*?[)）]/g, '')
    .trim()
}

function cleanText(value: string) {
  return String(value || '')
    .replace(/[（(].*?[)）]/g, '')
    .trim()
}

function isIgnorableSegment(segment: DialogueSegment) {
  if (segment.speaker && IGNORE_TTS_SPEAKERS.test(segment.speaker)) return true
  if (!segment.text) return true
  return IGNORE_TTS_TEXT.test(segment.text)
}

function formatSubtitleSegment(segment: DialogueSegment) {
  return segment.speaker ? `${segment.speaker}：${segment.text}` : segment.text
}

function resolveSegmentVoice(speaker: string, characters: CharacterVoice[], defaultVoice: string) {
  if (!speaker || NARRATOR_SPEAKER.test(speaker)) return defaultVoice
  const found = characters.find(char => String(char.name || '').trim() === speaker)
  return found?.voiceStyle || found?.voice_style || defaultVoice
}
