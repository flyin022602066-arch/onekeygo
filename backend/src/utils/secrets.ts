const SENSITIVE_KEYS = new Set([
  'authorization',
  'api_key',
  'apikey',
  'apiKey',
  'token',
  'access_token',
  'password',
  'secret',
])

export function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

export function sanitizeAiConfigForClient<T extends Record<string, any>>(row: T): Omit<T, 'api_key' | 'apiKey'> & {
  api_key: string
  has_api_key: boolean
  api_key_hint: string
} {
  const rawKey = row.api_key ?? row.apiKey ?? ''
  const { api_key: _snake, apiKey: _camel, ...rest } = row
  return {
    ...rest,
    api_key: '',
    has_api_key: !!rawKey,
    api_key_hint: maskSecret(rawKey),
  } as Omit<T, 'api_key' | 'apiKey'> & { api_key: string; has_api_key: boolean; api_key_hint: string }
}

export function sanitizeForLog(text: string, contentType = ''): string {
  if (!text) return text
  if (contentType.includes('application/json') || looksLikeJson(text)) {
    try {
      return JSON.stringify(redactSensitive(JSON.parse(text)))
    } catch {
      return redactText(text)
    }
  }
  return redactText(text)
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => redactSensitive(item))
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase()
    if (SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(lower) ||
      lower.includes('authorization') || lower.includes('apikey') ||
      lower.includes('api_key') || lower.includes('token') ||
      lower.includes('password') || lower.includes('secret')) {
      out[key] = '***'
    } else {
      out[key] = redactSensitive(raw)
    }
  }
  return out
}

function looksLikeJson(text: string) {
  const trimmed = text.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function redactText(text: string) {
  return text
    .replace(/("(?:api_key|apikey|apiKey|token|access_token|authorization|password|secret)"\s*:\s*")[^"]+"/gi, '$1***"')
    .replace(/((?:key|api_key|apikey|token|access_token|password|secret)=)[^&\s]+/gi, '$1***')
    .replace(/(authorization:\s*)(bearer|token)\s+[^\s,;]+/gi, '$1$2 ***')
}
