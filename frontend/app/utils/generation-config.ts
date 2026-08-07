export type GenerationConfigLike = {
  id?: number | null
  is_active?: boolean | null
  isActive?: boolean | null
  priority?: number | null
}

export function resolveEffectiveGenerationConfigId(
  selectedConfigId: number | null | undefined,
  lockedConfigId: number | null | undefined,
  activeConfigs: GenerationConfigLike[],
) {
  const active = activeConfigs.filter(config => config?.is_active !== false && config?.isActive !== false)
  if (selectedConfigId && active.some(config => Number(config.id || 0) === Number(selectedConfigId))) return selectedConfigId
  if (lockedConfigId && active.some(config => Number(config.id || 0) === Number(lockedConfigId))) return lockedConfigId
  return active[0]?.id || null
}
