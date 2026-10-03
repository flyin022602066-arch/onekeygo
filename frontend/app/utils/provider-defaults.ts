export type DefaultProviderServiceType = 'text' | 'image' | 'video' | 'audio'

export function getDefaultProviderPriority(
  serviceType: DefaultProviderServiceType,
  provider: string,
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
    if (normalizedProvider === 'mijing') return 110
    if (normalizedProvider === 'volcengine') return 108
    if (normalizedProvider === 'eggfans') return 98
  }
  if (serviceType === 'audio' && normalizedProvider === 'eggfans') return 97
  return 0
}
