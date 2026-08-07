import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGrokSequencePrompt, buildSequencePrompt } from '../video-sequence.js'

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
  assert.match(prompt, /首帧画面资产必须作为本镜头第一帧/)
  assert.match(prompt, /<role>林凡<\/role>走进<location>客厅<\/location>/)
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
})
