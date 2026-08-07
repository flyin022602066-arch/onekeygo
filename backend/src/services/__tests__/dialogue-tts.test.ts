import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDialogueTTSSegments, parseDialogueForTTS } from '../dialogue-tts.js'

test('parseDialogueForTTS splits multi-speaker storyboard dialogue into ordered segments', () => {
  const parsed = parseDialogueForTTS(`林凡：（惊喜又小心）雨欣，生日快乐。我等你很久了，想给你个惊喜。
王雨欣：（不耐烦）林凡，你怎么又来了？我不是说过，别来公司找我吗？`)

  assert.equal(parsed.ignorable, false)
  assert.deepEqual(parsed.segments.map(item => item.speaker), ['林凡', '王雨欣'])
  assert.deepEqual(parsed.segments.map(item => item.text), [
    '雨欣，生日快乐。我等你很久了，想给你个惊喜。',
    '林凡，你怎么又来了？我不是说过，别来公司找我吗？',
  ])
  assert.equal(parsed.pureText, '雨欣，生日快乐。我等你很久了，想给你个惊喜。\n林凡，你怎么又来了？我不是说过，别来公司找我吗？')
  assert.equal(parsed.subtitleText, '林凡：雨欣，生日快乐。我等你很久了，想给你个惊喜。\n王雨欣：林凡，你怎么又来了？我不是说过，别来公司找我吗？')
})
test('buildDialogueTTSSegments resolves each speaker to its own character voice', () => {
  const segments = buildDialogueTTSSegments(
    `赵天龙：（嗤笑）就这？雨欣，你以前的眼光可真够差的。
王雨欣：（鄙夷）林凡，你一个吃软饭的废物，也好意思来给我过生日？`,
    [
      { name: '赵天龙', voiceStyle: 'male-qn-badao' },
      { name: '王雨欣', voiceStyle: 'female-shaonv' },
      { name: '林凡', voiceStyle: 'male-qn-qingse' },
    ],
  )

  assert.deepEqual(segments.map(item => ({ speaker: item.speaker, voice: item.voice, text: item.text })), [
    { speaker: '赵天龙', voice: 'male-qn-badao', text: '就这？雨欣，你以前的眼光可真够差的。' },
    { speaker: '王雨欣', voice: 'female-shaonv', text: '林凡，你一个吃软饭的废物，也好意思来给我过生日？' },
  ])
})
