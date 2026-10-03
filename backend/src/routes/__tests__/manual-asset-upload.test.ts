import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onekeygo-manual-assets-'))
process.env.DB_PATH = path.join(testRoot, 'test.db')
process.env.STORAGE_PATH = path.join(testRoot, 'static')
process.env.CONFIG_PATH = path.join(testRoot, 'missing-config.yaml')

const { db, schema } = await import('../../db/index.js')
const { default: scenes } = await import('../scenes.js')
const { default: props } = await import('../props.js')
const { default: characters } = await import('../characters.js')

const ts = new Date().toISOString()
const dramaResult = db.insert(schema.dramas).values({
  title: 'Manual assets test',
  createdAt: ts,
  updatedAt: ts,
}).run()
const dramaId = Number(dramaResult.lastInsertRowid)
const episodeResult = db.insert(schema.episodes).values({
  dramaId,
  episodeNumber: 1,
  title: 'Episode 1',
  createdAt: ts,
  updatedAt: ts,
}).run()
const episodeId = Number(episodeResult.lastInsertRowid)

// A valid 1x1 PNG. The upload handlers normalize it to the UHD asset canvas;
// a signature-only byte sequence would pass MIME validation but fail Sharp.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function imageForm(fields: Record<string, string>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  form.append('file', new File([png], 'asset.png', { type: 'image/png' }))
  return form
}

test('manual character upload creates an episode-linked character with its local image', async () => {
  const response = await characters.request('/upload-image', {
    method: 'POST',
    body: imageForm({ drama_id: String(dramaId), episode_id: String(episodeId), name: '手动角色' }),
  })
  assert.equal(response.status, 201)
  const payload = await response.json() as any
  assert.equal(payload.data.name, '手动角色')
  assert.match(payload.data.imageUrl, /^static\/characters\/.+\.png$/)
  const links = db.select().from(schema.episodeCharacters).all()
  assert.ok(links.some(link => link.episodeId === episodeId && link.characterId === payload.data.id))
})

test('manual scene upload creates an episode-linked scene with its local image', async () => {
  const response = await scenes.request('/upload-image', {
    method: 'POST',
    body: imageForm({ drama_id: String(dramaId), episode_id: String(episodeId), location: '手动场景' }),
  })
  assert.equal(response.status, 201)
  const payload = await response.json() as any
  assert.equal(payload.data.location, '手动场景')
  assert.match(payload.data.imageUrl, /^static\/scenes\/.+\.png$/)
  const links = db.select().from(schema.episodeScenes).all()
  assert.ok(links.some(link => link.episodeId === episodeId && link.sceneId === payload.data.id))
})

test('manual prop upload creates an episode-linked prop even when the episode initially has none', async () => {
  const response = await props.request('/upload-image', {
    method: 'POST',
    body: imageForm({ drama_id: String(dramaId), episode_id: String(episodeId), name: '手动道具' }),
  })
  assert.equal(response.status, 201)
  const payload = await response.json() as any
  assert.equal(payload.data.name, '手动道具')
  assert.match(payload.data.imageUrl, /^static\/props\/.+\.png$/)
  const links = db.select().from(schema.episodeProps).all()
  assert.ok(links.some(link => link.episodeId === episodeId && link.propId === payload.data.id))
})

test('manual asset upload rejects an episode from another project', async () => {
  const response = await props.request('/upload-image', {
    method: 'POST',
    body: imageForm({ drama_id: String(dramaId + 1), episode_id: String(episodeId), name: '错误道具' }),
  })
  assert.equal(response.status, 400)
})

test('asset delete endpoints hide the deleted character, scene, and prop', async () => {
  const characterResponse = await characters.request('/upload-image', {
    method: 'POST',
    body: imageForm({ drama_id: String(dramaId), episode_id: String(episodeId), name: '待删除角色' }),
  })
  const character = await characterResponse.json() as any
  const sceneResponse = await scenes.request('/upload-image', {
    method: 'POST',
    body: imageForm({ drama_id: String(dramaId), episode_id: String(episodeId), location: '待删除场景' }),
  })
  const scene = await sceneResponse.json() as any
  const propResponse = await props.request('/upload-image', {
    method: 'POST',
    body: imageForm({ drama_id: String(dramaId), episode_id: String(episodeId), name: '待删除道具' }),
  })
  const prop = await propResponse.json() as any

  for (const [router, id] of [[characters, character.data.id], [scenes, scene.data.id], [props, prop.data.id]] as const) {
    const response = await router.request(`/${id}`, { method: 'DELETE' })
    assert.equal(response.status, 200)
  }

  const deletedCharacter = db.select().from(schema.characters).where(eq(schema.characters.id, character.data.id)).get()
  const deletedScene = db.select().from(schema.scenes).where(eq(schema.scenes.id, scene.data.id)).get()
  const deletedProp = db.select().from(schema.props).where(eq(schema.props.id, prop.data.id)).get()
  assert.ok(deletedCharacter?.deletedAt)
  assert.ok(deletedScene?.deletedAt)
  assert.ok(deletedProp?.deletedAt)
})
