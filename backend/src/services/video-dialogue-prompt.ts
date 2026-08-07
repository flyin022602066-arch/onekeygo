import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { isTkOverseasMode } from './overseas-visual.js'

const DIALOGUE_BEGIN = '视频对白约束（自动注入 BEGIN）'
const DIALOGUE_END = '视频对白约束（自动注入 END）'
const EMPTY_DIALOGUE = /^(?:无|无对白|无台词|无旁白|无需配音|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音乐|bgm|sfx|ambient|none|null|n\/a|na)$/i

export function normalizeVideoDialogue(dialogue: string | null | undefined, breakdownMode?: string | null) {
  const value = String(dialogue || '').trim()
  if (!value || EMPTY_DIALOGUE.test(value)) return ''
  if (!isTkOverseasMode(breakdownMode)) return value

  return value
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

export function appendVideoDialoguePrompt(
  prompt: string | null | undefined,
  dialogue: string | null | undefined,
  breakdownMode?: string | null,
) {
  const basePrompt = stripInjectedVideoDialogue(String(prompt || '').trim())
  const normalizedDialogue = normalizeVideoDialogue(dialogue, breakdownMode)
  if (!normalizedDialogue) return basePrompt

  const overseas = isTkOverseasMode(breakdownMode)
  const lines = overseas
    ? [
      DIALOGUE_BEGIN,
      '本镜头必须使用以下英文对白原文，仅使用英文发声：',
      normalizedDialogue,
      '对白语言：English。说话人必须与原文一致并按原文顺序说出；禁止翻译成中文、改写、省略或添加剧本外对白，禁止错配说话人。',
      DIALOGUE_END,
    ]
    : [
      DIALOGUE_BEGIN,
      '本镜头必须使用以下对白/旁白原文：',
      normalizedDialogue,
      '对白或旁白必须按原文表达；不得省略、翻译、改写或添加剧本外内容，禁止错配说话人。',
      DIALOGUE_END,
    ]

  return [basePrompt, lines.join('\n')].filter(Boolean).join('\n')
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
) {
  const context = getStoryboardVideoDialogue(storyboardId)
  return appendVideoDialoguePrompt(
    prompt,
    context.dialogue,
    breakdownMode || context.breakdownMode,
  )
}

export function hasInjectedVideoDialogue(prompt: string | null | undefined) {
  return String(prompt || '').includes(DIALOGUE_BEGIN)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
