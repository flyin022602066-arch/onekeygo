import test from 'node:test'
import assert from 'node:assert/strict'
import { canResumeBackgroundTasks } from '../background-resume.js'

test('normal launches retain automatic task recovery', () => {
  for (const reason of ['startup', 'api', 'api-get', 'api-list', 'generate', 'sequence-wait']) {
    assert.equal(canResumeBackgroundTasks(reason, {}), true)
  }
})

test('a paused launch skips automatic recovery but allows explicitly started work', () => {
  const environment = { MIJING_AUTO_RESUME: '0' }
  for (const reason of ['startup', 'api', 'api-get', 'api-list']) {
    assert.equal(canResumeBackgroundTasks(reason, environment), false)
  }
  for (const reason of ['generate', 'sequence-wait', 'retry']) {
    assert.equal(canResumeBackgroundTasks(reason, environment), true)
  }
})
