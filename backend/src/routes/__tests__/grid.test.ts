import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGridGenerationPrompt, buildGridPrompt, parseGridFrameType, resolveGridGenerationStoryboardId } from '../grid.js'

test('multi-reference grid generations are bound to the selected storyboard', () => {
  assert.equal(
    resolveGridGenerationStoryboardId('multi_ref', [{ id: 15 }, { id: 14 }]),
    15,
  )
})

test('batch grid generations are not bound to one storyboard', () => {
  assert.equal(resolveGridGenerationStoryboardId('first_frame', [{ id: 15 }]), undefined)
  assert.equal(resolveGridGenerationStoryboardId('first_last', [{ id: 15 }]), undefined)
})

test('parseGridFrameType extracts mode and layout from grid frame types', () => {
  assert.deepEqual(parseGridFrameType('grid_first_frame_2x2'), {
    mode: 'first_frame',
    rows: 2,
    cols: 2,
  })
  assert.deepEqual(parseGridFrameType('grid_first_last_2x4'), {
    mode: 'first_last',
    rows: 2,
    cols: 4,
  })
  assert.deepEqual(parseGridFrameType('grid_multi_ref_4x6'), {
    mode: 'multi_ref',
    rows: 4,
    cols: 6,
  })
  assert.equal(parseGridFrameType('first_frame'), null)
})

test('buildGridPrompt fallback text is localized for Chinese production workflow', () => {
  const prompt = buildGridPrompt(
    'multi_ref',
    [{ id: 15, storyboardNumber: 3, imagePrompt: '陈风在深夜办公室回头看向门口' }],
    2,
    2,
    '赛博末世动漫',
    [],
  )

  assert.match(prompt, /2x2 宫格布局/)
  assert.match(prompt, /同一镜头的不同角度和构图/)
  assert.doesNotMatch(prompt, /wide establishing shot|same scene|grid layout|high quality|no text/i)
})

test('multi-reference grid generation prompt is anchored to the selected storyboard static prompt', () => {
  const prompt = buildGridGenerationPrompt(
    'multi_ref',
    [{
      id: 25,
      storyboardNumber: 1,
      title: '宿舍哭声',
      description: '众人围在炕边哭闹',
      imagePrompt: '苏锦年脸色苍白头发潮湿昏睡，周小燕和农村妇人围在炕边焦急哭闹',
      location: '知青宿舍',
      shotType: '全景',
    }],
    2,
    2,
    '现实主义年代剧',
    [],
    '2x2 grid layout, exactly 4 visible panels, consistent art style',
  )

  assert.match(prompt, /只生成分镜 #01《宿舍哭声》/)
  assert.match(prompt, /核心静态画面提示词：苏锦年脸色苍白头发潮湿昏睡/)
  assert.match(prompt, /用户补充提示/)
  assert.match(prompt, /2x2 grid layout/)
  assert.match(prompt, /写实真人电影风格/)
  assert.match(prompt, /严禁 3D 渲染、CGI/)
})

test('different storyboard image prompts produce different multi-reference grid prompts', () => {
  const shot1 = buildGridGenerationPrompt(
    'multi_ref',
    [{ id: 25, storyboardNumber: 1, title: '宿舍哭声', imagePrompt: '苏锦年昏睡，众人围在炕边哭闹' }],
    2,
    2,
    '',
    [],
  )
  const shot2 = buildGridGenerationPrompt(
    'multi_ref',
    [{ id: 26, storyboardNumber: 2, title: '落水传言', imagePrompt: '俯视土炕，苏锦年眉头紧锁，妇人甲抹泪哭喊' }],
    2,
    2,
    '',
    [],
  )

  assert.notEqual(shot1, shot2)
  assert.match(shot1, /苏锦年昏睡/)
  assert.match(shot2, /俯视土炕/)
})

test('multi-reference prompt keeps the target storyboard before generic custom text', () => {
  const prompt = buildGridGenerationPrompt(
    'multi_ref',
    [{
      id: 26,
      storyboardNumber: 2,
      title: '落水传言',
      imagePrompt: '俯视土炕，苏锦年苍白虚弱躺在旧被褥上，妇人甲抹泪哭喊',
      description: '通过妇人甲的话交代跳河事实，镜头聚焦苏锦年的细微反应',
    }],
    2,
    2,
    '现实主义年代剧',
    [{ imageLabel: '图片1', label: '知青宿舍场景' }],
    '2x2 grid layout, exactly 4 visible panels, consistent art style',
  )

  assert.match(prompt, /只生成分镜 #02《落水传言》/)
  assert.match(prompt, /核心静态画面提示词：俯视土炕/)
  assert.match(prompt, /剧情\/画面描述：通过妇人甲的话交代跳河事实/)
  assert.match(prompt, /参考图映射：图片1=知青宿舍场景/)
})
