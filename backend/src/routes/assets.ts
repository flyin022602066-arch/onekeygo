import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, now, success } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { syncVolcImageAssetBatch } from '../services/volc-asset-sync.js'
import type { VolcAssetReferenceInput } from '../services/volc-asset-sync.js'

const app = new Hono()

app.get('/', async (c) => {
  const dramaId = c.req.query('drama_id')
  const provider = c.req.query('provider')
  let rows = db.select().from(schema.assets).all()
    .filter(row => !row.deletedAt)

  if (dramaId) rows = rows.filter(row => row.dramaId === Number(dramaId))
  if (provider) rows = rows.filter(row => row.provider === provider)

  rows = rows.sort((a, b) => Number(b.id) - Number(a.id))
  return success(c, rows.map(row => toSnakeCase(row)))
})

app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id) || id <= 0) return badRequest(c, '资产 ID 无效')

  const body = await c.req.json().catch(() => ({}))
  const name = String(body.name || '').trim()
  if (!name) return badRequest(c, '本地调用名不能为空')
  if (name.length > 80) return badRequest(c, '本地调用名不能超过 80 个字符')
  if (/[=@\r\n]/.test(name)) return badRequest(c, '本地调用名不能包含 =、@ 或换行')

  const [existing] = db.select().from(schema.assets).where(eq(schema.assets.id, id)).all()
  if (!existing || existing.deletedAt) return badRequest(c, '资产不存在')

  db.update(schema.assets)
    .set({ name, updatedAt: now() })
    .where(eq(schema.assets.id, id))
    .run()

  const [updated] = db.select().from(schema.assets).where(eq(schema.assets.id, id)).all()
  return success(c, toSnakeCase(updated))
})

app.post('/volc/sync', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const refs = Array.isArray(body.references) ? body.references : []
  if (!refs.length) return badRequest(c, 'references is required')

  const force = body.force === true
  const normalized: VolcAssetReferenceInput[] = refs.map((ref: any, index: number) => ({
    url: String(ref?.url || '').trim(),
    name: String(ref?.name || `参考图${index + 1}`).trim(),
    category: String(ref?.category || 'storyboard').trim(),
    dramaId: asOptionalNumber(ref?.drama_id ?? ref?.dramaId ?? body.drama_id ?? body.dramaId),
    episodeId: asOptionalNumber(ref?.episode_id ?? ref?.episodeId ?? body.episode_id ?? body.episodeId),
    storyboardId: asOptionalNumber(ref?.storyboard_id ?? ref?.storyboardId),
    storyboardNum: asOptionalNumber(ref?.storyboard_num ?? ref?.storyboardNum),
    groupName: ref?.group_name ?? ref?.groupName ?? body.group_name ?? body.groupName ?? null,
    source: String(ref?.source || 'volc:manualReferenceSync').trim(),
    force,
  }))

  const missingIndex = normalized.findIndex(ref => !ref.url)
  if (missingIndex >= 0) return badRequest(c, `第 ${missingIndex + 1} 张参考图缺少 url`)

  const result = await syncVolcImageAssetBatch(normalized)
  return success(c, {
    total: result.total,
    ok_count: result.okCount,
    failed_count: result.failedCount,
    items: result.items.map(item => ({
      input: toSnakeCase(item.input),
      success: item.success,
      error: item.error,
      asset: item.asset ? toSnakeCase(item.asset as any) : null,
    })),
  })
})

function asOptionalNumber(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : null
}

export default app
