import path from 'path'

export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024

const ALLOWED_IMAGE_TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])

export type UploadCandidate = {
  name: string
  type?: string
  size: number
  data?: ArrayBuffer | Buffer
}

export function validateImageUpload(file: UploadCandidate):
  | { ok: true; extension: string }
  | { ok: false; message: string } {
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return { ok: false, message: 'Image must be 10MB or smaller' }
  }

  const mime = String(file.type || '').toLowerCase()
  const expectedExt = ALLOWED_IMAGE_TYPES.get(mime)
  if (!expectedExt) {
    return { ok: false, message: 'Only PNG, JPEG, WebP, and GIF images are supported' }
  }

  const ext = path.extname(file.name || '').toLowerCase()
  if (ext && ![...ALLOWED_IMAGE_TYPES.values()].includes(ext)) {
    return { ok: false, message: 'Only PNG, JPEG, WebP, and GIF images are supported' }
  }
  if (file.data && !matchesImageSignature(file.data, expectedExt)) {
    return { ok: false, message: 'Uploaded file content does not match a supported image format' }
  }

  return { ok: true, extension: ext || expectedExt }
}

function matchesImageSignature(data: ArrayBuffer | Buffer, expectedExt: string): boolean {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (expectedExt === '.png') {
    return bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
  }
  if (expectedExt === '.jpg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (expectedExt === '.webp') {
    return bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  if (expectedExt === '.gif') {
    const signature = bytes.subarray(0, 6).toString('ascii')
    return signature === 'GIF87a' || signature === 'GIF89a'
  }
  return false
}
