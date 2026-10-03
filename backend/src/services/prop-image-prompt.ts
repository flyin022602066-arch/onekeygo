export function buildPropAssetPrompt(prop: { name?: string | null; type?: string | null; description?: string | null; prompt?: string | null }) {
  const details = [prop.type, prop.description, prop.prompt].map(value => String(value || '').trim()).filter(Boolean).join('，')
  return `短剧道具资产设定图，主体是“${String(prop.name || '道具').trim()}”。${details ? `外观与用途：${details}。` : ''}单个物件居中，完整展示轮廓、材质、颜色和关键细节，纯净背景，真人影视美术参考图质感，不要人物、手持、文字、水印、3D渲染或多物件拼图。`
}
