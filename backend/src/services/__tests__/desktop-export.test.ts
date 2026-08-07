import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildDesktopVideoFilename,
  copyStaticVideoToDesktop,
  getLocalVideoPath,
  pickExportableStoryboardVideo,
  resolveStaticVideoPath,
} from '../desktop-export.js'

test('resolveStaticVideoPath keeps exports inside the configured static storage root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eggfans-static-'))
  assert.equal(
    resolveStaticVideoPath('static/merged/final.mp4', root),
    path.join(root, 'merged', 'final.mp4'),
  )
  assert.throws(
    () => resolveStaticVideoPath('static/../eggfans_drama.db', root),
    /成片路径越界/,
  )
  assert.throws(
    () => resolveStaticVideoPath('https://cdn.example/final.mp4', root),
    /不是本地文件/,
  )
})

test('copyStaticVideoToDesktop copies local merged video with a readable filename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eggfans-static-'))
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'eggfans-desktop-'))
  const mergedDir = path.join(root, 'merged')
  fs.mkdirSync(mergedDir, { recursive: true })
  fs.writeFileSync(path.join(mergedDir, 'final.mp4'), Buffer.from('video'))

  const result = copyStaticVideoToDesktop(
    'static/merged/final.mp4',
    { dramaTitle: '测试/短剧', episodeNumber: 1, mergeId: 9 },
    {
      storageRoot: root,
      desktopDir: desktop,
      now: new Date(2026, 4, 25, 4, 30),
    },
  )

  assert.equal(path.dirname(result.desktopPath), desktop)
  assert.equal(result.fileName, '测试短剧-第1集-成片9-202605250430.mp4')
  assert.equal(fs.readFileSync(result.desktopPath, 'utf-8'), 'video')
})

test('buildDesktopVideoFilename names storyboard videos separately from merged output', () => {
  assert.equal(
    buildDesktopVideoFilename(
      { dramaTitle: '测试短剧', episodeNumber: 1, storyboardNumber: 3, videoGenerationId: 21 },
      '.mp4',
      new Date(2026, 4, 25, 4, 30),
    ),
    '测试短剧-第1集-镜头3-视频21-202605250430.mp4',
  )
})

test('pickExportableStoryboardVideo follows the newest completed generation', () => {
  const selected = pickExportableStoryboardVideo([
    { id: 20, status: 'completed', localPath: 'static/videos/local.mp4', videoUrl: 'https://example.test/old.mp4' },
    { id: 21, status: 'completed', localPath: null, videoUrl: 'https://example.test/new.mp4' },
  ], 21)

  assert.equal(selected?.id, 21)
})

test('pickExportableStoryboardVideo keeps the preferred shot when it already has local media', () => {
  const selected = pickExportableStoryboardVideo([
    { id: 20, status: 'completed', localPath: 'static/videos/old.mp4', videoUrl: null },
    { id: 21, status: 'completed', localPath: 'static/videos/new.mp4', videoUrl: null },
  ], 21)

  assert.equal(selected?.id, 21)
})

test('getLocalVideoPath treats static video_url as exportable local media', () => {
  assert.equal(
    getLocalVideoPath({ localPath: null, videoUrl: 'static/videos/fallback.mp4' }),
    'static/videos/fallback.mp4',
  )
  assert.equal(
    getLocalVideoPath({ localPath: null, videoUrl: 'https://example.test/remote.mp4' }),
    '',
  )
})
