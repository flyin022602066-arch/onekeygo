import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectLocalH3Refinement, inspectLocalH3VideoTail, localH3RefinementSettings } from '../local-h3-refinement.js'

const config = { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: '', settings: { comfyui: { refinement: { enabled: true } } } }
const required = Object.fromEntries(['base_video', 'latent', 'positive', 'model', 'vae', 'clip', 'audio_vae', 'prompt', 'seed', 'scale', 'steps', 'denoise', 'trim_frames'].map(field => [field, ['ANY']]))
const optional = Object.fromEntries([...Array.from({ length: 9 }, (_, index) => `reference_image_${index}`), 'reference_video', 'reference_audio'].map(field => [field, ['ANY']]))
const nodes = {
  MijingH3SafeRefine: { input: { required, optional }, output: ['VIDEO', 'STRING'] },
  MijingH3PreserveVideo: { input: { required: { video: ['VIDEO'], filename_prefix: ['STRING'] } }, output: ['VIDEO'], output_node: true },
  MijingH3VideoTail: { input: { required: { images: ['IMAGE'], max_frames: ['INT'], fps: ['FLOAT'] }, optional: { audio: ['AUDIO'] } }, output: ['IMAGE', 'AUDIO'] },
}

test('refinement is opt-in, bounded and isolated to the local ComfyUI channel', async () => {
  for (const override of [
    { provider: 'autodl_comfyui' }, { provider: 'mijing' }, { baseUrl: 'https://example.com' },
    { settings: {} }, { baseUrl: 'file:///tmp/comfy' },
  ]) {
    const isolated = { ...config, ...override }
    assert.equal(localH3RefinementSettings(isolated).enabled, false)
    await inspectLocalH3Refinement(isolated, (() => { throw new Error('must not fetch') }) as any)
  }
  assert.deepEqual(localH3RefinementSettings({ ...config, settings: { comfyui: { refinement: { enabled: true, scale: 9, steps: 20, denoise: 0.9 } } } }), {
    enabled: true, scale: 1.25, steps: 4, denoise: 0.3,
  })
})

test('refinement checks the complete reference and independent base-save contracts', async () => {
  const paths: string[] = []
  const mock = (async (url: string) => {
    paths.push(url)
    return Response.json(nodes)
  }) as typeof fetch
  assert.equal((await inspectLocalH3Refinement(config, mock)).available, true)
  assert.equal(paths.length, 2)
  assert.equal((await inspectLocalH3VideoTail(config, mock)).available, true)
  const missing = { ...nodes, MijingH3SafeRefine: { ...nodes.MijingH3SafeRefine, input: { required, optional: {} } } }
  assert.equal((await inspectLocalH3Refinement(config, (async () => Response.json(missing)) as typeof fetch)).available, false)
  assert.equal((await inspectLocalH3Refinement(config, (async () => Response.json({ MijingH3SafeRefine: nodes.MijingH3SafeRefine })) as typeof fetch)).available, false)
})

test('optional node discovery fails safely on missing nodes or connection errors', async () => {
  for (const inspect of [inspectLocalH3Refinement, inspectLocalH3VideoTail]) {
    assert.equal((await inspect(config, (async () => Response.json({})) as typeof fetch)).available, false)
    assert.equal((await inspect(config, (async () => { throw new Error('offline') }) as typeof fetch)).available, false)
  }
})
