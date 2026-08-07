import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, notFound, now, success } from '../utils/response.js'

const app = new Hono()

function parseValue(raw: string) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function normalizeKey(value: string) {
  const key = String(value || '').trim()
  return key.length > 0 && key.length <= 120 ? key : ''
}

app.get('/:key', (c) => {
  const key = normalizeKey(c.req.param('key'))
  if (!key) return badRequest(c, 'preference key is invalid')

  const [row] = db.select().from(schema.appPreferences)
    .where(eq(schema.appPreferences.key, key))
    .all()
  if (!row) return notFound(c)

  return success(c, { key, value: parseValue(row.value), updated_at: row.updatedAt })
})

app.put('/:key', async (c) => {
  const key = normalizeKey(c.req.param('key'))
  if (!key) return badRequest(c, 'preference key is invalid')

  const body = await c.req.json().catch(() => ({}))
  if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
    return badRequest(c, 'preference value is required')
  }

  let value: string | undefined
  try {
    value = JSON.stringify(body.value)
  } catch {
    return badRequest(c, 'preference value must be JSON serializable')
  }
  if (value === undefined || value.length > 256 * 1024) {
    return badRequest(c, 'preference value is too large')
  }

  const updatedAt = now()
  const [existing] = db.select().from(schema.appPreferences)
    .where(eq(schema.appPreferences.key, key))
    .all()

  if (existing) {
    db.update(schema.appPreferences)
      .set({ value, updatedAt })
      .where(eq(schema.appPreferences.key, key))
      .run()
  } else {
    db.insert(schema.appPreferences).values({ key, value, updatedAt }).run()
  }

  return success(c, { key, value: body.value, updated_at: updatedAt })
})

export default app
