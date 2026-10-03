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
  documentary: {
    value: 'documentary',
    label: '纪录片纪实',
    positive: '纪录片纪实摄影风格，真实自然光与现场光源，克制的调色和手持摄影质感，保留环境细节、真实肤质与生活化状态，像专业纪录片的观察式镜头',
    negative: '严禁棚拍摆拍感、过度磨皮、美颜、塑料皮肤、假 HDR、过饱和、3D 渲染、CGI、动漫或插画风格',
  },
  commercial: {
    value: 'commercial',
    label: '商业广告',
    positive: '高端商业广告视觉，精确布光与产品级构图，干净背景，质感清晰，色彩经过专业品牌调色，画面具有高级广告片的视觉冲击力，同时保持真实摄影材质',
    negative: '严禁低俗网红滤镜、过度磨皮、塑料质感、杂乱背景、过曝、假 HDR、3D 卡通或廉价电商海报排版',
  },
  film_noir: {
    value: 'film_noir',
    label: '黑色电影',
    positive: '经典黑色电影摄影风格，高反差黑白或低饱和色调，强烈侧光与百叶窗光影，深沉阴影、湿润街面反射、压迫感构图和悬疑氛围，真实电影摄影质感',
    negative: '严禁平光、糖果色、明亮广告感、过度锐化、3D 渲染、动漫、插画或游戏美术风格',
  },
  vintage_film: {
    value: 'vintage_film',
    label: '复古胶片',
    positive: '复古胶片电影风格，真实胶片颗粒、柔和高光、轻微色彩偏移与自然暗角，具有年代感的服化道和克制的模拟胶片调色，保持真实摄影材质',
    negative: '严禁数字塑料感、过度颗粒、脏污划痕遮挡主体、过度褪色、3D 渲染、动漫或插画风格',
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
  ink_wash: {
    value: 'ink_wash',
    label: '国风水墨',
    positive: '中国水墨画与现代国风插画融合风格，墨色浓淡、留白、宣纸纤维和自然笔触清晰可见，东方构图与写意光影，角色和场景造型稳定统一',
    negative: '严禁照片写实、3D 渲染、CGI、塑料材质、西式卡通或杂乱文字排版',
  },
  '3d_animation': {
    value: '3d_animation',
    label: '3D动画',
    positive: '高质量 3D 动画电影风格，精致可信的三维角色与场景建模，柔和全局光照、物理材质、细腻毛发与布料、电影级镜头和统一的动画美术设计',
    negative: '严禁低多边形、贴图拉伸、塑料玩具感、廉价游戏截图、写实真人照片、文字或水印',
  },
  stop_motion: {
    value: 'stop_motion',
    label: '定格动画',
    positive: '专业定格动画电影风格，可见手工制作的微妙纹理、布料、黏土或木偶材质，真实微缩摄影棚光线，逐帧动画的温度与稳定角色造型',
    negative: '严禁平滑 CGI 感、照片写实、廉价玩具摆拍、材质模糊、动漫线稿或文字水印',
  },
  oriental_period: {
    value: 'oriental_period',
    label: '东方古风',
    positive: '东方古装影视美术风格，考据可信的传统服饰、建筑、器物与纹样，层次丰富的自然光和烛火光，含蓄克制的东方色彩与电影构图，真实材质细节',
    negative: '严禁现代服装和建筑、错误时代道具、塑料廉价戏服、3D 卡通、动漫或西式奇幻元素',
  },
  fantasy_epic: {
    value: 'fantasy_epic',
    label: '奇幻史诗',
    positive: '电影级奇幻史诗视觉，宏大而可信的世界观环境，层次化雾气、体积光、自然材质和精确尺度，具有史诗叙事的色彩设计与真实镜头语言',
    negative: '严禁廉价游戏海报、过度发光、塑料盔甲、画面堆砌、文字水印或卡通贴纸感',
  },
  sci_fi: {
    value: 'sci_fi',
    label: '科幻未来',
    positive: '高质量科幻电影视觉，可信的未来科技、工业设计和空间尺度，冷峻但有层次的光色，真实金属、玻璃、织物与体积雾，专业电影摄影和统一美术设定',
    negative: '严禁随机乱码文字、廉价霓虹、过度镜面反光、低多边形、动漫或游戏 UI 截图风格',
  },
  cyberpunk: {
    value: 'cyberpunk',
    label: '赛博朋克',
    positive: '高质感赛博朋克电影视觉，潮湿城市、霓虹色温对比、真实反射和体积雾，工业管线与高密度街景细节，具有统一的未来城市美术和电影镜头语言',
    negative: '严禁乱码和可读文字、廉价荧光滤镜、过曝霓虹、塑料人物、3D 游戏截图、卡通或水印',
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
  if (!['realistic', 'cinematic', 'documentary', 'commercial', 'film_noir', 'vintage_film'].includes(spec.value)) return ''
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
