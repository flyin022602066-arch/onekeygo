export interface GridLayoutShape {
  rows: number
  cols: number
}

export interface GridAssignmentLike {
  storyboard_id?: number | null
  frame_type?: string | null
  [key: string]: unknown
}

export function parseGridLayoutFromFrameType(value: unknown): GridLayoutShape | null {
  const match = String(value || '').match(/grid_.+_(\d+)x(\d+)$/)
  if (!match) return null
  const rows = Number(match[1])
  const cols = Number(match[2])
  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows <= 0 || cols <= 0) return null
  return { rows, cols }
}

export function normalizeGridAssignments(
  assignments: GridAssignmentLike[] | undefined | null,
  layout: GridLayoutShape,
  defaults: GridAssignmentLike = {},
): GridAssignmentLike[] {
  const total = Math.max(0, Number(layout.rows || 0) * Number(layout.cols || 0))
  const source = Array.isArray(assignments) ? assignments : []
  return Array.from({ length: total }, (_, index) => ({
    ...defaults,
    ...(source[index] || {}),
  }))
}

export function createGridAssignmentsForShots(
  shotIds: Array<number | string> | undefined | null,
  layout: GridLayoutShape,
  frameType = 'first_frame',
): GridAssignmentLike[] {
  const total = Math.max(0, Number(layout.rows || 0) * Number(layout.cols || 0))
  const ids = Array.isArray(shotIds) ? shotIds.map(id => Number(id)).filter(Boolean) : []
  return Array.from({ length: total }, (_, index) => ({
    storyboard_id: ids[index] || null,
    frame_type: frameType,
  }))
}
