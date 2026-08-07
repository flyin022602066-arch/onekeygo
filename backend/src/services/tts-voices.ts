export type DefaultTTSVoice = {
  id: string
  name: string
  gender: 'male' | 'female' | 'neutral'
  language: string
  traits: string
  suitable: string
}
export const DEFAULT_MINIMAX_VOICES: DefaultTTSVoice[] = [
  { id: 'male-qn-qingse', name: '青涩青年音色', gender: 'male', language: '中文', traits: '年轻、清澈、自然', suitable: '年轻男主、少年感角色' },
  { id: 'male-qn-jingying', name: '精英青年音色', gender: 'male', language: '中文', traits: '沉稳、干练、清晰', suitable: '都市男主、精英、叙事男声' },
  { id: 'male-qn-badao', name: '霸道青年音色', gender: 'male', language: '中文', traits: '强势、低沉、有压迫感', suitable: '霸总、反派、权势角色' },
  { id: 'male-qn-daxuesheng', name: '青年大学生音色', gender: 'male', language: '中文', traits: '阳光、年轻、生活化', suitable: '学生、邻家男孩、轻松男声' },
  { id: 'female-shaonv', name: '少女音色', gender: 'female', language: '中文', traits: '清亮、年轻、灵动', suitable: '少女、女主、年轻配角' },
  { id: 'female-yujie', name: '御姐音色', gender: 'female', language: '中文', traits: '成熟、冷静、有气场', suitable: '女强人、御姐、反派女性' },
  { id: 'female-chengshu', name: '成熟女性音色', gender: 'female', language: '中文', traits: '温和、稳重、可信', suitable: '母亲、成熟女主、旁白' },
  { id: 'female-tianmei', name: '甜美女性音色', gender: 'female', language: '中文', traits: '甜润、亲和、轻快', suitable: '甜美女主、温柔女性、轻喜角色' },
]

const LEGACY_OPENAI_VOICE_MAP: Record<string, string> = {
  alloy: 'male-qn-jingying',
  echo: 'male-qn-badao',
  fable: 'male-qn-qingse',
  onyx: 'male-qn-badao',
  nova: 'female-tianmei',
  shimmer: 'female-shaonv',
}

export function isMinimaxLikeTTSProvider(provider?: string | null) {
  return ['minimax', 'eggfans'].includes(String(provider || '').toLowerCase())
}

export function normalizeTTSVoiceForProvider(voice: string, provider?: string | null) {
  const raw = String(voice || '').trim()
  if (!isMinimaxLikeTTSProvider(provider)) return raw || 'alloy'
  const key = raw.toLowerCase()
  return LEGACY_OPENAI_VOICE_MAP[key] || raw || DEFAULT_MINIMAX_VOICES[0].id
}
