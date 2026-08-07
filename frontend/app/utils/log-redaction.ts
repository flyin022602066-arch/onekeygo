const SENSITIVE_KEYS = [
  'api_key',
  'apikey',
  'apiKey',
  'seedance_api_key',
  'seedanceApiKey',
  'authorization',
  'Authorization',
  'token',
  'access_token',
  'password',
  'secret',
]

export function sanitizeApiLogPayload(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') return redactSecretText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(item => sanitizeApiLogPayload(item))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase()
      if (SENSITIVE_KEYS.some(item => item.toLowerCase() === normalized) ||
        normalized.includes('api_key') ||
        normalized.includes('apikey') ||
        normalized.includes('authorization') ||
        normalized.includes('token') ||
        normalized.includes('password') ||
        normalized.includes('secret')) {
        out[key] = '***'
        continue
      }
      out[key] = sanitizeApiLogPayload(raw)
    }
    return out
  }
  return value
}

function redactSecretText(value: string) {
  return value.replace(/((?:api_key|apikey|token|access_token|password|secret)=)[^&\s]+/gi, '$1***')
}
