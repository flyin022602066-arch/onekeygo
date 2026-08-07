export type GenerationWithId = { id?: number | null }

export function latestGenerationId<T extends GenerationWithId>(rows: T[]) {
  return rows.reduce<number | null>((latest, row) => {
    const id = Number(row.id || 0)
    if (!Number.isFinite(id) || id <= 0) return latest
    return latest == null || id > latest ? id : latest
  }, null)
}

export function isLatestGeneration<T extends GenerationWithId>(rows: T[], id: number | null | undefined) {
  const targetId = Number(id || 0)
  return targetId > 0 && latestGenerationId(rows) === targetId
}
