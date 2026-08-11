export const MIJING_STANDARD_BASE_URL = 'https://api.magine.work'
export const MIJING_VIDEO_BASE_URL = MIJING_STANDARD_BASE_URL

export function resolveMijingBaseUrl(serviceType?: string | null) {
  return String(serviceType || '').trim().toLowerCase() === 'video'
    ? MIJING_VIDEO_BASE_URL
    : MIJING_STANDARD_BASE_URL
}

export function buildConfigTestPayload(input: Record<string, any>, configId?: number | null) {
  return {
    ...input,
    id: configId || undefined,
  }
}
