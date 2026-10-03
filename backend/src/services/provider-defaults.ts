export type DefaultProviderServiceType = 'text' | 'image' | 'video' | 'audio'

/**
 * Default priorities used when a configuration is created by the app or a
 * preset is applied. Higher values win, while an explicit user priority can
 * still override these defaults.
 */
export function getDefaultProviderPriority(
  serviceType: DefaultProviderServiceType,
  provider?: string | null,
) {
  const normalizedProvider = String(provider || '').trim().toLowerCase()
  if (serviceType === 'text') {
    if (normalizedProvider === 'mijing') return 110
    if (normalizedProvider === 'eggfans') return 100
  }
  if (serviceType === 'image') {
    if (normalizedProvider === 'mijing') return 109
    if (normalizedProvider === 'eggfans') return 99
  }
  if (serviceType === 'video') {
    if (normalizedProvider === 'comfyui') return 111
    if (normalizedProvider === 'autodl_comfyui') return 109
    if (normalizedProvider === 'mijing') return 110
    if (normalizedProvider === 'volcengine') return 108
    if (normalizedProvider === 'eggfans') return 98
  }
  if (serviceType === 'audio' && normalizedProvider === 'eggfans') return 97
  return 0
}

export function getEffectiveProviderPriority(
  serviceType: DefaultProviderServiceType,
  provider?: string | null,
  priority?: number | null,
) {
  const explicitPriority = Number(priority || 0)
  return explicitPriority > 0
    ? explicitPriority
    : getDefaultProviderPriority(serviceType, provider)
}
