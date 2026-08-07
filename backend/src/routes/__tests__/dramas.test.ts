import test from 'node:test'
import assert from 'node:assert/strict'
import { pickDefaultEpisodeConfigIds } from '../dramas.js'

test('default episode configs choose the highest priority active config per service', () => {
  assert.deepEqual(
    pickDefaultEpisodeConfigIds([
      { id: 1, serviceType: 'video', priority: 98, isActive: true },
      { id: 2, serviceType: 'video', priority: 108, isActive: true },
      { id: 3, serviceType: 'video', priority: 999, isActive: false },
      { id: 4, serviceType: 'image', priority: 99, isActive: true },
      { id: 5, serviceType: 'audio', priority: 97, isActive: true },
    ]),
    {
      imageConfigId: 4,
      videoConfigId: 2,
      audioConfigId: 5,
    },
  )
})

test('default episode configs use is_default as a tie breaker', () => {
  assert.deepEqual(
    pickDefaultEpisodeConfigIds([
      { id: 10, serviceType: 'video', priority: 100, isDefault: false, isActive: true },
      { id: 11, serviceType: 'video', priority: 100, isDefault: true, isActive: true },
    ]),
    {
      imageConfigId: null,
      videoConfigId: 11,
      audioConfigId: null,
    },
  )
})
