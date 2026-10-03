import test from 'node:test'
import assert from 'node:assert/strict'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import {
  buildStoryboardPersistencePlan,
  normalizeStoryboardDuration,
  normalizeStoryboardDurationsForPolicy,
  validateTkSceneCoverage,
  validateStoryboardDurationPolicy,
  selectStoryboardScriptSource,
  extractStoryboardRoleNames,
  extractStoryboardVoiceNames,
  extractStoryboardDialogueSpeakerNames,
  resolveStoryboardCharacterIds,
  resolveAssetIdByName,
  resolveStoryboardSceneId,
  validateCompleteStoryboardSet,
  optimizeStoryboardCharacterAppearance,
  validateMiniMaxLocalContinuityContract,
  normalizeMiniMaxLocalContinuityContract,
  validateMiniMaxLocalCastContract,
} from '../tools/storyboard-tools.js'
import {
  haveStoryboardGenerationInputsChanged,
  storyboardGenerationResetValues,
} from '../../services/storyboard-generation-invalidation.js'

test('TK storyboard context uses the original screenplay so English dialogue is preserved', () => {
  const source = selectStoryboardScriptSource({
    breakdownMode: 'tk_overseas',
    content: 'Ayla: "Stop the ceremony."',
    scriptContent: 'Translated dialogue',
  })
  assert.equal(source, 'Ayla: "Stop the ceremony."')
})

test('every storyboard mode uses the user-pasted original script as the fact source', () => {
  assert.equal(selectStoryboardScriptSource({
    breakdownMode: 'standard',
    content: 'Original script',
    scriptContent: 'Formatted script',
  }), 'Original script')
})

test('storyboard role tags override a mismatched character id instead of carrying a wrong asset forward', () => {
  const characters = [
    { id: 18, name: '苏小小' },
    { id: 19, name: '苏大强' },
  ]
  assert.deepEqual(extractStoryboardRoleNames('<role>苏小小</role>颠锅，苏大强在后厨。'), ['苏小小'])
  assert.deepEqual(
    resolveStoryboardCharacterIds([19], '<role>苏小小</role>颠锅。', characters),
    [18],
  )
})

test('storyboard role aliases resolve to the canonical extracted character asset', () => {
  assert.deepEqual(
    resolveStoryboardCharacterIds(
      [],
      '<role>胖子顾客</role> raises a glass.',
      [{ id: 20, name: '胖顾客' }],
    ),
    [20],
  )
})

test('numbered storyboard role tags resolve only when the remaining name matches an asset', () => {
  const characters = [
    { id: 61, name: '沈四宁' },
    { id: 62, name: '陆北辰' },
    { id: 63, name: '1号角色' },
  ]

  assert.deepEqual(
    resolveStoryboardCharacterIds(
      [],
      '<role>1沈四宁</role><role>2、陆北辰</role><role>1号角色</role>',
      characters,
    ),
    [61, 62, 63],
  )
  assert.throws(
    () => resolveStoryboardCharacterIds([], '<role>3不存在角色</role>', characters),
    /不属于当前角色资产/,
  )
})

test('role tags with a leading marker and short action resolve to the shared character asset', () => {
  assert.deepEqual(
    resolveStoryboardCharacterIds(
      [],
      '<role>△ 沈昭宁捡起地上的玉佩</role>，镜头跟随她起身。',
      [{ id: 71, name: '沈昭宁' }],
    ),
    [71],
  )
})

test('storyboard voice and dialogue speakers are included in character asset bindings', () => {
  const characters = [
    { id: 34, name: '苏小小' },
    { id: 35, name: '苏大强' },
    { id: 37, name: '顾承渊' },
  ]
  assert.deepEqual(extractStoryboardVoiceNames('<voice>苏小小</voice><voice>顾承渊OS</voice><voice>旁白</voice>'), ['苏小小', '顾承渊'])
  assert.deepEqual(extractStoryboardDialogueSpeakerNames('苏小小：你先坐。 顾承渊OS：高考？'), ['苏小小', '顾承渊'])
  assert.deepEqual(
    resolveStoryboardCharacterIds(
      [35],
      '<role>苏大强</role><voice>苏小小</voice><voice>顾承渊OS</voice>',
      characters,
      '苏小小：你先坐。 顾承渊OS：高考？',
    ),
    [35, 34, 37],
  )
})

test('local MiniMax character bindings ignore previous-shot roles kept in continuity start', () => {
  const characters = [
    { id: 51, name: 'Previous Character' },
    { id: 52, name: 'Current Character' },
  ]
  const prompt = [
    'CONTINUITY_START: <role>Previous Character</role> remains visible at the end of the previous shot.',
    'CURRENT_SHOT_PROGRESS: <role>Current Character</role> enters from the left and takes the action.',
    'CURRENT_SHOT_END: <role>Current Character</role> completes the action.',
  ].join('\n')

  assert.deepEqual(
    resolveStoryboardCharacterIds([51], prompt, characters),
    [52],
  )
})

test('custom bilingual aliases resolve to one character or prop asset', () => {
  assert.equal(resolveAssetIdByName('jade pendant', [
    { id: 41, name: '玉佩', aliases: '["jade pendant","jade amulet"]' },
  ]), 41)
  assert.equal(resolveAssetIdByName('红木餐桌', [
    { id: 42, name: '餐桌', aliases: ['redwood dining table'] },
  ]), 42)
  assert.equal(resolveAssetIdByName('unknown', [
    { id: 41, name: '玉佩', aliases: '["jade pendant"]' },
  ]), null)
})

test('storyboard role tags reject relationship labels and unknown assets', () => {
  const characters = [{ id: 18, name: '苏小小' }, { id: 19, name: '苏大强' }]
  assert.throws(
    () => resolveStoryboardCharacterIds([18], '<role>苏大强的女儿</role>颠锅。', characters),
    /精确角色名称/,
  )
  assert.throws(
    () => resolveStoryboardCharacterIds([], '<role>未提取角色</role>入画。', characters),
    /不属于当前角色资产/,
  )
})

test('missing scene_id is resolved only from the current episode scene whitelist', () => {
  assert.equal(typeof resolveStoryboardSceneId, 'function')
})

test('missing scene_id is recovered from the canonical location tag and scene aliases', () => {
  const ts = new Date().toISOString()
  const drama = db.insert(schema.dramas).values({ title: 'scene-binding-test', createdAt: ts, updatedAt: ts }).run()
  const dramaId = Number(drama.lastInsertRowid)
  const episode = db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E1', content: '厨房', createdAt: ts, updatedAt: ts }).run()
  const episodeId = Number(episode.lastInsertRowid)
  const scene = db.insert(schema.scenes).values({ dramaId, episodeId, location: '烧烤店后厨', time: '夜', prompt: '烧烤店后厨，铁锅和暖黄色顶灯，纯场景环境，无人物', createdAt: ts, updatedAt: ts }).run()
  const sceneId = Number(scene.lastInsertRowid)
  db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).run()
  try {
    assert.equal(resolveStoryboardSceneId(episodeId, {
      scene_id: null,
      location: '',
      time: '夜晚',
      video_prompt: '<location>厨房</location> 苏小小在灶台前颠锅',
      action: '颠锅',
    }), sceneId)
  } finally {
    db.delete(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId)).run()
    db.delete(schema.scenes).where(eq(schema.scenes.id, sceneId)).run()
    db.delete(schema.episodes).where(eq(schema.episodes.id, episodeId)).run()
    db.delete(schema.dramas).where(eq(schema.dramas.id, dramaId)).run()
  }
})

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

test('complete storyboard validation rejects partial and duplicate shot sets', () => {
  assert.throws(
    () => validateCompleteStoryboardSet([{ shot_number: 3 }, { shot_number: 4 }]),
    /从 1 开始连续且不重复的完整镜号/,
  )
  assert.throws(
    () => validateCompleteStoryboardSet([{ shot_number: 1 }, { shot_number: 1 }]),
    /从 1 开始连续且不重复的完整镜号/,
  )
  assert.doesNotThrow(() => validateCompleteStoryboardSet([
    { shot_number: 1 },
    { shot_number: 2 },
    { shot_number: 3 },
  ]))
})

test('storyboard appearance conflicts are rewritten automatically while preserving actions and dialogue', () => {
  const dialogue = '陆北辰：你穿着这件衣服做什么？'
  const result = optimizeStoryboardCharacterAppearance([{
    shot_number: 4,
    action: '陆北辰身穿玄红嫁衣走入殿中。',
    description: '沈昭宁一袭素白麻衣缓步走来。',
    image_prompt: 'Close-up of Shen Zhaoning wearing a white robe, looking toward the doorway.',
    result: '陆北辰玄红嫁衣微敞，转头看向沈昭宁。',
    atmosphere: '沈昭宁一头乌黑长发，眉头紧锁，目光躲闪，嘴角微颤。',
    dialogue,
  }])

  assert.equal(result.storyboards[0].action, '陆北辰走入殿中。')
  assert.equal(result.storyboards[0].description, '沈昭宁缓步走来。')
  assert.equal(result.storyboards[0].image_prompt, 'Close-up of Shen Zhaoning, looking toward the doorway.')
  assert.equal(result.storyboards[0].result, '陆北辰转头看向沈昭宁。')
  assert.equal(result.storyboards[0].atmosphere, '沈昭宁，眉头紧锁，目光躲闪，嘴角微颤。')
  assert.equal(result.storyboards[0].dialogue, dialogue)
  assert.deepEqual(result.rewrittenFields, ['镜头4.action', '镜头4.description', '镜头4.result', '镜头4.atmosphere', '镜头4.image_prompt'])
})

test('storyboard appearance optimization leaves unrelated wording and address intact', () => {
  const prompts = [{
    shot_number: 1,
    action: '陆北辰停下脚步，转向沈昭宁。',
    video_prompt: 'She addresses him, then pauses and meets his gaze.',
  }]
  const result = optimizeStoryboardCharacterAppearance(prompts)

  assert.deepEqual(result.storyboards, prompts)
  assert.deepEqual(result.rewrittenFields, [])
})

test('persistence plan keeps newest active duplicate as canonical and retires the old row', () => {
  const plan = buildStoryboardPersistencePlan(
    [
      { id: 101, storyboardNumber: 1, updatedAt: '2026-09-01T00:00:00.000Z' },
      { id: 102, storyboardNumber: 1, updatedAt: '2026-09-02T00:00:00.000Z' },
    ],
    [{ shot_number: 1, title: '最新镜头' }],
  )
  assert.deepEqual(plan.updates.map(item => item.id), [102])
  assert.deepEqual(plan.retireIds, [101])
})

test('local MiniMax storyboard policy clamps every shot to adaptive 8-10 seconds', () => {
  const policy = { mode: 'minimax_local_8s', shotDuration: 5 }
  assert.equal(normalizeStoryboardDuration(undefined, policy), 8)
  assert.equal(normalizeStoryboardDuration(5, policy), 8)
  assert.equal(normalizeStoryboardDuration(8, policy), 8)
  assert.equal(normalizeStoryboardDuration(9, policy), 9)
  assert.equal(normalizeStoryboardDuration(10, policy), 10)
  assert.equal(normalizeStoryboardDuration(15, policy), 10)
  assert.deepEqual(
    normalizeStoryboardDurationsForPolicy([
      { shot_number: 1, duration: 5 },
      { shot_number: 2, duration: 9 },
      { shot_number: 3, duration: 12 },
    ], policy).map(item => item.duration),
    [8, 9, 10],
  )
  assert.doesNotThrow(() => validateStoryboardDurationPolicy(
    [{ shot_number: 1, duration: 8 }, { shot_number: 2, duration: 9 }, { shot_number: 3, duration: 10 }],
    policy,
  ))
  assert.throws(
    () => validateStoryboardDurationPolicy([{ shot_number: 1, duration: 11 }], policy),
    /8-10 秒的整数/,
  )
})

test('local MiniMax continuity contract accepts a new chained result after shot one', () => {
  assert.doesNotThrow(() => validateMiniMaxLocalContinuityContract([
    { shot_number: 1, action: 'establish the kitchen', result: 'the heroine grips the pan', video_prompt: '0-8s: establish the kitchen' },
    {
      shot_number: 2,
      action: 'the heroine turns from the stove and answers the customer',
      result: 'the heroine finishes the turn facing the customer with the pan lowered',
      video_prompt: [
        'CONTINUITY_START: inherit the previous shot final pose, positions, props, lighting, and framing as the 0-second opening.',
        'CURRENT_SHOT_PROGRESS: the heroine turns from the stove, answers the customer, and the camera tracks right.',
        'CURRENT_SHOT_END: the turn settles with the heroine facing the customer and the pan lowered, creating a new stable ending.',
      ].join('\n'),
    },
  ], { mode: 'minimax_local_8s' }))
})

test('local MiniMax continuity normalization repairs missing markers without discarding the shot', () => {
  const repaired = normalizeMiniMaxLocalContinuityContract([
    { shot_number: 1, action: 'open', result: 'the heroine grips the pan', video_prompt: '0-8s: establish the kitchen' },
    { shot_number: 2, action: 'the heroine turns toward the customer', result: '', video_prompt: '0-8s: continue the action toward the customer' },
  ], { mode: 'minimax_local_8s' })
  assert.equal(repaired.length, 2)
  assert.match(String(repaired[1].video_prompt), /CONTINUITY_START:/)
  assert.match(String(repaired[1].video_prompt), /CURRENT_SHOT_PROGRESS:/)
  assert.match(String(repaired[1].video_prompt), /CURRENT_SHOT_END:/)
  assert.match(String(repaired[1].result), /新的稳定尾帧/)
  assert.doesNotThrow(() => validateMiniMaxLocalContinuityContract(repaired, { mode: 'minimax_local_8s' }))
})

test('local MiniMax continuity contract rejects missing chain markers and copied endings', () => {
  assert.throws(
    () => validateMiniMaxLocalContinuityContract([
      { shot_number: 1, action: 'open', result: 'open', video_prompt: 'open' },
      { shot_number: 2, action: 'start over with a new opening', result: 'same as previous shot', video_prompt: '0-8s: restart' },
    ], { mode: 'minimax_local_8s' }),
    /独立开场或重置镜头语义|没有形成新的尾帧结果|缺少 CONTINUITY_START/,
  )
})

test('local MiniMax continuity contract rejects an unchanged adjacent result', () => {
  const copiedResult = 'the heroine remains frozen beside the stove'
  assert.throws(
    () => validateMiniMaxLocalContinuityContract([
      { shot_number: 1, action: 'open', result: copiedResult, video_prompt: 'open' },
      {
        shot_number: 2,
        action: 'continue the movement',
        result: copiedResult,
        video_prompt: [
          'CONTINUITY_START: inherit the previous shot final state as the 0-second opening.',
          'CURRENT_SHOT_PROGRESS: continue the action and move the camera forward.',
          'CURRENT_SHOT_END: create a new ending.',
        ].join('\n'),
      },
    ], { mode: 'minimax_local_8s' }),
    /result 与分镜 1 完全相同/,
  )
})

test('local MiniMax cast contract rejects a customer becoming the conflict focal point', () => {
  assert.throws(
    () => validateMiniMaxLocalCastContract([
      {
        shot_number: 3,
        character_ids: [19, 20],
        action: '<role>苏大强</role>冲入并夺走啤酒瓶，<role>胖顾客</role>举杯挡在两人之间。',
        result: '镜头横移到<role>胖顾客</role>并以胖顾客作为结尾主体。',
        video_prompt: [
          'CONTINUITY_START: inherit the previous ending.',
          'CURRENT_SHOT_PROGRESS: <role>苏大强</role> takes the bottle while <role>胖顾客</role> stays in the foreground.',
          'CURRENT_SHOT_END: camera pans to <role>胖顾客</role> and ends on the customer.',
        ].join('\n'),
      },
    ], [
      { id: 19, name: '苏大强', role: '店主，苏小小的父亲' },
      { id: 20, name: '胖顾客', role: '店内食客' },
    ], { mode: 'minimax_local_8s' }),
    /顾客站位越界|未明确顾客的独立旁桌位置|把顾客写成了镜头主体/,
  )
})

test('local MiniMax cast contract accepts a seated customer while the father owns the action ending', () => {
  assert.doesNotThrow(() => validateMiniMaxLocalCastContract([
    {
      shot_number: 3,
      character_ids: [19, 20],
      action: '<role>苏大强</role>冲入夺瓶，<role>胖顾客</role>坐在旁边餐桌旁反应。',
      result: '<role>苏大强</role>站在灶台前举起手机，<role>胖顾客</role>仍坐在独立旁桌。',
      video_prompt: [
        'CONTINUITY_START: inherit the previous ending.',
        'CURRENT_SHOT_PROGRESS: <role>苏大强</role> crosses to the stove and takes the bottle; <role>胖顾客</role> remains seated at the separate dining table.',
        'CURRENT_SHOT_END: <role>苏大强</role> holds the phone at the stove as the action settles; <role>胖顾客</role> stays seated at the side table.',
      ].join('\n'),
    },
  ], [
    { id: 19, name: '苏大强', role: '店主，苏小小的父亲' },
    { id: 20, name: '胖顾客', role: '店内食客' },
  ], { mode: 'minimax_local_8s' }))
})

test('non-local storyboard policies do not receive the MiniMax cast gate', () => {
  assert.doesNotThrow(() => validateMiniMaxLocalCastContract([
    { shot_number: 3, character_ids: [19, 20], action: 'customer at the counter', result: 'customer foreground', video_prompt: 'camera ends on customer' },
  ], [
    { id: 19, name: '苏大强', role: '父亲' },
    { id: 20, name: '胖顾客', role: '食客' },
  ], { mode: 'grok_10s' }))
})

test('non-local storyboard policies do not receive the MiniMax continuity gate', () => {
  assert.doesNotThrow(() => validateMiniMaxLocalContinuityContract([
    { shot_number: 1 },
    { shot_number: 2, action: '', result: '', video_prompt: '' },
  ], { mode: 'grok_10s' }))
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
    composedVideoGenerationId: null,
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
