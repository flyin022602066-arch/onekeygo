import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, ref } from 'vue'

const pageSource = readFileSync(new URL('../pages/drama/[id]/episode/[episodeNumber].vue', import.meta.url), 'utf8')
const script = pageSource.match(/<script setup>([\s\S]*?)<\/script>/)[1]
const parsed = ts.createSourceFile('episode.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const helperNames = [
  'isPendingCharImage', 'isPendingSceneImage', 'isPendingPropImage', 'assetImageState',
  'imageGenerationFor', 'hasFailedImageGeneration', 'imageGenerationError', 'imageBadgeClass',
  'imageBadgeLabel', 'retryOrGenerateImage', 'isImageGenerationPending', 'submitPropImage',
  'genPropImg', 'batchPropImages', 'choosePropMaterial', 'handlePropMaterialFile',
  'prodStepDone', 'mainStageDone', 'goMainStage', 'goSubStep', 'refreshExtractedAssets',
  'extractedAssetCounts', 'refreshExtractedAssetsUntilSettled',
]
const computedNames = ['hasExtractedAssets', 'propImgCount', 'pendingPropImageTargets', 'productionNeedsStoryboard', 'activeMainStage', 'pipelineTotal', 'pipelineProgress']
const statements = parsed.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) && helperNames.includes(statement.name?.text)
  || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => computedNames.includes(declaration.name.getText(parsed))),
)
assert.equal(statements.length, helperNames.length + computedNames.length)

function harness(overrides = {}) {
  const calls = { submissions: [], retries: [], polls: [], uploads: [], messages: [], refreshes: 0 }
  const state = {
    ref, computed,
    chars: ref([]), scenes: ref([]), props: ref([]), imageGenerations: ref([]),
    pendingCharImageIds: ref([]), pendingSceneImageIds: ref([]), pendingPropImageIds: ref([]),
    uploadingPropImageId: ref(null), batchPropImagesRunning: ref(false),
    propMaterialInput: ref(null), propMaterialTargetId: ref(null),
    epId: ref(15), imageGenerationOptions: ref({ config_id: 23, model: 'image-test', size: '1024x1024' }),
    panel: ref('production'), prodTab: ref('props'), scriptStep: ref(2), dubbingEnabled: ref(false),
    visualCharTotal: ref(0), charImgCount: ref(0), sceneImgCount: ref(0), charsVoiced: ref(0),
    sbs: ref([]), isDubbingReady: ref(true), shotImgCount: ref(0), shotVidCount: ref(0),
    composedCount: ref(0), mergeCandidateCount: ref(0), mergeUrl: ref(null), scriptContent: ref('测试剧本'),
    sidebarSections: ref([{ items: [{ done: true }, { done: false }] }]),
    imagePath: value => String(value || '').trim(),
    toCamel: value => value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
    refresh: async () => { calls.refreshes += 1 },
    pollAssetImageGeneration: options => { calls.polls.push(options) },
    toast: Object.fromEntries(['error', 'success', 'info', 'warning'].map(kind => [kind, message => calls.messages.push({ kind, message })])),
    propAPI: {
      generateImage: async (...args) => { calls.submissions.push(args); return { image_generation_id: 100 + Number(args[0]) } },
      uploadImage: async (...args) => { calls.uploads.push(args) },
    },
    imageAPI: { retry: async (...args) => { calls.retries.push(args); return { id: 88 } } },
    sleep: async () => {},
    ...overrides,
  }
  const context = vm.createContext(state)
  vm.runInContext(`${statements.map(statement => statement.getText(parsed)).join('\n')}\nglobalThis.api = { ${[...helperNames, ...computedNames].join(', ')} }`, context)
  return { state, calls, ...context.api }
}

test('props use prop_id only even when character and scene IDs collide', () => {
  const app = harness()
  app.state.imageGenerations.value = [
    { id: 91, scene_id: 7, status: 'failed', error_msg: 'scene failure' },
    { id: 92, characterId: 7, status: 'failed', error_msg: 'character failure' },
    { id: 5, prop_id: 7, status: 'failed', error_msg: 'old prop failure' },
    { id: 8, propId: 7, status: 'completed' },
  ]
  assert.equal(app.imageGenerationFor('prop', 7).id, 8)
  assert.equal(app.imageGenerationFor('scene', 7).id, 91)
  assert.equal(app.imageGenerationFor('character', 7).id, 92)
  assert.equal(app.imageGenerationFor('unknown', 7), null)
  assert.equal(app.imageGenerationError('prop', 7), '')
})

test('prop pending, failure and ready badges stay isolated', () => {
  const app = harness()
  app.state.pendingSceneImageIds.value = [7]
  app.state.props.value = [{ id: 7, image_url: 'static/props/old.png' }]
  assert.equal(app.imageBadgeClass('prop', 7), 'is-ready')
  for (const field of ['prop_id', 'propId']) {
    for (const status of ['pending', 'queued', 'processing', 'running']) {
      app.state.imageGenerations.value = [{ id: 9, [field]: 7, status }]
      assert.equal(app.isPendingPropImage('7'), true)
      assert.equal(app.imageBadgeLabel('prop', 7, 'old.png'), '生成中')
    }
  }
  app.state.imageGenerations.value = [{ id: 9, prop_id: 7, status: 'failed', error_msg: 'test failure' }]
  assert.equal(app.imageBadgeClass('prop', 7), 'is-failed')
  assert.equal(app.imageGenerationError('prop', 7), 'test failure')
  assert.equal(app.isPendingPropImage(7), false)
})

test('single prop generation preserves image channel options and polls its own asset', async () => {
  const app = harness()
  app.state.props.value = [{ id: 7, imageUrl: 'static/props/old.png' }]
  await app.genPropImg(7)
  assert.equal(app.calls.submissions.length, 1)
  assert.equal(app.calls.submissions[0][0], 7)
  assert.equal(app.calls.submissions[0][1], 15)
  assert.deepEqual(app.calls.submissions[0][2], app.state.imageGenerationOptions.value)
  assert.equal(app.calls.polls[0].generationId, 107)
  assert.equal(app.calls.polls[0].previousPath, 'static/props/old.png')
  assert.equal(app.calls.polls[0].getEntity(7).id, 7)
  assert.equal(app.isPendingPropImage(7), true)
  app.calls.polls[0].clearPending(7)
  assert.equal(app.isPendingPropImage(7), false)
})

test('rapid repeated generation clicks submit only once', async () => {
  let finish
  let submissions = 0
  const app = harness({ propAPI: { generateImage: () => { submissions += 1; return new Promise(resolve => { finish = resolve }) } } })
  const first = app.genPropImg(7)
  await app.genPropImg(7)
  assert.equal(submissions, 1)
  finish({ image_generation_id: 10 })
  await first
})

test('batch skips ready, pending and uploading props, and continues after one failure', async () => {
  const submitted = []
  const app = harness({ propAPI: { generateImage: async id => {
    submitted.push(id)
    if (id === 3) throw new Error('test submission failure')
    return { image_generation_id: 100 + id }
  } } })
  app.state.props.value = [{ id: 1, image_url: 'ready.png' }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
  app.state.imageGenerations.value = [{ id: 1, prop_id: 2, status: 'processing' }]
  app.state.uploadingPropImageId.value = 5
  await app.batchPropImages()
  assert.deepEqual(submitted, [3, 4])
  assert.equal(app.isPendingPropImage(3), false)
  assert.equal(app.isPendingPropImage(4), true)
  assert.equal(app.state.batchPropImagesRunning.value, false)
  assert.equal(app.calls.polls.length, 1)
  assert.ok(app.calls.messages.some(item => item.kind === 'error'))
})

test('missing task ID clears pending and surfaces an error', async () => {
  const app = harness({ propAPI: { generateImage: async () => ({}) } })
  await app.genPropImg(7)
  assert.equal(app.isPendingPropImage(7), false)
  assert.equal(app.calls.polls.length, 0)
  assert.ok(app.calls.messages.some(item => item.message.includes('未返回任务 ID')))
})

test('prop retry uses only the failed prop generation and clears only its pending state', async () => {
  const app = harness()
  app.state.props.value = [{ id: 7 }]
  app.state.pendingCharImageIds.value = [7]
  app.state.pendingSceneImageIds.value = [7]
  app.state.imageGenerations.value = [{ id: 42, prop_id: 7, status: 'failed' }, { id: 99, scene_id: 7, status: 'failed' }]
  await app.retryOrGenerateImage('prop', 7, () => assert.fail('should retry'))
  assert.equal(app.calls.retries[0][0], 42)
  assert.equal(app.calls.retries[0][1].episode_id, 15)
  assert.equal(app.calls.retries[0][1].config_id, 23)
  assert.equal(app.calls.polls[0].generationId, 88)
  app.calls.polls[0].clearPending(7)
  assert.equal(app.state.pendingPropImageIds.value.length, 0)
  assert.deepEqual(app.state.pendingCharImageIds.value, [7])
  assert.deepEqual(app.state.pendingSceneImageIds.value, [7])
})

test('scene failure never sends a prop to the retry endpoint', async () => {
  const app = harness()
  app.state.imageGenerations.value = [{ id: 42, scene_id: 7, status: 'failed' }]
  await app.retryOrGenerateImage('prop', 7, () => app.genPropImg(7))
  assert.equal(app.calls.retries.length, 0)
  assert.equal(app.calls.submissions.length, 1)
})

test('prop retry errors clear pending state for a subsequent attempt', async () => {
  const app = harness({ imageAPI: { retry: async () => { throw new Error('offline') } } })
  app.state.imageGenerations.value = [{ id: 42, propId: 7, status: 'failed' }]
  await app.retryOrGenerateImage('prop', 7, () => assert.fail('should retry'))
  assert.equal(app.isPendingPropImage(7), false)
  assert.equal(app.calls.messages.at(-1).message, 'offline')
})

test('prop uploads use the selected prop only, reject wrong formats and prevent generation races', async () => {
  const app = harness()
  app.choosePropMaterial({ id: 7 })
  await app.handlePropMaterialFile({ target: { files: [{ name: 'bad.mp4' }], value: 'bad.mp4' } })
  assert.equal(app.calls.uploads.length, 0)
  const input = { files: [{ name: '道具.png' }], value: '道具.png' }
  await app.handlePropMaterialFile({ target: input })
  assert.equal(app.calls.uploads[0][0], 7)
  assert.equal(input.value, '')
  assert.equal(app.state.uploadingPropImageId.value, null)
  app.choosePropMaterial({ id: 7 })
  app.state.pendingPropImageIds.value = [7]
  await app.handlePropMaterialFile({ target: input })
  assert.equal(app.calls.uploads.length, 1)
})

test('prop-only episodes can enter asset production before storyboard generation', () => {
  const app = harness()
  assert.equal(app.prodStepDone('props'), false)
  app.state.props.value = [{ id: 7 }]
  assert.equal(app.hasExtractedAssets.value, true)
  assert.equal(app.productionNeedsStoryboard.value, false)
  assert.equal(app.activeMainStage.value, 'assets')
  assert.equal(app.mainStageDone('assets'), false)
  app.state.props.value[0].image_url = 'ready.png'
  assert.equal(app.propImgCount.value, 1)
  assert.equal(app.mainStageDone('assets'), true)
  app.state.prodTab.value = 'videos'
  app.goMainStage('assets')
  assert.equal(app.state.prodTab.value, 'props')
  app.goSubStep('prod:props')
  assert.equal(app.state.panel.value, 'production')
})

test('extraction refresh includes props and the progress denominator follows displayed steps', async () => {
  const app = harness({ episodeAPI: { characters: async () => [], scenes: async () => [], props: async () => [{ id: 7 }] } })
  const counts = await app.refreshExtractedAssets()
  assert.equal(counts.props, 1)
  assert.equal(app.hasExtractedAssets.value, true)
  assert.equal(app.extractedAssetCounts({ text: '提取 2 个角色、1 个场景、3 个道具' }).props, 3)
  assert.equal(app.pipelineTotal.value, 2)
  assert.equal(app.pipelineProgress.value, 1)
  app.state.sidebarSections.value[0].items.push({ done: app.prodStepDone('props') })
  assert.equal(app.pipelineTotal.value, 3)
  assert.equal(app.pipelineProgress.value, 1)
})

test('workbench registers prop navigation, generation, upload and empty-state controls', () => {
  for (const expected of ["prodTab === 'props'", "id: 'props', label: '道具资产'", "key: 'prod:props'", '@click="batchPropImages"', "retryOrGenerateImage('prop'", '@change="handlePropMaterialFile"', '本集暂无道具资产']) {
    assert.ok(pageSource.includes(expected), expected)
  }
  assert.ok(!pageSource.includes('pipelineProgress }}/11'))
})
