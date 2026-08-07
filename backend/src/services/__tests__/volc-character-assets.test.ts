import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import {
  buildVolcAssetCreatePayload,
  isRetryableVolcAssetCreateError,
  syncVolcCharacterAssetForCharacter,
} from '../volc-asset-sync.js'

test('buildVolcAssetCreatePayload keeps role assets on the Volc asset create API shape', () => {
  const payload = buildVolcAssetCreatePayload({
    groupId: 'group-local-1',
    publicUrl: 'https://cdn.example.com/chenfeng.png',
    name: '角色-陈风',
    projectName: 'default',
    assetType: 'Image',
  })

  assert.deepEqual(payload, {
    group_id: 'group-local-1',
    url: 'https://cdn.example.com/chenfeng.png',
    name: '角色-陈风',
    asset_type: 'Image',
    project_name: 'default',
    wait_for_active: true,
    timeout_ms: 120000,
  })
})

test('Volc asset creation retries transient gateway failures only', () => {
  assert.equal(isRetryableVolcAssetCreateError(new Error('创建火山素材失败: HTTP 502 upstream unavailable')), true)
  assert.equal(isRetryableVolcAssetCreateError(new Error('fetch failed: ECONNRESET')), true)
  assert.equal(isRetryableVolcAssetCreateError(new Error('创建火山素材失败: HTTP 400 invalid url')), false)
})

test('syncVolcCharacterAssetForCharacter uploads the character image and stores the returned role URI', async () => {
  const ts = new Date().toISOString()
  const created = db.insert(schema.characters).values({
    dramaId: 987654,
    name: `测试角色-${Date.now()}`,
    role: '男主',
    description: '测试角色',
    appearance: '',
    personality: '',
    imageUrl: 'static/images/chenfeng.png',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const characterId = Number(created.lastInsertRowid)
  const calls: any[] = []

  try {
    const synced = await syncVolcCharacterAssetForCharacter(characterId, {
      syncAsset: async (input) => {
        calls.push(input)
        return {
          localAssetId: 77,
          providerAssetId: 'asset-chenfeng',
          assetUri: 'asset://asset-chenfeng',
          providerGroupId: 'volc-group-1',
          localGroupId: 'group-local-1',
          groupName: '测试角色库',
          providerUrl: 'https://provider.example.com/preview.png',
          publicUrl: 'https://cdn.example.com/chenfeng.png',
        }
      },
    })

    assert.equal(synced.providerAssetId, 'asset-chenfeng')
    assert.equal(synced.assetUri, 'asset://asset-chenfeng')
    assert.deepEqual(calls.map(call => ({
      url: call.url,
      name: call.name,
      category: call.category,
      dramaId: call.dramaId,
      source: call.source,
      assetType: call.assetType,
    })), [{
      url: 'static/images/chenfeng.png',
      name: calls[0].name,
      category: 'character',
      dramaId: 987654,
      source: 'volc:characterLibrary',
      assetType: 'Image',
    }])

    const [updated] = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).all()
    assert.equal(updated.volcCharacterAssetId, 'asset-chenfeng')
    assert.equal(updated.volcCharacterUri, 'asset://asset-chenfeng')
    assert.equal(updated.volcCharacterLocalAssetId, 77)
    assert.equal(updated.volcCharacterSyncStatus, 'uploaded')
    assert.equal(updated.volcCharacterSyncError, null)
    assert.ok(updated.volcCharacterSyncedAt)
  } finally {
    db.delete(schema.characters).where(eq(schema.characters.id, characterId)).run()
  }
})

test('syncVolcCharacterAssetForCharacter records upload failure without deleting the character image', async () => {
  const ts = new Date().toISOString()
  const created = db.insert(schema.characters).values({
    dramaId: 987655,
    name: `测试失败角色-${Date.now()}`,
    role: '女主',
    description: '测试角色',
    appearance: '',
    personality: '',
    imageUrl: 'static/images/suqingxue.png',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const characterId = Number(created.lastInsertRowid)

  try {
    await assert.rejects(
      () => syncVolcCharacterAssetForCharacter(characterId, {
        syncAsset: async () => {
          throw new Error('创建火山角色资产失败')
        },
      }),
      /创建火山角色资产失败/,
    )

    const [updated] = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).all()
    assert.equal(updated.imageUrl, 'static/images/suqingxue.png')
    assert.equal(updated.volcCharacterSyncStatus, 'failed')
    assert.match(updated.volcCharacterSyncError || '', /创建火山角色资产失败/)
  } finally {
    db.delete(schema.characters).where(eq(schema.characters.id, characterId)).run()
  }
})
