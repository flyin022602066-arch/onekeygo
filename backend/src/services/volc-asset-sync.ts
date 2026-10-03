import { and, eq } from 'drizzle-orm'
import fs from 'node:fs'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath, getStaticRelativePath, parseDataUrl, readLocalFile } from '../utils/storage.js'
import { logTaskPayload, logTaskProgress, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'
import type { AIConfig } from './ai.js'
import { getActiveConfig } from './ai.js'

const DEFAULT_ASSET_BASE_URL = 'https://20nbifxd.magine.work'
const DEFAULT_UPLOAD_BASE_URL = 'https://api.magine.work/v1'
const DEFAULT_UGUU_UPLOAD_URL = 'https://uguu.se/upload'
const DEFAULT_EGGFANS_IMAGE_HOST_UPLOAD_URL = 'https://imageproxy.zhongzhuan.chat/api/upload'
const DEFAULT_PROJECT_NAME = 'default'
const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000
const PUBLIC_IMAGE_VALIDATE_TIMEOUT_MS = 15_000
const PUBLIC_IMAGE_VALIDATE_RETRY_DELAYS_MS = [0, 600, 1_500] as const
const VOLC_ASSET_CREATE_RETRY_DELAYS_MS = [0, 1_500, 4_000] as const

export interface VolcAssetReferenceInput {
  url: string
  name: string
  category?: string
  assetType?: 'Image' | 'Video' | string
  dramaId?: number | null
  episodeId?: number | null
  storyboardId?: number | null
  storyboardNum?: number | null
  groupName?: string | null
  source?: string
  force?: boolean
}

export interface SyncedVolcAsset {
  localAssetId: number
  localName?: string | null
  providerAssetId: string
  assetUri?: string | null
  providerGroupId?: string | null
  localGroupId?: string | null
  groupName: string
  providerUrl?: string | null
  publicUrl: string
}

type SyncVolcCharacterAssetOptions = {
  force?: boolean
  groupName?: string | null
  syncAsset?: (input: VolcAssetReferenceInput) => Promise<SyncedVolcAsset>
}

type SyncVolcEntityAssetOptions = SyncVolcCharacterAssetOptions & {
  episodeId?: number | null
}

interface PublicImageFile {
  buffer: Buffer
  filename: string
  mimeType: string
}

export interface PublicImageUrlResult {
  url: string
  mimeType: string | null
  provider: string
}

export interface PublicImageUploadOptions {
  preferUguu?: boolean
  validateResult?: boolean
  allowedProviders?: string[]
  eggfansImageHost?: {
    apiKey?: string | null
    uploadUrl?: string | null
  } | null
}

type AssetConfig = AIConfig & {
  settings?: {
    asset?: {
      uploadBaseUrl?: string
      projectName?: string
    }
    imageHost?: {
      uploadUrl?: string
    }
  } | null
}

export function getVolcAssetConfig(): AssetConfig | null {
  const config = getActiveConfig('asset') as AssetConfig | null
  if (!config || !config.apiKey) return null
  return {
    ...config,
    baseUrl: config.baseUrl || DEFAULT_ASSET_BASE_URL,
  }
}

function getPublicImageUploadConfig(): AssetConfig | null {
  const config = getActiveConfig('asset') as AssetConfig | null
  if (!config) return null
  return {
    ...config,
    baseUrl: config.baseUrl || DEFAULT_ASSET_BASE_URL,
  }
}

function getEggfansImageHostConfig(): Partial<AssetConfig> | null {
  const rows = db.select().from(schema.aiServiceConfigs).all()
    .filter(row => row.serviceType === 'image_host' && row.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  const row = rows[0]
  if (!row || !row.apiKey) return null
  const models = row.model ? JSON.parse(row.model) : []
  const config: Partial<AssetConfig> = {
    id: row.id,
    serviceType: 'image_host',
    provider: row.provider || '',
    baseUrl: row.baseUrl || DEFAULT_EGGFANS_IMAGE_HOST_UPLOAD_URL,
    apiKey: row.apiKey,
    model: models[0] || '',
    endpoint: row.endpoint || null,
    queryEndpoint: row.queryEndpoint || null,
    settings: parseSettings(row.settings),
  }
  return {
    ...config,
    baseUrl: config.baseUrl || DEFAULT_EGGFANS_IMAGE_HOST_UPLOAD_URL,
  }
}

function parseSettings(value?: string | null): Record<string, any> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function syncVolcImageAsset(input: VolcAssetReferenceInput): Promise<SyncedVolcAsset> {
  const sourceUrl = String(input.url || '').trim()
  if (!sourceUrl) throw new Error('火山素材上传缺少图片地址')

  const existing = input.force ? null : findExistingAsset(input)
  if (existing?.providerAssetId) {
    const assetUri = normalizeVolcAssetUri(existing.assetUri, existing.providerAssetId)
    return {
      localAssetId: existing.id,
      localName: existing.name || null,
      providerAssetId: existing.providerAssetId,
      assetUri,
      providerGroupId: existing.providerGroupId,
      localGroupId: existing.localGroupId,
      groupName: existing.groupName || buildGroupName(input),
      providerUrl: existing.providerUrl,
      publicUrl: existing.url || sourceUrl,
    }
  }

  const config = getVolcAssetConfig()
  if (!config) {
    throw new Error('请先在 AI 服务配置中填写“火山素材上传 Key”，官方 Seedance 2.0 需要先上传参考图到火山素材库')
  }

  const groupName = input.groupName || buildGroupName(input)
  const projectName = config.settings?.asset?.projectName || DEFAULT_PROJECT_NAME
  let group: Awaited<ReturnType<typeof ensureVolcAssetGroup>>
  let hosted: Awaited<ReturnType<typeof ensurePublicAssetUrl>>
  let asset: Awaited<ReturnType<typeof createVolcAsset>>
  try {
    group = await ensureVolcAssetGroup(config, groupName, projectName)
    hosted = await ensurePublicAssetUrl(config, sourceUrl, input.name)
    asset = await createVolcAsset(config, {
      groupId: group.localGroupId,
      publicUrl: hosted.url,
      name: input.name || `素材-${Date.now()}`,
      projectName,
      assetType: input.assetType || 'Image',
    })
  } catch (err) {
    throw new Error(`同步火山素材失败（${input.name || sourceUrl}）：${normalizeUploadError(err)}`)
  }

  const ts = now()
  const assetUri = normalizeVolcAssetUri(asset.assetUri, asset.providerAssetId)
  const res = db.insert(schema.assets).values({
    dramaId: input.dramaId ?? null,
    episodeId: input.episodeId ?? null,
    storyboardId: input.storyboardId ?? null,
    storyboardNum: input.storyboardNum ?? null,
    name: input.name,
    description: input.category ? `${input.category} 火山素材` : '火山素材',
    type: 'image',
    category: input.category || 'reference',
    url: hosted.url,
    thumbnailUrl: asset.providerUrl || hosted.url || sourceUrl,
    localPath: getStaticRelativePath(sourceUrl),
    mimeType: hosted.mimeType || null,
    provider: 'volcengine_asset',
    providerAssetId: asset.providerAssetId,
    assetUri,
    providerGroupId: asset.providerGroupId || group.providerGroupId || null,
    localGroupId: asset.localGroupId || group.localGroupId,
    groupName,
    source: input.source || 'volc:seedanceReference',
    sourceUrl,
    projectName,
    status: asset.status || 'Processing',
    mediaType: 'image',
    providerUrl: asset.providerUrl || null,
    expireTime: asset.expireTime || null,
    expireTimeDesc: asset.expireTimeDesc || null,
    previewCachedKey: asset.providerAssetId ? `asset-preview-${asset.providerAssetId}` : null,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  logTaskProgress('VolcAssetSync', 'asset-synced', {
    localAssetId: Number(res.lastInsertRowid),
    providerAssetId: asset.providerAssetId,
    groupName,
    source: input.source || 'volc:seedanceReference',
  })

  return {
    localAssetId: Number(res.lastInsertRowid),
    localName: input.name || null,
    providerAssetId: asset.providerAssetId,
    assetUri,
    providerGroupId: asset.providerGroupId || group.providerGroupId,
    localGroupId: asset.localGroupId || group.localGroupId,
    groupName,
    providerUrl: asset.providerUrl,
    publicUrl: hosted.url,
  }
}

export async function syncVolcImageAssetBatch(
  inputs: VolcAssetReferenceInput[],
  syncAsset: (input: VolcAssetReferenceInput) => Promise<SyncedVolcAsset> = syncVolcImageAsset,
) {
  const items = []
  for (const input of inputs) {
    try {
      const asset = await syncAsset(input)
      items.push({
        input,
        success: true,
        asset,
      })
    } catch (err) {
      items.push({
        input,
        success: false,
        error: err instanceof Error ? err.message : String(err || 'unknown error'),
      })
    }
  }

  const okCount = items.filter(item => item.success).length
  return {
    total: items.length,
    okCount,
    failedCount: items.length - okCount,
    items,
  }
}

export async function syncVolcCharacterAssetForCharacter(
  characterId: number,
  options: SyncVolcCharacterAssetOptions = {},
): Promise<SyncedVolcAsset> {
  const [character] = db.select().from(schema.characters)
    .where(eq(schema.characters.id, characterId))
    .all()
  if (!character || character.deletedAt) throw new Error('角色不存在')

  // A manual upload is the character's source of truth.  image_url can be a
  // stale generated/provider URL after a retry, while local_path still points
  // at the exact file the user selected. Prefer it whenever it is readable so
  // remote asset sync cannot silently replace the protagonist's clothing.
  const imageUrl = preferredCharacterImageUrl(character)
  if (!imageUrl) throw new Error('角色缺少形象图，无法上传火山角色资产库')

  const groupName = options.groupName || buildCharacterGroupName(character.dramaId)
  const syncAsset = options.syncAsset || syncVolcImageAsset
  const ts = now()

  db.update(schema.characters)
    .set({
      volcCharacterSyncStatus: 'uploading',
      volcCharacterSyncError: null,
      updatedAt: ts,
    })
    .where(eq(schema.characters.id, character.id))
    .run()

  try {
    const asset = await syncAsset({
      url: imageUrl,
      name: buildCharacterAssetName(character),
      category: 'character',
      assetType: 'Image',
      dramaId: character.dramaId,
      groupName,
      source: 'volc:characterLibrary',
      force: options.force,
    })
    const syncedAt = now()
    db.update(schema.characters)
      .set({
        volcCharacterAssetId: asset.providerAssetId,
        volcCharacterUri: asset.assetUri || asset.providerAssetId,
        volcCharacterLocalAssetId: asset.localAssetId,
        volcCharacterSyncedAt: syncedAt,
        volcCharacterSyncStatus: 'uploaded',
        volcCharacterSyncError: null,
        updatedAt: syncedAt,
      })
      .where(eq(schema.characters.id, character.id))
      .run()
    return asset
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || 'unknown error')
    db.update(schema.characters)
      .set({
        volcCharacterSyncStatus: 'failed',
        volcCharacterSyncError: message,
        updatedAt: now(),
      })
      .where(eq(schema.characters.id, character.id))
      .run()
    throw err
  }
}

function preferredCharacterImageUrl(character: { imageUrl?: string | null; localPath?: string | null }) {
  const localPath = String(character.localPath || '').trim()
  const staticPath = getStaticRelativePath(localPath)
  if (staticPath) {
    try {
      if (fs.existsSync(getAbsolutePath(staticPath))) return staticPath
    } catch {
      // Fall through to image_url for legacy rows whose local file was removed.
    }
  }
  return String(character.imageUrl || localPath || '').trim()
}

export async function syncVolcSceneAssetForScene(
  sceneId: number,
  options: SyncVolcEntityAssetOptions = {},
): Promise<SyncedVolcAsset> {
  const [scene] = db.select().from(schema.scenes)
    .where(eq(schema.scenes.id, sceneId))
    .all()
  if (!scene || scene.deletedAt) throw new Error('场景不存在')

  const imageUrl = String(scene.imageUrl || scene.localPath || '').trim()
  if (!imageUrl) throw new Error('场景缺少图片，无法上传火山素材库')

  const syncAsset = options.syncAsset || syncVolcImageAsset
  return syncAsset({
    url: imageUrl,
    name: `场景-${String(scene.location || scene.id).trim()}`,
    category: 'scene',
    assetType: 'Image',
    dramaId: scene.dramaId,
    episodeId: options.episodeId ?? scene.episodeId,
    groupName: options.groupName,
    source: 'volc:autoSceneImage',
    force: options.force,
  })
}

export async function syncVolcPropAssetForProp(
  propId: number,
  options: SyncVolcEntityAssetOptions = {},
): Promise<SyncedVolcAsset> {
  const [prop] = db.select().from(schema.props)
    .where(eq(schema.props.id, propId))
    .all()
  if (!prop || prop.deletedAt) throw new Error('道具不存在')

  const imageUrl = String(prop.imageUrl || prop.localPath || '').trim()
  if (!imageUrl) throw new Error('道具缺少图片，无法上传火山素材库')

  const episodeId = options.episodeId ?? db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.propId, prop.id))
    .all()
    .sort((a, b) => b.id - a.id)[0]?.episodeId ?? null
  const syncAsset = options.syncAsset || syncVolcImageAsset
  return syncAsset({
    url: imageUrl,
    name: `道具-${String(prop.name || prop.id).trim()}`,
    category: 'prop',
    assetType: 'Image',
    dramaId: prop.dramaId,
    episodeId,
    groupName: options.groupName,
    source: 'volc:autoPropImage',
    force: options.force,
  })
}

export async function syncMissingVolcSemanticAssets(reason = 'startup') {
  if (!getVolcAssetConfig()) {
    logTaskProgress('VolcAssetSync', 'semantic-backfill-skipped', { reason, cause: 'asset-config-missing' })
    return { total: 0, okCount: 0, failedCount: 0, skipped: true }
  }

  const existingSources = new Set(db.select().from(schema.assets).all()
    .filter(asset => asset.provider === 'volcengine_asset' && !!asset.providerAssetId && !asset.deletedAt)
    .map(asset => String(asset.sourceUrl || '').trim())
    .filter(Boolean))
  const pendingScenes = db.select().from(schema.scenes).all()
    .filter(scene => !scene.deletedAt && !!String(scene.imageUrl || scene.localPath || '').trim())
    .filter(scene => !existingSources.has(String(scene.imageUrl || scene.localPath || '').trim()))
  const pendingProps = db.select().from(schema.props).all()
    .filter(prop => !prop.deletedAt && !!String(prop.imageUrl || prop.localPath || '').trim())
    .filter(prop => !existingSources.has(String(prop.imageUrl || prop.localPath || '').trim()))
  let okCount = 0
  let failedCount = 0

  for (const scene of pendingScenes) {
    try {
      await syncVolcSceneAssetForScene(scene.id)
      okCount += 1
    } catch (err) {
      failedCount += 1
      logTaskWarn('VolcAssetSync', 'scene-backfill-failed', {
        reason,
        sceneId: scene.id,
        error: err instanceof Error ? err.message : String(err || 'unknown error'),
      })
    }
  }
  for (const prop of pendingProps) {
    try {
      await syncVolcPropAssetForProp(prop.id)
      okCount += 1
    } catch (err) {
      failedCount += 1
      logTaskWarn('VolcAssetSync', 'prop-backfill-failed', {
        reason,
        propId: prop.id,
        error: err instanceof Error ? err.message : String(err || 'unknown error'),
      })
    }
  }

  const total = pendingScenes.length + pendingProps.length
  logTaskProgress('VolcAssetSync', 'semantic-backfill-complete', { reason, total, okCount, failedCount })
  return { total, okCount, failedCount, skipped: false }
}

function normalizeVolcAssetUri(assetUri: string | null | undefined, providerAssetId: string) {
  const value = String(assetUri || '').trim().replace(/^@+/, '')
  if (!value) return `Asset://${providerAssetId}`
  const match = value.match(/^asset:\/\/(.+)$/i)
  return match ? `Asset://${match[1]}` : value
}

function findExistingAsset(input: VolcAssetReferenceInput) {
  const sourceUrl = String(input.url || '').trim()
  const rows = db.select().from(schema.assets)
    .where(and(
      eq(schema.assets.provider, 'volcengine_asset'),
      eq(schema.assets.sourceUrl, sourceUrl),
    ))
    .all()
    .filter(row => !!row.providerAssetId && !row.deletedAt)
    .sort((a, b) => Number(b.id) - Number(a.id))
  return rows[0] || null
}

function buildGroupName(input: VolcAssetReferenceInput) {
  if (input.dramaId) return `Eggfans-短剧-${input.dramaId}`
  return 'Eggfans-火山素材库'
}

function buildCharacterGroupName(dramaId?: number | null) {
  if (dramaId) return `Eggfans-短剧-${dramaId}-虚拟角色库`
  return 'Eggfans-火山虚拟角色库'
}

function buildCharacterAssetName(character: Pick<typeof schema.characters.$inferSelect, 'id' | 'name' | 'role'>) {
  const rawName = String(character.name || '').trim() || String(character.id)
  const role = String(character.role || '').trim()
  return role ? `角色-${rawName}-${role}` : `角色-${rawName}`
}

async function ensureVolcAssetGroup(config: AssetConfig, groupName: string, projectName: string) {
  const found = await findVolcAssetGroup(config, groupName)
  if (found) return found

  const payload = await fetchJsonWithAction(joinProviderUrl(config.baseUrl, '/v1', '/assets/groups'), {
    method: 'POST',
    headers: jsonHeaders(config.apiKey),
    body: JSON.stringify({
      name: groupName,
      description: `${groupName} 剧本素材组`,
      project_name: projectName,
    }),
    signal: AbortSignal.timeout(65_000),
  }, '创建火山素材组失败')
  const data = payload.data || payload
  const localGroupId = String(data.id || data.group_id || '').trim()
  if (!localGroupId) throw new Error('创建火山素材组失败：响应缺少 data.id')
  return {
    localGroupId,
    providerGroupId: data.provider_group_id ? String(data.provider_group_id) : null,
    reused: false,
  }
}

async function findVolcAssetGroup(config: AssetConfig, groupName: string) {
  const withName = await queryVolcAssetGroups(config, groupName)
  const foundByName = findGroupInPayload(withName, groupName)
  if (foundByName) return foundByName

  const text = JSON.stringify(withName || {}).toLowerCase()
  if (!text.includes('where express error:description')) return null

  const fallback = await queryVolcAssetGroups(config)
  return findGroupInPayload(fallback, groupName)
}

async function queryVolcAssetGroups(config: AssetConfig, groupName?: string) {
  const url = new URL(joinProviderUrl(config.baseUrl, '/v1', '/assets/groups'))
  url.searchParams.set('page', '1')
  url.searchParams.set('page_size', '100')
  if (groupName) url.searchParams.set('name', groupName)
  return fetchJsonWithAction(url.toString(), {
    method: 'GET',
    headers: authHeaders(config.apiKey),
    signal: AbortSignal.timeout(65_000),
  }, '查询火山素材组失败')
}

function findGroupInPayload(payload: any, groupName: string) {
  const list = Array.isArray(payload?.data?.items)
    ? payload.data.items
    : Array.isArray(payload?.data?.list)
      ? payload.data.list
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.items)
          ? payload.items
          : []
  const item = list.find((row: any) => String(row?.name || '').trim() === groupName)
  if (!item) return null
  const localGroupId = String(item.id || item.group_id || item.local_group_id || '').trim()
  if (!localGroupId) return null
  return {
    localGroupId,
    providerGroupId: item.provider_group_id ? String(item.provider_group_id) : null,
    reused: true,
  }
}

async function ensurePublicAssetUrl(config: AssetConfig, sourceUrl: string, assetName: string) {
  return ensurePublicImageUrl(sourceUrl, assetName, config)
}

export async function ensurePublicImageUrl(
  sourceUrl: string,
  assetName: string,
  config: Partial<AssetConfig> | null = getPublicImageUploadConfig(),
  fetchImpl: typeof fetch = fetch,
  options: PublicImageUploadOptions = {},
): Promise<PublicImageUrlResult> {
  const url = String(sourceUrl || '').trim()
  if (!url) throw new Error('公网图床上传缺少图片地址')
  if (isPublicHttpUrl(url)) {
    if (options.validateResult) await validatePublicImageUrl(url, fetchImpl)
    return { url, mimeType: null, provider: 'source-url' }
  }

  const cached = findExistingPublicImageUrl(url)
  if (cached) {
    if (!options.validateResult) return cached
    try {
      await validatePublicImageUrl(cached.url, fetchImpl)
      return cached
    } catch (err) {
      logTaskWarn('VolcAssetSync', 'public-cache-invalid', {
        sourceUrl: redactUrl(url),
        publicUrl: redactUrl(cached.url),
        error: normalizeUploadError(err),
      })
    }
  }

  const file = await readSourceAsFile(url, assetName)
  return uploadPublicImageFile(file, config, fetchImpl, options)
}

export async function uploadPublicImageFile(
  file: PublicImageFile,
  config: Partial<AssetConfig> | null | undefined,
  fetchImpl: typeof fetch = fetch,
  options: PublicImageUploadOptions = {},
) {
  const uploadBaseUrl = config?.settings?.asset?.uploadBaseUrl || DEFAULT_UPLOAD_BASE_URL
  const eggfansImageHost = resolveEggfansImageHostConfig(options.eggfansImageHost)
  const shanheUploader = config?.apiKey
    ? {
      provider: 'shanhe-upload',
      upload: () => uploadToShanhe(file, config.apiKey!, joinProviderUrl(uploadBaseUrl, '', '/upload'), fetchImpl),
    }
    : null
  const eggfansImageHostUploader = eggfansImageHost?.apiKey
    ? {
      provider: 'eggfans-image-host',
      upload: () => uploadToEggfansImageHost(file, eggfansImageHost.apiKey!, eggfansImageHost.uploadUrl, fetchImpl),
    }
    : null
  const uguuUploader = {
    provider: 'uguu-upload',
    upload: () => uploadToUguu(file, DEFAULT_UGUU_UPLOAD_URL, fetchImpl),
  }
  const allowedProviders = options.allowedProviders?.length
    ? new Set(options.allowedProviders)
    : null
  const uploaders: Array<{ provider: string; upload: () => Promise<string> }> = (options.preferUguu
    ? [uguuUploader, eggfansImageHostUploader, shanheUploader].filter((item): item is NonNullable<typeof item> => !!item)
    : [shanheUploader, uguuUploader, eggfansImageHostUploader].filter((item): item is NonNullable<typeof item> => !!item))
    .filter(item => !allowedProviders || allowedProviders.has(item.provider))
  const errors: string[] = []

  for (const uploader of uploaders) {
    try {
      const url = await uploader.upload()
      if (options.validateResult) await validatePublicImageUrl(url, fetchImpl)
      return { url, mimeType: file.mimeType, provider: uploader.provider }
    } catch (err) {
      const message = normalizeUploadError(err)
      errors.push(`${uploader.provider}: ${message}`)
      logTaskWarn('VolcAssetSync', 'public-upload-fallback', {
        provider: uploader.provider,
        filename: file.filename,
        error: message,
      })
    }
  }

  throw new Error(`上传图片到公网图床失败：${errors.join('；')}`)
}

function resolveEggfansImageHostConfig(
  override?: PublicImageUploadOptions['eggfansImageHost'],
) {
  const configured = getEggfansImageHostConfig()
  const apiKey = String(
    override?.apiKey ||
    configured?.apiKey ||
    getActiveEggfansPlatformKey() ||
    '',
  ).trim()
  if (!apiKey) return null
  const uploadUrl = String(
    override?.uploadUrl ||
    configured?.settings?.imageHost?.uploadUrl ||
    configured?.baseUrl ||
    DEFAULT_EGGFANS_IMAGE_HOST_UPLOAD_URL,
  ).trim() || DEFAULT_EGGFANS_IMAGE_HOST_UPLOAD_URL
  return { apiKey, uploadUrl }
}

function getActiveEggfansPlatformKey() {
  const rows = db.select().from(schema.aiServiceConfigs).all()
    .filter(row => row.isActive && String(row.provider || '').trim() === 'eggfans')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  for (const row of rows) {
    const key = String(row.apiKey || '').trim()
    if (key) return key
  }
  return ''
}

async function validatePublicImageUrl(url: string, fetchImpl: typeof fetch) {
  let lastError = 'unknown error'
  for (const delayMs of PUBLIC_IMAGE_VALIDATE_RETRY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs)
    const result = await validatePublicImageUrlOnce(url, fetchImpl)
    if (result.ok) return
    lastError = result.error
    if (!result.retryable) break
  }
  throw new Error(`校验公网图片失败：${lastError}`)
}

async function validatePublicImageUrlOnce(url: string, fetchImpl: typeof fetch): Promise<{
  ok: boolean
  error: string
  retryable: boolean
}> {
  if (shouldValidateImageUrlWithGetFirst(url)) {
    return requestPublicImageValidation(url, 'GET', fetchImpl)
  }

  const head = await requestPublicImageValidation(url, 'HEAD', fetchImpl)
  if (head.ok) return head
  if (!head.tryGet) return head

  const get = await requestPublicImageValidation(url, 'GET', fetchImpl)
  if (get.ok) return get
  return {
    ok: false,
    error: get.error || head.error,
    retryable: get.retryable || head.retryable,
  }
}

async function requestPublicImageValidation(
  url: string,
  method: 'HEAD' | 'GET',
  fetchImpl: typeof fetch,
): Promise<{
  ok: boolean
  error: string
  retryable: boolean
  tryGet?: boolean
}> {
  let resp: Response
  try {
    resp = await fetchImpl(url, {
      method,
      headers: method === 'GET' ? { Range: 'bytes=0-32767' } : undefined,
      signal: AbortSignal.timeout(PUBLIC_IMAGE_VALIDATE_TIMEOUT_MS),
    })
  } catch (err) {
    return {
      ok: false,
      error: normalizeUploadError(err),
      retryable: true,
      tryGet: method === 'HEAD',
    }
  }

  if (!resp.ok) {
    return {
      ok: false,
      error: `HTTP ${resp.status}`,
      retryable: isTransientImageValidationStatus(resp.status),
      tryGet: method === 'HEAD',
    }
  }

  const mimeType = normalizeMimeType(resp.headers.get('content-type'))
  if (mimeType.startsWith('image/')) {
    if (method === 'GET') await drainValidationResponse(resp)
    return { ok: true, error: '', retryable: false }
  }

  if (isAmbiguousImageMimeType(mimeType) && urlLooksLikeImage(url)) {
    if (method === 'GET') await drainValidationResponse(resp)
    return { ok: true, error: '', retryable: false }
  }

  if (method === 'HEAD' && isAmbiguousImageMimeType(mimeType)) {
    return {
      ok: false,
      error: `链接不是图片类型（${mimeType || 'unknown'}）`,
      retryable: false,
      tryGet: true,
    }
  }

  return {
    ok: false,
    error: `链接不是图片类型（${mimeType || 'unknown'}）`,
    retryable: false,
  }
}

function isTransientImageValidationStatus(status: number) {
  return status === 404 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function normalizeMimeType(value: string | null) {
  return String(value || '').split(';')[0].trim().toLowerCase()
}

function isAmbiguousImageMimeType(mimeType: string) {
  return !mimeType || mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream'
}

function urlLooksLikeImage(value: string) {
  try {
    const parsed = new URL(value)
    return /\.(png|jpe?g|webp|gif|bmp|avif)(?:$|[?#])/i.test(parsed.pathname)
  } catch {
    return /\.(png|jpe?g|webp|gif|bmp|avif)(?:$|[?#])/i.test(value)
  }
}

function shouldValidateImageUrlWithGetFirst(value: string) {
  try {
    const url = new URL(value)
    return url.hostname === 'imageproxy.zhongzhuan.chat' && url.pathname.startsWith('/api/proxy/image/')
  } catch {
    return false
  }
}

async function drainValidationResponse(resp: Response) {
  try {
    await resp.arrayBuffer()
  } catch {
    // Validation already got a successful image response; body drain failures are not actionable.
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function findExistingPublicImageUrl(sourceUrl: string): PublicImageUrlResult | null {
  const staticPath = getStaticRelativePath(sourceUrl)
  const rows = db.select().from(schema.assets).all()
    .filter(row => !row.deletedAt)
    .filter(row => {
      const candidates = [
        row.sourceUrl,
        row.localPath,
        row.url,
      ].map(value => String(value || '').trim()).filter(Boolean)
      return candidates.includes(sourceUrl) || (!!staticPath && candidates.includes(staticPath))
    })
    .sort((a, b) => Number(b.id) - Number(a.id))

  for (const row of rows) {
    const publicUrl = String(row.url || '').trim()
    if (isPublicHttpUrl(publicUrl)) {
      return {
        url: publicUrl,
        mimeType: row.mimeType || null,
        provider: row.provider || 'asset-cache',
      }
    }
  }
  return null
}

async function uploadToShanhe(
  file: PublicImageFile,
  apiKey: string,
  uploadUrl: string,
  fetchImpl: typeof fetch,
) {
  const form = new FormData()
  form.append('file', new File([bufferToArrayBuffer(file.buffer)], file.filename, { type: file.mimeType }))
  form.append('expire_seconds', '259200')

  logTaskProgress('VolcAssetSync', 'upload-public-url', {
    filename: file.filename,
    mimeType: file.mimeType,
    uploadUrl: redactUrl(uploadUrl),
  })
  const resp = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
    signal: AbortSignal.timeout(DEFAULT_UPLOAD_TIMEOUT_MS),
  })
  const payload = await readJsonResponse(resp, '上传图片到山河图床失败')
  const ok = payload.code === 1 || payload.code === 200 || payload.success === true
  const hostedUrl = payload.data?.uri || payload.data?.url || payload.uri || payload.url
  if (!ok || !hostedUrl) {
    logTaskPayload('VolcAssetSync', 'upload-public-url unexpected', payload)
    throw new Error('上传图片到山河图床失败：响应缺少 data.uri')
  }
  return String(hostedUrl)
}

async function uploadToUguu(
  file: PublicImageFile,
  uploadUrl: string,
  fetchImpl: typeof fetch,
) {
  const form = new FormData()
  form.append('files[]', new File([bufferToArrayBuffer(file.buffer)], file.filename, { type: file.mimeType }))

  logTaskProgress('VolcAssetSync', 'upload-public-url-fallback', {
    filename: file.filename,
    mimeType: file.mimeType,
    uploadUrl: redactUrl(uploadUrl),
  })
  const resp = await fetchImpl(uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(DEFAULT_UPLOAD_TIMEOUT_MS),
  })
  const payload = await readJsonResponse(resp, '上传图片到 Uguu 图床失败')
  const hostedUrl = payload.files?.[0]?.url || payload.data?.files?.[0]?.url || payload.data?.url || payload.url
  if (!payload.success || !hostedUrl) {
    logTaskPayload('VolcAssetSync', 'upload-public-url-fallback unexpected', payload)
    throw new Error('上传图片到 Uguu 图床失败：响应缺少 files[0].url')
  }
  return String(hostedUrl).replace(/\\\//g, '/')
}

async function uploadToEggfansImageHost(
  file: PublicImageFile,
  apiKey: string,
  uploadUrl: string,
  fetchImpl: typeof fetch,
) {
  const form = new FormData()
  form.append('file', new File([bufferToArrayBuffer(file.buffer)], file.filename, { type: file.mimeType }))

  logTaskProgress('VolcAssetSync', 'upload-public-url-eggfans-host', {
    filename: file.filename,
    mimeType: file.mimeType,
    uploadUrl: redactUrl(uploadUrl),
  })
  const resp = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
    signal: AbortSignal.timeout(DEFAULT_UPLOAD_TIMEOUT_MS),
  })
  const payload = await readJsonResponse(resp, '上传图片到 Eggfans 图床失败')
  const hostedUrl = extractHostedImageUrl(payload)
  if (!hostedUrl) {
    logTaskPayload('VolcAssetSync', 'upload-public-url-eggfans-host unexpected', payload)
    throw new Error('上传图片到 Eggfans 图床失败：响应缺少 url')
  }
  return String(hostedUrl).replace(/\\\//g, '/')
}

function extractHostedImageUrl(payload: any) {
  return payload?.data?.url ||
    payload?.data?.uri ||
    payload?.data?.file?.url ||
    payload?.data?.files?.[0]?.url ||
    payload?.url ||
    payload?.uri ||
    payload?.file?.url ||
    payload?.files?.[0]?.url
}

function normalizeUploadError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err || 'unknown error')
  if (/aborted|timeout/i.test(message)) return '上传超时'
  return message
}

async function readSourceAsFile(sourceUrl: string, assetName: string) {
  const dataUrl = parseDataUrl(sourceUrl)
  if (dataUrl) {
    return {
      buffer: Buffer.from(dataUrl.data, 'base64'),
      mimeType: dataUrl.mimeType,
      filename: withImageExtension(assetName || 'asset', dataUrl.mimeType),
    }
  }

  const staticPath = getStaticRelativePath(sourceUrl)
  if (staticPath) {
    const file = readLocalFile(staticPath)
    return {
      ...file,
      filename: file.filename || withImageExtension(assetName || 'asset', file.mimeType),
    }
  }

  if (/^https?:\/\//i.test(sourceUrl)) {
    if (!isPublicHttpUrl(sourceUrl)) {
      throw new Error('拒绝读取非公网远程参考图，请先上传到项目本地素材或公网图床')
    }
    const resp = await fetchWithAction(sourceUrl, { signal: AbortSignal.timeout(65_000) }, '读取远程参考图失败')
    if (!resp.ok) throw new Error(`读取远程参考图失败：${resp.status}`)
    const mimeType = resp.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
    const buffer = Buffer.from(await resp.arrayBuffer())
    return {
      buffer,
      mimeType,
      filename: withImageExtension(assetName || 'asset', mimeType),
    }
  }

  throw new Error(`无法读取火山素材参考图：${sourceUrl}`)
}

async function createVolcAsset(config: AssetConfig, params: {
  groupId: string
  publicUrl: string
  name: string
  projectName: string
  assetType?: string
}) {
  let payload: any = null
  for (let attempt = 0; attempt < VOLC_ASSET_CREATE_RETRY_DELAYS_MS.length; attempt++) {
    const delayMs = VOLC_ASSET_CREATE_RETRY_DELAYS_MS[attempt]
    if (delayMs > 0) await sleep(delayMs)
    try {
      payload = await fetchJsonWithAction(joinProviderUrl(config.baseUrl, '/v1', '/assets'), {
        method: 'POST',
        headers: jsonHeaders(config.apiKey),
        body: JSON.stringify(buildVolcAssetCreatePayload(params)),
        signal: AbortSignal.timeout(130_000),
      }, '创建火山素材失败')
      break
    } catch (err) {
      if (!isRetryableVolcAssetCreateError(err) || attempt === VOLC_ASSET_CREATE_RETRY_DELAYS_MS.length - 1) throw err
      logTaskWarn('VolcAssetSync', 'asset-create-retry', {
        name: params.name,
        attempt: attempt + 1,
        error: normalizeUploadError(err),
      })
    }
  }
  const data = payload.data || payload
  const providerAssetId = String(data.provider_asset_id || data.asset_id || '').trim()
  if (!providerAssetId) throw new Error('创建火山素材失败：响应缺少 provider_asset_id')
  return {
    localId: data.id ? String(data.id) : null,
    localGroupId: data.group_id || data.local_group_id ? String(data.group_id || data.local_group_id) : null,
    providerGroupId: data.provider_group_id ? String(data.provider_group_id) : null,
    providerAssetId,
    assetUri: data.asset_uri ? String(data.asset_uri) : null,
    providerUrl: data.provider_url ? String(data.provider_url) : null,
    status: data.status ? String(data.status) : null,
    expireTime: data.expire_time ? String(data.expire_time) : null,
    expireTimeDesc: data.expire_time_desc ? String(data.expire_time_desc) : null,
  }
}

export function isRetryableVolcAssetCreateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  return /HTTP\s+(?:408|409|425|429|5\d\d)\b/i.test(message)
    || /aborted|timeout|timed out|fetch failed|ECONNRESET|EAI_AGAIN|ETIMEDOUT/i.test(message)
}

export function buildVolcAssetCreatePayload(params: {
  groupId: string
  publicUrl: string
  name: string
  projectName: string
  assetType?: string
}) {
  return {
    group_id: params.groupId,
    url: params.publicUrl,
    name: params.name,
    asset_type: params.assetType || 'Image',
    project_name: params.projectName,
    wait_for_active: true,
    timeout_ms: 120000,
  }
}

async function fetchJsonWithAction(input: string | URL, init: RequestInit, action: string) {
  const resp = await fetchWithAction(input, init, action)
  return readJsonResponse(resp, action)
}

async function fetchWithAction(input: string | URL, init: RequestInit, action: string) {
  try {
    return await fetch(input, init)
  } catch (err) {
    throw new Error(`${action}：${normalizeUploadError(err)}`)
  }
}

async function readJsonResponse(resp: Response, action: string) {
  const text = await resp.text()
  let payload: any = null
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = { raw: text }
  }
  if (!resp.ok) {
    logTaskWarn('VolcAssetSync', 'http-error', { action, status: resp.status, body: text.slice(0, 240) })
    throw new Error(`${action}: HTTP ${resp.status} ${text.slice(0, 240)}`)
  }
  return payload
}

export function isPublicHttpUrl(value: string) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost')) return false
    if (host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return false
    if (/^10\./.test(host)) return false
    if (/^192\.168\./.test(host)) return false
    if (/^169\.254\./.test(host)) return false
    const private172 = host.match(/^172\.(\d+)\./)
    if (private172) {
      const second = Number(private172[1])
      if (second >= 16 && second <= 31) return false
    }
    return true
  } catch {
    return false
  }
}

function authHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` }
}

function jsonHeaders(apiKey: string) {
  return { ...authHeaders(apiKey), 'Content-Type': 'application/json' }
}

function withImageExtension(name: string, mimeType: string) {
  const safeBase = name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/\.+$/, '') || 'asset'
  if (/\.(png|jpe?g|webp|gif)$/i.test(safeBase)) return safeBase
  const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : mimeType.includes('gif') ? '.gif' : '.jpg'
  return `${safeBase}${ext}`
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength)
  new Uint8Array(out).set(buffer)
  return out
}
