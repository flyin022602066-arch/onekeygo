import { buildVisualStyleLock } from './visual-style.js'
import { buildTkOverseasVisualLock, isTkOverseasMode } from './overseas-visual.js'

const HUMAN_SCENE_PATTERN = /(?:人物|角色|男人|女人|男性|女性|男孩|女孩|少年|少女|老人|儿童|人群|路人|行人|客人|顾客|保安|服务员|工作人员|演员|模特|人影|身影|剪影|人像|肖像|面孔|脸部|眼神|手臂|手腕|身体|服装|穿着|鲜血|伤口|对白|交谈|拥抱|打斗|坐在|站在|躺在|走进|走出|推门|挽着|手捧|撕毁|拿起|照片|合影|自拍)/

export interface SceneAssetPromptInput {
  location?: string | null
  time?: string | null
  prompt?: string | null
  characterNames?: string[]
  style?: string | null
  breakdownMode?: string | null
}

export function normalizeSceneEnvironmentDescription(
  value: string | null | undefined,
  characterNames: string[] = [],
) {
  const names = characterNames.map(name => String(name || '').trim()).filter(Boolean)
  const clauses = String(value || '')
    .replace(/\r/g, '\n')
    .split(/[。！？；;，,\n]+/)
    .map(clause => clause.trim().replace(/^[，、,:：\s]+|[，、,:：\s]+$/g, ''))
    .filter(Boolean)

  const environmentClauses = clauses.filter((clause) => {
    if (names.some(name => clause.includes(name))) return false
    return !HUMAN_SCENE_PATTERN.test(clause)
  })

  return environmentClauses.join('。')
}

export function buildSceneAssetPrompt(input: SceneAssetPromptInput) {
  const location = String(input.location || '').trim() || '未命名场景'
  const time = String(input.time || '').trim()
  const environment = normalizeSceneEnvironmentDescription(input.prompt, input.characterNames)
  const description = environment || [location, time].filter(Boolean).join('，')

  return [
    '请生成一张用于影视制作的纯场景资产参考图，只表现环境本身。',
    `场景地点：${location}。`,
    time ? `时间与光线：${time}。` : '',
    `环境描述：${description}。`,
    isTkOverseasMode(input.breakdownMode) ? buildTkOverseasVisualLock('纯场景资产与串行视频') : '',
    isTkOverseasMode(input.breakdownMode) ? '场景资产仍然必须是无人纯环境；默认使用欧美或国际化空间与建筑审美，禁止用东方人物或东方地域符号填充画面。剧本明确地点优先。' : '',
    '硬性要求：画面中绝对不能出现任何人物、人体、脸、手、背影、人影、剪影、人群、角色或生物主体。',
    '禁止通过镜子、玻璃反射、照片、画像、海报、电视、电脑或手机屏幕间接出现人物。',
    '只保留建筑、空间结构、道路、家具、陈设、道具、自然环境、天气、光线、色调和氛围。',
    buildVisualStyleLock(input.style, '场景资产与后续分镜'),
    '画幅 16:9，广角环境建立镜头，构图完整，材质与光影严格服从项目视觉风格，适合作为后续视频生成的固定场景参考资产。',
  ].filter(Boolean).join('\n')
}
