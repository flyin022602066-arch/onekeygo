import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { saveUploadedFileWithExtension } from '../utils/storage.js'
import { validateImageUpload } from '../utils/upload-validation.js'

const app = new Hono()

// POST /upload/image
app.post('/image', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']

  if (!file || !(file instanceof File)) {
    return badRequest(c, 'file is required')
  }

  const buffer = await file.arrayBuffer()
  const validation = validateImageUpload({
    name: file.name,
    type: file.type,
    size: file.size,
    data: buffer,
  })
  if (!validation.ok) {
    return badRequest(c, validation.message)
  }

  const path = await saveUploadedFileWithExtension(buffer, 'uploads', validation.extension)
  return success(c, { url: `/${path}`, path })
})

export default app
