import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onekeygo-asset-image-'))
process.env.STORAGE_PATH = path.join(testRoot, 'static')
process.env.CONFIG_PATH = path.join(testRoot, 'missing-config.yaml')

const { saveUploadedAssetImage, getAbsolutePath, ASSET_IMAGE_WIDTH, ASSET_IMAGE_HEIGHT } = await import('../storage.js')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('new asset uploads are normalized to the UHD 4K canvas', async () => {
  const relativePath = await saveUploadedAssetImage(png, 'characters')
  const absolutePath = getAbsolutePath(relativePath)
  const metadata = await sharp(absolutePath).metadata()
  assert.equal(metadata.width, ASSET_IMAGE_WIDTH)
  assert.equal(metadata.height, ASSET_IMAGE_HEIGHT)
  assert.equal(path.extname(absolutePath), '.png')
})
