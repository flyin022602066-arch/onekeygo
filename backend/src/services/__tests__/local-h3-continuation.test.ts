import test from 'node:test'
import assert from 'node:assert/strict'
import { applyLocalH3VideoContinuation } from '../local-h3-continuation.js'
import { compileLocalH3SpeechPrompt } from '../local-h3-speech.js'

test('video continuation starts each relevant section from the actual ending view', () => {
  const original = compileLocalH3SpeechPrompt('LOCAL SERIAL VIDEO CONTINUATION: <Video 1> is the complete previous shot.\nGenerate exactly one shot in sequence. Keep the same visual identity across shots and follow the original shot direction below.\n0-2.5s: 0-second opening continuity image state: Ava is left; Ben is already right. The camera pushes to the bottle.', 'Ava: Hello!')
  const prompt = applyLocalH3VideoContinuation(original)
  assert.match(prompt, /^subject_definitions:\nMANDATORY SERIAL VIDEO EXTENSION \(all shots after the first\):/)
  assert.match(prompt, /本分镜为 <Video 1> 参考视频的延长和继承/)
  assert.ok(prompt.indexOf('MANDATORY SERIAL VIDEO EXTENSION') < prompt.indexOf('LOCAL H3 VIDEO END CONTINUATION BEGIN'))
  assert.ok(prompt.indexOf('final visible instant of <Video 1>') < prompt.indexOf('LOCAL SERIAL VIDEO CONTINUATION:'))
  assert.match(prompt, /summary:\n\[video continuation \+ reference generation\]/)
  assert.match(prompt, /retention_analysis:\nLOCAL H3 VIDEO END RETENTION BEGIN/)
  assert.match(prompt, /detailed_description:\nLOCAL H3 VIDEO END HANDOFF BEGIN/)
  assert.match(prompt, /At 0\.00s, inherit the exact ending view/)
  assert.match(prompt, /camera position, angle, shot size, perspective/)
  assert.match(prompt, /Do not restart from the beginning or a representative moment/)
  assert.match(prompt, /Do not cut, reset the camera, teleport/)
  assert.match(prompt, /Picture references define identity and appearance, not a replacement opening composition/)
  assert.match(prompt, /only this shot's starting anchor/)
  assert.match(prompt, /not the requested ending state/)
  assert.match(prompt, /finish at a new result/)
  assert.match(prompt, /Ava is left; Ben is already right/)
  assert.match(prompt, /TARGET STAGING TO REACH THROUGH CONTINUOUS MOTION/)
  assert.doesNotMatch(prompt, /0-second opening continuity image state:/)
  assert.equal((prompt.match(/<d>\[English\] Hello!<\/d>/g) || []).length, 1)
})

test('continuation insertion is idempotent through repeated audio compilation', () => {
  const original = compileLocalH3SpeechPrompt('LOCAL SERIAL VIDEO CONTINUATION: <Video 1>. The woman reaches for a bottle.', '')
  const once = applyLocalH3VideoContinuation(original)
  assert.equal(applyLocalH3VideoContinuation(once), once)
  assert.equal(applyLocalH3VideoContinuation(compileLocalH3SpeechPrompt(once, '')), once)
  assert.equal((once.match(/LOCAL H3 VIDEO END CONTINUATION BEGIN/g) || []).length, 1)
  assert.match(once, /NO SPOKEN WORDS/)
  assert.doesNotMatch(once, /<d>/)
})

test('legacy Chinese or English opening labels become targets, never overwrite spoken words', () => {
  const prompt = applyLocalH3VideoContinuation(compileLocalH3SpeechPrompt(
    '0至2秒：0秒首帧状态：女孩居左，男人居右。\n0-2s: 0-second first-frame state: Ava by the table.',
    'Ava: "0-second first-frame state: do not say this twice."',
  ))
  assert.doesNotMatch(prompt.split('LOCAL H3 AUTHORIZED SPEECH BEGIN')[0]!, /0秒首帧状态|0-second first-frame state:/)
  assert.match(prompt, /<d>\[English\] 0-second first-frame state: do not say this twice\.<\/d>/)
})

test('plain legacy prompts gain a continuation contract without fake frame slots', () => {
  const prompt = applyLocalH3VideoContinuation('<Picture 1> a woman turns and raises a cup.')
  assert.match(prompt, /^subject_definitions:/)
  assert.match(prompt, /<Video 1>/)
  assert.match(prompt, /<Picture 1> a woman turns and raises a cup\./)
  assert.doesNotMatch(prompt, /first_frame|last_frame|FL2VA|I2V|Picture 1.*ending view/)
  assert.deepEqual([...prompt.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):/gm)].map(match => match[1]), [
    'subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music',
  ])
})
