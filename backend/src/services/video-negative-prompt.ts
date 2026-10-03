const VIDEO_NEGATIVE_BEGIN = '视频画面负面约束（自动注入 BEGIN）'
const VIDEO_NEGATIVE_END = '视频画面负面约束（自动注入 END）'

export const VIDEO_NEGATIVE_PROMPT = [
  VIDEO_NEGATIVE_BEGIN,
  '保持场景一致性、人物一致性、空间关系、光线方向、时间天气、色彩和镜头轴线连续；以下约束只限制模型擅自生成的错误，不覆盖剧本、对白、角色资产、场景资产、道具资产或已明确的声音规划。',
  '剧情与对白：禁止改动、漏掉、重复或翻译原台词；禁止说话人、听者、能力归属或动作主语错误；禁止把人物介绍、角色档案、动作说明或环境描述变成旁白；禁止新增剧本外人物、对白、冲突、剧情结果或结尾。',
  '人物与人脸：禁止变脸、换人、五官漂移、脸部变形、眼睛错位、瞳孔漂移、嘴型撕裂、口型与对白不同步、蜡像脸、塑料皮肤、过度磨皮、美颜感、假高光、死鱼眼、糊脸和低清人脸；保持角色资产中的脸型、发型、肤色、年龄感、体型、服装、配饰和瞳色不变。',
  '人体与动作：禁止手指错误、多手多脚、肢体畸变、肢体穿模、身体缠绕、关节反折、人物残影和不自然复制；禁止人物瞬移、无过程换位、反轴、换机位导致脚下锁点改变、远处人物突然贴脸。',
  '道具与状态：禁止武器凭空换手、道具消失或复制、道具尺寸和方向跳变、伤痕/血迹/衣物/环境破损重置；已建立的角色、道具、场景和破损状态必须跨帧、跨镜头连续。',
  '物理与表演：禁止假打、未接触却击中、无受力反馈、无重力漂浮、无惯性、无停顿连击、动作回弹错误、接触关系错误和不符合重量的运动；每个动作必须有连续过程、接触点和可见受力反应。',
  '特效：禁止能量凭空出现、特效无传播路径、贴纸光效、过曝遮脸、粒子无重力、特效穿身、特效遮挡关键表情和动作；特效必须有来源、方向、速度、遮挡关系和环境光反馈。',
  '摄影与画面：禁止乱晃、失焦、遮挡关键动作、无意义全景、无意义环绕、无意义空镜、无意义特写、突然跳切、构图漂移、脚下漂移、夜景黑糊、噪点、压缩伪影和过度锐化；禁止游戏 UI、动画感、漫画感、2.5D、3D 动漫、纯游戏 CG、抠图边、合成边和廉价 AI 海报感。',
  '声音：禁止气泡音效、卡通 boing、拟声贴纸音、未授权的人声、额外旁白、群众乱语、耳语、哼唱和重复台词；禁止模型擅自添加背景音乐，只有 bgm_prompt 明确要求的配乐才能保留；不得覆盖剧本对白、sound_effect、环境声和已配置的合法配乐。',
  '禁止字幕、水印、屏幕文字、乱码、品牌标识和血腥特写；不要把任何文字、UI 或声音提示直接可视化到画面中。',
  VIDEO_NEGATIVE_END,
].join('\n')

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function stripVideoNegativePrompt(prompt: string | null | undefined) {
  return String(prompt || '')
    .replace(
      new RegExp(`(?:^|\\n)${escapeRegExp(VIDEO_NEGATIVE_BEGIN)}[\\s\\S]*?${escapeRegExp(VIDEO_NEGATIVE_END)}\\s*`, 'g'),
      '\n',
    )
    .trim()
}

export function appendVideoNegativePrompt(prompt: string | null | undefined) {
  const basePrompt = stripVideoNegativePrompt(prompt)
  return [basePrompt, VIDEO_NEGATIVE_PROMPT].filter(Boolean).join('\n')
}
