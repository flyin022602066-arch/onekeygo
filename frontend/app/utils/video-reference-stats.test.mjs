import test from 'node:test'
import assert from 'node:assert/strict'
import { assetReferenceCounts, formatElapsed, generationElapsedMs, hasPreviousVideoReference } from './video-reference-stats.mjs'

test('assetReferenceCounts reports semantic serial bindings by category', () => {
  const counts = assetReferenceCounts({
    storyboard: { character_ids: [1, 2], scene_id: 8 },
    step: {
      asset_refs: JSON.stringify([
        { role: 'continuity_reference', name: '连续参考图' },
        { role: 'scene', name: '场景-厨房' },
        { role: 'character', name: '角色-苏小小', asset_id: 'char-1' },
        { role: 'character', name: '角色-苏大强', asset_id: 'char-2' },
        { role: 'prop', name: '道具-菜刀', asset_id: 'prop-1' },
        { role: 'prop', name: '道具-菜刀', asset_id: 'prop-1' },
      ]),
    },
  })
  assert.deepEqual(counts, { characters: 2, scenes: 1, props: 1, total: 4, references: 5 })
})

test('assetReferenceCounts falls back to storyboard bindings and prop mentions', () => {
  const counts = assetReferenceCounts({
    storyboard: {
      character_ids: JSON.stringify([1]),
      scene_id: 3,
      action: '她拿起玉佩，转身离开',
    },
    characters: [{ id: 1, name: '苏小小' }],
    scenes: [{ id: 3, location: '厨房' }],
    props: [{ id: 5, name: '玉佩' }],
  })
  assert.deepEqual(counts, { characters: 1, scenes: 1, props: 1, total: 3, references: 3 })
})

test('generationElapsedMs and formatElapsed support active and completed rows', () => {
  const start = '2026-09-03T00:00:00.000Z'
  assert.equal(generationElapsedMs({ status: 'processing', created_at: start }, Date.parse('2026-09-03T00:01:05.000Z')), 65_000)
  assert.equal(generationElapsedMs({ status: 'completed', created_at: start, completed_at: '2026-09-03T01:02:03.000Z' }), 3_723_000)
  assert.equal(formatElapsed(3_723_000), '01:02:03')
  assert.equal(formatElapsed(65_000), '01:05')
})

test('hasPreviousVideoReference only accepts the persisted previous-video field', () => {
  assert.equal(hasPreviousVideoReference({ reference_video_local_path: 'static/videos/previous.mp4' }), true)
  assert.equal(hasPreviousVideoReference({ referenceVideoLocalPath: 'static/videos/previous.mp4' }), true)
  assert.equal(hasPreviousVideoReference({ reference_image_urls: JSON.stringify(['static/images/ref.png']) }), false)
  assert.equal(hasPreviousVideoReference({ reference_video_local_path: '' }), false)
})
