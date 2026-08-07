import test from 'node:test'
import assert from 'node:assert/strict'
import { createGridAssignmentsForShots, normalizeGridAssignments, parseGridLayoutFromFrameType } from './grid-state.ts'

test('parseGridLayoutFromFrameType supports multi-reference frame types', () => {
  assert.deepEqual(parseGridLayoutFromFrameType('grid_multi_ref_2x2'), { rows: 2, cols: 2 })
  assert.deepEqual(parseGridLayoutFromFrameType('grid_multi_ref_2x4'), { rows: 2, cols: 4 })
  assert.deepEqual(parseGridLayoutFromFrameType('grid_first_frame_3x3'), { rows: 3, cols: 3 })
  assert.deepEqual(parseGridLayoutFromFrameType('grid_first_frame_2x2'), { rows: 2, cols: 2 })
})

test('normalizeGridAssignments trims stale cached assignments to the actual layout', () => {
  const assignments = Array.from({ length: 9 }, (_, index) => ({
    storyboard_id: 15,
    frame_type: 'reference',
    stale: index + 1,
  }))

  const normalized = normalizeGridAssignments(assignments, { rows: 2, cols: 2 })

  assert.equal(normalized.length, 4)
  assert.deepEqual(normalized.map(item => item.stale), [1, 2, 3, 4])
})

test('normalizeGridAssignments fills missing cells with defaults', () => {
  const normalized = normalizeGridAssignments(
    [{ storyboard_id: 15, frame_type: 'reference' }],
    { rows: 2, cols: 2 },
    { storyboard_id: 15, frame_type: 'reference' },
  )

  assert.equal(normalized.length, 4)
  assert.deepEqual(normalized.map(item => item.storyboard_id), [15, 15, 15, 15])
  assert.deepEqual(normalized.map(item => item.frame_type), ['reference', 'reference', 'reference', 'reference'])
})

test('createGridAssignmentsForShots maps selected shots into the chosen grid cells', () => {
  const assignments = createGridAssignmentsForShots([13, 14, 15, 16], { rows: 2, cols: 2 }, 'first_frame')

  assert.equal(assignments.length, 4)
  assert.deepEqual(assignments.map(item => item.storyboard_id), [13, 14, 15, 16])
  assert.deepEqual(assignments.map(item => item.frame_type), ['first_frame', 'first_frame', 'first_frame', 'first_frame'])
})
