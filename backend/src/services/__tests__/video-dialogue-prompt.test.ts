import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendVideoDialoguePrompt,
  normalizeVideoDialogue,
  stripInjectedVideoDialogue,
} from '../video-dialogue-prompt.js'

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
