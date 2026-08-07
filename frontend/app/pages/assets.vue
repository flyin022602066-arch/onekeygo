<template>
  <div class="assets-page">
    <div class="assets-head">
      <div>
        <h1 class="assets-title">资产库</h1>
        <p class="assets-desc">集中查看角色、场景、镜头参考图上传到火山素材库后的资产 ID。</p>
      </div>
      <button class="btn" :disabled="loading" @click="loadAll">
        <RefreshCw v-if="loading" :size="14" class="animate-spin" />
        <RefreshCw v-else :size="14" />
        刷新
      </button>
    </div>

    <section class="assets-toolbar card">
      <label class="filter-field">
        <span>搜索</span>
        <input v-model="filters.keyword" class="input" placeholder="名称、资产 ID、来源路径" />
      </label>
      <label class="filter-field">
        <span>项目</span>
        <select v-model="filters.dramaId" class="input">
          <option value="">全部项目</option>
          <option v-for="drama in dramas" :key="drama.id" :value="String(drama.id)">
            {{ drama.title || `项目 ${drama.id}` }}
          </option>
        </select>
      </label>
      <label class="filter-field">
        <span>分类</span>
        <select v-model="filters.category" class="input">
          <option value="">全部分类</option>
          <option v-for="item in categoryOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </label>
      <label class="filter-field">
        <span>状态</span>
        <select v-model="filters.status" class="input">
          <option value="">全部状态</option>
          <option v-for="status in statusOptions" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
    </section>

    <section class="asset-summary">
      <article class="summary-card card">
        <span>总资产</span>
        <strong>{{ assets.length }}</strong>
      </article>
      <article class="summary-card card">
        <span>当前筛选</span>
        <strong>{{ filteredAssets.length }}</strong>
      </article>
      <article class="summary-card card">
        <span>火山 Active</span>
        <strong>{{ activeCount }}</strong>
      </article>
      <article class="summary-card card">
        <span>角色/场景</span>
        <strong>{{ semanticCount }}</strong>
      </article>
    </section>

    <div v-if="loading" class="asset-grid">
      <div v-for="i in 8" :key="i" class="asset-card skeleton-card card"></div>
    </div>

    <div v-else-if="filteredAssets.length" class="asset-grid">
      <article v-for="asset in filteredAssets" :key="asset.id" class="asset-card card">
        <div class="asset-preview">
          <img v-if="assetPreview(asset)" :src="assetPreview(asset)" :alt="asset.name || 'asset'" loading="lazy" />
          <div v-else class="asset-preview-empty">
            <ImageOff :size="24" />
          </div>
          <span :class="['tag', statusClass(asset)]">{{ asset.status || 'Unknown' }}</span>
        </div>
        <div class="asset-body">
          <div class="asset-topline">
            <span class="tag tag-accent">{{ categoryLabel(asset.category) }}</span>
            <span class="asset-provider">{{ asset.provider || 'local' }}</span>
          </div>
          <div v-if="editingId === asset.id" class="asset-name-edit">
            <input
              v-model="editingName"
              class="input"
              maxlength="80"
              placeholder="例如：男主陈风正面、宿舍全景、镜头1动作参考"
              @keyup.enter="saveAssetName(asset)"
              @keyup.esc="cancelEditName"
            />
            <button class="btn btn-primary btn-icon" :disabled="savingId === asset.id" title="保存本地调用名" @click="saveAssetName(asset)">
              <Loader2 v-if="savingId === asset.id" :size="13" class="animate-spin" />
              <Check v-else :size="13" />
            </button>
            <button class="btn btn-ghost btn-icon" title="取消" @click="cancelEditName">
              <X :size="13" />
            </button>
          </div>
          <div v-else class="asset-name-row">
            <h2 class="asset-name">{{ asset.name || `资产 ${asset.id}` }}</h2>
            <button class="btn btn-ghost btn-icon" title="编辑本地调用名" @click="startEditName(asset)">
              <Pencil :size="13" />
            </button>
          </div>
          <div class="asset-call-hint">后续提示词调用名：{{ asset.name || `资产 ${asset.id}` }}</div>
          <button class="asset-id" :title="assetId(asset) || '未生成资产 ID'" @click="copyAssetId(asset)">
            <Copy :size="12" />
            <span class="mono">{{ assetId(asset) || '未生成资产 ID' }}</span>
          </button>
          <div class="asset-meta">
            <span v-if="asset.drama_id || asset.dramaId">项目 #{{ asset.drama_id || asset.dramaId }}</span>
            <span v-if="asset.episode_id || asset.episodeId">第 {{ asset.episode_id || asset.episodeId }} 集</span>
            <span v-if="asset.storyboard_num || asset.storyboardNum">镜头 {{ asset.storyboard_num || asset.storyboardNum }}</span>
          </div>
          <div class="asset-source mono" :title="asset.source_url || asset.sourceUrl || asset.local_path || asset.localPath || ''">
            {{ asset.source_url || asset.sourceUrl || asset.local_path || asset.localPath || '无来源路径' }}
          </div>
        </div>
      </article>
    </div>

    <div v-else class="empty-assets card">
      <Images :size="34" />
      <h2>暂无可显示资产</h2>
      <p>生成角色图、场景图或镜头参考图后，在工作台上传火山素材，资产会自动出现在这里。</p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Check, Copy, ImageOff, Images, Loader2, Pencil, RefreshCw, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { assetAPI, dramaAPI } from '~/composables/useApi'

const assets = ref([])
const dramas = ref([])
const loading = ref(false)
const editingId = ref(null)
const editingName = ref('')
const savingId = ref(null)
const filters = reactive({
  keyword: '',
  dramaId: '',
  category: '',
  status: '',
})

const categoryOptions = [
  { label: '角色', value: 'character' },
  { label: '场景', value: 'scene' },
  { label: '镜头参考', value: 'storyboard' },
  { label: '其他参考', value: 'reference' },
]

const statusOptions = computed(() => {
  return [...new Set(assets.value.map(item => String(item.status || '').trim()).filter(Boolean))].sort()
})

const filteredAssets = computed(() => {
  const keyword = filters.keyword.trim().toLowerCase()
  return assets.value.filter((asset) => {
    if (filters.dramaId && String(asset.drama_id || asset.dramaId || '') !== filters.dramaId) return false
    if (filters.category && String(asset.category || '') !== filters.category) return false
    if (filters.status && String(asset.status || '') !== filters.status) return false
    if (!keyword) return true
    const haystack = [
      asset.name,
      asset.description,
      asset.provider_asset_id,
      asset.providerAssetId,
      asset.asset_uri,
      asset.assetUri,
      asset.source_url,
      asset.sourceUrl,
      asset.local_path,
      asset.localPath,
      asset.provider,
      asset.category,
    ].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(keyword)
  })
})

const activeCount = computed(() => assets.value.filter(item => String(item.status || '').toLowerCase() === 'active').length)
const semanticCount = computed(() => assets.value.filter(item => ['character', 'scene'].includes(String(item.category || ''))).length)

onMounted(loadAll)

async function loadAll() {
  loading.value = true
  try {
    const [assetRows, dramaRows] = await Promise.all([
      assetAPI.list({ provider: 'volcengine_asset' }),
      dramaAPI.list(),
    ])
    assets.value = Array.isArray(assetRows) ? assetRows : []
    dramas.value = dramaRows?.items || []
  } catch (error) {
    toast.error(error?.message || '资产库加载失败')
  } finally {
    loading.value = false
  }
}

function assetPreview(asset) {
  const raw = asset.local_path || asset.localPath || asset.source_url || asset.sourceUrl || asset.thumbnail_url || asset.thumbnailUrl || asset.url || asset.provider_url || asset.providerUrl
  return normalizeAssetUrl(raw)
}

function normalizeAssetUrl(url) {
  const value = String(url || '').trim()
  if (!value) return ''
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')) return value
  if (value.startsWith('/')) return value
  if (value.startsWith('static/')) return `/${value}`
  return value
}

function assetId(asset) {
  const value = asset.provider_asset_id || asset.providerAssetId || ''
  return String(value || '').trim()
}

function categoryLabel(category) {
  return categoryOptions.find(item => item.value === category)?.label || category || '未分类'
}

function statusClass(asset) {
  const status = String(asset.status || '').toLowerCase()
  if (status === 'active' || status === 'completed') return 'tag-success'
  if (status === 'failed' || status === 'error') return 'tag-error'
  if (status === 'processing' || status === 'pending') return 'tag-warning'
  return 'tag-info'
}

async function copyAssetId(asset) {
  const id = assetId(asset)
  if (!id) return
  const text = `@asset://${id}`
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`已复制 ${text}`)
  } catch {
    toast.error('复制失败，请手动复制资产 ID')
  }
}

function startEditName(asset) {
  editingId.value = asset.id
  editingName.value = asset.name || ''
}

function cancelEditName() {
  editingId.value = null
  editingName.value = ''
}

async function saveAssetName(asset) {
  const name = editingName.value.trim()
  if (!name) {
    toast.error('本地调用名不能为空')
    return
  }
  if (/[=@\r\n]/.test(name)) {
    toast.error('本地调用名不能包含 =、@ 或换行')
    return
  }
  savingId.value = asset.id
  try {
    const updated = await assetAPI.update(asset.id, { name })
    assets.value = assets.value.map(item => item.id === asset.id ? { ...item, ...updated } : item)
    cancelEditName()
    toast.success('本地调用名已保存，后续视频提示词会优先使用这个名称')
  } catch (error) {
    toast.error(error?.message || '保存本地调用名失败')
  } finally {
    savingId.value = null
  }
}
</script>

<style scoped>
.assets-page {
  height: 100%;
  overflow: auto;
  padding: 28px;
  background: var(--bg-base);
}
.assets-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}
.assets-title {
  font-size: 26px;
  font-weight: 700;
}
.assets-desc {
  margin-top: 4px;
  color: var(--text-3);
  font-size: 13px;
}
.assets-toolbar {
  display: grid;
  grid-template-columns: minmax(240px, 1.4fr) repeat(3, minmax(140px, 1fr));
  gap: 12px;
  padding: 14px;
  margin-bottom: 16px;
}
.filter-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.asset-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.summary-card {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.summary-card span {
  color: var(--text-3);
  font-size: 12px;
}
.summary-card strong {
  color: var(--text-0);
  font-size: 24px;
  line-height: 1;
}
.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
}
.asset-card {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 330px;
}
.asset-preview {
  position: relative;
  aspect-ratio: 16 / 10;
  background: var(--bg-2);
  overflow: hidden;
}
.asset-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.asset-preview .tag {
  position: absolute;
  top: 10px;
  right: 10px;
  box-shadow: var(--shadow-xs);
}
.asset-preview-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.asset-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  flex: 1;
}
.asset-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.asset-provider {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-name {
  font-family: var(--font-body);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: 0;
}
.asset-name-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.asset-name-row .asset-name {
  flex: 1;
  min-width: 0;
}
.asset-name-edit {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px 32px;
  gap: 6px;
  align-items: center;
}
.asset-call-hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.45;
}
.asset-id {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--accent-text);
  cursor: pointer;
  text-align: left;
}
.asset-id span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.asset-meta span {
  padding: 2px 7px;
  border-radius: 99px;
  background: var(--bg-2);
}
.asset-source {
  margin-top: auto;
  color: var(--text-3);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-assets {
  min-height: 360px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-3);
  text-align: center;
  padding: 48px;
}
.empty-assets h2 {
  font-family: var(--font-body);
  font-size: 17px;
}
.empty-assets p {
  max-width: 460px;
  font-size: 13px;
}

@media (max-width: 900px) {
  .assets-page { padding: 18px; }
  .assets-head { align-items: flex-start; flex-direction: column; }
  .assets-toolbar { grid-template-columns: 1fr; }
  .asset-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
