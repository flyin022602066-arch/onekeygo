import { buildPhotorealisticImageDetailLock, withVisualStyleLock } from './visual-style.js'
import { withTkOverseasVisualLock } from './overseas-visual.js'

export type StoryboardImageReferenceType =
  | 'scene'
  | 'character'
  | 'character_reference'
  | 'storyboard_reference'
  | 'continuity'
  | 'manual'

export interface StoryboardImageReference {
  type: StoryboardImageReferenceType
  label: string
  url: string
}

type StoryboardImageReferenceInput = {
  frameType?: string | null
  storyboard?: Record<string, any> | null
  scene?: Record<string, any> | null
  characters?: Record<string, any>[]
  requestReferences?: string[]
  maxReferences?: number
}

type StoryboardImagePromptInput = {
  basePrompt?: string | null
  visualStyle?: string | null
  frameType?: string | null
  storyboard?: Record<string, any> | null
  scene?: Record<string, any> | null
  characters?: Record<string, any>[]
  references?: StoryboardImageReference[]
  breakdownMode?: string | null
}

export function buildStoryboardImageReferences(input: StoryboardImageReferenceInput): StoryboardImageReference[] {
  const refs: StoryboardImageReference[] = []
  const seen = new Set<string>()
  const frameType = input.frameType || 'first_frame'
  const maxReferences = input.maxReferences ?? 10
  const storyboard = input.storyboard || {}
  const excluded = new Set<string>()

  if (frameType === 'first_frame') addExcluded(excluded, field(storyboard, 'firstFrameImage', 'first_frame_image'))
  if (frameType === 'last_frame') addExcluded(excluded, field(storyboard, 'lastFrameImage', 'last_frame_image'))

  const push = (type: StoryboardImageReferenceType, label: string, value: unknown) => {
    const url = cleanImageUrl(value)
    if (!url || excluded.has(url) || seen.has(url) || refs.length >= maxReferences) return
    seen.add(url)
    refs.push({ type, label: label || referenceTypeLabel(type), url })
  }

  const scene = input.scene || null
  if (scene) {
    const sceneLabel = [field(scene, 'location'), field(scene, 'time')].filter(Boolean).join(' · ')
    push('scene', sceneLabel || '绑定场景', field(scene, 'imageUrl', 'image_url', 'localPath', 'local_path'))
  }

  for (const character of input.characters || []) {
    const name = String(field(character, 'name') || '绑定角色')
    push('character', name, field(character, 'imageUrl', 'image_url', 'localPath', 'local_path'))
    for (const image of parseImageList(field(character, 'referenceImages', 'reference_images'))) {
      push('character_reference', name, image)
    }
  }

  for (const image of parseImageList(field(storyboard, 'referenceImages', 'reference_images'))) {
    push('storyboard_reference', '镜头参考图', image)
  }

  if (frameType === 'last_frame') {
    push('continuity', '首帧连续性参考', field(storyboard, 'firstFrameImage', 'first_frame_image'))
  }

  for (const image of input.requestReferences || []) {
    push('manual', '请求附加参考图', image)
  }

  return refs
}

export function buildStoryboardImagePrompt(input: StoryboardImagePromptInput): string {
  const storyboard = input.storyboard || {}
  const scene = input.scene || null
  const characters = input.characters || []
  const references = input.references || []
  const frameType = input.frameType || 'first_frame'
  const frameLabel = frameType === 'last_frame' ? '尾帧' : '首帧'
  const basePrompt = String(input.basePrompt || '').trim()
  const imagePrompt = String(field(storyboard, 'imagePrompt', 'image_prompt') || '').trim()
  const description = String(field(storyboard, 'description') || '').trim()
  const action = String(field(storyboard, 'action') || '').trim()
  const result = String(field(storyboard, 'result') || '').trim()
  const atmosphere = String(field(storyboard, 'atmosphere') || '').trim()
  const dialogue = String(field(storyboard, 'dialogue') || '').trim()
  const sceneText = scene
    ? [field(scene, 'location'), field(scene, 'time'), field(scene, 'prompt')]
      .filter(Boolean)
      .join('；')
    : [field(storyboard, 'location'), field(storyboard, 'time')].filter(Boolean).join('；')
  const characterText = characters
    .map((character) => {
      const name = String(field(character, 'name') || '').trim()
      const appearance = String(field(character, 'appearance') || field(character, 'description') || '').trim()
      return [name, appearance].filter(Boolean).join('：')
    })
    .filter(Boolean)
    .join('；')

  const prompt = [
    `请生成短剧分镜${frameLabel}。必须严格依据镜头信息、角色设定、场景设定和参考图，不要生成与镜头信息无关的画面。`,
    basePrompt ? `当前生成提示词：${basePrompt}` : '',
    imagePrompt && imagePrompt !== basePrompt ? `静态画面提示词：${imagePrompt}` : '',
    field(storyboard, 'title') ? `镜头标题：${field(storyboard, 'title')}` : '',
    description ? `画面描述：${description}` : '',
    [field(storyboard, 'shotType', 'shot_type'), field(storyboard, 'angle'), field(storyboard, 'movement')]
      .filter(Boolean).length
      ? `镜头结构：${[
        field(storyboard, 'shotType', 'shot_type') ? `景别=${field(storyboard, 'shotType', 'shot_type')}` : '',
        field(storyboard, 'angle') ? `机位=${field(storyboard, 'angle')}` : '',
        field(storyboard, 'movement') ? `运镜=${field(storyboard, 'movement')}` : '',
      ].filter(Boolean).join('，')}`
      : '',
    sceneText ? `场景设定：${sceneText}` : '',
    characterText ? `角色设定：${characterText}` : '',
    action ? `动作：${action}` : '',
    result ? `结果：${result}` : '',
    atmosphere ? `氛围：${atmosphere}` : '',
    dialogue ? `对白/旁白：${dialogue}` : '',
    references.length ? `参考图使用说明：${references.map(formatReferenceInstruction).join('；')}` : '',
    frameType === 'last_frame'
      ? '输出要求：生成这个镜头动作结束后的关键画面，保留角色身份、服装、场景光线和剧情结果。'
      : '输出要求：生成这个镜头开始时的关键画面，保留角色身份、服装、场景光线和动作起点。',
  ].filter(Boolean).join('\n')
  return withTkOverseasVisualLock(
    [
      withVisualStyleLock(prompt, input.visualStyle, `分镜${frameLabel}最终出图`),
      buildPhotorealisticImageDetailLock(input.visualStyle, `分镜${frameLabel}最终出图`),
    ].filter(Boolean).join('\n'),
    input.breakdownMode,
    `分镜${frameLabel}最终出图`,
  )
}

function formatReferenceInstruction(reference: StoryboardImageReference, index: number) {
  const number = `第${index + 1}张`
  if (reference.type === 'scene') return `${number}为场景参考图「${reference.label}」，参考空间布局、光线、氛围和环境元素`
  if (reference.type === 'character') return `${number}为角色参考图「${reference.label}」，必须参考人物五官、发型、服装、体态和身份一致性`
  if (reference.type === 'character_reference') return `${number}为角色补充参考图「${reference.label}」，用于加强人物一致性`
  if (reference.type === 'continuity') return `${number}为首帧连续性参考，尾帧需与其保持角色、场景和运动方向连贯`
  if (reference.type === 'storyboard_reference') return `${number}为镜头附加参考图，用于构图、道具或局部视觉一致性`
  return `${number}为请求附加参考图，仅作为辅助参考`
}

function field(record: Record<string, any> | null | undefined, ...keys: string[]) {
  if (!record) return undefined
  for (const key of keys) {
    if (record[key] != null && record[key] !== '') return record[key]
  }
  return undefined
}

function parseImageList(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : []
  } catch {
    return [trimmed]
  }
}

function cleanImageUrl(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/^\/+static\//, 'static/')
}

function addExcluded(excluded: Set<string>, value: unknown) {
  const url = cleanImageUrl(value)
  if (url) excluded.add(url)
}

function referenceTypeLabel(type: StoryboardImageReferenceType) {
  const labels: Record<StoryboardImageReferenceType, string> = {
    scene: '绑定场景',
    character: '绑定角色',
    character_reference: '角色补充参考',
    storyboard_reference: '镜头参考图',
    continuity: '连续性参考',
    manual: '请求附加参考图',
  }
  return labels[type]
}
