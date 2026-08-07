export type VisualStyleSpec = {
  value: string
  label: string
  positive: string
  negative: string
}

const STYLE_SPECS: Record<string, VisualStyleSpec> = {
  realistic: {
    value: 'realistic',
    label: '写实真人',
    positive: '写实真人电影风格，photorealistic live-action，真实人体比例，真实皮肤纹理、发丝和布料材质；未经美颜处理的自然皮肤，清晰可见的毛孔、细纹、肤色细微不均、真实皮肤瑕疵和局部油光，汗水、湿润表面、布料纤维和磨损材质真实可辨，物理可信的三点布光与环境光，真实镜头光学、自然景深、准确曝光和克制的电影调色',
    negative: '严禁 3D 渲染、CGI、严禁美颜、磨皮、空气刷皮肤、蜡像脸、塑料皮肤、完美无瑕皮肤、过度锐化、过度HDR、假高光、卡通、动漫、插画、游戏角色、虚拟人、低多边形或玩具质感',
  },
  anime: {
    value: 'anime',
    label: '二维动漫',
    positive: '二维动画电影风格，清晰线稿，稳定角色设计，平面绘制质感，层次明确的动画光影和色彩',
    negative: '严禁写实真人皮肤、摄影棚人像、3D 渲染、CGI、塑料模型质感或写实照片质感',
  },
  ghibli: {
    value: 'ghibli',
    label: '手绘动画',
    positive: '高质量手绘动画电影风格，细腻背景绘制，柔和自然光，温暖通透的手工绘画质感，角色造型稳定',
    negative: '严禁 3D 渲染、CGI、塑料模型、写实照片、游戏角色或金属材质质感',
  },
  cinematic: {
    value: 'cinematic',
    label: '电影感真人',
    positive: '电影级真人摄影风格，photorealistic live-action，专业摄影机与真实镜头成像，真实人体比例，真实皮肤纹理、发丝和布料材质；保留毛孔、细纹、肤色不均、轻微瑕疵和自然油光的未经美颜皮肤，真实发丝、汗水、湿润反光、布料纤维与环境材质，方向明确的主光、柔和补光、可控轮廓光和真实反射，准确曝光、自然高光滚降、真实阴影层次、自然景深与克制电影调色',
    negative: '严禁 3D 渲染、CGI、严禁美颜、磨皮、空气刷、蜡像脸、塑料皮肤、完美无瑕皮肤、假高光、过度HDR、过度锐化、卡通、动漫、插画、游戏角色、虚拟人或塑料质感',
  },
  comic: {
    value: 'comic',
    label: '漫画',
    positive: '高质量漫画绘制风格，清晰轮廓线，稳定角色造型，分明明暗和有控制的漫画色彩',
    negative: '严禁 3D 渲染、CGI、照片写实、塑料模型或无关的真实摄影质感',
  },
  watercolor: {
    value: 'watercolor',
    label: '水彩',
    positive: '高质量电影感水彩绘画风格，透明水彩晕染，纸张和笔触质感，柔和自然的色彩层次',
    negative: '严禁 3D 渲染、CGI、塑料模型、照片写实或游戏美术质感',
  },
}

export function getVisualStyleSpec(value?: string | null): VisualStyleSpec {
  const raw = String(value || '').trim().toLowerCase()
  if (STYLE_SPECS[raw]) return STYLE_SPECS[raw]

  const match = Object.values(STYLE_SPECS).find(spec => spec.label.toLowerCase() === raw)
  return match || STYLE_SPECS.realistic
}

export function buildVisualStyleLock(value?: string | null, purpose = '当前镜头') {
  const spec = getVisualStyleSpec(value)
  return `视觉风格锁定（${purpose}，项目风格=${spec.label}）：${spec.positive}。${spec.negative}。同一项目所有镜头必须保持这一风格，不得发生画风漂移。`
}

export function buildPhotorealisticImageDetailLock(value?: string | null, purpose = '首帧与分镜静态画面') {
  const spec = getVisualStyleSpec(value)
  if (!['realistic', 'cinematic'].includes(spec.value)) return ''
  return [
    `摄影级写实细节锁定（${purpose}）：人物必须呈现真实摄影而非 AI 美颜效果。`,
    '输出规格：按接口支持的最高原生画布输出 4K UHD，横版 3840x2160、16:9 构图，high quality；不要用低分辨率画布放大冒充 4K，不要生成带边框、海报排版或拼贴版式。',
    '如画面包含人物，皮肤必须保留自然毛孔、细小细纹、轻微色素不均、雀斑或皮肤瑕疵、局部油光与真实肤色变化；不要磨皮、不要美颜、不要塑料皮肤、不要蜡像脸、不要把人物处理成完美无瑕的商业海报模特。',
    '使用真实影视摄影逻辑：主光方向明确；全画幅电影摄影机，35mm 或 50mm 电影镜头，主光从画面左前方约 45° 入射并高于人物视线约 30°，柔和但有方向性；右前方只保留约 1:4 强度的低强度补光，人物后上方约 120° 设置克制的轮廓光，环境反射光自然补足阴影，不要无方向平光。',
    '默认电影光色：主光约 4300K 中性偏暖，补光约 5600K 的冷中性环境光，轮廓光比主光低 1 至 1.5 档；根据场景时间调整色温，日光约 5600K，黄昏约 3200K 至 4300K，夜景月光约 6500K 并保留 2800K 至 3200K 的室内实用光源。',
    '保留高光滚降、暗部层次、反射光和空气透视，阴影必须有细节且落点符合光源方向；禁止假 HDR、过曝光晕、不合物理的发光、死黑阴影或一键套滤镜。',
    '细节优先落在眼睛湿润感、皮肤微结构、发丝边缘、嘴唇纹理、手部关节、衣物纤维、汗水或水滴与环境材质；真实镜头景深和自然运动瞬间，不要过度锐化。',
    '负面限制：不要低清、模糊、噪点、压缩伪影、过度锐化、AI 海报感、网红美颜、磨皮、塑料皮肤、蜡像脸、完美无瑕皮肤或 3D/CGI 渲染。',
  ].join('\n')
}

export function withVisualStyleLock(prompt: string | null | undefined, value?: string | null, purpose = '当前镜头') {
  const lines = String(prompt || '')
    .split(/\r?\n/)
    .filter(line => !/^视觉风格锁定（/.test(line.trim()))
  return [...lines, buildVisualStyleLock(value, purpose)].filter(Boolean).join('\n')
}
