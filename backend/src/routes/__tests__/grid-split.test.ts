import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeStoryboardReferenceImages } from '../grid.js'

test('grid split reference images replace the previous grid-cut batch instead of appending duplicates', () => {
  const current = [
    'static/grid-cells/cell_old_0.png',
    'static/grid-cells/cell_old_1.png',
    'static/grid-cells/cell_old_2.png',
    'static/grid-cells/cell_old_3.png',
  ]
  const next = [
    'static/grid-cells/cell_new_0.png',
    'static/grid-cells/cell_new_1.png',
    'static/grid-cells/cell_new_2.png',
    'static/grid-cells/cell_new_3.png',
  ]

  assert.deepEqual(mergeStoryboardReferenceImages(current, next), next)
})

test('grid split reference images preserve manual non-grid references and dedupe incoming cells', () => {
  const merged = mergeStoryboardReferenceImages(
    ['static/manual/ref.png', 'static/grid-cells/cell_old_0.png'],
    ['static/grid-cells/cell_new_0.png', 'static/grid-cells/cell_new_0.png'],
  )

  assert.deepEqual(merged, ['static/manual/ref.png', 'static/grid-cells/cell_new_0.png'])
})
