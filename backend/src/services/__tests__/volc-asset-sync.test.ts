import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { isPublicHttpUrl, syncVolcImageAssetBatch, uploadPublicImageFile } from '../volc-asset-sync.js'

test('uploadPublicImageFile falls back to Uguu when Shanhe upload fails', async () => {
  const calls: Array<{ url: string; hasAuth: boolean; bodyText: string }> = []
  const fakeFetch: typeof fetch = async (url, init) => {
    const body = init?.body as FormData
    calls.push({
      url: String(url),
      hasAuth: !!((init?.headers as Record<string, string> | undefined)?.Authorization),
      bodyText: Array.from(body.keys()).join(','),
    })

    if (String(url).includes('api.magine.work')) {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }

    return new Response(JSON.stringify({
      success: true,
      files: [{ url: 'https://d.uguu.se/reference.png' }],
    }), { status: 200 })
  }

  const result = await uploadPublicImageFile(
    {
      buffer: Buffer.from('fake-image'),
      filename: 'reference.png',
      mimeType: 'image/png',
    },
    {
      provider: 'volcengine_asset',
      baseUrl: 'https://20nbifxd.magine.work',
      apiKey: 'asset-key',
      model: '',
    },
    fakeFetch,
  )

  assert.equal(result.url, 'https://d.uguu.se/reference.png')
  assert.equal(result.provider, 'uguu-upload')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://api.magine.work/v1/upload')
  assert.equal(calls[0].hasAuth, true)
  assert.equal(calls[0].bodyText, 'file,expire_seconds')
  assert.equal(calls[1].url, 'https://uguu.se/upload')
  assert.equal(calls[1].hasAuth, false)
  assert.equal(calls[1].bodyText, 'files[]')
})

test('uploadPublicImageFile validates hosted image URLs before accepting an uploader', async () => {
  const calls: string[] = []
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push(`${init?.method || 'GET'} ${String(url)}`)

    if (String(url).includes('api.magine.work')) {
      return new Response(JSON.stringify({
        code: 1,
        data: { uri: 'https://media.example.com/not-an-image' },
      }), { status: 200 })
    }

    if (String(url).includes('media.example.com')) {
      return new Response('html', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    }

    if (String(url).includes('uguu.se/upload')) {
      return new Response(JSON.stringify({
        success: true,
        files: [{ url: 'https://d.uguu.se/reference.jpg' }],
      }), { status: 200 })
    }

    return new Response('jpg', {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    })
  }

  const result = await uploadPublicImageFile(
    {
      buffer: Buffer.from('fake-image'),
      filename: 'reference.png',
      mimeType: 'image/png',
    },
    {
      provider: 'volcengine_asset',
      baseUrl: 'https://20nbifxd.magine.work',
      apiKey: 'asset-key',
      model: '',
    },
    fakeFetch,
    { validateResult: true },
  )

  assert.equal(result.url, 'https://d.uguu.se/reference.jpg')
  assert.equal(result.provider, 'uguu-upload')
  assert.deepEqual(calls, [
    'POST https://api.magine.work/v1/upload',
    'HEAD https://media.example.com/not-an-image',
    'POST https://uguu.se/upload',
    'HEAD https://d.uguu.se/reference.jpg',
  ])
})

test('uploadPublicImageFile can prefer Uguu for Grok public references', async () => {
  const calls: string[] = []
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push(`${init?.method || 'GET'} ${String(url)}`)

    if (String(url).includes('uguu.se/upload')) {
      return new Response(JSON.stringify({
        success: true,
        files: [{ url: 'https://d.uguu.se/grok-reference.jpg' }],
      }), { status: 200 })
    }

    if (String(url).includes('d.uguu.se')) {
      return new Response('jpg', {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      })
    }

    return new Response(JSON.stringify({
      code: 1,
      data: { uri: 'https://media.example.com/reference.png' },
    }), { status: 200 })
  }

  const result = await uploadPublicImageFile(
    {
      buffer: Buffer.from('fake-image'),
      filename: 'reference.jpg',
      mimeType: 'image/jpeg',
    },
    {
      provider: 'volcengine_asset',
      baseUrl: 'https://20nbifxd.magine.work',
      apiKey: 'asset-key',
      model: '',
    },
    fakeFetch,
    { preferUguu: true, validateResult: true },
  )

  assert.equal(result.url, 'https://d.uguu.se/grok-reference.jpg')
  assert.equal(result.provider, 'uguu-upload')
  assert.deepEqual(calls, [
    'POST https://uguu.se/upload',
    'HEAD https://d.uguu.se/grok-reference.jpg',
  ])
})

test('uploadPublicImageFile falls back to Eggfans image host after preferred Uguu fails', async () => {
  const calls: Array<{ method: string; url: string; auth: string; bodyText: string }> = []
  const fakeFetch: typeof fetch = async (url, init) => {
    const body = init?.body as FormData | undefined
    calls.push({
      method: init?.method || 'GET',
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization || '',
      bodyText: body ? Array.from(body.keys()).join(',') : '',
    })

    if (String(url).includes('uguu.se/upload')) {
      return new Response(JSON.stringify({ success: false, error: 'temporary unavailable' }), { status: 503 })
    }

    if (String(url).includes('imageproxy.zhongzhuan.chat/api/upload')) {
      return new Response(JSON.stringify({
        code: 200,
        data: { url: 'https://cdn.eggfans.com/reference.png' },
      }), { status: 200 })
    }

    return new Response('png', {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  const result = await uploadPublicImageFile(
    {
      buffer: Buffer.from('fake-image'),
      filename: 'reference.png',
      mimeType: 'image/png',
    },
    {
      provider: 'volcengine_asset',
      baseUrl: 'https://20nbifxd.magine.work',
      apiKey: 'asset-key',
      model: '',
    },
    fakeFetch,
    {
      preferUguu: true,
      validateResult: true,
      eggfansImageHost: { apiKey: 'eggfans-key' },
    },
  )

  assert.equal(result.url, 'https://cdn.eggfans.com/reference.png')
  assert.equal(result.provider, 'eggfans-image-host')
  assert.deepEqual(calls, [
    { method: 'POST', url: 'https://uguu.se/upload', auth: '', bodyText: 'files[]' },
    { method: 'POST', url: 'https://imageproxy.zhongzhuan.chat/api/upload', auth: 'Bearer eggfans-key', bodyText: 'file' },
    { method: 'HEAD', url: 'https://cdn.eggfans.com/reference.png', auth: '', bodyText: '' },
  ])
})

test('uploadPublicImageFile accepts Eggfans image host URL when HEAD is stale but GET is ready', async () => {
  const calls: Array<{ method: string; url: string; auth: string; bodyText: string }> = []
  const fakeFetch: typeof fetch = async (url, init) => {
    const body = init?.body as FormData | undefined
    calls.push({
      method: init?.method || 'GET',
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization || '',
      bodyText: body ? Array.from(body.keys()).join(',') : '',
    })

    if (String(url).includes('uguu.se/upload')) {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }

    if (String(url).includes('imageproxy.zhongzhuan.chat/api/upload')) {
      return new Response(JSON.stringify({
        code: 200,
        data: { url: 'https://cdn.eggfans.com/reference-stale-head.png' },
      }), { status: 200 })
    }

    if (init?.method === 'HEAD') {
      return new Response('', { status: 404 })
    }

    return new Response('png', {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  const result = await uploadPublicImageFile(
    {
      buffer: Buffer.from('fake-image'),
      filename: 'reference.png',
      mimeType: 'image/png',
    },
    {
      provider: 'volcengine_asset',
      baseUrl: 'https://20nbifxd.magine.work',
      apiKey: 'asset-key',
      model: '',
    },
    fakeFetch,
    {
      preferUguu: true,
      validateResult: true,
      eggfansImageHost: { apiKey: 'eggfans-key' },
    },
  )

  assert.equal(result.url, 'https://cdn.eggfans.com/reference-stale-head.png')
  assert.equal(result.provider, 'eggfans-image-host')
  assert.deepEqual(calls, [
    { method: 'POST', url: 'https://uguu.se/upload', auth: '', bodyText: 'files[]' },
    { method: 'POST', url: 'https://imageproxy.zhongzhuan.chat/api/upload', auth: 'Bearer eggfans-key', bodyText: 'file' },
    { method: 'HEAD', url: 'https://cdn.eggfans.com/reference-stale-head.png', auth: '', bodyText: '' },
    { method: 'GET', url: 'https://cdn.eggfans.com/reference-stale-head.png', auth: '', bodyText: '' },
  ])
})

test('uploadPublicImageFile validates Eggfans proxy image URLs with GET directly', async () => {
  const calls: Array<{ method: string; url: string; auth: string; bodyText: string }> = []
  const fakeFetch: typeof fetch = async (url, init) => {
    const body = init?.body as FormData | undefined
    calls.push({
      method: init?.method || 'GET',
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization || '',
      bodyText: body ? Array.from(body.keys()).join(',') : '',
    })

    if (String(url).includes('uguu.se/upload')) {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }

    if (String(url).includes('imageproxy.zhongzhuan.chat/api/upload')) {
      return new Response(JSON.stringify({
        url: 'https://imageproxy.zhongzhuan.chat/api/proxy/image/2316ce07a01000cf14a628c8b29e97a8.png',
        created: 1757403998946,
      }), { status: 200 })
    }

    if (init?.method === 'HEAD') {
      return new Response('', { status: 404 })
    }

    return new Response('png', {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  const result = await uploadPublicImageFile(
    {
      buffer: Buffer.from('fake-image'),
      filename: 'reference.png',
      mimeType: 'image/png',
    },
    {
      provider: 'volcengine_asset',
      baseUrl: 'https://20nbifxd.magine.work',
      apiKey: 'asset-key',
      model: '',
    },
    fakeFetch,
    {
      preferUguu: true,
      validateResult: true,
      eggfansImageHost: { apiKey: 'eggfans-key' },
    },
  )

  assert.equal(result.url, 'https://imageproxy.zhongzhuan.chat/api/proxy/image/2316ce07a01000cf14a628c8b29e97a8.png')
  assert.equal(result.provider, 'eggfans-image-host')
  assert.deepEqual(calls, [
    { method: 'POST', url: 'https://uguu.se/upload', auth: '', bodyText: 'files[]' },
    { method: 'POST', url: 'https://imageproxy.zhongzhuan.chat/api/upload', auth: 'Bearer eggfans-key', bodyText: 'file' },
    { method: 'GET', url: 'https://imageproxy.zhongzhuan.chat/api/proxy/image/2316ce07a01000cf14a628c8b29e97a8.png', auth: '', bodyText: '' },
  ])
})

test('uploadPublicImageFile retries transient Eggfans image host 404 before failing over', async () => {
  const calls: Array<{ method: string; url: string; auth: string; bodyText: string }> = []
  let validationAttempt = 0
  const fakeFetch: typeof fetch = async (url, init) => {
    const body = init?.body as FormData | undefined
    calls.push({
      method: init?.method || 'GET',
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization || '',
      bodyText: body ? Array.from(body.keys()).join(',') : '',
    })

    if (String(url).includes('uguu.se/upload')) {
      return new Response(JSON.stringify({ success: false, error: 'temporary unavailable' }), { status: 503 })
    }

    if (String(url).includes('imageproxy.zhongzhuan.chat/api/upload')) {
      return new Response(JSON.stringify({
        code: 200,
        data: { url: 'https://cdn.eggfans.com/reference-propagating.png' },
      }), { status: 200 })
    }

    validationAttempt += 1
    if (validationAttempt <= 2) {
      return new Response('', { status: 404 })
    }

    return new Response('png', {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  const result = await uploadPublicImageFile(
    {
      buffer: Buffer.from('fake-image'),
      filename: 'reference.png',
      mimeType: 'image/png',
    },
    {
      provider: 'volcengine_asset',
      baseUrl: 'https://20nbifxd.magine.work',
      apiKey: 'asset-key',
      model: '',
    },
    fakeFetch,
    {
      preferUguu: true,
      validateResult: true,
      eggfansImageHost: { apiKey: 'eggfans-key' },
    },
  )

  assert.equal(result.url, 'https://cdn.eggfans.com/reference-propagating.png')
  assert.equal(result.provider, 'eggfans-image-host')
  assert.deepEqual(calls, [
    { method: 'POST', url: 'https://uguu.se/upload', auth: '', bodyText: 'files[]' },
    { method: 'POST', url: 'https://imageproxy.zhongzhuan.chat/api/upload', auth: 'Bearer eggfans-key', bodyText: 'file' },
    { method: 'HEAD', url: 'https://cdn.eggfans.com/reference-propagating.png', auth: '', bodyText: '' },
    { method: 'GET', url: 'https://cdn.eggfans.com/reference-propagating.png', auth: '', bodyText: '' },
    { method: 'HEAD', url: 'https://cdn.eggfans.com/reference-propagating.png', auth: '', bodyText: '' },
  ])
})

test('uploadPublicImageFile can restrict Grok references to Uguu and Eggfans image host only', async () => {
  const calls: Array<{ method: string; url: string; auth: string }> = []
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({
      method: init?.method || 'GET',
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization || '',
    })

    if (String(url).includes('uguu.se/upload')) {
      return new Response(JSON.stringify({ success: false, error: 'temporary unavailable' }), { status: 503 })
    }

    if (String(url).includes('api.magine.work')) {
      throw new Error('shanhe should not be called for Grok references')
    }

    if (String(url).includes('imageproxy.zhongzhuan.chat/api/upload')) {
      return new Response(JSON.stringify({ url: 'https://cdn.eggfans.com/grok-reference.png' }), { status: 200 })
    }

    return new Response('png', {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  const result = await uploadPublicImageFile(
    {
      buffer: Buffer.from('fake-image'),
      filename: 'grok-reference.png',
      mimeType: 'image/png',
    },
    {
      provider: 'volcengine_asset',
      baseUrl: 'https://20nbifxd.magine.work',
      apiKey: 'shanhe-key',
      model: '',
    },
    fakeFetch,
    {
      preferUguu: true,
      validateResult: true,
      allowedProviders: ['uguu-upload', 'eggfans-image-host'],
      eggfansImageHost: { apiKey: 'eggfans-key' },
    },
  )

  assert.equal(result.url, 'https://cdn.eggfans.com/grok-reference.png')
  assert.equal(result.provider, 'eggfans-image-host')
  assert.deepEqual(calls, [
    { method: 'POST', url: 'https://uguu.se/upload', auth: '' },
    { method: 'POST', url: 'https://imageproxy.zhongzhuan.chat/api/upload', auth: 'Bearer eggfans-key' },
    { method: 'HEAD', url: 'https://cdn.eggfans.com/grok-reference.png', auth: '' },
  ])
})

test('uploadPublicImageFile reuses active Eggfans platform key for image host fallback', async () => {
  const now = new Date().toISOString()
  const eggfansConfig = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'video',
    provider: 'eggfans',
    name: `Eggfans video key ${Date.now()}`,
    baseUrl: 'https://api.eggfans.com',
    apiKey: 'eggfans-platform-key',
    model: JSON.stringify(['grok-video-3-10s']),
    priority: 9999,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run()

  const calls: Array<{ method: string; url: string; auth: string }> = []
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({
      method: init?.method || 'GET',
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization || '',
    })

    if (String(url).includes('uguu.se/upload')) {
      return new Response(JSON.stringify({ success: false }), { status: 503 })
    }

    if (String(url).includes('imageproxy.zhongzhuan.chat/api/upload')) {
      return new Response(JSON.stringify({ url: 'https://cdn.eggfans.com/fallback.png' }), { status: 200 })
    }

    return new Response('png', {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  try {
    const result = await uploadPublicImageFile(
      {
        buffer: Buffer.from('fake-image'),
        filename: 'fallback.png',
        mimeType: 'image/png',
      },
      {
        provider: 'volcengine_asset',
        baseUrl: 'https://20nbifxd.magine.work',
        apiKey: '',
        model: '',
      },
      fakeFetch,
      { preferUguu: true, validateResult: true },
    )

    assert.equal(result.url, 'https://cdn.eggfans.com/fallback.png')
    assert.equal(result.provider, 'eggfans-image-host')
    assert.equal(calls[1]?.method, 'POST')
    assert.equal(calls[1]?.url, 'https://imageproxy.zhongzhuan.chat/api/upload')
    assert.match(calls[1]?.auth || '', /^Bearer\s+\S+/)
    assert.deepEqual(calls.map(call => ({ method: call.method, url: call.url, hasAuth: !!call.auth })), [
      { method: 'POST', url: 'https://uguu.se/upload', hasAuth: false },
      { method: 'POST', url: 'https://imageproxy.zhongzhuan.chat/api/upload', hasAuth: true },
      { method: 'HEAD', url: 'https://cdn.eggfans.com/fallback.png', hasAuth: false },
    ])
    assert.deepEqual(calls, [
      { method: 'POST', url: 'https://uguu.se/upload', auth: '' },
      { method: 'POST', url: 'https://imageproxy.zhongzhuan.chat/api/upload', auth: 'Bearer eggfans-platform-key' },
      { method: 'HEAD', url: 'https://cdn.eggfans.com/fallback.png', auth: '' },
    ])
  } finally {
    db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(eggfansConfig.lastInsertRowid))).run()
  }
})

test('syncVolcImageAssetBatch returns per-reference upload status and forwards force retry', async () => {
  const calls: Array<{ url: string; force?: boolean }> = []
  const result = await syncVolcImageAssetBatch([
    { url: 'static/grid-cells/one.png', name: '镜头1-参考图1', dramaId: 1, force: true },
    { url: 'static/grid-cells/two.png', name: '镜头1-参考图2', dramaId: 1, force: true },
  ], async (input) => {
    calls.push({ url: input.url, force: input.force })
    if (input.url.includes('two.png')) throw new Error('创建火山素材失败')
    return {
      localAssetId: 8,
      providerAssetId: 'asset-one',
      groupName: '测试素材组',
      publicUrl: 'https://d.uguu.se/one.png',
    }
  })

  assert.equal(result.total, 2)
  assert.equal(result.okCount, 1)
  assert.equal(result.failedCount, 1)
  assert.deepEqual(calls, [
    { url: 'static/grid-cells/one.png', force: true },
    { url: 'static/grid-cells/two.png', force: true },
  ])
  assert.deepEqual(result.items.map(item => ({
    success: item.success,
    providerAssetId: item.asset?.providerAssetId,
    error: item.error,
  })), [
    { success: true, providerAssetId: 'asset-one', error: undefined },
    { success: false, providerAssetId: undefined, error: '创建火山素材失败' },
  ])
})

test('isPublicHttpUrl rejects loopback and private network URLs before server fetch', () => {
  assert.equal(isPublicHttpUrl('https://cdn.example.com/reference.png'), true)
  assert.equal(isPublicHttpUrl('http://127.0.0.1:5679/static/reference.png'), false)
  assert.equal(isPublicHttpUrl('http://localhost/static/reference.png'), false)
  assert.equal(isPublicHttpUrl('http://10.0.0.8/reference.png'), false)
  assert.equal(isPublicHttpUrl('http://172.20.0.8/reference.png'), false)
  assert.equal(isPublicHttpUrl('http://192.168.1.8/reference.png'), false)
})
