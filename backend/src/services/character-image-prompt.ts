import { buildPhotorealisticImageDetailLock, buildVisualStyleLock } from './visual-style.js'
import { buildTkOverseasVisualLock, isTkOverseasMode } from './overseas-visual.js'

type CharacterPromptInput = {
  name?: string | null
  role?: string | null
  appearance?: string | null
  description?: string | null
  personality?: string | null
  style?: string | null
  breakdownMode?: string | null
}

function cleanText(value?: string | null) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function buildCharacterDesignPrompt(character: CharacterPromptInput) {
  const name = cleanText(character.name) || '未命名角色'
  const role = cleanText(character.role)
  const appearance = cleanText(character.appearance || character.description) || '根据角色设定生成稳定人物外形'
  const description = cleanText(character.description)
  const personality = cleanText(character.personality)

  return [
    `请生成角色「${name}」的横版角色资产设定图，画幅 16:9，适合后续作为视频模型角色参考资产。`,
    `角色定位：${[role, description].filter(Boolean).join('，') || '短剧角色'}。`,
    `固定人物设定：${appearance}。${personality ? `性格气质：${personality}。` : ''}`,
    isTkOverseasMode(character.breakdownMode) ? buildTkOverseasVisualLock('角色设定资产与串行视频') : '',
    isTkOverseasMode(character.breakdownMode) ? '角色资产只允许一个明确的国际真人角色，不要输出东亚默认脸或将角色改成东方人；如果剧本明确指定民族或地域，按剧本设定执行。' : '',
    '画面结构：同一张横版图片中从左到右只允许清晰排布四个分区；第1区在最左侧，是人物上半身照/胸像肖像；第2区是正面全身站姿；第3区是侧面全身站姿，只允许一个侧面，禁止左右两个侧面；第4区是背面全身站姿。',
    '数量限制：整张图只允许 1 张人物上半身照 + 3 张全身三视图，总计四个角色呈现；禁止第五视图、第六视图、额外面板、额外人物、额外头像、额外半身像、动作表情格。',
    '视角限制：三视图只包含正面、一个侧面、背面；禁止四分之三视角、斜侧面、左右双侧面、俯视、仰视、镜像复制、额外视角或多余角度。',
    '一致性要求：四个分区必须是同一个角色，五官、发型、年龄、体型、肤色、固定服装、配饰完全一致；服装要清楚完整，不能随镜头或剧情变化。',
    '资产可用性：纯角色设定稿，干净浅色背景或透明感影棚背景，均匀光照，不要生成剧情场景，不要复杂场景，不要多人，不要剧情动作，不要电影剧照，不要夸张姿势，不要文字标签，不要水印。',
    buildVisualStyleLock(character.style, '角色资产与后续分镜'),
    buildPhotorealisticImageDetailLock(character.style, '角色资产与后续分镜'),
    '输出目标：让后续 Seedance 2.0 只通过这张图就能稳定参考角色外貌、固定服装和项目画风。',
  ].filter(Boolean).join('\n')
}
