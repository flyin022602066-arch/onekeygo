import test from 'node:test'
import assert from 'node:assert/strict'
import { createMijingModelsRoute } from '../mijingModels.js'
import type { NormalizedMijingModel } from '../../services/mijing/models.js'

function model(partial: Partial<NormalizedMijingModel> & Pick<NormalizedMijingModel, 'name' | 'serviceType'>): NormalizedMijingModel {
  return {
    displayName: partial.name,
    description: '',
    modelType: partial.serviceType,
    endpointPath: partial.serviceType === 'text' ? '/v1/chat/completions' : `/v1/${partial.serviceType}/generations`,
    endpointMethod: 'POST',
    extraJson: null,
    transmissionParameters: {
      requestShape: 'test',
      requiredFields: ['model'],
      optionalFields: [],
    },
    ...partial,
  }
}

test('GET / returns filtered Mijing model catalog', async () => {
  const app = createMijingModelsRoute(async () => [
    model({ name: '豆包2.0-pro', serviceType: 'text' }),
    model({ name: 'Seedream5.0', serviceType: 'image' }),
    model({ name: 'seedance2.0创作版', serviceType: 'video' }),
  ])

  const resp = await app.request('/?service_type=video&base_url=https%3A%2F%2Fapi.mjing.cc')
  assert.equal(resp.status, 200)
  const body = await resp.json()
  assert.equal(body.code, 200)
  assert.deepEqual(body.data.models.map((item: any) => item.name), ['seedance2.0创作版'])
})

test('GET /?refresh=1 reloads the Mijing catalog request', async () => {
  let calls = 0
  const app = createMijingModelsRoute(async () => {
    calls += 1
    return [model({ name: `model-${calls}`, serviceType: 'text' })]
  })

  const first = await app.request('/?service_type=text&base_url=https%3A%2F%2Fapi.magine.work')
  const refreshed = await app.request('/?service_type=text&base_url=https%3A%2F%2Fapi.magine.work&refresh=1')
  assert.equal(first.status, 200)
  assert.equal(refreshed.status, 200)
  assert.equal(calls, 2)
})
