import type { AIConfig } from './adapters/types.js'

export function isLocalH3Channel(config: AIConfig) {
  if (config.provider !== 'comfyui') return false
  try {
    const url = new URL(config.baseUrl || 'http://127.0.0.1:8188')
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export function localH3RefinementSettings(config: AIConfig) {
  const value = config.settings?.comfyui?.refinement || {}
  const bounded = (input: unknown, fallback: number, minimum: number, maximum: number) => {
    const parsed = input === undefined || input === null || input === '' ? fallback : Number(input)
    return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback
  }
  return {
    enabled: isLocalH3Channel(config) && value.enabled === true,
    scale: bounded(value.scale, 1.25, 1, 1.25),
    steps: Math.round(bounded(value.steps, 2, 1, 4)),
    denoise: bounded(value.denoise, 0.2, 0.1, 0.3),
  }
}

export async function inspectLocalH3VideoTail(config: AIConfig, fetchImpl = fetch) {
  if (!isLocalH3Channel(config)) return { available: false }
  try {
    const baseUrl = String(config.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
    const response = await fetchImpl(`${baseUrl}/object_info/MijingH3VideoTail`, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as any
    const node = body?.MijingH3VideoTail
    if (['images', 'max_frames', 'fps'].every(field => node?.input?.required?.[field])
      && node?.input?.optional?.audio && node?.output?.join(',') === 'IMAGE,AUDIO') return { available: true }
    return { available: false, reason: '尾段保留节点未加载，沿用原 R2V 参考链；重启本项目 Worker 后启用。' }
  } catch (error) {
    return { available: false, reason: `尾段节点检查失败，沿用原参考链：${String(error)}` }
  }
}

export async function inspectLocalH3Refinement(config: AIConfig, fetchImpl = fetch) {
  if (!localH3RefinementSettings(config).enabled) return { available: false }
  try {
    const baseUrl = String(config.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
    const response = await fetchImpl(`${baseUrl}/object_info/MijingH3SafeRefine`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as any
    const required = body?.MijingH3SafeRefine?.input?.required
    const fields = ['base_video', 'latent', 'positive', 'model', 'vae', 'clip', 'audio_vae', 'prompt', 'seed', 'scale', 'steps', 'denoise', 'trim_frames']
    const optional = body?.MijingH3SafeRefine?.input?.optional
    if (!fields.every(field => required?.[field]) || body.MijingH3SafeRefine.output?.[0] !== 'VIDEO'
      || !Array.from({ length: 9 }, (_, index) => `reference_image_${index}`).every(field => optional?.[field])
      || !optional?.reference_video || !optional?.reference_audio) {
      return { available: false, reason: '安全二采节点未加载或版本不兼容；本次保留普通输出，请重启本项目的 ComfyUI Worker。' }
    }
    const saved = await fetchImpl(`${baseUrl}/object_info/MijingH3PreserveVideo`, { signal: AbortSignal.timeout(5_000) })
    if (!saved.ok) throw new Error(`原片保存节点 HTTP ${saved.status}`)
    const preserve = (await saved.json() as any)?.MijingH3PreserveVideo
    if (!preserve?.input?.required?.video || !preserve?.input?.required?.filename_prefix
      || preserve?.output?.[0] !== 'VIDEO' || preserve?.output_node !== true) {
      return { available: false, reason: '原片保存节点不兼容，跳过二采以保护普通输出。' }
    }
    return { available: true }
  } catch (error) {
    return { available: false, reason: `二采能力检查失败，保留普通输出：${String(error)}` }
  }
}
