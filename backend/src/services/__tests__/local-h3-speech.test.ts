import test from 'node:test'
import assert from 'node:assert/strict'
import { compileLocalH3SpeechPrompt, isLocalH3SpeechSnapshotCompatible, isLikelyCharacterProfileLine, parseLocalH3Dialogue } from '../local-h3-speech.js'

test('silent local shots cannot inherit a narrator or spoken text from the visual prompt', () => {
  const prompt = compileLocalH3SpeechPrompt('<voice>苏小小</voice> drinks. A narrator says <d>[English] She drinks.</d>', '')
  assert.doesNotMatch(prompt, /<voice>|<d>/)
  assert.match(prompt, /NO SPOKEN WORDS/)
  assert.match(prompt, /No narrator, monologue, voiceover/)
  assert.equal(isLocalH3SpeechSnapshotCompatible(prompt, ''), true)
})

test('only exact scripted words appear in H3 dialogue tags in speaker order', () => {
  const prompt = compileLocalH3SpeechPrompt('胖顾客 claps. 苏小小 smiles.', '胖顾客：厨子小妹儿好酒量！\n苏小小：那是！外号山城酒仙的嘛！')
  assert.deepEqual([...prompt.matchAll(/<d>(.*?)<\/d>/g)].map(match => match[1]), [
    '[Chinese] 厨子小妹儿好酒量！', '[Chinese] 那是！外号山城酒仙的嘛！',
  ])
  assert.match(prompt, /胖顾客 \(S\d+\) says:/)
  assert.match(prompt, /苏小小 \(S\d+\) says:/)
  assert.match(prompt, /One speaker at a time/)
  assert.match(prompt, /Never repeat or copy words from a reference video/)
})

test('stage directions and sound cues are not spoken while explicit voiceover stays explicit', () => {
  const lines = parseLocalH3Dialogue('音效：玻璃杯碰撞\n（镜头推近）\n苏小小（压低声音）：我知道了。\n旁白：夜幕降临。')
  assert.equal(lines.length, 2)
  assert.equal(lines[0].speaker, '苏小小')
  assert.equal(lines[0].text, '我知道了。')
  assert.equal(lines[0].delivery, '压低声音')
  const prompt = compileLocalH3SpeechPrompt('The camera pushes in.', '苏小小（压低声音）：我知道了。\n旁白：夜幕降临。')
  assert.match(prompt, /<d>\[Chinese\] 我知道了。<\/d>/)
  assert.doesNotMatch(prompt, /<d>[^<]*(压低声音|镜头推近|玻璃杯)/)
  assert.match(prompt, /says in an off-screen voiceover: <d>\[Chinese\] 夜幕降临。<\/d> while the on-screen characters' lips remain closed/)
})

test('character profile lines are not compiled as spoken dialogue', () => {
  const profile = '1.沈昭宁：外表十八岁，实则修炼千年的修仙界开山祖师。'
  const ageProfile = '2.陆北辰：20岁/6岁，南楚战神，军功赫赫。'
  assert.equal(isLikelyCharacterProfileLine(profile), true)
  assert.equal(isLikelyCharacterProfileLine(ageProfile), true)
  assert.deepEqual(parseLocalH3Dialogue(`${profile}\n${ageProfile}\n沈昭宁：师父，等等！`).map(line => line.text), ['师父，等等！'])
  const prompt = compileLocalH3SpeechPrompt('沈昭宁 stands by the gate.', `${profile}\n${ageProfile}`)
  assert.doesNotMatch(prompt, /<d>/)
  assert.match(prompt, /NO SPOKEN WORDS/)
  assert.equal(isLikelyCharacterProfileLine('旁白：年龄不是秘密。'), false)
})

test('local audio structure is idempotent and contains all six official sections once', () => {
  const original = '<Picture 1> is Ava. She says "Wait here!" and points at the door.'
  const first = compileLocalH3SpeechPrompt(original, 'Ava: "Wait here!"')
  const second = compileLocalH3SpeechPrompt(first, 'Ava: "Wait here!"')
  assert.equal(second, first)
  assert.equal((first.match(/Wait here!/g) || []).length, 1)
  assert.deepEqual([...first.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):/gm)].map(match => match[1]), [
    'subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music',
  ])
  assert.match(first, /<d>\[English\] Wait here!<\/d>/)
})

test('speaker IDs stay stable across different shot speaking orders', () => {
  const first = compileLocalH3SpeechPrompt('Scene.', 'Ava: Hello.\nBen: Hi.')
  const second = compileLocalH3SpeechPrompt('Scene.', 'Ben: Go.\nAva: Yes.')
  assert.equal(first.match(/Ava \((S\d+)\)/)?.[1], second.match(/Ava \((S\d+)\)/)?.[1])
  const single = compileLocalH3SpeechPrompt('Scene.', 'Ben: Go.', [{ id: 12, name: 'Ben' }])
  assert.match(single, /Ben \(S12\) says:/)
})

test('structured snapshots reject missing, duplicated, changed, or reassigned spoken content', () => {
  const dialogue = 'Ava: Stay here!\nBen: I will.'
  const prompt = compileLocalH3SpeechPrompt('Ava and Ben wait by the door.', dialogue)
  assert.equal(isLocalH3SpeechSnapshotCompatible(prompt, dialogue), true)
  assert.equal(isLocalH3SpeechSnapshotCompatible(prompt.replace('I will.', 'I left.'), dialogue), false)
  assert.equal(isLocalH3SpeechSnapshotCompatible(prompt.replace('says:', 'says in an off-screen voiceover:'), dialogue), false)
  assert.equal(isLocalH3SpeechSnapshotCompatible(prompt.replace(/Ben \(S\d+\) says:/, 'Ava (S123) says:'), dialogue), false)
  assert.equal(isLocalH3SpeechSnapshotCompatible(prompt + '\n<d>[English] Extra words.</d>', dialogue), false)
  assert.equal(isLocalH3SpeechSnapshotCompatible(prompt.replace(/<d>\[English\] I will\.<\/d>/, ''), dialogue), false)
})

test('recompiling a shot replaces previous dialogue without duplicating audio sections', () => {
  const first = compileLocalH3SpeechPrompt('Ava waits.', 'Ava: Wait!')
  const changed = compileLocalH3SpeechPrompt(first, 'Ava: Run!')
  const silent = compileLocalH3SpeechPrompt(changed, '')
  assert.doesNotMatch(changed, /Wait!|NO SPOKEN WORDS/)
  assert.match(changed, /<d>\[English\] Run!<\/d>/)
  assert.doesNotMatch(silent, /Run!|<d>/)
})
