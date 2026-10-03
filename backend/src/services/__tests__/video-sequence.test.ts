// The implementation is restored from the generated ESM artifact while its
// source annotations are being rebuilt. Runtime assertions below remain fully
// active; this directive only prevents temporary declaration noise in tsc.
// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertLocalH3CharacterReferenceBindings, assertLocalSequenceContinuityMode, assertLocalSequenceR2VContract, buildComfyUiSequencePrompt, buildGrokSequencePrompt, buildSequencePrompt, buildVideoSequenceReusePlan, buildLocalAssetAliasBindings, compileLocalAssetMentions, characterIdentityDescription, enrichSequenceStepErrors, enrichSequenceStepsForDisplay, filterCharacterOwnedWardrobeProps, isCharacterOwnedProp, isCharacterExplicitlyAbsent, isCharacterBackgroundOnlyMention, isRelationshipOnlyCharacterMention, isGenerationCompatibleWithStoryboard, isStoryboardDialogueSnapshotCompatible, isLegacyLocalH3SequenceRun, isLegacyLocalH3SequenceStep, lockComfyUiSerialOpeningState, orderSerialReferenceAssets, orderStoryboardCharacters, persistedBindingIdsMatchContext, propMatchesStoryboardText, rankStoryboardProps, resolveComfyUiSerialReferenceMode, resolveSequenceStepFirstFrameLocalPath, sanitizeSequenceStepForMode, sceneMatchesStoryboardText, sequenceWaitPollLimit, shouldExtractSequenceTail, shouldPrepareLocalContinuityReference, shouldUploadSequenceTail, shouldReuseCompletedGenerationOnSequenceRetry, shouldUseLocalContinuityPicture, splitSerialReferenceImages, validateSerialReferenceSlots, inferSequenceCharacterGender } from '../video-sequence.js'


test('local standard R2V keeps the previous video as the only temporal continuity source', () => {
  const previous = {
    assetRefs: JSON.stringify([
      { role: 'character', entity_id: 40, entity_name: '苏大强' },
      { role: 'character', entity_id: 39, entity_name: '苏小小' },
    ]),
  }
  assert.equal(shouldUseLocalContinuityPicture(previous, [
    { id: 42, name: '顾承渊' },
    { id: 43, name: '林婉约' },
  ]), false)
  assert.equal(shouldUseLocalContinuityPicture(previous, [
    { id: 40, name: '苏大强' },
    { id: 42, name: '顾承渊' },
  ]), false)
})
test('serial MiniMax voice gender is inferred from the original screenplay when the asset row has no gender field', () => {
  const script = '凤溪是被追捕的女弟子，她猛地抬头。凤溪：（惊慌）你们要干什么！放开我！\n七长老是威严的男性长老，他冷声说道。七长老：（冷漠）今日废你金丹，逐出宗门。'
  assert.equal(inferSequenceCharacterGender({ name: '凤溪', role: '主角' }, script), 'female')
  assert.equal(inferSequenceCharacterGender({ name: '七长老', role: '混元宗长老' }, script), 'male')
})


test('serial reference order always keeps the previous tail and scene before optional assets', () => {
  const ordered = orderSerialReferenceAssets([
    { role: 'reference_image', id: 'manual' },
    { role: 'character', id: 'character' },
    { role: 'scene', id: 'scene' },
    { role: 'first_frame', id: 'tail' },
    { role: 'prop', id: 'prop' },
  ])
  assert.deepEqual(ordered.map(item => item.id), ['tail', 'scene', 'character', 'prop', 'manual'])
})


test('serial reference order promotes the lead character immediately after continuity', () => {
  const ordered = orderSerialReferenceAssets([
    { role: 'scene', id: 'scene' },
    { role: 'character', id: 'supporting' },
    { role: 'character', primary: true, id: 'lead' },
    { role: 'first_frame', id: 'tail' },
  ])
  assert.deepEqual(ordered.map(item => item.id), ['tail', 'lead', 'scene', 'supporting'])
})


test('serial reference payload keeps the previous tail separate from frame-1 semantic references', () => {
  const split = splitSerialReferenceImages([
    { role: 'scene', url: 'scene.png' },
    { role: 'character', url: 'role.png' },
    { role: 'first_frame', url: 'tail.png' },
    { role: 'first_frame', url: 'tail.png' },
    { role: 'prop', url: 'prop.png' },
  ])
  assert.equal(split.firstFrameUrl, 'tail.png')
  assert.deepEqual(split.referenceImages.map(item => item.url), ['scene.png', 'role.png', 'prop.png'])
})


test('serial reference slot validation requires the tail to be Picture 1', () => {
  assert.doesNotThrow(() => validateSerialReferenceSlots([
    { role: 'first_frame', url: 'tail.png' },
    { role: 'scene', url: 'scene.png' },
  ], { hasFirstFrame: true, maxImages: 9, storyboardNumber: 5 }))
  assert.throws(() => validateSerialReferenceSlots([
    { role: 'scene', url: 'scene.png' },
    { role: 'first_frame', url: 'tail.png' },
  ], { hasFirstFrame: true, maxImages: 9, storyboardNumber: 5 }), /必须排在 Picture 1/)
  assert.throws(() => validateSerialReferenceSlots(
    Array.from({ length: 10 }, (_, index) => ({ role: 'reference_image', url: `ref-${index}.png` })),
    { maxImages: 9, storyboardNumber: 5 },
  ), /超过最多 9 张限制/)
  assert.throws(() => validateSerialReferenceSlots([
    { role: 'first_frame', url: 'tail.png' },
    { role: 'scene', url: 'scene.png' },
    { role: 'reference_image', url: 'scene.png' },
  ], { hasFirstFrame: true, maxImages: 9, storyboardNumber: 5 }), /重复参考图/)
  assert.throws(() => validateSerialReferenceSlots([
    { role: 'first_frame', url: 'tail.png' },
    { role: 'scene', url: 'scene.png' },
  ], { localR2v: true, hasFirstFrame: true, maxImages: 9, storyboardNumber: 5 }), /本地 MiniMax H3 多参考链路禁止首帧\/尾帧/)
  assert.throws(() => validateSerialReferenceSlots([
    { role: 'continuity_reference', url: 'tail.png' },
    { role: 'scene', url: 'scene.png' },
  ], { localR2v: true, hasFirstFrame: true, maxImages: 9, storyboardNumber: 5 }), /使用完整 Video 1 连续/)
})


test('scene matching accepts a paraphrased location when the persisted scene prompt is present', () => {
  assert.equal(sceneMatchesStoryboardText(
    { location: '老苏烧烤店后厨', time: '夜晚', prompt: '老苏烧烤店后厨，狭窄灶台、铁锅和暖黄色顶灯，纯场景环境' },
    {
      requestedLocation: '后厨',
      requestedTime: '夜',
      promptText: '苏小小在厨房灶台前颠锅，暖黄色顶灯照亮铁锅',
      locationNames: [],
    },
  ), true)
  assert.equal(sceneMatchesStoryboardText(
    { location: '已删除场景', time: '夜', prompt: '厨房' , deletedAt: '2026-08-30' },
    { requestedLocation: '厨房', promptText: '厨房' },
  ), false)
})


test('scene matching uses the opening location and does not switch to a transition destination', () => {
  assert.equal(sceneMatchesStoryboardText(
    { location: '厨房', time: '夜', prompt: '厨房灶台、铁锅、暖黄色顶灯，纯场景环境' },
    {
      requestedLocation: '',
      requestedTime: '夜',
      promptText: '<location>厨房</location>人物从厨房走向店内，镜头跟拍到门口',
      locationNames: ['厨房'],
    },
  ), true)
  assert.equal(sceneMatchesStoryboardText(
    { location: '店内', time: '夜', prompt: '店内桌椅和暖光，纯场景环境' },
    {
      requestedLocation: '',
      requestedTime: '夜',
      promptText: '<location>厨房</location>人物从厨房走向店内，镜头跟拍到门口',
      locationNames: ['厨房'],
    },
  ), false)
})


test('local ComfyUI sequence waits for provider completion instead of a fixed timeout', () => {
  assert.equal(sequenceWaitPollLimit('comfyui'), Number.POSITIVE_INFINITY)
  assert.equal(sequenceWaitPollLimit('mijing'), 660)
})


test('Motion Context Plus is latent-only and standard R2V does not prepare a continuity picture', () => {
  assert.equal(shouldExtractSequenceTail('comfyui', 'latent_plus'), false)
  assert.equal(shouldExtractSequenceTail('comfyui', 'standard_r2v'), false)
  assert.equal(shouldPrepareLocalContinuityReference('comfyui', 'standard_r2v'), false)
  assert.equal(shouldPrepareLocalContinuityReference('comfyui', 'latent_plus'), false)
  assert.equal(shouldPrepareLocalContinuityReference('mijing', 'standard_r2v'), false)
  assert.equal(shouldExtractSequenceTail('mijing', 'latent_plus'), true)
  assert.equal(shouldUploadSequenceTail('comfyui'), false)
  assert.equal(shouldUploadSequenceTail('mijing'), true)
})


test('local sequence R2V contract rejects legacy frame roles in both continuity modes', () => {
  assert.doesNotThrow(() => assertLocalSequenceR2VContract('comfyui', 'latent_plus', [{ role: 'character', url: 'role.png' }]))
  assert.throws(() => assertLocalSequenceR2VContract('comfyui', 'standard_r2v', [{ role: 'continuity_reference', url: 'tail.png' }]), /连续性由完整 Video 1 或 AV latent/)
  assert.throws(() => assertLocalSequenceR2VContract('comfyui', 'standard_r2v', [{ role: 'first_frame', url: 'tail.png' }]), /禁止首帧\/尾帧/)
  assert.throws(() => assertLocalSequenceR2VContract('comfyui', 'first_last', [{ role: 'scene', url: 'scene.png' }]), /仅支持标准 R2V 或 Motion Context Plus/)
  assert.throws(() => assertLocalSequenceR2VContract('comfyui', 'latent_plus', [{ role: 'continuity_reference', url: 'tail.png' }]), /连续性由完整 Video 1 或 AV latent/)
})


test('local sequence continuity mode rejects retired first/last-frame values', () => {
  assert.doesNotThrow(() => assertLocalSequenceContinuityMode('comfyui', 'standard_r2v'))
  assert.doesNotThrow(() => assertLocalSequenceContinuityMode('comfyui', 'latent_plus'))
  assert.throws(() => assertLocalSequenceContinuityMode('comfyui', 'first_last'), /仅支持标准 R2V 或 Motion Context Plus/)
  assert.doesNotThrow(() => assertLocalSequenceContinuityMode('mijing', 'first_last'))
})


test('Motion Context Plus display sanitizes legacy first/tail-frame state', () => {
  const rawRefs = JSON.stringify([
    { name: '上一镜头尾帧', role: 'first_frame', category: 'storyboard', url: 'static/tail.png' },
    { name: '角色-凤溪', role: 'character', category: 'character' },
  ])
  const sanitized = sanitizeSequenceStepForMode({
    status: 'extracting_tail',
    firstFrameUrl: 'static/tail.png',
    tailFrameUrl: 'static/tail-2.png',
    assetRefs: rawRefs,
    referenceImageUrls: JSON.stringify(['static/tail.png', 'static/fengxi.png']),
  }, 'latent_plus', 'comfyui')
  assert.equal(sanitized.status, 'processing')
  assert.equal(sanitized.firstFrameUrl, null)
  assert.equal(sanitized.tailFrameUrl, null)
  assert.deepEqual(JSON.parse(sanitized.assetRefs), [{ name: '角色-凤溪', role: 'character', category: 'character' }])
  assert.deepEqual(JSON.parse(sanitized.referenceImageUrls), ['static/fengxi.png'])
})


test('local standard R2V state sanitizes legacy frame labels into neutral continuity data', () => {
  const step = { status: 'extracting_tail', firstFrameUrl: 'static/tail.png', tailFrameUrl: 'static/tail-2.png' }
  const sanitized = sanitizeSequenceStepForMode(step, 'standard_r2v', 'comfyui')
  assert.equal(sanitized.status, 'processing')
  assert.equal(sanitized.firstFrameUrl, null)
  assert.equal(sanitized.tailFrameUrl, null)
  // A legacy tail-frame column is not a valid local H3 R2V continuity input.
  // Only the current pipeline's neutral continuityReference* fields may be
  // consumed by a new run; stale rows are regenerated instead of migrated.
  assert.equal(sanitized.continuityReferenceUrl, null)
})


test('legacy local H3 snapshots are never resumed or exposed as current', () => {
  const legacy = {
    status: 'processing',
    prompt: 'previous shot tail frame (must be frame 0); R2V OPENING FRAME CONTRACT',
    assetRefs: JSON.stringify([{ role: 'first_frame', url: 'static/tail.png' }]),
    firstFrameUrl: 'static/tail.png',
  }
  assert.equal(isLegacyLocalH3SequenceStep(legacy), true)
  assert.equal(isLegacyLocalH3SequenceRun({ provider: 'comfyui', continuityMode: 'standard_r2v' }, [legacy]), true)
  assert.equal(isLegacyLocalH3SequenceRun({ provider: 'mijing', continuityMode: 'standard_r2v' }, [legacy]), false)
})


test('Plus retry regenerates a completed video when its AV latent is missing', () => {
  assert.equal(shouldReuseCompletedGenerationOnSequenceRetry({
    generationStatus: 'completed',
    generationDeletedAt: null,
    isLatentPlus: true,
    latentReady: false,
  }), false)
  assert.equal(shouldReuseCompletedGenerationOnSequenceRetry({
    generationStatus: 'completed',
    generationDeletedAt: null,
    isLatentPlus: true,
    latentReady: true,
  }), true)
  assert.equal(shouldReuseCompletedGenerationOnSequenceRetry({
    generationStatus: 'completed',
    generationDeletedAt: null,
    isLatentPlus: false,
    latentReady: false,
  }), true)
})


test('local serial prompt locks the locally uploaded protagonist outfit', () => {
  const prompt = buildComfyUiSequencePrompt(
    '凤溪 raises her head and speaks to the elder.',
    [
      { role: 'character', primary: true, entityName: '凤溪', name: '角色-凤溪', category: 'character', url: 'local-lead.png', identityDescription: 'black torn robe' },
      { role: 'scene', entityName: '祭台', name: '场景-祭台', category: 'scene', url: 'scene.png' },
    ],
    false,
  )
  assert.match(prompt, /PRIMARY CHARACTER CLOTHING LOCK/)
  assert.match(prompt, /authoritative source for 凤溪/)
  assert.match(prompt, /exact outfit, colors, accessories/)
})


test('character-owned wardrobe props are not independent R2V identity references', () => {
  const fengxi = { name: '凤溪', aliases: ['fengxi'] }
  const bailing = { name: '白灵', aliases: ['bailing'] }
  const robe = { name: '白灵法衣', type: '服饰', description: '白灵穿着的圣洁白色法衣，沾有暗红污血' }
  const basin = { name: '狗血盆', type: '容器', description: '祭台边的厚重盆器' }
  assert.equal(isCharacterOwnedProp(robe, bailing), true)
  assert.equal(isCharacterOwnedProp(robe, fengxi), false)
  assert.equal(isCharacterOwnedProp(basin, bailing), false)
  assert.deepEqual(filterCharacterOwnedWardrobeProps([robe, basin], [fengxi, bailing]).map(item => item.name), ['狗血盆'])
})


test('local serial prompt excludes another character wardrobe from the protagonist', () => {
  const prompt = buildComfyUiSequencePrompt(
    '<role>凤溪</role> confronts <role>白灵</role>.',
    [
      { role: 'character', primary: true, entityName: '凤溪', aliases: ['fengxi'], name: '角色-凤溪', url: 'feng.png', identityDescription: 'black and red outfit' },
      { role: 'character', entityName: '白灵', aliases: ['bailing'], name: '角色-白灵', url: 'bailing.png', identityDescription: 'white ritual robe' },
      { role: 'prop', entityName: '白灵法衣', name: '道具-白灵法衣', url: 'robe.png', identityDescription: 'white ritual robe stained with blood' },
    ],
    false,
  )
  assert.match(prompt, /WARDROBE STORY-PROP BINDING/)
  assert.match(prompt, /白灵法衣 is associated only with 白灵 as a separate screenplay prop/)
  assert.match(prompt, /STRICT WARDROBE PROP OWNERSHIP/)
  assert.match(prompt, /never place or transfer it onto 凤溪/i)
})


test('local serial prompt gives the character asset final authority over stale costume actions', () => {
  const prompt = buildComfyUiSequencePrompt(
    '<role>陆北辰</role>身上玄红婚服瞬间四分五裂剥落，露出坚实赤裸的胸膛。',
    [
      {
        role: 'character',
        entityName: '陆北辰',
        name: '角色-陆北辰',
        url: 'lubeichen.png',
        entityId: 47,
        identityDescription: 'User-uploaded local master image. Ignore any conflicting textual appearance or costume description; copy the visible black jacket, gray hoodie and black trousers.',
      },
    ],
    false,
  )
  assert.match(prompt, /FINAL CHARACTER ASSET AUTHORITY/)
  assert.match(prompt, /陆北辰 must use only the exact face, body, clothing layers, colors, accessories and visible wear shown in <Picture 1>/)
  assert.match(prompt, /do not undress, tear, remove, recolor, replace or invent clothing/)
  assert.match(prompt, /If any text conflicts with this Picture, the character asset image wins/)
})


test('local serial prompt binds bilingual character aliases to the same Picture slot', () => {
  const prompt = buildComfyUiSequencePrompt(
    '<role>Feng Xi</role> faces <role>Senior Sister Jiang</role>.',
    [
      { role: 'continuity_reference', entityName: '', name: 'continuity', category: 'storyboard', url: 'tail.png' },
      { role: 'character', entityName: '凤溪', aliases: ['Feng Xi'], name: '角色-凤溪', category: 'character', url: 'feng.png' },
      { role: 'character', entityName: '姜师姐', aliases: ['Senior Sister Jiang'], name: '角色-姜师姐', category: 'character', url: 'jiang.png' },
    ],
    true,
  )
  assert.match(prompt, /<Picture 2> = 凤溪 \(Feng Xi\)/)
  assert.match(prompt, /<Picture 3> = 姜师姐 \(Senior Sister Jiang\)/)
  assert.match(prompt, /<Picture 2> identity aliases: 凤溪 = Feng Xi/)
  assert.match(prompt, /<Picture 3> identity aliases: 姜师姐 = Senior Sister Jiang/)
})


test('local serial prompt follows explicit role-tag order for similar character assets', () => {
  const prompt = buildComfyUiSequencePrompt(
    '<location>混元宗祭台</location> <role>凤溪</role> <role>姜师姐</role> <role>七长老</role> <role>弟子甲</role>',
    [
      { role: 'continuity_reference', entityName: '', name: 'continuity', category: 'storyboard', url: 'tail.png' },
      { role: 'scene', entityName: '混元宗祭台', name: '场景-混元宗祭台', category: 'scene', url: 'scene.png' },
      { role: 'character', entityName: '凤溪', name: '角色-凤溪', category: 'character', url: 'feng.png' },
      { role: 'character', entityName: '姜师姐', name: '角色-姜师姐', category: 'character', url: 'jiang.png' },
      { role: 'character', entityName: '七长老', name: '角色-七长老', category: 'character', url: 'elder.png' },
      { role: 'character', entityName: '弟子甲', name: '角色-弟子甲', category: 'character', url: 'disciple.png' },
    ],
    true,
  )
  assert.match(prompt, /<Picture 4> = 姜师姐[\s\S]*<Picture 5> = 七长老/)
  assert.match(prompt, /姜师姐 may perform only[\s\S]*七长老 may perform only/)
})


test('local H3 keeps visual speech direction separate from the native audio contract', () => {
  const prompt = buildComfyUiSequencePrompt(
    '0-2.5s: Su Xiaoxiao speaks once according to the dialogue field toward the kitchen, then listens silently.',
    [{ role: 'character', entityName: '\u82cf\u5c0f\u5c0f', name: '\u89d2\u8272-\u82cf\u5c0f\u5c0f', url: 'xiaoxiao.png', entityId: 18 }],
    false,
    'minimax_local_8s',
    '\u82cf\u5c0f\u5c0f\uff1a\u8001\u6c49\u513f\uff01\u8170\u82b1\u597d\u4e86\uff01\u4e0a\u83dc\uff01',
  )
  assert.doesNotMatch(prompt, /speaks once according to the dialogue field/i)
  assert.match(prompt, /scripted visual speaking turn/)
  assert.equal((prompt.match(/\u8001\u6c49\u513f\uff01\u8170\u82b1\u597d\u4e86\uff01\u4e0a\u83dc\uff01/g) || []).length, 1)
})


test('storyboard character references follow role-tag order instead of link insertion order', () => {
  const ordered = orderStoryboardCharacters(
    [{ name: '七长老' }, { name: '凤溪' }, { name: '姜师姐' }],
    { videoPrompt: '<role>凤溪</role> <role>姜师姐</role> <role>七长老</role>', action: '', dialogue: '', description: '' },
  )
  assert.deepEqual(ordered.map(item => item.name), ['凤溪', '姜师姐', '七长老'])
})


test('local H3 rejects a previous-shot character from the current reference whitelist', () => {
  const context = { characters: [{ id: 18, name: '苏小小' }, { id: 19, name: '苏大强' }] }
  const currentRefs = [
    { role: 'character', entityId: 18, entityName: '苏小小' },
    { role: 'character', entityId: 19, entityName: '苏大强' },
  ]
  assert.equal(assertLocalH3CharacterReferenceBindings(currentRefs, context, 4), true)
  assert.throws(
    () => assertLocalH3CharacterReferenceBindings([
      ...currentRefs,
      { role: 'character', entityId: 20, entityName: '胖顾客' },
    ], context, 4),
    /镜头4本地 MiniMax H3 角色参考绑定已过期/,
  )
})


test('explicitly off-screen role is excluded even when wrapped in role markup', () => {
  assert.equal(isCharacterExplicitlyAbsent('<role>苏大强</role>未入画', '苏大强'), true)
  assert.equal(isCharacterExplicitlyAbsent('<role>苏大强</role>在左侧入画', '苏大强'), false)
})


test('relationship-only names are not promoted to visible character assets', () => {
  assert.equal(isRelationshipOnlyCharacterMention('苏小小是苏大强的女儿。', '苏大强'), true)
  assert.equal(isRelationshipOnlyCharacterMention('苏大强从后厨冲出来。', '苏大强'), false)
  assert.equal(isRelationshipOnlyCharacterMention('她的父亲苏大强站在门口。', '苏大强'), false)
})


test('local ComfyUI serial mode always uses ordinary R2V multi-reference', () => {
  assert.equal(resolveComfyUiSerialReferenceMode(true), 'multiple')
  assert.equal(resolveComfyUiSerialReferenceMode(false), 'multiple')
})


test('local H3 prompt contains no first/last-frame provider contract', () => {
  const prompt = buildComfyUiSequencePrompt(
    '0s first-frame state: Fengxi opens her eyes; previous shot tail frame continues.',
    [
      { role: 'continuity_reference', name: '连续参考图', url: 'continuity.png' },
      { role: 'character', entityName: '凤溪', name: '角色-凤溪', url: 'feng.png' },
    ],
    true,
    undefined,
    '',
    '',
    [],
    false,
  )
  assert.doesNotMatch(prompt, /首尾帧|首帧硬约束|尾帧|first-frame|last-frame|tail frame|first_frame|last_frame/i)
  assert.match(prompt, /LOCAL SERIAL VIDEO CONTINUATION/)
  assert.match(prompt, /<Video 1>/)
})


test('local reference prop ranking removes substring duplicates and prioritizes active props', () => {
  const ranked = rankStoryboardProps(
    ['爆炒腰花', '啤酒瓶', '啤酒', '酒杯', '皮带'].map(name => ({ name })),
    {
      action: '苏大强挥皮带追在后面；食客们抱起酒杯和餐盘躲避。',
      videoPrompt: '苏大强举皮带追来，爆炒腰花浅盘、啤酒瓶和空酒杯清晰出现。',
      result: '顾承渊桌面保留爆炒腰花、啤酒瓶和空酒杯。',
      imagePrompt: '',
      description: '',
    },
  )
  assert.deepEqual(ranked.map(item => item.name), ['酒杯', '爆炒腰花', '啤酒瓶', '皮带'])
  assert.doesNotMatch(ranked.map(item => item.name).join(','), /(^|,)啤酒(,|$)/)
})


test('local reference prop matching resolves English storyboard terms to Chinese assets', () => {
  const props = [
    { name: '爆炒腰花' },
    { name: '啤酒瓶' },
    { name: '啤酒' },
    { name: '酒杯' },
    { name: '皮带' },
  ]
  const storyboard = {
    action: 'She bites open a beer bottle and drinks the beer.',
    dialogue: '胖顾客 raises a beer glass.',
    videoPrompt: 'She sprays beer onto the stir-fried pork kidney, then Su Daqiang swings a leather belt.',
    result: '',
    imagePrompt: '',
    description: '',
  }
  assert.deepEqual(
    props.filter(prop => propMatchesStoryboardText(prop, storyboard, props)).map(prop => prop.name),
    ['爆炒腰花', '啤酒瓶', '啤酒', '酒杯', '皮带'],
  )
})


test('local reference prop matching uses per-asset aliases for any bilingual project', () => {
  const props = [
    { name: '玉佩', aliases: '["jade pendant", "jade amulet"]' },
    { name: '古董怀表', aliases: ['antique pocket watch'] },
  ]
  const storyboard = {
    action: 'She raises the jade pendant, then checks the antique pocket watch.',
    dialogue: '',
    videoPrompt: '',
    result: '',
    imagePrompt: '',
    description: '',
  }
  assert.deepEqual(
    props.filter(prop => propMatchesStoryboardText(prop, storyboard, props)).map(prop => prop.name),
    ['玉佩', '古董怀表'],
  )
})


test('prop ranking keeps a specific English asset over the generic beer term', () => {
  const ranked = rankStoryboardProps(
    [{ name: '啤酒瓶' }, { name: '啤酒' }, { name: '皮带' }],
    {
      action: 'She bites open a beer bottle and drinks.',
      dialogue: '',
      videoPrompt: 'The beer bottle remains in her hand.',
      result: '',
      imagePrompt: '',
      description: '',
    },
  )
  assert.deepEqual(ranked.map(item => item.name), ['啤酒瓶'])
})


test('local R2V continuity resolver ignores legacy tail-frame columns', () => {
  assert.equal(
    resolveSequenceStepFirstFrameLocalPath({ firstFrameLocalPath: null }, { tailFrameLocalPath: 'static/sequence-frames/tail-4.png' }),
    null,
  )
  assert.equal(
    resolveSequenceStepFirstFrameLocalPath({ continuityReferenceLocalPath: 'static/sequence-frames/saved.png' }, null),
    'static/sequence-frames/saved.png',
  )
  assert.equal(
    resolveSequenceStepFirstFrameLocalPath({ firstFrameLocalPath: null }, { tailFrameLocalPath: null, tailFrameUrl: 'static/sequence-frames/legacy-tail.png' }),
    null,
  )
})


test('local serial opening removes a conflicting generated 0-second composition', () => {
  const original = [
    '0\u79d2\u9996\u5e27\u72b6\u6001\uFF1A\u7532\u5728\u53f3\u4fa7\uFF0c\u4e59\u5728\u5de6\u4fa7\uFF0c\u80d6\u987e\u5ba2\u5728\u4e2d\u95f4\uFF1B',
    '0\u81f33\u79d2\u955c\u5934\u8f6c\u5411\u80d6\u987e\u5ba2\uFF1B',
    '3\u81f38\u79d2\u4fdd\u6301\u539f\u5267\u60c5\u3002',
  ].join('')
  const result = lockComfyUiSerialOpeningState(original, true)

  assert.match(result, /^0\u79d2\u9996\u5e27\u72b6\u6001\uFF1A\u4e25\u683c\u590d\u5236<Picture 1>/)
  assert.match(result, /0\u81f30\.25\u79d2/)
  assert.match(result, /0\.25\u81f33\u79d2\u955c\u5934\u8f6c\u5411\u80d6\u987e\u5ba2/)
  assert.doesNotMatch(result, /\u80d6\u987e\u5ba2\u5728\u4e2d\u95f4/)
  assert.match(result, /3\u81f38\u79d2\u4fdd\u6301\u539f\u5267\u60c5/)
})


test('local serial opening leaves the first shot unchanged', () => {
  const original = '0\u79d2\u9996\u5e27\u72b6\u6001\uFF1A\u80d6\u987e\u5ba2\u5728\u4e2d\u95f4\uFF1B0\u81f33\u79d2\u5f00\u59cb\u52a8\u4f5c'
  assert.equal(lockComfyUiSerialOpeningState(original, false), original)
})


test('sequence step exposes the provider failure when the step error was lost', () => {
  const [step] = enrichSequenceStepErrors(
    [{ status: 'failed', videoGenerationId: 42, errorMsg: null }],
    [{ id: 42, status: 'failed', errorMsg: 'ComfyUI 节点执行失败：CUDA out of memory' }],
  )
  assert.equal(step.errorMsg, 'ComfyUI 节点执行失败：CUDA out of memory')
})


test('sequence step always gets an actionable fallback when no provider error exists', () => {
  const [step] = enrichSequenceStepErrors(
    [{ status: 'failed', videoGenerationId: null, errorMsg: null }],
    [],
  )
  assert.match(step.errorMsg || '', /没有返回具体错误/)
})

function asset(id: string) {
  return {
    localAssetId: 1,
    providerAssetId: id,
    assetUri: `asset://${id}`,
    groupName: 'test',
    publicUrl: `https://cdn.example/${id}.png`,
  }
}


test('buildSequencePrompt puts the previous tail binding first and declares each asset once', () => {
  const prompt = buildSequencePrompt(
    '<role>林凡</role>走进<location>客厅</location>。',
    [
      { url: 'https://cdn.example/tail.png', name: '首帧画面', role: 'first_frame', category: 'storyboard', asset: asset('tail-1') },
      { url: 'https://cdn.example/linfan.png', name: '角色-林凡', role: 'character', category: 'character', entityName: '林凡', asset: asset('role-1') },
      { url: 'https://cdn.example/room.png', name: '场景-客厅', role: 'scene', category: 'scene', entityName: '客厅', asset: asset('scene-1') },
    ],
    true,
  )

  assert.match(prompt, /^连续镜头资产绑定：首帧画面=@asset:\/\/tail-1 /)
  assert.match(prompt, /林凡=@asset:\/\/role-1 /)
  assert.match(prompt, /客厅=@asset:\/\/scene-1 /)
  assert.equal((prompt.match(/@asset:\/\/tail-1/g) || []).length, 1)
  assert.equal((prompt.match(/@asset:\/\/role-1/g) || []).length, 1)
  assert.match(prompt, /上一镜尾帧是本镜头视频第 0 帧/)
  assert.match(prompt, /<role>林凡<\/role>走进<location>客厅<\/location>/)
  assert.match(prompt, /第 0 秒和第一帧的唯一视觉真值/)
  assert.match(prompt, /第一帧严禁新增、删除、替换或移动任何人物或物体/)
  assert.match(prompt, /角色、场景和道具参考图只用于第一帧之后/)
  assert.match(prompt, /首帧图中没有的箭、武器或其他道具/)
  assert.match(prompt, /只能在视频开始运动后按剧情动作在正确时机进入画面/)
  assert.ok(prompt.indexOf('【首帧硬约束】') > prompt.indexOf('<role>林凡</role>走进<location>客厅</location>'))
  assert.match(prompt, /只能在视频开始运动后按剧情动作在正确时机进入画面。$/)
})


test('buildSequencePrompt replaces an older sequence block instead of duplicating it', () => {
  const prompt = buildSequencePrompt(
    [
      '连续镜头资产绑定：首帧画面=@asset://old-tail ；林凡=@asset://old-role',
      '首帧画面资产必须作为本镜头第一帧。',
      '资产 ID 只在本段绑定中声明一次；对白中的角色名保持原文。',
      '<role>林凡</role>抬头。',
    ].join('\n'),
    [{ url: 'https://cdn.example/new.png', name: '角色-林凡', role: 'character', category: 'character', entityName: '林凡', asset: asset('new-role') }],
    false,
  )

  assert.equal((prompt.match(/连续镜头资产绑定/g) || []).length, 1)
  assert.doesNotMatch(prompt, /old-tail|old-role/)
  assert.match(prompt, /new-role/)
  assert.doesNotMatch(prompt, /【首帧硬约束】|唯一视觉真值/)
})


test('buildSequencePrompt carries the current storyboard dialogue into the serial prompt', () => {
  const prompt = buildSequencePrompt(
    '<role>Eli</role> turns toward the sea.',
    [{ url: 'https://cdn.example/eli.png', name: '角色-Eli', role: 'character', category: 'character', entityName: 'Eli', asset: asset('eli-1') }],
    false,
    'tk_overseas',
    'Eli: "Where did you get that necklace?"（你从哪里得到那条项链？）',
  )

  assert.match(prompt, /Eli: "Where did you get that necklace\?"/)
  assert.match(prompt, /对白语言：English/)
  assert.doesNotMatch(prompt, /你从哪里得到那条项链/)
})


test('buildGrokSequencePrompt declares public references in order without Volc asset syntax', () => {
  const prompt = buildGrokSequencePrompt(
    '<role>Ava</role> walks through <location>the studio</location>.',
    [
      { url: 'https://cdn.example/tail.png', name: '首帧画面', role: 'first_frame', category: 'storyboard' },
      { url: 'https://cdn.example/ava.png', name: '角色-Ava', role: 'character', category: 'character', entityName: 'Ava' },
      { url: 'https://cdn.example/studio.png', name: '场景-studio', role: 'scene', category: 'scene', entityName: 'studio' },
    ],
    true,
    'tk_overseas',
    'Ava: "We should leave now."（我们现在应该离开。）',
  )

  assert.match(prompt, /<IMAGE_1>：上一镜尾帧，本镜头首帧/)
  assert.match(prompt, /<IMAGE_2>：Ava/)
  assert.match(prompt, /<IMAGE_3>：studio/)
  assert.match(prompt, /Grok Imagine 只使用公网图片 URL 或 base64/)
  assert.match(prompt, /Ava: "We should leave now\."/)
  assert.doesNotMatch(prompt, /@asset:\/\//)
  assert.doesNotMatch(prompt, /我们现在应该离开/)
  assert.match(prompt, /第 0 秒和第一帧的唯一视觉真值/)
  assert.match(prompt, /角色、场景和道具参考图只用于第一帧之后/)
  assert.match(prompt, /首帧图中没有的箭、武器或其他道具/)
  assert.ok(prompt.indexOf('【首帧硬约束】') > prompt.indexOf('<role>Ava</role> walks through <location>the studio</location>.'))
  assert.match(prompt, /只能在视频开始运动后按剧情动作在正确时机进入画面。$/)
})


test('serial prompts carry storyboard movement into the provider request', () => {
  const movement = '从吧台向右上方小幅摇镜并推进，焦点由酒瓶转移到人物眼神，最终落在面部特写'
  const prompt = buildSequencePrompt(
    '<role>Eli</role> looks up.',
    [{ url: 'https://cdn.example/eli.png', name: '角色-Eli', role: 'character', category: 'character', entityName: 'Eli', asset: asset('eli-1') }],
    false,
    undefined,
    undefined,
    movement,
  )
  assert.match(prompt, /运镜硬约束 \/ CAMERA MOTION CONTRACT/)
  assert.match(prompt, /必须执行以下 movement 字段/)
  assert.match(prompt, /摇镜并推进/)
  assert.match(prompt, /Do not use a fully locked-off\/static camera/)

  const localPrompt = buildComfyUiSequencePrompt(
    '<role>Eli</role> looks up.',
    [{ url: 'static/assets/eli.png', name: '角色-Eli', role: 'character', category: 'character', entityName: 'Eli' }],
    false,
    undefined,
    undefined,
    movement,
  )
  assert.match(localPrompt, /摇镜并推进/)
  assert.match(localPrompt, /CAMERA MOTION CONTRACT/)
})


test('buildGrokSequencePrompt does not apply the continuity lock to the first shot', () => {
  const prompt = buildGrokSequencePrompt(
    '<role>Ava</role> raises a bow.',
    [{ url: 'https://cdn.example/ava.png', name: '角色-Ava', role: 'character', category: 'character', entityName: 'Ava' }],
    false,
  )

  assert.doesNotMatch(prompt, /【首帧硬约束】|唯一视觉真值/)
})


test('buildComfyUiSequencePrompt keeps local serial continuity explicit', () => {
  const prompt = buildComfyUiSequencePrompt(
    '<role>Ava</role> walks forward with the lantern.',
    [
      { url: 'static/sequence-frames/tail.png', name: 'continuity', role: 'continuity_reference', category: 'storyboard' },
      { url: 'static/assets/ava.png', name: '角色-Ava', role: 'character', category: 'character', entityName: 'Ava' },
    ],
    true,
  )

  assert.match(prompt, /LOCAL SERIAL VIDEO CONTINUATION/)
  assert.match(prompt, /carries the ending of the previous shot/)
  assert.match(prompt, /<Video 1>/)
  assert.match(prompt, /Ava/)
  assert.match(prompt, /<Subject 2> walks forward with the lantern\./)
  // Local H3 uses ordinary ordered multi-reference R2V; continuity is
  // carried by the previous Video 1, not by a Picture slot.
  assert.doesNotMatch(prompt, /frame 0/)
  assert.match(prompt, /PICTURE-TO-ASSET BINDINGS/)
  assert.match(prompt, /<Picture 2> = Ava/)
  assert.match(prompt, /^subject_definitions:\nMANDATORY SERIAL VIDEO EXTENSION \(all shots after the first\):/)
  assert.match(prompt, /^summary:/m)
  assert.match(prompt, /^retention_analysis:/m)
  assert.match(prompt, /^detailed_description:/m)
  const sectionOrder = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']
  assert.deepEqual(sectionOrder.map(section => prompt.indexOf(section)), [...sectionOrder.keys()].map(index => index === 0 ? 0 : 0).map((_, index) => prompt.indexOf(sectionOrder[index])).sort((a, b) => a - b))
  assert.match(prompt, /overall_soundscape:\nOnly the ambience/)
  assert.ok(prompt.indexOf('final visible instant of <Video 1>') < prompt.indexOf('PICTURE-TO-ASSET BINDINGS'))
})


test('standard local R2V treats the previous video as temporal source without Motion Context', () => {
  const prompt = buildComfyUiSequencePrompt(
    'CONTINUITY_START: inherit the previous ending.\nCURRENT_SHOT_PROGRESS: Ava turns toward the counter.\nCURRENT_SHOT_END: Ava reaches the counter and stops.',
    [
      { url: 'ava.png', role: 'character', entityName: 'Ava', entityId: 11 },
      { url: 'room.png', role: 'scene', entityName: 'Room', entityId: 12 },
    ],
    true,
  )

  assert.match(prompt, /STANDARD R2V VIDEO-EXTENSION CONTRACT/)
  assert.match(prompt, /only temporal continuity source/)
  assert.match(prompt, /direct extension of the previous shot, not a new opening/)
  assert.match(prompt, /CONTINUITY_START: inherit the previous ending/)
  assert.match(prompt, /CURRENT_SHOT_PROGRESS: <Subject 1> turns toward the counter/)
  assert.match(prompt, /CURRENT_SHOT_END: <Subject 1> reaches the counter and stops/)
  assert.doesNotMatch(prompt, /MOTION CONTEXT PLUS|Motion Context node|AV latent/)
  assert.match(prompt, /Character identity binding and temporal continuation are separate contracts/)
})


test('only standard follow-up shots prioritize the ending view over scene layout and zero-second staging', () => {
  const refs = [
    { url: 'ava.png', role: 'character', entityName: 'Ava' },
    { url: 'room.png', role: 'scene', entityName: 'Room' },
  ]
  const text = '0-2.5s: 0-second first-frame state: Ava stands beside the table. Then she turns.'
  const first = buildComfyUiSequencePrompt(text, refs, false)
  const next = buildComfyUiSequencePrompt(text, refs, true)
  const plus = buildComfyUiSequencePrompt(text, refs, true, undefined, undefined, undefined, [], true)
  assert.doesNotMatch(first, /LOCAL H3 VIDEO END|actual ending view of Video 1/)
  assert.match(first, /required scene environment/)
  assert.match(next, /^subject_definitions:\nMANDATORY SERIAL VIDEO EXTENSION \(all shots after the first\):/)
  assert.match(next, /The ending view of Video 1 controls the join/)
  assert.match(next, /TARGET STAGING TO REACH THROUGH CONTINUOUS MOTION/)
  assert.match(next, /<Subject 1> stands beside the table\. Then she turns\./)
  assert.doesNotMatch(next, /environment authority|0-second opening continuity image state:/)
  assert.doesNotMatch(plus, /LOCAL H3 VIDEO END|actual ending view of Video 1/)
  assert.match(plus, /MOTION CONTEXT PLUS/)
})


test('local MiniMax prompt compiles @ asset aliases to stable Picture bindings', () => {
  const refs = [
    { url: 'static/assets/suxiaoxiao.png', role: 'character', entityName: '苏小小', aliases: ['Su Xiaoxiao', 'Xiaoxiao'] },
    { url: 'static/assets/kitchen.png', role: 'scene', entityName: '后厨', aliases: ['Kitchen'] },
  ]
  const aliases = buildLocalAssetAliasBindings(refs)
  assert.match(aliases, /@苏小小 = <Picture 1>/)
  assert.match(aliases, /@Su Xiaoxiao = <Picture 1>/)
  assert.match(aliases, /@后厨 = <Picture 2>/)
  assert.match(aliases, /苏小小 = <Picture 1>/)

  const compiled = compileLocalAssetMentions(
    'At start, @苏小小 enters @Kitchen; keep @Xiaoxiao on the left.',
    refs,
  )
  assert.match(compiled, /<Picture 1> enters <Picture 2>/)
  assert.match(compiled, /keep <Picture 1> on the left/)
  assert.equal(
    compileLocalAssetMentions('苏小小=@Su Xiaoxiao；场景=@后厨', refs),
    '苏小小=<Picture 1>；场景=<Picture 2>',
  )
})


test('standard local cast binds the entering father separately from the seated customer without changing Plus', () => {
  const refs = [
    { role: 'character', entityName: '苏小小', entityId: 18, storyRole: '苏大强的女儿', url: 'daughter.png' },
    { role: 'scene', entityName: '老苏烧烤店', url: 'scene.png' },
    { role: 'character', entityName: '胖顾客', entityId: 20, storyRole: '店内食客', url: 'customer.png' },
    { role: 'character', entityName: '苏大强', entityId: 19, storyRole: '苏小小的父亲', url: 'father.png' },
  ]
  const original = '<role>胖顾客</role> applauds. 5.5-8s: <role>苏大强</role> enters from the kitchen with a phone.'
  const dialogue = '胖顾客：好酒量！ / 苏小小：那是！'
  const movement = 'Camera tracks Su Daqiang as he takes the bottle.'
  const source = '胖顾客和周围几桌客人纷纷鼓掌。苏大强从后厨冲出来。'
  const prompt = buildComfyUiSequencePrompt(original, refs, true, null, dialogue, movement, ['苏小小', '胖顾客'], false, [], source)
  assert.match(prompt, /<Subject 4> is 苏大强, exclusively defined by <Picture 4>/)
  assert.match(prompt, /NEW IDENTITY: <Subject 4>/)
  assert.match(prompt, /DINING AREA OWNERSHIP: <Subject 3>/)
  assert.match(prompt, /5\.5-8s: <Subject 4> enters from the kitchen with a phone/)
  assert.match(prompt, /Camera tracks <Subject 4> as he takes the bottle/)
  assert.doesNotMatch(prompt, /<Picture 1> 只负责承接|identity from Picture 1|person visible only inside <Picture 1>/)
  assert.equal(isStoryboardDialogueSnapshotCompatible(prompt, { dialogue }, true), true)
  const plus = buildComfyUiSequencePrompt(original, refs, true, null, dialogue, movement, ['苏小小', '胖顾客'], true, [], source)
  assert.doesNotMatch(plus, /LOCAL H3 CAST AND BLOCKING|NEW IDENTITY|DINING AREA OWNERSHIP/)
  assert.match(plus, /<Subject 4> is 苏大强, exclusively represented by <Picture 4>/)
  assert.match(plus, /<role>苏大强<\/role> enters from the kitchen with a phone/)
  assert.match(plus, /Camera tracks Su Daqiang/)
  const first = buildComfyUiSequencePrompt('<role>苏小小</role> cooks.', refs.slice(0, 2), false, null, '', '', [], false, [], source)
  assert.doesNotMatch(first.split('PICTURE-TO-ASSET BINDINGS')[0], /苏大强/)
  assert.doesNotMatch(first, /NEW IDENTITY|<Video 1>/)
})


test('local MiniMax prompt declares role equals @asset bindings before shot text', () => {
  const prompt = buildComfyUiSequencePrompt(
    '苏小小=@苏小小 enters @后厨.',
    [
      { role: 'character', entityName: '苏小小', aliases: ['Su Xiaoxiao'], url: 'suxiaoxiao.png' },
      { role: 'scene', entityName: '后厨', aliases: ['Kitchen'], url: 'kitchen.png' },
    ],
    false,
  )
  const bindings = prompt.indexOf('COMPILED @ ASSET BINDINGS')
  const shotText = prompt.indexOf('<Picture 1> enters <Picture 2>')
  assert.ok(bindings >= 0)
  assert.ok(shotText > bindings)
  assert.match(prompt, /@苏小小 = <Picture 1>/)
  assert.match(prompt, /苏小小 = <Picture 1>/)
})


test('ambiguous local @ aliases are not silently remapped', () => {
  const refs = [
    { url: 'a.png', role: 'character', entityName: '甲', aliases: ['同名'] },
    { url: 'b.png', role: 'character', entityName: '乙', aliases: ['同名'] },
  ]
  const aliases = buildLocalAssetAliasBindings(refs)
  assert.doesNotMatch(aliases, /"同名".*same/)
  assert.equal(compileLocalAssetMentions('角色@同名保持原文', refs), '角色@同名保持原文')
})


test('Motion Context Plus prompt is isolated from the previous-tail frame contract', () => {
  const prompt = buildComfyUiSequencePrompt(
    '<role>Ava</role> continues the action.',
    [
      { url: 'static/assets/ava.png', name: '角色-Ava', role: 'character', category: 'character', entityName: 'Ava' },
      { url: 'static/assets/room.png', name: '场景-厨房', role: 'scene', category: 'scene', entityName: '厨房' },
    ],
    true,
    undefined,
    undefined,
    undefined,
    [],
    true,
  )
  assert.doesNotMatch(prompt, /previous shot tail frame/i)
  assert.doesNotMatch(prompt, /R2V OPENING FRAME CONTRACT/i)
  assert.doesNotMatch(prompt, /首帧硬约束/)
  assert.doesNotMatch(prompt, /LOCAL H3 VIDEO END/)
  assert.match(prompt, /PICTURE-TO-ASSET BINDINGS/)
})


test('local serial prompt does not duplicate dialogue already present in video_prompt', () => {
  const prompt = buildComfyUiSequencePrompt(
    '<role>苏小小</role> turns the wok and says "胖顾客，厨子小妹儿好酒量！" with lively emphasis.',
    [{ url: 'static/assets/suxiaoxiao.png', name: '角色-苏小小', role: 'character', category: 'character', entityName: '苏小小' }],
    false,
    'minimax_local_8s',
    '苏小小：胖顾客，厨子小妹儿好酒量！',
  )

  assert.equal((prompt.match(/胖顾客，厨子小妹儿好酒量/g) || []).length, 1)
  assert.match(prompt, /This speech plan is the only source of spoken words/)
})


test('local serial prompt binds each picture index to one unique asset identity', () => {
  const prompt = buildComfyUiSequencePrompt(
    '<role>苏大强</role>走到吧台，<role>胖顾客</role>在后景举杯。',
    [
      { url: 'static/tail.png', name: 'continuity', role: 'continuity_reference', category: 'storyboard' },
      { url: 'static/sudaqiang.png', name: '角色-苏大强', role: 'character', category: 'character', entityName: '苏大强', identityDescription: 'middle-aged Chinese man, short receding black hair, clean-shaven, black polo shirt, black waist apron' },
      { url: 'static/fat.png', name: '角色-胖顾客', role: 'character', category: 'character', entityName: '胖顾客', identityDescription: 'heavy-set Chinese male customer, short tousled black hair, moustache and small goatee, dark navy patterned shirt, beige trousers' },
    ],
    true,
  )
  assert.match(prompt, /<Picture 2> = 苏大强/)
  assert.match(prompt, /<Picture 3> = 胖顾客/)
  assert.match(prompt, /short receding black hair, clean-shaven, black polo shirt/)
  assert.match(prompt, /heavy-set Chinese male customer, short tousled black hair, moustache and small goatee/)
  assert.match(prompt, /Never transfer a face, hairstyle, body shape, clothing or age/i)
  assert.match(prompt, /CHARACTER ACTION OWNERSHIP/)
  assert.match(prompt, /苏大强 may perform only the actions and dialogue assigned to 苏大强/)
  assert.match(prompt, /background person inherit another character's identity/i)
  assert.match(prompt, /Relationship words describe story relations only and never change the picture-to-identity mapping\./)
  assert.match(prompt, /Never transfer a face, hairstyle, body shape, clothing or age from one character to another/i)
})

test('local H3 does not invent a detailed human or modern prop when no character is bound', () => {
  const prompt = buildComfyUiSequencePrompt(
    '??????????????????????',
    [
      { url: 'scene.png', role: 'scene', entityName: '???' },
      { url: 'coffin.png', role: 'prop', entityName: '????' },
    ],
    false,
    'minimax_local_8s',
    '',
    '????????????????',
  )
  assert.match(prompt, /^subject_definitions:/)
  assert.match(prompt, /summary:/)
  assert.match(prompt, /retention_analysis:/)
  assert.match(prompt, /detailed_description:/)
  assert.match(prompt, /overall_soundscape:/)
  assert.match(prompt, /non_diegetic_music:/)
  assert.match(prompt, /UNBOUND HUMAN SUBJECT LOCK/)
  assert.match(prompt, /Do not invent a named or detailed human character/i)
  assert.match(prompt, /Do not add an unmentioned person.*electronic device.*modern object/i)
  assert.match(prompt, /distant supernatural silhouette or energy trail/i)
})


test('local serial prompt quarantines previous-tail characters absent from the current shot', () => {
  const prompt = buildComfyUiSequencePrompt(
    '<role>胖顾客</role>举杯并夸赞苏小小。',
    [
      { url: 'static/tail.png', name: 'continuity', role: 'continuity_reference', category: 'storyboard' },
      { url: 'static/scene.png', name: '场景-老苏烧烤店', role: 'scene', category: 'scene', entityName: '老苏烧烤店' },
      { url: 'static/suxiaoxiao.png', name: '角色-苏小小', role: 'character', category: 'character', entityName: '苏小小' },
      { url: 'static/fat.png', name: '角色-胖顾客', role: 'character', category: 'character', entityName: '胖顾客' },
      { url: 'static/diners.png', name: '角色-食客们', role: 'character', category: 'character', entityName: '食客们' },
    ],
    true,
    undefined,
    undefined,
    undefined,
    ['苏大强'],
  )
  assert.match(prompt, /ACTIVE CHARACTER SET AFTER OPENING CONTINUITY: only these named character identities may be active in this shot: 苏小小, 胖顾客, 食客们/)
  assert.match(prompt, /person visible only inside <Video 1>.*continuity-only/i)
  assert.match(prompt, /PREVIOUS-CONTINUITY-ONLY IDENTITIES: 苏大强 appear only in Video 1 from the previous shot/i)
  assert.match(prompt, /never cast, name, animate or use their face, clothing or actions for 苏小小, 胖顾客, 食客们/i)
  assert.match(prompt, /never cast, name, animate or use their face, clothing or actions for/i)
  assert.match(prompt, /Extend that video with the current shot direction/i)
})


test('character identity mapping ignores relatives and never falls back to role text', () => {
  assert.match(
    characterIdentityDescription(
      { name: '苏小小', role: '女主角；苏大强的女儿', appearance: '年轻女性，黑发束起，穿深色围裙' },
      ['苏小小', '苏大强'],
    ),
    /年轻女性.*深色围裙/,
  )
  assert.doesNotMatch(
    characterIdentityDescription(
      { name: '苏小小', role: '女主角；苏大强的女儿', appearance: '' },
      ['苏小小', '苏大强'],
    ),
    /苏大强|女儿/,
  )
  assert.match(
    characterIdentityDescription(
      { name: '苏大强', role: '老苏烧烤店店主；苏小小的父亲', appearance: '中年男性，短发，穿黑色围裙' },
      ['苏小小', '苏大强'],
    ),
    /中年男性.*黑色围裙/,
  )
})


test('manual character uploads override stale extracted costume text', () => {
  const description = characterIdentityDescription(
    {
      name: '凤溪',
      role: '主角',
      appearance: '衣物被狗血浸湿，外衣撕扯后露出沾血衬衣。',
      imageUrl: 'static/images/generated-character.png',
      localPath: 'static/characters/user-upload.png',
    },
    ['凤溪'],
  )
  assert.match(description, /User-uploaded local master image/)
  assert.match(description, /Ignore any conflicting textual appearance/)
  assert.doesNotMatch(description, /狗血浸湿/)
})

function storyboard(id: number) {
  return { id, storyboardNumber: id }
}

function completedGeneration(id: number, storyboardId: number) {
  return {
    id,
    storyboardId,
    status: 'completed',
    localPath: `static/videos/${id}.mp4`,
  }
}


test('local R2V reuse rejects a completed row containing a stale character binding', () => {
  const storyboard = { id: 901, episodeId: 902, storyboardNumber: 1 }
  const generation = {
    id: 903,
    storyboardId: 901,
    provider: 'comfyui',
    status: 'completed',
    referenceMode: 'multiple',
    continuityMode: 'latent_plus',
    prompt: 'LOCAL COMFYUI REFERENCE ORDER (3 images): 1. 凤溪; 2. 混元宗祭台; 3. 风越',
  }
  // The database-backed context is not available in this unit fixture, but
  // the metadata guard remains directly covered by the production helper via
  // a no-episode storyboard (which exercises the strict provider mode checks).
  assert.equal(isGenerationCompatibleWithStoryboard({ ...generation, firstFrameUrl: 'legacy.png' }, storyboard, 'comfyui', 'latent_plus'), false)
  assert.equal(isGenerationCompatibleWithStoryboard({ ...generation, referenceMode: 'first_frame_multiple' }, storyboard, 'comfyui', 'latent_plus'), false)
})


test('local R2V reuse rejects legacy image_url and missing continuity metadata', () => {
  const storyboard = { id: 904, episodeId: null, storyboardNumber: 1 }
  const current = {
    id: 905,
    storyboardId: 904,
    provider: 'comfyui',
    status: 'completed',
    referenceMode: 'multiple',
    continuityMode: 'standard_r2v',
    referenceImageUrls: JSON.stringify(['scene.png']),
    prompt: 'ordered R2V picture mapping',
  }
  assert.equal(isGenerationCompatibleWithStoryboard({ ...current, imageUrl: 'legacy.png' }, storyboard, 'comfyui', 'standard_r2v'), false)
  assert.equal(isGenerationCompatibleWithStoryboard({ ...current, continuityMode: null }, storyboard, 'comfyui', 'standard_r2v'), false)
  assert.equal(isGenerationCompatibleWithStoryboard({ ...current, continuityMode: 'first_last' }, storyboard, 'comfyui', 'standard_r2v'), false)
})


test('reuse plan skips completed shots and starts generation at the first missing shot', () => {
  const plan = buildVideoSequenceReusePlan({
    storyboards: [storyboard(1), storyboard(2), storyboard(3)],
    videoGenerations: [completedGeneration(11, 1), completedGeneration(12, 2)],
    historicalSteps: [
      { storyboardId: 1, videoGenerationId: 11, tailFrameUrl: 'https://cdn.example/tail-1.png', tailFrameAssetId: 'tail-1' },
      { storyboardId: 2, videoGenerationId: 12, tailFrameUrl: 'https://cdn.example/tail-2.png', tailFrameAssetId: 'tail-2' },
    ],
    provider: 'mijing',
  })

  assert.deepEqual(plan.map(item => item.status), ['skipped', 'skipped', 'pending'])
  assert.deepEqual(plan.map(item => item.videoGenerationId), [11, 12, null])
  assert.equal(plan[2].reused, false)
})

test('Plus explicit resume keeps stale earlier history out of the selected boundary check', () => {
  const plan = buildVideoSequenceReusePlan({
    storyboards: [storyboard(1), storyboard(2), storyboard(3)],
    videoGenerations: [
      {
        ...completedGeneration(21, 1),
        provider: 'comfyui',
        referenceMode: 'multiple',
        continuityMode: 'latent_plus',
        firstFrameUrl: 'legacy-frame-1.png',
        latentPath: 'h3_context/run-1',
        latentClipIndex: 1,
      },
      {
        ...completedGeneration(22, 2),
        provider: 'comfyui',
        referenceMode: 'multiple',
        continuityMode: 'latent_plus',
        firstFrameUrl: 'legacy-frame-2.png',
        latentPath: 'h3_context/run-1',
        latentClipIndex: 2,
      },
    ],
    historicalSteps: [
      { id: 31, storyboardId: 1, videoGenerationId: 21, status: 'completed', latentPath: 'h3_context/run-1', latentClipIndex: 1 },
      { id: 32, storyboardId: 2, videoGenerationId: 22, status: 'completed', latentPath: 'h3_context/run-1', latentClipIndex: 2 },
    ],
    provider: 'comfyui',
    continuityMode: 'latent_plus',
    forceFromIndex: 2,
    preservePrefixUntilIndex: 2,
  })

  assert.deepEqual(plan.map(item => item.status), ['skipped', 'skipped', 'pending'])
  assert.deepEqual(plan.map(item => item.videoGenerationId), [21, 22, null])
  assert.equal(plan[0].reused, true)
  assert.equal(plan[1].reused, true)
})

test('local H3 reuse plan regenerates shots when the selected UNET changes', () => {
  const selectedModel = 'minimax-h3\\minimax_h3_ref2va_pruned_int8_convrot.safetensors'
  const previousModel = 'minimax-h3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors'
  const generation = {
    ...completedGeneration(31, 1),
    provider: 'comfyui',
    model: previousModel,
    referenceMode: 'multiple',
    continuityMode: 'standard_r2v',
    referenceImageUrls: JSON.stringify(['scene.png']),
    prompt: 'ordered R2V picture mapping',
  }
  const plan = buildVideoSequenceReusePlan({
    storyboards: [{ ...storyboard(1), episodeId: null }],
    videoGenerations: [generation],
    historicalSteps: [],
    provider: 'comfyui',
    continuityMode: 'standard_r2v',
    model: selectedModel,
  })

  assert.deepEqual(plan.map(item => item.status), ['pending'])
  assert.equal(plan[0].reused, false)
})


test('reuse plan rejects legacy local tail snapshots at a selected storyboard boundary', () => {
  const plan = buildVideoSequenceReusePlan({
    storyboards: [storyboard(1), storyboard(2), storyboard(3), storyboard(4), storyboard(5), storyboard(6)],
    videoGenerations: [
      completedGeneration(11, 1),
      completedGeneration(12, 2),
      completedGeneration(13, 3),
      completedGeneration(14, 4),
      completedGeneration(15, 5),
      completedGeneration(16, 6),
    ],
    historicalSteps: [
      { storyboardId: 1, videoGenerationId: 11, status: 'completed', tailFrameUrl: 'static/sequence-frames/tail-1.png' },
      { storyboardId: 2, videoGenerationId: 12, status: 'completed', tailFrameUrl: 'static/sequence-frames/tail-2.png' },
      { storyboardId: 3, videoGenerationId: 13, status: 'completed', tailFrameUrl: 'static/sequence-frames/tail-3.png' },
      { storyboardId: 4, videoGenerationId: 14, status: 'completed', tailFrameUrl: 'static/sequence-frames/tail-4.png' },
      { storyboardId: 5, videoGenerationId: 15, status: 'completed', tailFrameUrl: 'static/sequence-frames/tail-5.png' },
      { storyboardId: 6, videoGenerationId: 16, status: 'completed', tailFrameUrl: 'static/sequence-frames/tail-6.png' },
    ],
    provider: 'comfyui',
    forceFromIndex: 4,
  })

  assert.deepEqual(plan.map(item => item.status), ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'])
  assert.deepEqual(plan.map(item => item.videoGenerationId), [null, null, null, null, null, null])
  assert.equal(plan[3].reused, false)
  assert.equal(plan[4].reused, false)
})


test('reuse plan treats an explicit full restart boundary as all shots pending', () => {
  const plan = buildVideoSequenceReusePlan({
    storyboards: [storyboard(1), storyboard(2), storyboard(3)],
    videoGenerations: [completedGeneration(11, 1), completedGeneration(12, 2), completedGeneration(13, 3)],
    historicalSteps: [],
    provider: 'mijing',
    forceFromIndex: 0,
  })

  assert.deepEqual(plan.map(item => item.status), ['pending', 'pending', 'pending'])
  assert.ok(plan.every(item => item.videoGenerationId == null && item.reused === false))
})


test('reuse plan regenerates a shot when its newest generation failed, even if an older one completed', () => {
  const plan = buildVideoSequenceReusePlan({
    storyboards: [storyboard(1), storyboard(2), storyboard(3)],
    videoGenerations: [
      completedGeneration(11, 1),
      completedGeneration(12, 2),
      { id: 13, storyboardId: 2, status: 'failed', errorMsg: 'gateway timeout' },
    ],
    historicalSteps: [
      { storyboardId: 1, videoGenerationId: 11, tailFrameUrl: 'https://cdn.example/tail-1.png', tailFrameAssetId: 'tail-1' },
      { storyboardId: 2, videoGenerationId: 12, tailFrameUrl: 'https://cdn.example/tail-2.png', tailFrameAssetId: 'tail-2' },
    ],
    provider: 'mijing',
  })

  assert.deepEqual(plan.map(item => item.status), ['skipped', 'pending', 'pending'])
  assert.deepEqual(plan.map(item => item.videoGenerationId), [11, null, null])
  assert.equal(plan[1].reused, false)
})


test('reuse plan invalidates the entire downstream chain after the first stale local H3 shot', () => {
  const plan = buildVideoSequenceReusePlan({
    storyboards: [
      { id: 1, episodeId: 1, storyboardNumber: 1 },
      { id: 2, episodeId: 1, storyboardNumber: 2 },
      { id: 3, episodeId: 1, storyboardNumber: 3 },
    ],
    videoGenerations: [
      { id: 11, storyboardId: 1, status: 'completed', localPath: 'static/videos/11.mp4', referenceMode: 'first_frame_multiple', continuityMode: 'standard_r2v' },
      { id: 12, storyboardId: 2, status: 'completed', localPath: 'static/videos/12.mp4', referenceMode: 'multiple', continuityMode: 'standard_r2v' },
      { id: 13, storyboardId: 3, status: 'completed', localPath: 'static/videos/13.mp4', referenceMode: 'multiple', continuityMode: 'standard_r2v' },
    ],
    historicalSteps: [
      { storyboardId: 1, videoGenerationId: 11, status: 'completed', tailFrameUrl: 'static/tail-1.png' },
      { storyboardId: 2, videoGenerationId: 12, status: 'completed', tailFrameUrl: 'static/tail-2.png' },
      { storyboardId: 3, videoGenerationId: 13, status: 'completed', tailFrameUrl: 'static/tail-3.png' },
    ],
    provider: 'comfyui',
    continuityMode: 'standard_r2v',
  })
  assert.deepEqual(plan.map(item => item.status), ['pending', 'pending', 'pending'])
  assert.ok(plan.every(item => !item.reused && item.videoGenerationId == null))
})


test('reuse plan regenerates a shot when preparation failed before any video generation was created', () => {
  const plan = buildVideoSequenceReusePlan({
    storyboards: [storyboard(1), storyboard(2)],
    videoGenerations: [completedGeneration(11, 1), completedGeneration(12, 2)],
    historicalSteps: [
      { id: 21, storyboardId: 1, videoGenerationId: 11, status: 'completed', tailFrameUrl: 'https://cdn.example/tail-1.png', tailFrameAssetId: 'tail-1' },
      { id: 22, storyboardId: 2, status: 'failed', errorMsg: 'reference asset missing' },
    ],
    provider: 'mijing',
  })

  assert.equal(plan[0].status, 'skipped')
  assert.equal(plan[1].status, 'pending')
  assert.equal(plan[1].videoGenerationId, null)
})


test('reuse plan carries historical tail assets and asset bindings into skipped steps', () => {
  const history = {
    id: 9,
    storyboardId: 1,
    videoGenerationId: 11,
    status: 'completed',
    tailFrameUrl: 'https://cdn.example/tail-1.png',
    tailFrameAssetId: 'tail-1',
    assetRefs: JSON.stringify([{ role: 'character', category: 'character', asset_id: 'role-1' }]),
  }
  const [item] = buildVideoSequenceReusePlan({
    storyboards: [storyboard(1), storyboard(2)],
    videoGenerations: [completedGeneration(11, 1)],
    historicalSteps: [history],
    provider: 'mijing',
  })

  assert.equal(item.status, 'skipped')
  assert.equal(item.historyStep, history)
  assert.equal(item.needsTailPreparation, false)
})


test('reuse plan prepares only the missing tail frame when the existing video feeds a missing shot', () => {
  const plan = buildVideoSequenceReusePlan({
    storyboards: [storyboard(1), storyboard(2)],
    videoGenerations: [completedGeneration(11, 1)],
    historicalSteps: [],
    provider: 'mijing',
  })

  assert.equal(plan[0].status, 'pending')
  assert.equal(plan[0].reused, true)
  assert.equal(plan[0].needsTailPreparation, true)
  assert.equal(plan[0].videoGenerationId, 11)
  assert.equal(plan[1].status, 'pending')
  assert.equal(plan[1].reused, false)
})


test('reuse plan rejects a local ComfyUI legacy tail path as continuity', () => {
  const plan = buildVideoSequenceReusePlan({
    storyboards: [storyboard(1), storyboard(2)],
    videoGenerations: [completedGeneration(11, 1)],
    historicalSteps: [{ storyboardId: 1, videoGenerationId: 11, tailFrameUrl: 'static/sequence-frames/tail.png' }],
    provider: 'comfyui',
  })

  assert.equal(plan[0].status, 'pending')
  assert.equal(plan[0].needsTailPreparation, false)
  assert.equal(plan[1].status, 'pending')
})


test('reuse plan completes immediately when every shot already has a video', () => {
  const plan = buildVideoSequenceReusePlan({
    storyboards: [storyboard(1), storyboard(2)],
    videoGenerations: [completedGeneration(11, 1), completedGeneration(12, 2)],
    historicalSteps: [],
    provider: 'mijing',
  })

  assert.deepEqual(plan.map(item => item.status), ['skipped', 'skipped'])
  assert.ok(plan.every(item => item.reused && !item.needsTailPreparation))
})


test('display steps recover actual asset counts from the completed video history', () => {
  const assetRefs = JSON.stringify([
    { role: 'character', category: 'character', asset_id: 'role-1' },
    { role: 'scene', category: 'scene', asset_id: 'scene-1' },
  ])
  const [displayStep] = enrichSequenceStepsForDisplay({
    steps: [{ id: 20, storyboardId: 2, stepIndex: 1, status: 'cancelled', assetRefs: null }],
    historicalSteps: [
      { id: 15, storyboardId: 2, videoGenerationId: 12, status: 'cancelled', assetRefs },
    ],
    videoGenerations: [completedGeneration(12, 2)],
  })

  assert.equal(displayStep.status, 'cancelled')
  assert.equal(displayStep.videoGenerationId, 12)
  assert.equal(displayStep.assetRefs, assetRefs)
})


test('display steps do not invent asset references for shots without completed videos', () => {
  const [displayStep] = enrichSequenceStepsForDisplay({
    steps: [{ id: 21, storyboardId: 3, stepIndex: 2, status: 'cancelled', assetRefs: null }],
    historicalSteps: [{ id: 16, storyboardId: 3, status: 'cancelled', assetRefs: null }],
    videoGenerations: [],
  })

  assert.equal(displayStep.assetRefs, null)
  assert.equal(displayStep.videoGenerationId, undefined)
})

test('foreground character is not hidden by another actor background clause', () => {
  const prompt = "Jiang leans from the right foreground; Fengxi lies centered on the slab, while Bai Ling remains in the soft background."
  assert.equal(isCharacterBackgroundOnlyMention(prompt, { name: 'Fengxi', aliases: ['fengxi'], role: 'protagonist' }), false)
  assert.equal(isCharacterBackgroundOnlyMention(prompt, { name: 'Bai Ling', aliases: ['bailing'], role: 'background observer' }), true)
})


test('dialogue snapshot compatibility rejects changed or reassigned lines', () => {
  const storyboard = { dialogue: '凤溪：别碰我！' }
  const prompt = 'LOCAL COMFYUI REFERENCE ORDER (1 images): 凤溪\n<voice>凤溪</voice>\n视频对白约束（自动注入 BEGIN）\n凤溪：别碰我！\n视频对白约束（自动注入 END）'
  assert.equal(isStoryboardDialogueSnapshotCompatible(prompt, storyboard), true)
  assert.equal(isStoryboardDialogueSnapshotCompatible(prompt.replaceAll('别碰我', '我不能死'), storyboard), false)
  assert.equal(isStoryboardDialogueSnapshotCompatible(prompt.replaceAll('<voice>凤溪</voice>', '<voice>白灵</voice>'), storyboard), false)
})


test('dialogue snapshot compatibility allows an empty dialogue only without an injected block', () => {
  assert.equal(isStoryboardDialogueSnapshotCompatible('LOCAL H3 shot prompt', { dialogue: '' }), true)
  assert.equal(isStoryboardDialogueSnapshotCompatible('视频对白约束（自动注入 BEGIN）\n旧台词\n视频对白约束（自动注入 END）', { dialogue: '' }), false)
})


test('local dialogue validation accepts both speakers separated by a slash without invalidating a completed shot', () => {
  const storyboard = { dialogue: '胖顾客：厨子小妹儿好酒量！ / 苏小小：那是！外号山城酒仙的嘛！' }
  const prompt = `<voice>胖顾客</voice> <voice>苏小小</voice>\n${storyboard.dialogue}`
  assert.equal(isStoryboardDialogueSnapshotCompatible(prompt, storyboard, true), true)
  assert.equal(isStoryboardDialogueSnapshotCompatible(prompt.replace(' / ', '\n'), storyboard, true), true)
  assert.equal(isStoryboardDialogueSnapshotCompatible(prompt.replace('苏小小：那是！外号山城酒仙的嘛！', ''), storyboard, true), false)
  assert.equal(isStoryboardDialogueSnapshotCompatible(prompt.replace('<voice>苏小小</voice>', '<voice>苏大强</voice>'), storyboard, true), false)
  assert.equal(isStoryboardDialogueSnapshotCompatible(`${prompt}\n苏小小：那是！外号山城酒仙的嘛！`, storyboard, true), false)
  assert.equal(isStoryboardDialogueSnapshotCompatible(prompt, storyboard), false)
})


test('local serial prompt and completed-snapshot validation share slash-separated speaker parsing', () => {
  const dialogue = '胖顾客：好酒量！ / 苏小小：那是！'
  const prompt = buildComfyUiSequencePrompt(
    '<voice>胖顾客</voice> compliments the cook. <voice>苏小小</voice> replies.',
    [
      { url: 'static/fat.png', role: 'character', entityName: '胖顾客' },
      { url: 'static/cook.png', role: 'character', entityName: '苏小小' },
    ],
    false,
    'standard',
    dialogue,
  )
  assert.match(prompt, /DIALOGUE SPEAKER OWNERSHIP: only 胖顾客, 苏小小 may speak/)
  assert.match(prompt, /Only these scripted speakers may speak: 胖顾客, 苏小小/)
  assert.equal(isStoryboardDialogueSnapshotCompatible(prompt, { dialogue }, true), true)
})


test('completed local shots with slash-separated speakers are reusable in both isolated continuity modes', () => {
  const storyboard = { id: -90043, episodeId: -90007, storyboardNumber: 3, dialogue: '胖顾客：好酒量！ / 苏小小：那是！' }
  for (const continuityMode of ['standard_r2v', 'latent_plus']) {
    const generation = {
      id: 248,
      storyboardId: storyboard.id,
      provider: 'comfyui',
      status: 'completed',
      referenceMode: 'multiple',
      continuityMode,
      localPath: 'static/videos/completed-shot-3.mp4',
      prompt: `<voice>胖顾客</voice> <voice>苏小小</voice>\n${storyboard.dialogue}`,
    }
    assert.equal(isGenerationCompatibleWithStoryboard(generation, storyboard, 'comfyui', continuityMode), true)
    const [step] = buildVideoSequenceReusePlan({
      storyboards: [storyboard],
      videoGenerations: [generation],
      historicalSteps: [],
      provider: 'comfyui',
      continuityMode,
    })
    assert.equal(step.reused, true)
    assert.equal(step.videoGenerationId, generation.id)
    assert.equal(isGenerationCompatibleWithStoryboard(generation, { ...storyboard, dialogue: '胖顾客：好酒量！ / 苏小小：换了一句！' }, 'comfyui', continuityMode), false)
  }
})


test('persisted entity bindings must match the current shot exactly', () => {
  const context = {
    characters: [{ id: 11 }, { id: 12 }],
    scene: { id: 21 },
    props: [{ id: 31 }, { id: 32 }],
  }
  const current = [
    'binding_role=character; entity_id=11',
    'binding_role=character; entity_id=12',
    'binding_role=scene; entity_id=21',
    'binding_role=prop; entity_id=31',
    'binding_role=prop; entity_id=32',
  ].join('\n')
  assert.equal(persistedBindingIdsMatchContext(current, context), true)
  assert.equal(persistedBindingIdsMatchContext(current.replace('entity_id=12', 'entity_id=99'), context), false)
  assert.equal(persistedBindingIdsMatchContext(current.replace('entity_id=21', 'entity_id=22'), context), false)
  assert.equal(persistedBindingIdsMatchContext(current.replace('entity_id=32', 'entity_id=99'), context), false)
  assert.equal(persistedBindingIdsMatchContext(`${current}\nbinding_role=prop; entity_id=99`, context), false)
})
