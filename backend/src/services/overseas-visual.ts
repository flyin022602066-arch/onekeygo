export type OverseasVisualMode = string | null | undefined

export function isTkOverseasMode(value: unknown): boolean {
  return String(value || '').trim().toLowerCase() === 'tk_overseas'
}

/**
 * TK overseas scripts may contain an English canonical line followed by a
 * Chinese translation in parentheses.  Keep the canonical dialogue intact
 * across rewriting, extraction, and storyboard generation.
 */
export function buildTkEnglishDialogueLock() {
  return [
    'TK ENGLISH DIALOGUE LOCK:',
    '- Treat every English speaker line and quoted English sentence in the source script as canonical dialogue.',
    '- Preserve English dialogue verbatim: speaker name, casing, punctuation, quotation marks, contractions, and word order.',
    '- Do not translate, rewrite, summarize, paraphrase, or replace English dialogue with Chinese.',
    '- Chinese text in parentheses after an English line is translation or acting guidance only; keep it out of dialogue.',
  ].join('\n')
}

export function buildTkOverseasVisualLock(purpose = '当前资产与镜头') {
  return [
    `TK 海外剧视觉锁定（${purpose}）：默认采用欧美/国际真人影视的选角与美术设计。`,
    '角色默认使用非东亚面孔、欧美或国际化真人影视演员气质；不要根据中文姓名、翻译文本或模型默认倾向生成东方五官、东亚发型或中式服饰。剧本明确指定的民族、地域、人物外貌和服装优先于默认规则。',
    '场景默认使用欧美或国际化影视环境，建筑、室内设计、街道、标识和陈设避免中国或东亚地域符号；剧本明确指定的地点和文化元素优先保留。',
    '角色和场景资产必须与本项目后续视频保持同一地域审美，不得在不同镜头之间发生东方化、地域漂移或重新选角。',
  ].join('\n')
}

export function withTkOverseasVisualLock(
  prompt: string | null | undefined,
  mode: OverseasVisualMode,
  purpose = '当前资产与镜头',
) {
  const base = stripTkOverseasVisualLock(String(prompt || '').trim())
  return isTkOverseasMode(mode)
    ? [base, buildTkOverseasVisualLock(purpose)].filter(Boolean).join('\n')
    : base
}

export function stripTkOverseasVisualLock(prompt: string | null | undefined) {
  const lines = String(prompt || '').split(/\r?\n/)
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*TK 海外剧视觉锁定（/.test(lines[index] || '')) {
      index += 3
      continue
    }
    kept.push(lines[index])
  }
  return kept.join('\n').trim()
}
