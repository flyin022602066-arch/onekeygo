import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStoryboardImagePrompt,
  buildStoryboardImageReferences,
} from '../storyboard-image-request.js'

test('buildStoryboardImageReferences prioritizes source assets and excludes stale first-frame output', () => {
  const refs = buildStoryboardImageReferences({
    frameType: 'first_frame',
    storyboard: {
      firstFrameImage: 'static/images/old-first.png',
      lastFrameImage: 'static/images/old-last.png',
      referenceImages: JSON.stringify(['static/images/story-ref.png']),
    },
    scene: {
      location: '公司办公区',
      time: '深夜',
      imageUrl: 'static/images/scene.png',
    },
    characters: [
      {
        name: '陈风',
        imageUrl: 'static/images/char.png',
        referenceImages: JSON.stringify(['static/images/char-extra.png']),
      },
    ],
    requestReferences: [
      'static/images/old-first.png',
      'static/images/char.png',
      'static/images/manual-ref.png',
    ],
  })

  assert.deepEqual(refs.map(ref => ref.url), [
    'static/images/scene.png',
    'static/images/char.png',
    'static/images/char-extra.png',
    'static/images/story-ref.png',
    'static/images/manual-ref.png',
  ])
})

test('buildStoryboardImageReferences keeps first frame for last-frame continuity but excludes stale last frame', () => {
  const refs = buildStoryboardImageReferences({
    frameType: 'last_frame',
    storyboard: {
      firstFrameImage: 'static/images/first.png',
      lastFrameImage: 'static/images/old-last.png',
      referenceImages: null,
    },
    scene: null,
    characters: [],
    requestReferences: ['static/images/old-last.png'],
  })

  assert.deepEqual(refs.map(ref => ref.url), ['static/images/first.png'])
  assert.equal(refs[0].type, 'continuity')
})

test('buildStoryboardImagePrompt embeds static prompt and reference image duties', () => {
  const prompt = buildStoryboardImagePrompt({
    basePrompt: '前端提示词',
    visualStyle: 'realistic',
    frameType: 'first_frame',
    storyboard: {
      title: '深夜加班',
      imagePrompt: 'Modern office with a tired young Chinese man',
      description: '陈风独自坐在工位前加班',
      action: '揉眼后站起身伸懒腰',
      atmosphere: '寂静压抑',
    },
    scene: { location: '公司办公区', time: '深夜' },
    characters: [{ name: '陈风', appearance: '白衬衫、短发、黑眼圈' }],
    references: [
      { type: 'scene', label: '公司办公区 · 深夜', url: 'static/images/scene.png' },
      { type: 'character', label: '陈风', url: 'static/images/char.png' },
    ],
  })

  assert.match(prompt, /静态画面提示词：Modern office/)
  assert.match(prompt, /角色设定：陈风：白衬衫、短发、黑眼圈/)
  assert.match(prompt, /第1张为场景参考图/)
  assert.match(prompt, /第2张为角色参考图/)
  assert.match(prompt, /不要生成与镜头信息无关/)
  assert.match(prompt, /photorealistic live-action/)
  assert.match(prompt, /未经美颜处理的自然皮肤/)
  assert.match(prompt, /毛孔、细小细纹/)
  assert.match(prompt, /高光滚降/)
  assert.match(prompt, /4K UHD/)
  assert.match(prompt, /3840x2160/)
  assert.match(prompt, /主光从画面左前方约 45°/)
  assert.match(prompt, /严禁 3D 渲染、CGI/)
  assert.equal(prompt.match(/视觉风格锁定（/g)?.length, 1)
})

test('buildStoryboardImageReferences sends current scene and storyboard character images to image generation', () => {
  const refs = buildStoryboardImageReferences({
    frameType: 'first_frame',
    storyboard: {
      id: 25,
      sceneId: 6,
      referenceImages: JSON.stringify(['static/grid-cells/storyboard-ref.png']),
    },
    scene: {
      id: 6,
      location: '知青宿舍',
      time: '上午',
      imageUrl: 'static/images/scene-current.png',
    },
    characters: [
      { id: 8, name: '苏锦年', imageUrl: 'static/images/su-current.png' },
      { id: 9, name: '周小燕', imageUrl: 'static/images/zhou-current.png' },
    ],
  })

  assert.deepEqual(refs.map(ref => `${ref.type}:${ref.url}`), [
    'scene:static/images/scene-current.png',
    'character:static/images/su-current.png',
    'character:static/images/zhou-current.png',
    'storyboard_reference:static/grid-cells/storyboard-ref.png',
  ])
})
