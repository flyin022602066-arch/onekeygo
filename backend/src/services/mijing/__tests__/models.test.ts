import test from 'node:test'
import assert from 'node:assert/strict'
import {
  filterMijingModels,
  normalizeMijingCatalog,
  type MijingModelsResponse,
} from '../models.js'

const sample: MijingModelsResponse = {
  success: true,
  data: [
    { name: '豆包2.0-pro', display_name: '豆包 2.0 Pro', type: 'chat', extra_json: '{"context":128000}' },
    { name: 'Seedream5.0', display_name: 'Seedream 5.0', type: 'image' },
    { name: 'seedance2.0创作版', display_name: 'Seedance 2.0 创作版', type: 'video' },
  ],
}

test('normalizeMijingCatalog maps model types and endpoints', () => {
  const models = normalizeMijingCatalog(sample)

  assert.deepEqual(models.map(model => model.name), ['豆包2.0-pro', 'Seedream5.0', 'seedance2.0创作版'])
  assert.equal(models[0].serviceType, 'text')
  assert.equal(models[0].endpointPath, '/v1/chat/completions')
  assert.deepEqual(models[0].extraJson, { context: 128000 })

  assert.equal(models[1].serviceType, 'image')
  assert.equal(models[1].endpointPath, '/v1/images/generations')
  assert.equal(models[1].queryEndpointPath, '/v1/images/generations/{task_id}')
  assert.equal(models[1].transmissionParameters.qualityField, 'quality')
  assert.deepEqual(models[1].transmissionParameters.defaults, undefined)

  const gptImageModels = normalizeMijingCatalog({
    data: [{ name: 'gpt-image-2', display_name: 'gpt-image-2', type: 'image' }],
  })
  assert.deepEqual(gptImageModels[0].transmissionParameters.defaults, { size: '1K', quality: 'high' })

  const gptImageAllModels = normalizeMijingCatalog({
    data: [{ name: 'gpt-image-2-all', display_name: 'gpt-image-2-all', type: 'image' }],
  })
  assert.deepEqual(gptImageAllModels[0].transmissionParameters.defaults, {
    size: '3840x2160',
    quality: 'high',
  })

  assert.equal(models[2].serviceType, 'video')
  assert.equal(models[2].endpointPath, '/v1/video/generations')
  assert.equal(models[2].queryEndpointPath, '/v1/video/generations/{task_id}')
  assert.equal(models[2].transmissionParameters.durationField, 'duration')
  assert.equal(models[2].transmissionParameters.aspectRatioField, 'ratio')
  assert.equal(models[2].transmissionParameters.optionalFields.includes('generate_audio'), true)
})

test('filterMijingModels returns only requested service type', () => {
  const models = normalizeMijingCatalog(sample)
  assert.deepEqual(filterMijingModels(models, 'text').map(model => model.name), ['豆包2.0-pro'])
  assert.deepEqual(filterMijingModels(models, 'image').map(model => model.name), ['Seedream5.0'])
  assert.deepEqual(filterMijingModels(models, 'video').map(model => model.name), ['seedance2.0创作版'])
})
