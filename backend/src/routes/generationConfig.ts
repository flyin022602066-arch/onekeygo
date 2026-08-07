export function resolveGenerationConfigId(
  requested: unknown,
  fallback?: number | null,
): number | undefined {
  const requestedId = toPositiveInteger(requested)
  if (requestedId) return requestedId

  return toPositiveInteger(fallback)
}

function toPositiveInteger(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}
