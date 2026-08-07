import assert from 'node:assert/strict'
import test from 'node:test'

import { validateImageUpload } from '../upload-validation.js'

test('validateImageUpload accepts expected browser image uploads', () => {
  const result = validateImageUpload({
    name: 'frame.png',
    type: 'image/png',
    size: 1024,
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  })

  assert.deepEqual(result, { ok: true, extension: '.png' })
})

test('validateImageUpload rejects non-image files and oversized images', () => {
  assert.deepEqual(validateImageUpload({
    name: 'shell.php',
    type: 'application/x-php',
    size: 100,
  }), { ok: false, message: 'Only PNG, JPEG, WebP, and GIF images are supported' })

  assert.deepEqual(validateImageUpload({
    name: 'huge.png',
    type: 'image/png',
    size: 11 * 1024 * 1024,
  }), { ok: false, message: 'Image must be 10MB or smaller' })
})

test('validateImageUpload rejects files whose contents do not match the declared image type', () => {
  assert.deepEqual(validateImageUpload({
    name: 'fake.png',
    type: 'image/png',
    size: 100,
    data: Buffer.from('not a real image'),
  }), { ok: false, message: 'Uploaded file content does not match a supported image format' })
})
