import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStoryboardPersistencePlan,
  normalizeStoryboardDuration,
  normalizeStoryboardDurationsForPolicy,
  validateTkSceneCoverage,
  validateStoryboardDurationPolicy,
} from '../tools/storyboard-tools.js'
import {
  haveStoryboardGenerationInputsChanged,
  storyboardGenerationResetValues,
} from '../../services/storyboard-generation-invalidation.js'

test('buildStoryboardPersistencePlan preserves existing storyboard ids by shot number', () => {
  const plan = buildStoryboardPersistencePlan(
    [
      { id: 101, storyboardNumber: 1 },
      { id: 102, storyboardNumber: 2 },
      { id: 103, storyboardNumber: 3 },
    ],
    [
      { shot_number: 1, title: '新版镜头一' },
      { shot_number: 2, title: '新版镜头二' },
      { shot_number: 4, title: '新增镜头四' },
    ],
  )

  assert.deepEqual(plan.updates.map(item => item.id), [101, 102])
  assert.deepEqual(plan.creates.map(item => item.storyboard.shot_number), [4])
  assert.deepEqual(plan.retireIds, [103])
})

test('validateStoryboardDurationPolicy accepts Grok 3 minute breakdowns within limits', () => {
  assert.doesNotThrow(() => validateStoryboardDurationPolicy(
    Array.from({ length: 18 }, (_, index) => ({ shot_number: index + 1, duration: 10 })),
    { mode: 'grok_3min', shotDuration: 10, maxTotalDuration: 180, maxShots: 18 },
  ))
})

test('normalizeStoryboardDuration keeps normal shots compact and Grok shots fixed', () => {
  assert.equal(normalizeStoryboardDuration(undefined, null), 5)
  assert.equal(normalizeStoryboardDuration(2, null), 4)
  assert.equal(normalizeStoryboardDuration(6, null), 6)
  assert.equal(normalizeStoryboardDuration(12, null), 7)
  assert.equal(normalizeStoryboardDuration(5, { mode: 'grok_10s', shotDuration: 10 }), 10)
  assert.equal(normalizeStoryboardDuration(15, { mode: 'grok_3min', shotDuration: 10 }), 10)
})

test('validateStoryboardDurationPolicy rejects Grok 3 minute breakdowns over shot or duration limits', () => {
  assert.throws(
    () => validateStoryboardDurationPolicy(
      Array.from({ length: 19 }, (_, index) => ({ shot_number: index + 1, duration: 10 })),
      { mode: 'grok_3min', shotDuration: 10, maxTotalDuration: 180, maxShots: 18 },
    ),
    /最多 18 个镜头/,
  )

  assert.throws(
    () => validateStoryboardDurationPolicy(
      [
        { shot_number: 1, duration: 10 },
        { shot_number: 2, duration: 12 },
      ],
      { mode: 'grok_3min', shotDuration: 10, maxTotalDuration: 180, maxShots: 18 },
    ),
    /每个镜头时长必须为 10 秒/,
  )
})

test('TK overseas storyboard policy accepts adaptive shots totaling 60-100 seconds', () => {
  assert.doesNotThrow(() => validateStoryboardDurationPolicy(
    Array.from({ length: 8 }, (_, index) => ({ shot_number: index + 1, duration: 8 })),
    {
      mode: 'tk_overseas',
      shotDurationMin: 4,
      shotDurationMax: 15,
      minTotalDuration: 60,
      maxTotalDuration: 100,
    },
  ))
})

test('TK overseas storyboard duration follows the adaptive 4-15 second range', () => {
  assert.equal(normalizeStoryboardDuration(3, { mode: 'tk_overseas' }), 4)
  assert.equal(normalizeStoryboardDuration(8, { mode: 'tk_overseas' }), 8)
  assert.equal(normalizeStoryboardDuration(15, { mode: 'tk_overseas' }), 15)
  assert.equal(normalizeStoryboardDuration(18, { mode: 'tk_overseas' }), 15)
})

test('TK overseas storyboard policy rejects invalid total or shot durations', () => {
  assert.throws(
    () => validateStoryboardDurationPolicy(
      Array.from({ length: 3 }, (_, index) => ({ shot_number: index + 1, duration: 5 })),
      { mode: 'tk_overseas', minTotalDuration: 60, maxTotalDuration: 100 },
    ),
    /总时长必须为 60-100 秒/,
  )
  assert.throws(
    () => validateStoryboardDurationPolicy(
      Array.from({ length: 10 }, (_, index) => ({ shot_number: index + 1, duration: 5 })),
      { mode: 'tk_overseas', minTotalDuration: 60, maxTotalDuration: 100, minShots: 10 },
    ),
    /总时长必须为 60-100 秒/,
  )
  assert.throws(
    () => validateStoryboardDurationPolicy(
      Array.from({ length: 10 }, (_, index) => ({ shot_number: index + 1, duration: index === 0 ? 16 : 5 })),
      { mode: 'tk_overseas', minTotalDuration: 60, maxTotalDuration: 100 },
    ),
    /每个镜头时长必须为 4-15 秒/,
  )
})

test('TK overseas storyboard policy requires every extracted scene to be represented', () => {
  assert.throws(
    () => validateTkSceneCoverage(
      [{ scene_id: 101 }, { scene_id: 101 }],
      new Set([101, 102, 103]),
    ),
    /未覆盖当前集的场景：102, 103/,
  )
  assert.doesNotThrow(() => validateTkSceneCoverage(
    [{ scene_id: 101 }, { scene_id: 102 }, { scene_id: 103 }],
    [101, 102, 103],
  ))
})

test('storyboard content changes invalidate every generated output', () => {
  const existing = {
    sceneId: 1,
    action: '角色走进房间',
    dialogue: '你好',
    imagePrompt: '旧图片提示词',
    videoPrompt: '旧视频提示词',
    duration: 7,
  }

  assert.equal(haveStoryboardGenerationInputsChanged(
    existing,
    { ...existing, action: '角色转身离开' },
    [2, 1],
    [1, 2],
  ), true)
  assert.deepEqual(storyboardGenerationResetValues('2026-08-05T00:00:00.000Z'), {
    composedImage: null,
    firstFrameImage: null,
    lastFrameImage: null,
    referenceImages: null,
    videoUrl: null,
    ttsAudioUrl: null,
    subtitleUrl: null,
    composedVideoUrl: null,
    status: 'pending',
    updatedAt: '2026-08-05T00:00:00.000Z',
  })
})

test('unchanged storyboard content preserves generated outputs', () => {
  const storyboard = {
    sceneId: 1,
    location: '出租屋',
    action: '角色坐下',
    dialogue: '你好',
    imagePrompt: '图片提示词',
    videoPrompt: '视频提示词',
    duration: 5,
  }

  assert.equal(haveStoryboardGenerationInputsChanged(
    storyboard,
    { ...storyboard },
    [3, 1, 3],
    [1, 3],
  ), false)
})
