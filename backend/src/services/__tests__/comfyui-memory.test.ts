import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseComfyUiMemory } from '../comfyui-memory.js'

test('releaseComfyUiMemory requests ComfyUI to unload models and free memory', async () => {
  const requests: string[] = []
  let freeInit: RequestInit | undefined
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(input)
    requests.push(requestUrl)
    if (requestUrl.endsWith('/free')) {
      freeInit = init
      return new Response(null, { status: 200 })
    }
    return Response.json({ devices: [{ vram_total: 16 * 1024 ** 3, vram_free: 15 * 1024 ** 3 }] })
  }

  await releaseComfyUiMemory({ baseUrl: 'http://127.0.0.1:8188/' }, { fetchImpl })

  assert.deepEqual(requests, [
    'http://127.0.0.1:8188/free',
    'http://127.0.0.1:8188/system_stats',
  ])
  assert.equal(freeInit?.method, 'POST')
  assert.deepEqual(JSON.parse(String(freeInit?.body)), {
    unload_models: true,
    free_memory: true,
  })
})

test('releaseComfyUiMemory waits for VRAM to recover after the asynchronous free flag', async () => {
  const freeBytes = [
    2 * 1024 ** 3,
    15 * 1024 ** 3,
  ]
  let statsCalls = 0
  const fetchImpl = async (input: string | URL | Request) => {
    if (String(input).endsWith('/free')) return new Response(null, { status: 200 })
    const free = freeBytes[Math.min(statsCalls++, freeBytes.length - 1)]
    return Response.json({ devices: [{ vram_total: 16 * 1024 ** 3, vram_free: free }] })
  }

  await releaseComfyUiMemory({ baseUrl: 'http://127.0.0.1:8188' }, {
    fetchImpl,
    timeoutMs: 1_000,
    pollIntervalMs: 25,
  })

  assert.equal(statsCalls, 2)
})

test('releaseComfyUiMemory blocks when VRAM status cannot be verified', async () => {
  await assert.rejects(
    () => releaseComfyUiMemory({ baseUrl: 'http://127.0.0.1:8188' }, {
      fetchImpl: async (input: string | URL | Request) => {
        if (String(input).endsWith('/free')) return new Response(null, { status: 200 })
        return Response.json({ devices: [] })
      },
      timeoutMs: 100,
    }),
    /did not return usable VRAM data/,
  )
})

test('releaseComfyUiMemory reports a failed ComfyUI release request', async () => {
  await assert.rejects(
    () => releaseComfyUiMemory({ baseUrl: 'http://127.0.0.1:8188' }, {
      fetchImpl: async () => new Response('worker unavailable', { status: 503 }),
    }),
    /ComfyUI memory release failed 503: worker unavailable/,
  )
})
