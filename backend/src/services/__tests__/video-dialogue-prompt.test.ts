import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendVideoDialoguePrompt,
  normalizeVideoDialogue,
  normalizeLocalVideoDialogue,
  stripInlineChineseTranslation,
  stripInjectedVideoDialogue,
  appendStoryboardDialoguePrompt,
} from '../video-dialogue-prompt.js'

test('local H3 splits explicit slash-separated speakers without changing spoken slash content', () => {
  assert.equal(normalizeLocalVideoDialogue('甲：好了！ / 乙：走吧。'), '甲：好了！\n乙：走吧。')
  assert.equal(normalizeLocalVideoDialogue('甲：好了！ ／ 乙：走吧。'), '甲：好了！\n乙：走吧。')
  assert.equal(normalizeLocalVideoDialogue('A: Use 1/2 cup and http://example.test/a/b / then stir.'), 'A: Use 1/2 cup and http://example.test/a/b / then stir.')
  assert.equal(normalizeLocalVideoDialogue('A: Visit / https://example.test/a/b'), 'A: Visit / https://example.test/a/b')
})

test('local H3 native audio includes both slash-separated speakers and leaves ordinary channels unchanged', () => {
  const dialogue = '胖顾客：好酒量！ / 苏小小：那是！'
  const prompt = appendVideoDialoguePrompt('Scene.', dialogue, 'standard', [], true)
  assert.match(prompt, /胖顾客 \(S\d+\) says: <d>\[Chinese\] 好酒量！<\/d>/)
  assert.match(prompt, /苏小小 \(S\d+\) says: <d>\[Chinese\] 那是！<\/d>/)
  assert.match(prompt, /Only these scripted speakers may speak: 胖顾客, 苏小小/)
  assert.equal(normalizeVideoDialogue(dialogue), dialogue)
  assert.match(appendVideoDialoguePrompt('Scene.', dialogue, 'standard'), /胖顾客：好酒量！ \/ 苏小小：那是！/)
  assert.match(appendVideoDialoguePrompt('Scene.', dialogue, 'minimax_local_8s'), /胖顾客：好酒量！ \/ 苏小小：那是！/)
  assert.match(appendVideoDialoguePrompt('Scene.', dialogue, 'minimax_local_8s', [], true), /<d>\[Chinese\] 好酒量！<\/d>/)
})

test('empty local dialogue never uses stale visual voice tags as permission to speak', () => {
  const prompt = appendVideoDialoguePrompt('<voice>苏小小</voice> drinks beer. <d>[Chinese] 旧台词。</d>', '', 'standard', [], true)
  assert.match(prompt, /NO SPOKEN WORDS/)
  assert.doesNotMatch(prompt, /<voice>|<d>|旧台词/)
  assert.equal(appendVideoDialoguePrompt(prompt, '', 'standard', [], true), prompt)
  assert.equal(normalizeLocalVideoDialogue('音效：杯子碰撞\n（镜头推近）'), '')
})

test('TK video prompt keeps English dialogue and removes an inline Chinese translation', () => {
  const dialogue = 'Eli: “Hey! That case is mine!”（嘿！那是我的箱子！）'
  const normalized = normalizeVideoDialogue(dialogue, 'tk_overseas')

  assert.equal(normalized, 'Eli: “Hey! That case is mine!”')
  const prompt = appendVideoDialoguePrompt('0-5s: Eli turns toward the door.', dialogue, 'tk_overseas')
  assert.match(prompt, /Eli: “Hey! That case is mine!”/)
  assert.match(prompt, /对白语言：English/)
  assert.doesNotMatch(prompt, /嘿！那是我的箱子/)
})

test('ordinary video prompt preserves non-empty dialogue verbatim', () => {
  const prompt = appendVideoDialoguePrompt('0-5秒：人物抬头。', '林凡：你来了。', 'standard')
  assert.match(prompt, /林凡：你来了。/)
  assert.match(prompt, /对白\/旁白原文/)
  assert.match(prompt, /对白互动与视线硬约束/)
  assert.match(prompt, /视线落在听者眼睛或脸部/)
  assert.match(prompt, /严禁无理由看向摄影机镜头/)
  assert.match(prompt, /over-the-shoulder shots and shot\/reverse-shot/i)
})

test('mixed English dialogue uses the English original outside TK mode', () => {
  const dialogue = 'Eli: "Hey!"（嘿！）'
  assert.equal(stripInlineChineseTranslation(dialogue), 'Eli: "Hey!"')
  assert.equal(normalizeVideoDialogue(dialogue, 'standard'), 'Eli: "Hey!"')
  assert.equal(normalizeVideoDialogue('Eli：你好', 'standard'), 'Eli：你好')
})

test('empty or ambient-only dialogue does not add a dialogue block', () => {
  const prompt = appendVideoDialoguePrompt('0-5秒：空镜。', '环境音', 'tk_overseas')
  assert.equal(prompt, '0-5秒：空镜。')
})

test('refreshing a prompt replaces the old automatic dialogue block instead of duplicating it', () => {
  const first = appendVideoDialoguePrompt('镜头动作。', 'Eli: "Wait."', 'tk_overseas')
  const refreshed = appendVideoDialoguePrompt(first, 'Eli: "Run!"', 'tk_overseas')

  assert.doesNotMatch(refreshed, /Eli: "Wait\."/)
  assert.equal((refreshed.match(/视频对白约束（自动注入 BEGIN）/g) || []).length, 1)
  assert.match(refreshed, /Eli: "Run!"/)
  assert.equal(stripInjectedVideoDialogue(refreshed), '镜头动作。')
})

test('character profiles are removed from the dialogue source without removing real lines', () => {
  const dialogue = '1.沈昭宁：外表十八岁，实则修炼千年的修仙界开山祖师。\n沈昭宁：师父，等等！'
  assert.equal(normalizeVideoDialogue(dialogue, 'minimax_local_8s'), '沈昭宁：师父，等等！')
  assert.equal(normalizeLocalVideoDialogue(dialogue, 'minimax_local_8s'), '沈昭宁：师父，等等！')
})

test('voice-over narration does not force an on-screen mutual eyeline', () => {
  const prompt = appendVideoDialoguePrompt('0-5秒：空镜。', '旁白：夜幕降临。', 'standard')
  assert.match(prompt, /旁白：夜幕降临。/)
  assert.doesNotMatch(prompt, /对白互动与视线硬约束/)
})

test('does not copy dialogue text when video_prompt already describes the spoken line', () => {
  const prompt = appendVideoDialoguePrompt(
    '0-4秒：Eli turns to the door and says "Wait, stay here!" with a tense voice.',
    'Eli: "Wait, stay here!"',
    'standard',
  )

  assert.equal((prompt.match(/Wait, stay here!/g) || []).length, 1)
  assert.match(prompt, /对白唯一来源：storyboard dialogue 字段/)
  assert.doesNotMatch(prompt, /本镜头必须使用以下对白\/旁白原文/)
})

test('fills only missing lines when a prompt contains part of a multi-line dialogue', () => {
  const prompt = appendVideoDialoguePrompt(
    '先听见 Lin: "你好。"，随后她转身。',
    'Lin: "你好。"\nLin: "请进。"',
    'standard',
  )

  assert.equal((prompt.match(/你好。/g) || []).length, 1)
  assert.equal((prompt.match(/请进。/g) || []).length, 1)
})

test('MiniMax local dialogue prompt locks native audio to named speakers and silent tail', () => {
  const prompt = appendVideoDialoguePrompt('0-8秒：凤溪抬头。', '凤溪：你们要干什么！放开我！', 'minimax_local_8s')
  assert.match(prompt, /原生音频硬约束/)
  assert.match(prompt, /只允许对白字段指定的说话人发声：凤溪/)
  assert.match(prompt, /绝对静音直到本镜结束/)
  assert.match(prompt, /No extra male or female voice/i)
})

test('MiniMax local dialogue prompt pins each speaker gender and voice id across shots', () => {
  const bindings = [
    { name: '苏小小', aliases: ['Su Xiaoxiao'], gender: 'female', voiceStyle: 'female-shaonv', voiceProvider: 'minimax' },
    { name: '苏大强', aliases: ['Su Daqiang'], gender: 'male', voiceStyle: 'male-qn-badao', voiceProvider: 'minimax' },
  ]
  const femaleShot = appendVideoDialoguePrompt('苏小小看向苏大强。', '苏小小：你回来了。', 'minimax_local_8s', bindings)
  const maleShot = appendVideoDialoguePrompt('苏大强看向苏小小。', '苏大强：嗯，我回来了。', 'minimax_local_8s', bindings)
  assert.match(femaleShot, /苏小小: gender=female; voice_id=female-shaonv; provider=minimax/)
  assert.match(maleShot, /苏大强: gender=male; voice_id=male-qn-badao; provider=minimax/)
  assert.match(femaleShot, /不得改变性别、音色 ID、音高身份/)
  assert.match(femaleShot, /Use the declared speaker-to-gender-to-voice_id mapping exactly/i)
  assert.doesNotMatch(femaleShot, /苏大强: gender=/)
})

test('native H3 audio lock is not injected into ordinary providers', () => {
  const prompt = appendVideoDialoguePrompt('0-5秒：人物抬头。', '凤溪：你们要干什么！', 'standard')
  assert.doesNotMatch(prompt, /原生音频硬约束/)
})

test('storyboard final prompt always carries the shared visual negative contract', () => {
  const prompt = appendStoryboardDialoguePrompt('0-8秒：角色看向门口。')
  assert.match(prompt, /视频画面负面约束（自动注入 BEGIN）/)
  assert.match(prompt, /变脸、换人、五官漂移/)
  assert.match(prompt, /保持场景一致性、人物一致性/)
  assert.equal((prompt.match(/视频画面负面约束（自动注入 BEGIN）/g) || []).length, 1)
})

test('storyboard negative contract stays after local H3 speech sections', () => {
  const prompt = appendStoryboardDialoguePrompt(
    'subject_definitions:\nAva is in the room.\nsummary:\nAva looks at the door.',
    undefined,
    'minimax_local_8s',
    true,
  )
  assert.match(prompt, /LOCAL H3 AUTHORIZED SPEECH END[\s\S]*视频画面负面约束（自动注入 BEGIN）/)
})
