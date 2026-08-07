import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildVolcAssetPrompt,
  buildVolcFinalPrompt,
  applyVideoVisualStyleLock,
  collectVideoReferences,
  filterVolcSemanticReferencesByPromptRoles,
  prependVolcStoryboardAssetSequence,
  buildVideoFetchInit,
  preparePublicVideoReferenceRecord,
  formatVideoProviderError,
  isResumableVideoGeneration,
  isStaleUnrecoverableVideoGeneration,
  normalizeVolcAssetUri,
  sanitizeVolcFinalPrompt,
  syncRequiredVolcReferences,
} from '../video-generation.js'

test('video final prompt replaces stale style locks with the project style', () => {
  const prompt = applyVideoVisualStyleLock(
    '0-5秒：林凡走向窗边。\n视觉风格锁定（旧规则，项目风格=二维动漫）：二维动画。严禁写实真人。',
    'realistic',
  )

  assert.match(prompt, /0-5秒：林凡走向窗边/)
  assert.match(prompt, /项目风格=写实真人/)
  assert.match(prompt, /photorealistic live-action/)
  assert.match(prompt, /严禁 3D 渲染、CGI/)
  assert.doesNotMatch(prompt, /项目风格=二维动漫/)
  assert.equal(prompt.match(/视觉风格锁定（/g)?.length, 1)
})

test('normalizeVolcAssetUri normalizes saved 火山 asset URI variants', () => {
  assert.equal(normalizeVolcAssetUri('asset://asset-role'), 'Asset://asset-role')
  assert.equal(normalizeVolcAssetUri('Asset://asset-scene'), 'Asset://asset-scene')
  assert.equal(normalizeVolcAssetUri('@asset://asset-prop'), 'Asset://asset-prop')
})

test('syncRequiredVolcReferences cancels Seedance generation when any required reference fails', async () => {
  const calls: string[] = []
  const refs = [
    { url: 'static/grid-cells/one.png', name: '参考图1', role: 'reference_image', category: 'storyboard' },
    { url: 'static/grid-cells/two.png', name: '参考图2', role: 'reference_image', category: 'storyboard' },
  ]

  await assert.rejects(
    () => syncRequiredVolcReferences(
      refs,
      { id: 18, storyboardId: 13, dramaId: 1 },
      { episodeId: 1, storyboardNum: 1, groupName: '测试素材组' },
      async (input) => {
        calls.push(input.name)
        if (input.name === '参考图2') throw new Error('Uguu 上传失败')
        return {
          localAssetId: 1,
          providerAssetId: 'asset-ok',
          groupName: '测试素材组',
          publicUrl: 'https://d.uguu.se/one.png',
        }
      },
    ),
    /参考图上传火山素材失败，已取消视频生成。1\/2 张失败：参考图2: Uguu 上传失败/,
  )

  assert.deepEqual(calls, ['参考图1', '参考图2'])
})

test('syncRequiredVolcReferences reuses saved character role URI without uploading that character again', async () => {
  const calls: string[] = []
  const synced = await syncRequiredVolcReferences(
    [
      {
        url: 'static/grid-cells/one.png',
        name: '参考图1',
        role: 'reference_image',
        category: 'storyboard',
      },
      {
        url: 'static/images/chenfeng.png',
        name: '角色-陈风',
        role: 'character',
        category: 'character',
        entityName: '陈风',
        existingAsset: {
          localAssetId: 66,
          providerAssetId: 'asset-chenfeng',
          assetUri: 'asset://asset-chenfeng',
          groupName: '角色库',
          publicUrl: 'https://cdn.example.com/chenfeng.png',
        },
      },
    ] as any,
    { id: 19, storyboardId: 14, dramaId: 1 },
    { episodeId: 1, storyboardNum: 1, groupName: '测试素材组' },
    async (input) => {
      calls.push(input.name)
      return {
        localAssetId: 1,
        providerAssetId: 'asset-shot',
        groupName: '测试素材组',
        publicUrl: 'https://d.uguu.se/one.png',
      }
    },
  )

  assert.deepEqual(calls, ['参考图1'])
  assert.deepEqual(synced.map(item => item.asset.providerAssetId), ['asset-shot', 'asset-chenfeng'])
  const prompt = buildVolcAssetPrompt(synced as any)
  assert.match(prompt, /陈风=@asset:\/\/asset-chenfeng/)
})

test('syncRequiredVolcReferences uploads missing character role URI through the character library path', async () => {
  const genericCalls: string[] = []
  const characterCalls: number[] = []
  const synced = await syncRequiredVolcReferences(
    [
      {
        url: 'static/images/chenfeng.png',
        name: '角色-陈风',
        role: 'character',
        category: 'character',
        entityName: '陈风',
        characterId: 123,
      },
    ] as any,
    { id: 20, storyboardId: 15, dramaId: 1 },
    { episodeId: 1, storyboardNum: 1, groupName: '测试素材组' },
    async (input) => {
      genericCalls.push(input.name)
      throw new Error('不应该走普通素材上传')
    },
    {
      syncCharacterAsset: async (characterId) => {
        characterCalls.push(characterId)
        return {
          localAssetId: 88,
          providerAssetId: 'asset-character-uri',
          assetUri: 'asset://asset-character-uri',
          groupName: '角色库',
          publicUrl: 'https://cdn.example.com/chenfeng.png',
        }
      },
    },
  )

  assert.deepEqual(genericCalls, [])
  assert.deepEqual(characterCalls, [123])
  assert.equal(synced[0].asset.assetUri, 'asset://asset-character-uri')
})

test('preparePublicVideoReferenceRecord uploads storyboard, character, and scene references for Eggfans video', async () => {
  const calls: string[] = []
  const prepared = await preparePublicVideoReferenceRecord(
    videoRecord({
      id: 81,
      prompt: '0-3秒：<location>公司办公区</location>，<role>陈风</role>走向窗边。',
      provider: 'eggfans',
      referenceMode: 'multiple',
      referenceImageUrls: JSON.stringify([
        'static/grid-cells/shot-1.png',
        'static/grid-cells/shot-2.png',
      ]),
    }),
    {
      sceneImages: [{ name: '公司办公区', url: 'static/images/scene.png' }],
      characterImages: [{ name: '陈风', url: 'static/images/chenfeng.png' }],
    },
    async (url, name) => {
      calls.push(`${name}:${url}`)
      return { url: `https://d.uguu.se/${name}.png`, mimeType: 'image/png', provider: 'uguu-upload' }
    },
  )

  assert.equal(prepared.referenceMode, 'multiple')
  assert.deepEqual(prepared.referenceImageUrls, [
    'https://d.uguu.se/视频任务81-参考图1.png',
    'https://d.uguu.se/视频任务81-参考图2.png',
    'https://d.uguu.se/场景-公司办公区.png',
    'https://d.uguu.se/角色-陈风.png',
  ])
  assert.deepEqual(calls, [
    '视频任务81-参考图1:static/grid-cells/shot-1.png',
    '视频任务81-参考图2:static/grid-cells/shot-2.png',
    '场景-公司办公区:static/images/scene.png',
    '角色-陈风:static/images/chenfeng.png',
  ])
  assert.equal(prepared.imageUrl, null)
  assert.equal(prepared.firstFrameUrl, null)
  assert.equal(prepared.lastFrameUrl, null)
  assert.match(prepared.prompt, /Eggfans\/Grok 视频参考图：/)
  assert.match(prepared.prompt, /角色-陈风=https:\/\/d\.uguu\.se\/角色-陈风\.png/)
  assert.doesNotMatch(prepared.prompt, /@asset:\/\//)
  assert.doesNotMatch(JSON.stringify(prepared.referenceImageUrls), /static\/|data:image/)
})

test('preparePublicVideoReferenceRecord keeps Grok video references within seven public images', async () => {
  const calls: string[] = []
  const prepared = await preparePublicVideoReferenceRecord(
    videoRecord({
      id: 82,
      prompt: '0-3秒：<location>公司办公区</location>，<role>陈风</role>走向窗边。',
      provider: 'eggfans',
      model: 'grok-video-3-10s',
      referenceMode: 'multiple',
      imageUrl: 'static/composed/shot-1.png',
      firstFrameUrl: 'static/first-frame/shot-1.png',
      referenceImageUrls: JSON.stringify([
        'static/grid-cells/shot-1.png',
        'static/grid-cells/shot-2.png',
        'static/grid-cells/shot-3.png',
        'static/grid-cells/shot-4.png',
      ]),
    }),
    {
      sceneImages: [{ name: '公司办公区', url: 'static/images/scene.png' }],
      characterImages: [
        { name: '陈风', url: 'static/images/chenfeng.png' },
        { name: '林薇', url: 'static/images/linwei.png' },
        { name: '王雨欣', url: 'static/images/wangyuxin.png' },
      ],
    },
    async (url, name) => {
      calls.push(`${name}:${url}`)
      return { url: `https://d.uguu.se/${name}.png`, mimeType: 'image/png', provider: 'uguu-upload' }
    },
  )

  assert.equal(prepared.referenceMode, 'multiple')
  assert.equal(prepared.imageUrl, null)
  assert.equal(prepared.firstFrameUrl, null)
  assert.deepEqual(prepared.referenceImageUrls, [
    'https://d.uguu.se/视频任务82-参考图1.png',
    'https://d.uguu.se/视频任务82-参考图2.png',
    'https://d.uguu.se/视频任务82-参考图3.png',
    'https://d.uguu.se/视频任务82-参考图4.png',
    'https://d.uguu.se/场景-公司办公区.png',
    'https://d.uguu.se/角色-陈风.png',
    'https://d.uguu.se/角色-林薇.png',
  ])
  assert.deepEqual(calls, [
    '视频任务82-参考图1:static/grid-cells/shot-1.png',
    '视频任务82-参考图2:static/grid-cells/shot-2.png',
    '视频任务82-参考图3:static/grid-cells/shot-3.png',
    '视频任务82-参考图4:static/grid-cells/shot-4.png',
    '场景-公司办公区:static/images/scene.png',
    '角色-陈风:static/images/chenfeng.png',
    '角色-林薇:static/images/linwei.png',
  ])
  assert.match(prepared.prompt, /Eggfans\/Grok 视频参考图：/)
  assert.match(prepared.prompt, /参考图4=https:\/\/d\.uguu\.se\/视频任务82-参考图4\.png/)
  assert.match(prepared.prompt, /角色-陈风=https:\/\/d\.uguu\.se\/角色-陈风\.png/)
  assert.match(prepared.prompt, /场景-公司办公区=https:\/\/d\.uguu\.se\/场景-公司办公区\.png/)
  assert.doesNotMatch(prepared.prompt, /王雨欣/)
})

test('preparePublicVideoReferenceRecord restricts Grok uploads to public Uguu and Eggfans image host providers', async () => {
  const uploadOptions: any[] = []
  const prepared = await preparePublicVideoReferenceRecord(
    videoRecord({
      id: 83,
      prompt: '<role>陈风</role>在<location>公司办公区</location>抬头。',
      provider: 'eggfans',
      model: 'grok-video-3-10s',
      referenceMode: 'multiple',
      referenceImageUrls: JSON.stringify(['static/grid-cells/shot-1.png']),
    }),
    {
      sceneImages: [],
      characterImages: [],
    },
    async (_url, name, options) => {
      uploadOptions.push(options)
      return { url: `https://cdn.eggfans.com/${name}.png`, mimeType: 'image/png', provider: 'eggfans-image-host' }
    },
  )

  assert.deepEqual(prepared.referenceImageUrls, [
    'https://cdn.eggfans.com/视频任务83-参考图1.png',
  ])
  assert.deepEqual(uploadOptions, [{
    preferUguu: true,
    validateResult: true,
    allowedProviders: ['uguu-upload', 'eggfans-image-host'],
  }])
  assert.doesNotMatch(JSON.stringify(prepared.referenceImageUrls), /data:image|static\//)
})

test('preparePublicVideoReferenceRecord replaces existing Grok public reference block instead of duplicating it', async () => {
  const prepared = await preparePublicVideoReferenceRecord(
    videoRecord({
      id: 84,
      prompt: [
        '0-3秒：<location>公司办公区</location>，<role>陈风</role>看向窗外。',
        'Eggfans/Grok 视频参考图：多图参考，最多7张；旧传输稿。',
        '角色-陈风=https://old.example/chenfeng.png',
        '参考规则：旧规则。',
      ].join('\n'),
      provider: 'eggfans',
      model: 'grok-video-3-10s',
      referenceMode: 'multiple',
      referenceImageUrls: JSON.stringify(['static/grid-cells/shot-1.png']),
    }),
    {
      sceneImages: [],
      characterImages: [],
    },
    async (_url, name) => {
      return { url: `https://d.uguu.se/${name}.png`, mimeType: 'image/png', provider: 'uguu-upload' }
    },
  )

  assert.equal((prepared.prompt.match(/Eggfans\/Grok 视频参考图/g) || []).length, 1)
  assert.equal((prepared.prompt.match(/参考规则：Grok 本次使用多参考图模式/g) || []).length, 1)
  assert.doesNotMatch(prepared.prompt, /old\.example|旧传输稿|旧规则/)
  assert.match(prepared.prompt, /0-3秒：<location>公司办公区<\/location>/)
  assert.match(prepared.prompt, /参考图1=https:\/\/d\.uguu\.se\/视频任务84-参考图1\.png/)
})

function videoRecord(overrides = {}) {
  return {
    id: 18,
    storyboardId: null,
    dramaId: 1,
    prompt: '生成视频',
    model: 'doubao-seedance-2-0-pro-250528',
    provider: 'volcengine',
    referenceMode: 'multiple',
    imageUrl: null,
    firstFrameUrl: null,
    lastFrameUrl: null,
    referenceImageUrls: null,
    videoUrl: null,
    localPath: null,
    taskId: null,
    status: 'processing',
    errorMsg: null,
    duration: 5,
    aspectRatio: '16:9',
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...overrides,
  } as any
}

test('collectVideoReferences requires valid Seedance multi-reference inputs', () => {
  assert.throws(
    () => collectVideoReferences(videoRecord({ referenceImageUrls: null })),
    /Seedance 2\.0 多图参考模式缺少参考图，已取消视频生成/,
  )
  assert.throws(
    () => collectVideoReferences(videoRecord({ referenceImageUrls: 'not-json' })),
    /Seedance 2\.0 多图参考解析失败，已取消视频生成/,
  )
  assert.throws(
    () => collectVideoReferences(videoRecord({ referenceImageUrls: JSON.stringify(['static/one.png', '']) })),
    /Seedance 2\.0 多图参考模式第 2 张参考图为空，已取消视频生成/,
  )
})

test('collectVideoReferences preserves all Seedance multi-reference images', () => {
  const refs = collectVideoReferences(videoRecord({
    referenceImageUrls: JSON.stringify([
      'static/grid-cells/one.png',
      'static/grid-cells/two.png',
      'static/grid-cells/three.png',
      'static/grid-cells/four.png',
    ]),
  }))

  assert.deepEqual(refs.map(ref => ref.url), [
    'static/grid-cells/one.png',
    'static/grid-cells/two.png',
    'static/grid-cells/three.png',
    'static/grid-cells/four.png',
  ])
  assert.deepEqual(refs.map(ref => ref.order), [1, 2, 3, 4])
})

test('buildVolcAssetPrompt declares storyboard asset bindings once in order', () => {
  const prompt = buildVolcAssetPrompt([
    {
      url: 'static/first.png',
      name: '镜头1-参考图1',
      role: 'reference_image',
      category: 'storyboard',
      order: 1,
      asset: {
        localAssetId: 1,
        providerAssetId: 'asset-first',
        assetUri: 'Asset://asset-first',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/first.png',
      },
    },
    {
      url: 'static/second.png',
      name: '镜头1-参考图2',
      role: 'reference_image',
      category: 'storyboard',
      order: 2,
      asset: {
        localAssetId: 2,
        providerAssetId: 'asset-second',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/second.png',
      },
    },
  ])

  assert.match(prompt, /资产绑定：/)
  assert.match(prompt, /参考图1=@asset:\/\/asset-first/)
  assert.match(prompt, /参考图2=@asset:\/\/asset-second/)
  assert.doesNotMatch(prompt, /参考图1 @asset:\/\/asset-first/)
  assert.doesNotMatch(prompt, /参考图2 @asset:\/\/asset-second/)
  assert.match(prompt, /严格按参考图1 → 参考图2/)
  assert.match(prompt, /已绑定角色和场景的视觉信息只以资产 ID 为准/)
  assert.doesNotMatch(prompt, /@asset-first/)
})

test('buildVolcAssetPrompt lists four storyboard assets in exact order for Seedance', () => {
  const prompt = buildVolcAssetPrompt([1, 2, 3, 4].map(index => ({
    url: `static/ref-${index}.png`,
    name: `镜头1-参考图${index}`,
    role: 'reference_image',
    category: 'storyboard',
    order: index,
    asset: {
      localAssetId: index,
      providerAssetId: `asset-${index}`,
      groupName: '测试素材组',
      publicUrl: `https://cdn.example/ref-${index}.png`,
    },
  })))

  assert.match(prompt, /参考图1=@asset:\/\/asset-1/)
  assert.match(prompt, /参考图2=@asset:\/\/asset-2/)
  assert.match(prompt, /参考图3=@asset:\/\/asset-3/)
  assert.match(prompt, /参考图4=@asset:\/\/asset-4/)
  assert.match(prompt, /这 4 张镜头参考图是有顺序的/)
  assert.equal((prompt.match(/@asset:\/\/asset-[1-4]/g) || []).length, 4)
})

test('buildVolcAssetPrompt includes editable local names for storyboard references', () => {
  const prompt = buildVolcAssetPrompt([
    {
      url: 'static/ref-1.png',
      name: '镜头1-参考图1',
      role: 'reference_image',
      category: 'storyboard',
      order: 1,
      asset: {
        localAssetId: 1,
        localName: '男主夜班疲惫近景',
        providerAssetId: 'asset-local-shot',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/ref-1.png',
      },
    },
  ])

  assert.match(prompt, /参考图1（男主夜班疲惫近景）=@asset:\/\/asset-local-shot/)
  assert.match(prompt, /资产绑定/)
})

test('prependVolcStoryboardAssetSequence puts ordered storyboard references before the matching time segments', () => {
  const prompt = '0-3秒：<location>公司办公区</location>，全景。<n>3-6秒：<role>陈风</role>坐在工位前。'
  const result = prependVolcStoryboardAssetSequence(prompt, [
    {
      url: 'static/first.png',
      name: '镜头1-参考图1',
      role: 'reference_image',
      category: 'storyboard',
      order: 1,
      asset: {
        localAssetId: 1,
        providerAssetId: 'asset-first',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/first.png',
      },
    },
    {
      url: 'static/second.png',
      name: '镜头1-参考图2',
      role: 'reference_image',
      category: 'storyboard',
      order: 2,
      asset: {
        localAssetId: 2,
        providerAssetId: 'asset-second',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/second.png',
      },
    },
  ] as any)

  assert.match(result, /^参考图1；0-3秒/)
  assert.match(result, /<n>参考图2；3-6秒/)
  assert.doesNotMatch(result, /@asset:\/\//)
})

test('filterVolcSemanticReferencesByPromptRoles keeps only characters visually tagged in prompt', () => {
  const refs = [
    { url: 'static/scene.png', name: '场景-公司办公区', role: 'scene', category: 'scene', entityName: '公司办公区' },
    { url: 'static/chenfeng.png', name: '角色-陈风', role: 'character', category: 'character', entityName: '陈风' },
    { url: 'static/coworker.png', name: '角色-同事A', role: 'character', category: 'character', entityName: '同事A' },
  ]

  const result = filterVolcSemanticReferencesByPromptRoles(
    '0-3秒：<location>公司办公区</location>，<role>陈风</role>查看同事A的群消息。',
    refs as any,
  )

  assert.deepEqual(result.map(item => item.entityName), ['公司办公区', '陈风'])
})

test('filterVolcSemanticReferencesByPromptRoles keeps named visual characters when prompt has no role tags', () => {
  const refs = [
    { url: 'static/scene.png', name: '场景-公司办公区', role: 'scene', category: 'scene', entityName: '公司办公区' },
    { url: 'static/chenfeng.png', name: '角色-陈风', role: 'character', category: 'character', entityName: '陈风' },
    { url: 'static/coworker.png', name: '角色-同事A', role: 'character', category: 'character', entityName: '同事A' },
  ]

  const result = filterVolcSemanticReferencesByPromptRoles(
    '0-3秒：深夜办公室里，陈风一个人坐在工位前。\n对白：同事A：外面出事了！',
    refs as any,
  )

  assert.deepEqual(result.map(item => item.entityName), ['公司办公区', '陈风'])
})

test('filtered Seedance asset prompt does not list dialogue-only character references', () => {
  const refs: Parameters<typeof buildVolcAssetPrompt>[0] = [
    {
      url: 'static/scene.png',
      name: '场景-公司办公区',
      role: 'scene',
      category: 'scene',
      entityName: '公司办公区',
      asset: {
        localAssetId: 1,
        providerAssetId: 'asset-scene',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/scene.png',
      },
    },
    {
      url: 'static/chenfeng.png',
      name: '角色-陈风',
      role: 'character',
      category: 'character',
      entityName: '陈风',
      asset: {
        localAssetId: 2,
        providerAssetId: 'asset-chenfeng',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/chenfeng.png',
      },
    },
    {
      url: 'static/coworker.png',
      name: '角色-同事A',
      role: 'character',
      category: 'character',
      entityName: '同事A',
      asset: {
        localAssetId: 3,
        providerAssetId: 'asset-coworker',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/coworker.png',
      },
    },
  ]

  const filtered = filterVolcSemanticReferencesByPromptRoles(
    '0-3秒：<location>公司办公区</location>，<role>陈风</role>一个人在工位前查看同事A发来的消息。',
    refs,
  )
  const prompt = buildVolcAssetPrompt(filtered)

  assert.match(prompt, /资产绑定：/)
  assert.match(prompt, /陈风=@asset:\/\/asset-chenfeng/)
  assert.doesNotMatch(prompt, /同事A/)
  assert.doesNotMatch(prompt, /asset-coworker/)
})

test('buildVolcAssetPrompt declares character and scene bindings once without inline replacement syntax', () => {
  const prompt = buildVolcAssetPrompt([
    {
      url: 'static/scene.png',
      name: '场景-公司办公区',
      role: 'scene',
      category: 'scene',
      entityName: '公司办公区',
      asset: {
        localAssetId: 1,
        providerAssetId: 'asset-scene',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/scene.png',
      },
    },
    {
      url: 'static/chenfeng.png',
      name: '角色-陈风',
      role: 'character',
      category: 'character',
      entityName: '陈风',
      asset: {
        localAssetId: 2,
        providerAssetId: 'asset-chenfeng',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/chenfeng.png',
      },
    },
    {
      url: 'static/chenfeng-copy.png',
      name: '角色-陈风',
      role: 'character',
      category: 'character',
      entityName: '陈风',
      asset: {
        localAssetId: 3,
        providerAssetId: 'asset-chenfeng',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/chenfeng-copy.png',
      },
    },
  ] as any)

  assert.match(prompt, /资产绑定：/)
  assert.equal((prompt.match(/陈风=@asset:\/\/asset-chenfeng/g) || []).length, 1)
  assert.equal((prompt.match(/公司办公区=@asset:\/\/asset-scene/g) || []).length, 1)
  assert.doesNotMatch(prompt, /角色参考资产ID：陈风 @asset/)
  assert.doesNotMatch(prompt, /场景参考资产ID：公司办公区 @asset/)
})

test('buildVolcAssetPrompt uses editable local names for semantic asset bindings', () => {
  const prompt = buildVolcAssetPrompt([
    {
      url: 'static/chenfeng.png',
      name: '角色-陈风',
      role: 'character',
      category: 'character',
      entityName: '陈风',
      asset: {
        localAssetId: 2,
        localName: '男主陈风固定造型',
        providerAssetId: 'asset-chenfeng',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/chenfeng.png',
      },
    },
  ] as any)

  assert.match(prompt, /男主陈风固定造型=@asset:\/\/asset-chenfeng/)
  assert.doesNotMatch(prompt, /陈风=@asset:\/\/asset-chenfeng/)
})

test('buildVolcAssetPrompt separates repeated semantic asset ids with spaces around Chinese semicolon', () => {
  const prompt = buildVolcAssetPrompt([
    {
      url: 'static/chenfeng-a.png',
      name: '角色-陈风',
      role: 'character',
      category: 'character',
      entityName: '陈风',
      asset: {
        localAssetId: 2,
        providerAssetId: 'asset-chenfeng-a',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/chenfeng-a.png',
      },
    },
    {
      url: 'static/chenfeng-b.png',
      name: '角色-陈风',
      role: 'character',
      category: 'character',
      entityName: '陈风',
      asset: {
        localAssetId: 3,
        providerAssetId: 'asset-chenfeng-b',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/chenfeng-b.png',
      },
    },
  ] as any)

  assert.match(prompt, /陈风=@asset:\/\/asset-chenfeng-a ；@asset:\/\/asset-chenfeng-b/)
  assert.doesNotMatch(prompt, /@asset:\/\/asset-chenfeng-a；@asset:\/\/asset-chenfeng-b/)
})

test('Seedance asset prompt uses asset IDs instead of textual character appearance or clothing rules', () => {
  const prompt = buildVolcAssetPrompt([
    {
      url: 'static/chenfeng.png',
      name: '角色-陈风',
      role: 'character',
      category: 'character',
      entityName: '陈风',
      asset: {
        localAssetId: 2,
        providerAssetId: 'asset-chenfeng',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/chenfeng.png',
      },
    },
  ] as any)

  assert.match(prompt, /陈风=@asset:\/\/asset-chenfeng/)
  assert.doesNotMatch(prompt, /脸型|发型|服装|着装|外形|人物形象/)
})

test('sanitizeVolcFinalPrompt removes stale character appearance wording from submitted final prompts', () => {
  const prompt = [
    '0-3秒：<role>陈风</role>走进办公室。',
    '资产绑定：',
    '陈风=@asset://asset-chenfeng',
    '绑定规则：保持镜头参考顺序、角色脸型、发型、服装、身份以及场景空间结构一致。',
    '生成约束：必须保持人物身份、脸型、发型、服装、场景结构一致。',
  ].join('\n')

  const sanitized = sanitizeVolcFinalPrompt(prompt)

  assert.match(sanitized, /陈风=@asset:\/\/asset-chenfeng/)
  assert.match(sanitized, /已绑定角色和场景的视觉信息只以资产 ID 为准/)
  assert.doesNotMatch(sanitized, /脸型|发型|服装|着装|外形|人物形象/)
})

test('Seedance prompt body keeps role, location, and dialogue text clean while bindings live in asset block', () => {
  const prompt = '0-3秒：<location>公司办公区</location>，全景。<role>陈风</role>坐在工位前。'
  const refs: Parameters<typeof buildVolcAssetPrompt>[0] = [
    {
      url: 'static/scene.png',
      name: '场景-公司办公区',
      role: 'scene',
      category: 'scene',
      entityName: '公司办公区',
      asset: {
        localAssetId: 1,
        providerAssetId: 'asset-scene',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/scene.png',
      },
    },
    {
      url: 'static/chenfeng.png',
      name: '角色-陈风',
      role: 'character',
      category: 'character',
      entityName: '陈风',
      asset: {
        localAssetId: 2,
        providerAssetId: 'asset-chenfeng',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/chenfeng.png',
      },
    },
  ]
  const finalPrompt = [
    prompt,
    buildVolcAssetPrompt(refs),
  ].join('\n')

  assert.match(finalPrompt, /<location>公司办公区<\/location>/)
  assert.match(finalPrompt, /<role>陈风<\/role>/)
  assert.doesNotMatch(finalPrompt, /<location>公司办公区 @asset/)
  assert.doesNotMatch(finalPrompt, /<role>陈风 @asset/)
  assert.match(finalPrompt, /陈风=@asset:\/\/asset-chenfeng/)
  assert.match(finalPrompt, /公司办公区=@asset:\/\/asset-scene/)
})

test('Seedance semantic bindings do not replace dialogue speaker names repeatedly', () => {
  const prompt = '0-3秒：<role>陈风</role>低头看手机。\n对白：陈风：我需要冷静。'
  const refs: Parameters<typeof buildVolcAssetPrompt>[0] = [
    {
      url: 'static/chenfeng.png',
      name: '角色-陈风',
      role: 'character',
      category: 'character',
      entityName: '陈风',
      asset: {
        localAssetId: 2,
        providerAssetId: 'asset-chenfeng',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/chenfeng.png',
      },
    },
  ]
  const finalPrompt = [
    prompt,
    buildVolcAssetPrompt(refs),
  ].join('\n')

  assert.match(finalPrompt, /对白：陈风：我需要冷静。/)
  assert.equal((finalPrompt.match(/陈风=@asset:\/\/asset-chenfeng/g) || []).length, 1)
  assert.doesNotMatch(finalPrompt, /对白：陈风 @asset/)
})

test('buildVolcFinalPrompt adds missing asset bindings to an edited final prompt', () => {
  const prompt = '0-3秒：深夜办公室里，陈风一个人低头看手机。'
  const refs: Parameters<typeof buildVolcAssetPrompt>[0] = [
    {
      url: 'static/chenfeng.png',
      name: '角色-陈风',
      role: 'character',
      category: 'character',
      entityName: '陈风',
      asset: {
        localAssetId: 2,
        providerAssetId: 'asset-chenfeng',
        groupName: '测试素材组',
        publicUrl: 'https://cdn.example/chenfeng.png',
      },
    },
  ]

  const finalPrompt = buildVolcFinalPrompt(prompt, refs)

  assert.match(finalPrompt, /0-3秒：深夜办公室里，陈风一个人低头看手机。/)
  assert.match(finalPrompt, /陈风=@asset:\/\/asset-chenfeng/)
  assert.equal((finalPrompt.match(/陈风=@asset:\/\/asset-chenfeng/g) || []).length, 1)
})

test('buildVideoFetchInit attaches a timeout signal to provider fetches', () => {
  const init = buildVideoFetchInit('POST', { Authorization: 'Bearer test' }, { model: 'm' }, 1234)

  assert.equal(init.method, 'POST')
  const headers = init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer test')
  assert.equal(init.body, '{"model":"m"}')
  assert.ok(init.signal)
})

test('formatVideoProviderError preserves Volc policy failure details', () => {
  assert.equal(
    formatVideoProviderError({
      code: 'OutputVideoSensitiveContentDetected.PolicyViolation',
      message: 'The request failed because the output video may be related to copyright restrictions. Request id: abc',
    }),
    '火山视频生成失败：输出视频触发平台审核/版权策略限制（OutputVideoSensitiveContentDetected.PolicyViolation）。The request failed because the output video may be related to copyright restrictions. Request id: abc',
  )
})

test('isResumableVideoGeneration only resumes async video tasks that still need polling', () => {
  assert.equal(isResumableVideoGeneration(videoRecord({
    status: 'processing',
    taskId: 'cgt-20260525202358-m9lbp',
    provider: 'volcengine',
  })), true)
  assert.equal(isResumableVideoGeneration(videoRecord({
    status: 'queued',
    taskId: 'eggfans-task-1',
    provider: 'eggfans',
  })), true)
  assert.equal(isResumableVideoGeneration(videoRecord({
    status: 'completed',
    taskId: 'done-task',
    provider: 'volcengine',
  })), false)
  assert.equal(isResumableVideoGeneration(videoRecord({
    status: 'processing',
    taskId: 'invalidated-task',
    provider: 'volcengine',
    deletedAt: '2026-08-05T00:00:00.000Z',
  })), false)
  assert.equal(isResumableVideoGeneration(videoRecord({
    status: 'processing',
    taskId: '',
    provider: 'volcengine',
  })), false)
  assert.equal(isResumableVideoGeneration(videoRecord({
    status: 'processing',
    taskId: 'vidu-webhook-task',
    provider: 'vidu',
  })), false)
})

test('stale video generations without task ids are unrecoverable except webhook providers', () => {
  const now = Date.parse('2026-05-27T10:00:00.000Z')
  assert.equal(isStaleUnrecoverableVideoGeneration(videoRecord({
    status: 'processing',
    taskId: '',
    provider: 'volcengine',
    createdAt: '2026-05-27T09:30:00.000Z',
    updatedAt: '2026-05-27T09:30:00.000Z',
  }), now), true)
  assert.equal(isStaleUnrecoverableVideoGeneration(videoRecord({
    status: 'processing',
    taskId: 'task-1',
    provider: 'volcengine',
    createdAt: '2026-05-27T09:30:00.000Z',
    updatedAt: '2026-05-27T09:30:00.000Z',
  }), now), false)
  assert.equal(isStaleUnrecoverableVideoGeneration(videoRecord({
    status: 'processing',
    taskId: '',
    provider: 'vidu',
    createdAt: '2026-05-27T09:30:00.000Z',
    updatedAt: '2026-05-27T09:30:00.000Z',
  }), now), false)
})
