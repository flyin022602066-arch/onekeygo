import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTrimLastFrameArgs,
  buildHighQualityMergeOutputOptions,
  buildMergeOutputOptions,
  buildSilentAudioTrackArgs,
  metadataHasAudio,
  parseFrameRate,
  resolveSerialMergePlan,
  buildMergeSnapshot,
  isMergeCurrent,
  isMergeJobCurrent,
  selectMergeCandidates,
} from '../ffmpeg-merge.js'

test('merge output explicitly maps normalized video and audio streams', () => {
  assert.deepEqual(buildMergeOutputOptions(), [
    '-fflags', '+genpts',
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-movflags', '+faststart',
  ])
})

test('merge fallback re-encodes with high quality instead of heavy compression', () => {
  assert.deepEqual(buildHighQualityMergeOutputOptions(), [
    '-fflags', '+genpts',
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '16',
    '-c:a', 'aac',
    '-ar', '48000',
    '-b:a', '192k',
    '-movflags', '+faststart',
  ])
})

test('silent audio repair maps original video with generated AAC audio', () => {
  assert.deepEqual(buildSilentAudioTrackArgs('/tmp/input.mp4', '/tmp/output.mp4'), [
    '-hide_banner',
    '-y',
    '-i', '/tmp/input.mp4',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '/tmp/output.mp4',
  ])
})

test('metadataHasAudio detects audio streams from ffprobe metadata', () => {
  assert.equal(metadataHasAudio({ streams: [{ codec_type: 'video' }] }), false)
  assert.equal(metadataHasAudio({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }), true)
})

test('frame rate parser supports ffprobe rational values', () => {
  assert.equal(parseFrameRate('30000/1001'), 30000 / 1001)
  assert.equal(parseFrameRate('24'), 24)
  assert.equal(parseFrameRate('N/A'), 0)
})

test('末帧裁剪参数保留高质量并同步截短音频', () => {
  const args = buildTrimLastFrameArgs('/tmp/input.mp4', '/tmp/output.mp4', 121, 24)
  assert.deepEqual(args.slice(0, 12), [
    '-hide_banner',
    '-y',
    '-i', '/tmp/input.mp4',
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-vf', 'select=lt(n\\,120),setpts=N/24/TB',
    '-af', 'atrim=end=5,asetpts=N/SR/TB',
  ])
  assert.ok(args.includes('-crf') && args.includes('16'))
  assert.ok(args.includes('-shortest'))
})

test('merge candidates ignore empty legacy storyboards', () => {
  const candidates = selectMergeCandidates([
    { id: 1, videoUrl: 'static/videos/one.mp4', composedVideoUrl: 'static/composed/one.mp4' },
    { id: 2, videoUrl: '', composedVideoUrl: '' },
    { id: 3, videoUrl: null, composedVideoUrl: null },
    { id: 4, videoUrl: '', composedVideoUrl: '' },
  ])

  assert.deepEqual(candidates.map(item => item.id), [1])
})

test('merge candidates include completed generation sources', () => {
  const candidates = selectMergeCandidates(
    [{ id: 10, videoUrl: '', composedVideoUrl: '' }, { id: 11, videoUrl: '', composedVideoUrl: '' }],
    [{ id: 501, storyboardId: 10, status: 'completed', localPath: 'static/videos/ten.mp4' }],
  )

  assert.deepEqual(candidates.map(item => item.id), [10])
})

test('serial merge plan trims only every segment before the final one', () => {
  const storyboards = [1, 2, 3].map(id => ({ id, videoUrl: '', composedVideoUrl: `static/composed/${id}.mp4` }))
  const generations = [1, 2, 3].map(id => ({ id: 100 + id, storyboardId: id, status: 'completed', localPath: `static/videos/${id}.mp4` }))
  const steps = [1, 2, 3].map((storyboardId, index) => ({
    runId: 77,
    storyboardId,
    stepIndex: index,
    videoGenerationId: 100 + storyboardId,
  }))

  assert.deepEqual(resolveSerialMergePlan(storyboards, generations, steps, [{ id: 77, totalCount: 3 }]), {
    runId: 77,
    trimLastFrameIndexes: [0, 1],
  })
})

test('ordinary or mixed merge candidates do not activate serial末帧裁剪', () => {
  const storyboards = [1, 2].map(id => ({ id, videoUrl: '', composedVideoUrl: `static/composed/${id}.mp4` }))
  const generations = [{ id: 101, storyboardId: 1, status: 'completed', localPath: 'static/videos/1.mp4' }]
  const steps = [{ runId: 77, storyboardId: 1, stepIndex: 0, videoGenerationId: 101 }]
  assert.equal(resolveSerialMergePlan(storyboards, generations, steps, [{ id: 77, totalCount: 2 }]), null)
})

test('merge snapshot records the generation used by each composed storyboard', () => {
  const storyboards = [{ id: 1, composedVideoUrl: 'static/composed/shot-1.mp4', composedVideoGenerationId: 22 }]
  const generations = [{ id: 22, storyboardId: 1, status: 'completed', localPath: 'static/videos/shot-1.mp4' }]
  assert.deepEqual(buildMergeSnapshot(storyboards, generations), [{
    storyboardId: 1,
    composedVideoUrl: 'static/composed/shot-1.mp4',
    videoGenerationId: 22,
  }])
})

test('merge is stale when a storyboard has been regenerated', () => {
  const storyboards = [{ id: 1, composedVideoUrl: 'static/composed/new.mp4', composedVideoGenerationId: 22 }]
  const generations = [
    { id: 21, storyboardId: 1, status: 'completed', localPath: 'static/videos/old.mp4' },
    { id: 22, storyboardId: 1, status: 'completed', localPath: 'static/videos/new.mp4' },
  ]
  const current = {
    status: 'completed',
    mergedUrl: 'static/merged/current.mp4',
    scenes: JSON.stringify(buildMergeSnapshot(storyboards, generations)),
  }
  assert.equal(isMergeCurrent(current, storyboards, generations), true)

  const regenerated = [{ id: 23, storyboardId: 1, status: 'completed', localPath: 'static/videos/latest.mp4' }]
  assert.equal(isMergeCurrent(current, storyboards, regenerated), false)
})

test('legacy URL-only merge snapshots are rejected when generation provenance exists', () => {
  const storyboards = [{ id: 1, composedVideoUrl: 'static/composed/shot-1.mp4', composedVideoGenerationId: 22 }]
  const generations = [{ id: 22, storyboardId: 1, status: 'completed', localPath: 'static/videos/shot-1.mp4' }]
  assert.equal(isMergeCurrent({
    status: 'completed',
    mergedUrl: 'static/merged/old.mp4',
    scenes: JSON.stringify(['static/composed/shot-1.mp4']),
  }, storyboards, generations), false)
})

test('stale merge workers cannot publish after a newer merge is queued', () => {
  const storyboards = [{ id: 1, composedVideoUrl: 'static/composed/shot-1.mp4', composedVideoGenerationId: 22 }]
  const generations = [{ id: 22, storyboardId: 1, status: 'completed', localPath: 'static/videos/shot-1.mp4' }]
  const merge = {
    status: 'completed',
    mergedUrl: 'static/merged/new.mp4',
    scenes: JSON.stringify(buildMergeSnapshot(storyboards, generations)),
  }
  assert.equal(isMergeJobCurrent(5, 6, merge, storyboards, generations), false)
  assert.equal(isMergeJobCurrent(6, 6, merge, storyboards, generations), true)
})
