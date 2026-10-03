import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import {
  buildVolcAssetCreatePayload,
  isRetryableVolcAssetCreateError,
  syncVolcCharacterAssetForCharacter,
  syncVolcPropAssetForProp,
  syncVolcSceneAssetForScene,
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

test('syncVolcSceneAssetForScene automatically uploads the generated scene with episode context', async () => {
  const ts = new Date().toISOString()
  const created = db.insert(schema.scenes).values({
    dramaId: 987656,
    episodeId: 765432,
    location: `scene-${Date.now()}`,
    time: 'day',
    prompt: 'scene prompt',
    imageUrl: 'static/images/generated-scene.png',
    localPath: 'static/images/generated-scene.png',
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const sceneId = Number(created.lastInsertRowid)
  const calls: any[] = []

  try {
    await syncVolcSceneAssetForScene(sceneId, {
      syncAsset: async (input) => {
        calls.push(input)
        return fakeSyncedAsset('asset-scene')
      },
    })
    assert.deepEqual(calls.map(call => ({
      url: call.url,
      category: call.category,
      dramaId: call.dramaId,
      episodeId: call.episodeId,
      source: call.source,
    })), [{
      url: 'static/images/generated-scene.png',
      category: 'scene',
      dramaId: 987656,
      episodeId: 765432,
      source: 'volc:autoSceneImage',
    }])
  } finally {
    db.delete(schema.scenes).where(eq(schema.scenes.id, sceneId)).run()
  }
})

test('syncVolcPropAssetForProp automatically uploads the generated prop with linked episode context', async () => {
  const ts = new Date().toISOString()
  const created = db.insert(schema.props).values({
    dramaId: 987657,
    name: `prop-${Date.now()}`,
    imageUrl: 'static/images/generated-prop.png',
    localPath: 'static/images/generated-prop.png',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const propId = Number(created.lastInsertRowid)
  const link = db.insert(schema.episodeProps).values({ episodeId: 765433, propId, createdAt: ts }).run()
  const linkId = Number(link.lastInsertRowid)
  const calls: any[] = []

  try {
    await syncVolcPropAssetForProp(propId, {
      syncAsset: async (input) => {
        calls.push(input)
        return fakeSyncedAsset('asset-prop')
      },
    })
    assert.deepEqual(calls.map(call => ({
      url: call.url,
      category: call.category,
      dramaId: call.dramaId,
      episodeId: call.episodeId,
      source: call.source,
    })), [{
      url: 'static/images/generated-prop.png',
      category: 'prop',
      dramaId: 987657,
      episodeId: 765433,
      source: 'volc:autoPropImage',
    }])
  } finally {
    db.delete(schema.episodeProps).where(eq(schema.episodeProps.id, linkId)).run()
    db.delete(schema.props).where(eq(schema.props.id, propId)).run()
  }
})

function fakeSyncedAsset(providerAssetId: string) {
  return {
    localAssetId: 1,
    providerAssetId,
    assetUri: `Asset://${providerAssetId}`,
    providerGroupId: 'provider-group',
    localGroupId: 'local-group',
    groupName: 'test-group',
    providerUrl: 'https://provider.example.com/preview.png',
    publicUrl: 'https://cdn.example.com/image.png',
  }
}
