# Eggfans Provider Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the project's default non-Seedance AI service path with Eggfans aggregation APIs while keeping VolcEngine Seedance 2.0 video generation on the current official VolcEngine API.

**Architecture:** Add `eggfans` as a first-class provider instead of rewriting existing provider IDs. Text uses Eggfans OpenAI-compatible APIs, media services use dedicated Eggfans adapters selected by model capability from `https://eggfans.com/api/pricing_new`, and Seedance 2.0 remains routed through `volcengine` with `https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`.

**Tech Stack:** TypeScript, Hono, SQLite/Drizzle, Nuxt 3, Node test runner, existing provider adapter pattern.

---

## Scope And Non-Goals

- Replace default text, image, non-Seedance video, and audio/TTS configuration with Eggfans.
- Keep all `doubao-seedance-2-*`, `doubao-seedance-2.0*`, and any configured Seedance 2.0 video models on the official VolcEngine adapter and official base URL.
- Do not remove existing provider adapters. Keep OpenAI, Gemini, Ali, VolcEngine, Vidu, and MiniMax available for manual fallback.
- Do not store API keys in frontend state beyond the existing create/update flow. API keys remain in `ai_service_configs.api_key` and must never be returned to the browser.
- Do not rely on `pricing_new` alone for request shapes. Use it for model catalog and capability selection; use Eggfans API docs examples for endpoint/body mapping.

## Current Chain Summary

- Runtime configuration lives in `ai_service_configs` with `service_type`, `provider`, `base_url`, `api_key`, `model`, `priority`, and `is_active`.
- Text agents call `getTextConfig()` and `getTextProviderBaseUrl()` in `backend/src/services/ai.ts`, then `createOpenAI()` in `backend/src/agents/index.ts`.
- Image generation calls `getImageAdapter(config.provider)` from `backend/src/services/image-generation.ts`.
- Video generation calls `getVideoAdapter(config.provider)` from `backend/src/services/video-generation.ts`.
- Audio/TTS calls `getTTSAdapter(config.provider)` from `backend/src/services/tts-generation.ts`.
- Provider registration is centralized in `backend/src/services/adapters/registry.ts`.
- Settings providers and presets are currently hardcoded in `frontend/app/pages/settings.vue`.
- `/api/v1/ai-configs/test` probes providers through hardcoded provider branches in `backend/src/routes/aiConfigs.ts`.

## File Structure

- Create `backend/src/services/eggfans/models.ts`: fetch/cache `https://eggfans.com/api/pricing_new`, normalize model catalog, classify models by service type and endpoint capability.
- Create `backend/src/services/eggfans/routing.ts`: resolve Eggfans endpoint family for a selected model, and enforce the Seedance 2.0 official-provider exception.
- Create `backend/src/services/eggfans/__tests__/models.test.ts`: model catalog normalization and service filtering tests.
- Create `backend/src/services/eggfans/__tests__/routing.test.ts`: endpoint-family selection and Seedance 2.0 exclusion tests.
- Create `backend/src/routes/eggfansModels.ts`: expose filtered model catalog to the frontend.
- Modify `backend/src/index.ts`: register `/api/v1/eggfans/models`.
- Modify `backend/src/services/ai.ts`: make `eggfans` text configs use `/v1`.
- Create `backend/src/services/adapters/eggfans-image.ts`: Eggfans image adapter for `/v1/images/generations` and async task parsing where supported.
- Create `backend/src/services/adapters/eggfans-video.ts`: Eggfans video adapter for OpenAI video format, AliBailian/HappyHorse format, and polling.
- Create `backend/src/services/adapters/eggfans-tts.ts`: Eggfans TTS adapter for MiniMax sync TTS first, with parse support for hex and URL responses.
- Modify `backend/src/services/adapters/types.ts`: allow TTS adapters to return either hex, URL, or binary metadata in a backward-compatible shape.
- Modify `backend/src/services/tts-generation.ts`: save TTS output from hex, remote URL, or direct binary response if needed by the adapter contract.
- Modify `backend/src/services/adapters/registry.ts`: register `eggfans` for image, video, and TTS.
- Modify `backend/src/routes/aiConfigs.ts`: add Eggfans preset, Eggfans probe branch, and keep Seedance 2.0 official VolcEngine preset separate.
- Modify `frontend/app/composables/useApi.ts`: add `eggfansModelAPI`.
- Modify `frontend/app/pages/settings.vue`: add `eggfans` provider, dynamic Eggfans model selector, Eggfans one-click preset, and a Seedance 2.0 official-provider notice.
- Create `backend/src/services/adapters/__tests__/eggfans-image.test.ts`, `eggfans-video.test.ts`, `eggfans-tts.test.ts`: request and response parser coverage.
- Create `backend/src/routes/__tests__/eggfansModels.test.ts`: route-level catalog filtering tests.
- Modify `README.md`: document Eggfans setup and Seedance 2.0 exception.

## Model And Endpoint Mapping

Use `pricing_new.data[].supported_endpoint_types` as the routing input:

- Text: `openai` -> `https://api.eggfans.com/v1/chat/completions` through existing `createOpenAI()` path.
- Text catalog: `文本` and `对话` model types with `openai`.
- Image: `image-generation`, `dall-e-3`, `openai`, and `openai编辑图片` -> `POST https://api.eggfans.com/v1/images/generations`.
- Image: `images-generations` also starts at `/v1/images/generations` when the docs model example uses that endpoint, but keep the endpoint family explicit so non-compatible models can be blocked with a clear error.
- Video: `happyhorse视频` -> `POST https://api.eggfans.com/alibailian/api/v1/services/aigc/video-generation/video-synthesis`; poll `GET https://api.eggfans.com/alibailian/api/v1/tasks/{task_id}`.
- Video: `openAI视频格式` -> `POST https://api.eggfans.com/v1/videos`; poll the matching Eggfans OpenAI video task endpoint after confirming the response field in docs.
- Video: `豆包视频异步` is not the default Eggfans route for Seedance 2.0. If the model name indicates Seedance 2.0, keep provider `volcengine`.
- Audio: `同步语音` -> `POST https://api.eggfans.com/minimax/v1/t2a_v2`.
- Audio: `异步语音` -> defer until the synchronous path is stable, unless long-form audio is required by acceptance testing.
- Audio: `openai` -> `POST https://api.eggfans.com/v1/audio/speech`; implement after adapting `tts-generation.ts` to binary response.
- Audio: `geminitts` -> `POST https://api.eggfans.com/v1beta/models/{model}:generateContent`; lower priority because voice assignment currently resembles MiniMax/OpenAI voice IDs.

## Task 1: Model Catalog Service

**Files:**
- Create: `backend/src/services/eggfans/models.ts`
- Create: `backend/src/services/eggfans/__tests__/models.test.ts`

- [ ] **Step 1: Write catalog normalization tests**

Create `backend/src/services/eggfans/__tests__/models.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeEggfansCatalog,
  filterEggfansModels,
  type EggfansPricingResponse,
} from '../models.js'

const sample: EggfansPricingResponse = {
  success: true,
  auto_groups: ['default'],
  data: [
    {
      model_name: 'qwen3.7-max',
      model_type: '文本',
      tags: '对话,工具',
      supported_endpoint_types: ['openai'],
      model_ratio: 6,
      model_price: 0,
      enable_groups: ['default'],
      vendor_id: 96,
      quota_type: 0,
      sort_order: 525,
    },
    {
      model_name: 'gpt-image-2',
      model_type: '图像',
      tags: '绘画,dall-e-3格式',
      supported_endpoint_types: ['image-generation', 'openai编辑图片'],
      model_ratio: 2.5,
      model_price: 0,
      enable_groups: ['default'],
      vendor_id: 52,
      quota_type: 0,
      sort_order: 525,
    },
    {
      model_name: 'happyhorse-1.0-i2v',
      model_type: '音视频',
      tags: '视频',
      supported_endpoint_types: ['happyhorse视频'],
      model_ratio: 0,
      model_price: 0.014,
      enable_groups: ['default'],
      vendor_id: 96,
      quota_type: 4,
      sort_order: 522,
    },
    {
      model_name: 'speech-2.8-hd',
      model_type: '音视频',
      tags: '音频',
      supported_endpoint_types: ['同步语音', '异步语音'],
      model_ratio: 0,
      model_price: 0,
      enable_groups: ['default'],
      vendor_id: 95,
      quota_type: 0,
      sort_order: 500,
    },
  ],
}

test('normalizeEggfansCatalog keeps endpoint metadata and derives service types', () => {
  const models = normalizeEggfansCatalog(sample)

  assert.deepEqual(models.map(m => m.name), [
    'qwen3.7-max',
    'gpt-image-2',
    'happyhorse-1.0-i2v',
    'speech-2.8-hd',
  ])
  assert.equal(models[0].serviceType, 'text')
  assert.equal(models[1].serviceType, 'image')
  assert.equal(models[2].serviceType, 'video')
  assert.equal(models[3].serviceType, 'audio')
  assert.deepEqual(models[1].endpointTypes, ['image-generation', 'openai编辑图片'])
})

test('filterEggfansModels returns only models useful for the requested service', () => {
  const models = normalizeEggfansCatalog(sample)

  assert.deepEqual(filterEggfansModels(models, 'text').map(m => m.name), ['qwen3.7-max'])
  assert.deepEqual(filterEggfansModels(models, 'image').map(m => m.name), ['gpt-image-2'])
  assert.deepEqual(filterEggfansModels(models, 'video').map(m => m.name), ['happyhorse-1.0-i2v'])
  assert.deepEqual(filterEggfansModels(models, 'audio').map(m => m.name), ['speech-2.8-hd'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd backend
npm test -- src/services/eggfans/__tests__/models.test.ts
```

Expected: FAIL because `backend/src/services/eggfans/models.ts` does not exist.

- [ ] **Step 3: Implement catalog service**

Create `backend/src/services/eggfans/models.ts`:

```ts
import { logTaskWarn } from '../../utils/task-logger.js'

export type EggfansServiceType = 'text' | 'image' | 'video' | 'audio'

export interface EggfansPricingModel {
  model_name: string
  description?: string
  tags?: string
  model_type?: string
  vendor_id?: number
  quota_type?: number
  model_ratio?: number
  model_price?: number
  completion_ratio?: number
  enable_groups?: string[]
  supported_endpoint_types?: string[]
  sort_order?: number
}

export interface EggfansPricingResponse {
  success?: boolean
  auto_groups?: string[]
  data?: EggfansPricingModel[]
  supported_endpoint?: unknown
  vendors?: unknown
}

export interface NormalizedEggfansModel {
  name: string
  description: string
  serviceType: EggfansServiceType
  modelType: string
  tags: string[]
  endpointTypes: string[]
  groups: string[]
  vendorId?: number
  quotaType?: number
  ratio: number
  price: number
  completionRatio: number
  sortOrder: number
}

const PRICING_URL = 'https://eggfans.com/api/pricing_new'
const CACHE_MS = 10 * 60 * 1000

let cachedAt = 0
let cachedModels: NormalizedEggfansModel[] = []

export async function getEggfansModels(fetchImpl: typeof fetch = fetch): Promise<NormalizedEggfansModel[]> {
  if (cachedModels.length && Date.now() - cachedAt < CACHE_MS) return cachedModels

  const resp = await fetchImpl(PRICING_URL)
  if (!resp.ok) throw new Error(`Eggfans pricing fetch failed: ${resp.status}`)

  const payload = await resp.json() as EggfansPricingResponse
  cachedModels = normalizeEggfansCatalog(payload)
  cachedAt = Date.now()
  return cachedModels
}

export function clearEggfansModelCache() {
  cachedAt = 0
  cachedModels = []
}

export function normalizeEggfansCatalog(payload: EggfansPricingResponse): NormalizedEggfansModel[] {
  const rows = Array.isArray(payload.data) ? payload.data : []
  return rows
    .map(normalizeModel)
    .filter((model): model is NormalizedEggfansModel => !!model)
    .sort((a, b) => b.sortOrder - a.sortOrder || a.name.localeCompare(b.name))
}

export function filterEggfansModels(models: NormalizedEggfansModel[], serviceType?: string) {
  if (!serviceType) return models
  return models.filter(model => model.serviceType === serviceType)
}

function normalizeModel(row: EggfansPricingModel): NormalizedEggfansModel | null {
  const name = String(row.model_name || '').trim()
  if (!name) return null

  const tags = splitList(row.tags)
  const endpointTypes = Array.isArray(row.supported_endpoint_types)
    ? row.supported_endpoint_types.map(String).filter(Boolean)
    : []
  const serviceType = deriveServiceType(row.model_type || '', tags, endpointTypes)
  if (!serviceType) {
    logTaskWarn('EggfansModels', 'unsupported-model-type', {
      model: name,
      modelType: row.model_type,
      endpointTypes,
      tags,
    })
    return null
  }

  return {
    name,
    description: String(row.description || ''),
    serviceType,
    modelType: String(row.model_type || ''),
    tags,
    endpointTypes,
    groups: Array.isArray(row.enable_groups) ? row.enable_groups.map(String) : [],
    vendorId: row.vendor_id,
    quotaType: row.quota_type,
    ratio: Number(row.model_ratio || 0),
    price: Number(row.model_price || 0),
    completionRatio: Number(row.completion_ratio || 0),
    sortOrder: Number(row.sort_order || 0),
  }
}

function deriveServiceType(modelType: string, tags: string[], endpointTypes: string[]): EggfansServiceType | null {
  const modelTypeText = modelType.toLowerCase()
  const tagText = tags.join(',').toLowerCase()
  const endpointText = endpointTypes.join(',').toLowerCase()

  if (modelType === '文本' || modelType === '对话') return 'text'
  if (modelType === '图像') return 'image'
  if (modelType === '音视频' && tagText.includes('音频')) return 'audio'
  if (modelType === '音视频' && tagText.includes('视频')) return 'video'
  if (endpointText.includes('tts') || endpointText.includes('语音') || tagText.includes('音频')) return 'audio'
  if (endpointText.includes('video') || endpointText.includes('视频') || tagText.includes('视频')) return 'video'
  if (endpointText.includes('image') || endpointText.includes('图像') || tagText.includes('绘画')) return 'image'
  if (endpointText.includes('openai') && (modelTypeText.includes('text') || tagText.includes('对话'))) return 'text'
  return null
}

function splitList(value?: string) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}
```

- [ ] **Step 4: Run model tests**

Run:

```bash
cd backend
npm test -- src/services/eggfans/__tests__/models.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/eggfans/models.ts backend/src/services/eggfans/__tests__/models.test.ts
git commit -m "feat: add eggfans model catalog service"
```

## Task 2: Eggfans Routing And Seedance 2.0 Exception

**Files:**
- Create: `backend/src/services/eggfans/routing.ts`
- Create: `backend/src/services/eggfans/__tests__/routing.test.ts`

- [ ] **Step 1: Write routing tests**

Create `backend/src/services/eggfans/__tests__/routing.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveEggfansRoute,
  shouldUseOfficialVolcengineVideo,
} from '../routing.js'

test('resolveEggfansRoute maps endpoint families for supported models', () => {
  assert.equal(resolveEggfansRoute('text', 'qwen3.7-max', ['openai']).family, 'openai-chat')
  assert.equal(resolveEggfansRoute('image', 'gpt-image-2', ['image-generation']).family, 'openai-image')
  assert.equal(resolveEggfansRoute('video', 'happyhorse-1.0-i2v', ['happyhorse视频']).family, 'alibailian-video')
  assert.equal(resolveEggfansRoute('audio', 'speech-2.8-hd', ['同步语音']).family, 'minimax-sync-tts')
})

test('Seedance 2.0 video models stay on official VolcEngine provider', () => {
  assert.equal(shouldUseOfficialVolcengineVideo('doubao-seedance-2-0-pro-260215'), true)
  assert.equal(shouldUseOfficialVolcengineVideo('doubao-seedance-2.0-pro'), true)
  assert.equal(shouldUseOfficialVolcengineVideo('doubao-seedance-1-5-pro-251215'), false)
  assert.equal(shouldUseOfficialVolcengineVideo('happyhorse-1.0-i2v'), false)
})

test('resolveEggfansRoute rejects Seedance 2.0 as an Eggfans video route', () => {
  assert.throws(
    () => resolveEggfansRoute('video', 'doubao-seedance-2-0-pro-260215', ['豆包视频异步']),
    /official VolcEngine/i,
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd backend
npm test -- src/services/eggfans/__tests__/routing.test.ts
```

Expected: FAIL because `routing.ts` does not exist.

- [ ] **Step 3: Implement routing**

Create `backend/src/services/eggfans/routing.ts`:

```ts
import type { EggfansServiceType } from './models.js'

export type EggfansRouteFamily =
  | 'openai-chat'
  | 'openai-image'
  | 'alibailian-video'
  | 'openai-video'
  | 'minimax-sync-tts'
  | 'openai-tts'
  | 'gemini-tts'

export interface EggfansRoute {
  family: EggfansRouteFamily
  reason: string
}

export function shouldUseOfficialVolcengineVideo(modelName: string) {
  const normalized = modelName.toLowerCase()
  return /^doubao-seedance[-_.]?2(?:[-_.]?0)?/.test(normalized)
}

export function resolveEggfansRoute(
  serviceType: EggfansServiceType,
  modelName: string,
  endpointTypes: string[],
): EggfansRoute {
  const endpointText = endpointTypes.join(',').toLowerCase()

  if (serviceType === 'video' && shouldUseOfficialVolcengineVideo(modelName)) {
    throw new Error(`${modelName} must use the official VolcEngine Seedance 2.0 adapter, not Eggfans`)
  }

  if (serviceType === 'text' && endpointText.includes('openai')) {
    return { family: 'openai-chat', reason: 'OpenAI-compatible chat endpoint' }
  }

  if (serviceType === 'image' && hasAny(endpointText, ['image-generation', 'images-generations', 'dall-e-3', 'openai'])) {
    return { family: 'openai-image', reason: 'Eggfans image endpoint accepts OpenAI image generation shape' }
  }

  if (serviceType === 'video' && endpointText.includes('happyhorse')) {
    return { family: 'alibailian-video', reason: 'HappyHorse uses Eggfans AliBailian video synthesis endpoint' }
  }

  if (serviceType === 'video' && hasAny(endpointText, ['openai视频格式', 'openai video', 'openai-video'])) {
    return { family: 'openai-video', reason: 'Model advertises Eggfans OpenAI video format' }
  }

  if (serviceType === 'audio' && endpointText.includes('同步语音')) {
    return { family: 'minimax-sync-tts', reason: 'Synchronous MiniMax-compatible TTS response' }
  }

  if (serviceType === 'audio' && endpointText.includes('geminitts')) {
    return { family: 'gemini-tts', reason: 'Gemini TTS generateContent endpoint' }
  }

  if (serviceType === 'audio' && endpointText.includes('openai')) {
    return { family: 'openai-tts', reason: 'OpenAI audio speech endpoint' }
  }

  throw new Error(`No Eggfans route for ${serviceType} model ${modelName} with endpoints: ${endpointTypes.join(', ')}`)
}

function hasAny(value: string, needles: string[]) {
  return needles.some(needle => value.includes(needle.toLowerCase()))
}
```

- [ ] **Step 4: Run routing tests**

Run:

```bash
cd backend
npm test -- src/services/eggfans/__tests__/routing.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/eggfans/routing.ts backend/src/services/eggfans/__tests__/routing.test.ts
git commit -m "feat: route eggfans models by endpoint capability"
```

## Task 3: Backend Model Catalog Route

**Files:**
- Create: `backend/src/routes/eggfansModels.ts`
- Create: `backend/src/routes/__tests__/eggfansModels.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write route tests**

Create `backend/src/routes/__tests__/eggfansModels.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEggfansModelsRoute } from '../eggfansModels.js'

test('GET / returns filtered Eggfans model catalog', async () => {
  const app = createEggfansModelsRoute(async () => [
    {
      name: 'qwen3.7-max',
      description: '',
      serviceType: 'text',
      modelType: '文本',
      tags: ['对话'],
      endpointTypes: ['openai'],
      groups: ['default'],
      ratio: 6,
      price: 0,
      completionRatio: 3,
      sortOrder: 525,
    },
    {
      name: 'gpt-image-2',
      description: '',
      serviceType: 'image',
      modelType: '图像',
      tags: ['绘画'],
      endpointTypes: ['image-generation'],
      groups: ['default'],
      ratio: 2.5,
      price: 0,
      completionRatio: 6,
      sortOrder: 525,
    },
  ])

  const resp = await app.request('/?service_type=image')
  assert.equal(resp.status, 200)
  const body = await resp.json()
  assert.equal(body.success, true)
  assert.deepEqual(body.data.models.map((model: any) => model.name), ['gpt-image-2'])
})
```

- [ ] **Step 2: Run route test to verify it fails**

Run:

```bash
cd backend
npm test -- src/routes/__tests__/eggfansModels.test.ts
```

Expected: FAIL because `eggfansModels.ts` does not exist.

- [ ] **Step 3: Implement route**

Create `backend/src/routes/eggfansModels.ts`:

```ts
import { Hono } from 'hono'
import { success } from '../utils/response.js'
import {
  filterEggfansModels,
  getEggfansModels,
  type NormalizedEggfansModel,
} from '../services/eggfans/models.js'

type Loader = () => Promise<NormalizedEggfansModel[]>

export function createEggfansModelsRoute(loadModels: Loader = () => getEggfansModels()) {
  const app = new Hono()

  app.get('/', async (c) => {
    const serviceType = c.req.query('service_type')
    const models = filterEggfansModels(await loadModels(), serviceType)
    return success(c, { models })
  })

  return app
}

export default createEggfansModelsRoute()
```

- [ ] **Step 4: Register route**

Modify `backend/src/index.ts`:

```ts
import eggfansModels from './routes/eggfansModels.js'
```

Add near the existing AI routes:

```ts
api.route('/eggfans/models', eggfansModels)
```

- [ ] **Step 5: Run route tests**

Run:

```bash
cd backend
npm test -- src/routes/__tests__/eggfansModels.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/eggfansModels.ts backend/src/routes/__tests__/eggfansModels.test.ts backend/src/index.ts
git commit -m "feat: expose eggfans model catalog"
```

## Task 4: Text Provider Integration

**Files:**
- Modify: `backend/src/services/ai.ts`
- Create: `backend/src/services/__tests__/ai.test.ts`

- [ ] **Step 1: Write base URL tests**

Create `backend/src/services/__tests__/ai.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { getTextProviderBaseUrl } from '../ai.js'

test('getTextProviderBaseUrl appends /v1 for Eggfans text configs', () => {
  assert.equal(
    getTextProviderBaseUrl({
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'key',
      model: 'qwen3.7-max',
    }),
    'https://api.eggfans.com/v1',
  )
})

test('getTextProviderBaseUrl does not duplicate /v1 for Eggfans text configs', () => {
  assert.equal(
    getTextProviderBaseUrl({
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com/v1',
      apiKey: 'key',
      model: 'qwen3.7-max',
    }),
    'https://api.eggfans.com/v1',
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd backend
npm test -- src/services/__tests__/ai.test.ts
```

Expected: FAIL because `eggfans` currently returns the raw base URL.

- [ ] **Step 3: Add Eggfans to OpenAI-compatible text branch**

Modify `backend/src/services/ai.ts`:

```ts
if (provider === 'openai' || provider === 'openrouter' || provider === 'chatfire' || provider === 'eggfans') {
  return joinProviderUrl(config.baseUrl, '/v1', '')
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd backend
npm test -- src/services/__tests__/ai.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/ai.ts backend/src/services/__tests__/ai.test.ts
git commit -m "feat: support eggfans openai-compatible text endpoint"
```

## Task 5: Eggfans Image Adapter

**Files:**
- Create: `backend/src/services/adapters/eggfans-image.ts`
- Create: `backend/src/services/adapters/__tests__/eggfans-image.test.ts`
- Modify: `backend/src/services/adapters/registry.ts`

- [ ] **Step 1: Write image adapter tests**

Create `backend/src/services/adapters/__tests__/eggfans-image.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { EggfansImageAdapter } from '../eggfans-image.js'

const adapter = new EggfansImageAdapter()

test('EggfansImageAdapter builds /v1/images/generations requests', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'gpt-image-2',
    },
    {
      id: 1,
      model: 'doubao-seedream-5-0-260128',
      prompt: 'portrait',
      size: '1920x1080',
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/v1/images/generations')
  assert.equal(req.method, 'POST')
  assert.equal(req.headers.Authorization, 'Bearer secret')
  assert.equal(req.body.model, 'doubao-seedream-5-0-260128')
  assert.equal(req.body.prompt, 'portrait')
  assert.equal(req.body.response_format, 'url')
  assert.equal(req.body.watermark, false)
})

test('EggfansImageAdapter extracts OpenAI-style image URLs', () => {
  const result = { data: [{ url: 'https://cdn.example/image.png' }] }
  assert.deepEqual(adapter.parseGenerateResponse(result), {
    isAsync: false,
    imageUrl: 'https://cdn.example/image.png',
  })
  assert.equal(adapter.extractImageUrl(result), 'https://cdn.example/image.png')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd backend
npm test -- src/services/adapters/__tests__/eggfans-image.test.ts
```

Expected: FAIL because `eggfans-image.ts` does not exist.

- [ ] **Step 3: Implement image adapter**

Create `backend/src/services/adapters/eggfans-image.ts`:

```ts
import type {
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
  ImageProviderAdapter,
  ProviderRequest,
} from './types.js'
import { joinProviderUrl } from './url.js'

export class EggfansImageAdapter implements ImageProviderAdapter {
  provider = 'eggfans'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const body: any = {
      model: record.model || config.model,
      prompt: record.prompt,
      size: normalizeImageSize(record.size),
      n: 1,
      response_format: 'url',
      watermark: false,
    }

    const references = parseReferences(record.referenceImages)
    if (references.length) body.image = references

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const imageUrl = this.extractImageUrl(result)
    if (imageUrl) return { isAsync: false, imageUrl }

    const taskId = result.task_id || result.id || result.output?.task_id
    if (taskId) return { isAsync: true, taskId }

    const b64 = this.extractImageBase64(result)
    if (b64) return { isAsync: false, imageUrl: undefined }

    throw new Error('No Eggfans image URL or task id in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/images/task/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = result.status || result.output?.task_status
    if (status === 'completed' || status === 'SUCCEEDED' || status === 'succeeded') {
      return { status: 'completed', imageUrl: this.extractImageUrl(result) || undefined }
    }
    if (status === 'failed' || status === 'FAILED') {
      return { status: 'failed', error: result.error?.message || result.message || 'Eggfans image generation failed' }
    }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url
      || result.output?.image_url
      || result.output?.results?.[0]?.url
      || result.image_url
      || result.url
      || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.data?.[0]?.b64_json || result.output?.b64_json
    return b64 ? { data: b64, mimeType: 'image/png' } : null
  }
}

function normalizeImageSize(size?: string | null) {
  if (!size) return '1024x1024'
  if (size === '1920x1080') return '1792x1024'
  if (size === '1080x1920') return '1024x1792'
  return size
}

function parseReferences(value?: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && item) : []
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Register adapter**

Modify `backend/src/services/adapters/registry.ts`:

```ts
import { EggfansImageAdapter } from './eggfans-image'
```

Add to `imageAdapters`:

```ts
eggfans: new EggfansImageAdapter(),
```

- [ ] **Step 5: Run image adapter tests**

Run:

```bash
cd backend
npm test -- src/services/adapters/__tests__/eggfans-image.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/adapters/eggfans-image.ts backend/src/services/adapters/__tests__/eggfans-image.test.ts backend/src/services/adapters/registry.ts
git commit -m "feat: add eggfans image adapter"
```

## Task 6: Eggfans Video Adapter With Seedance Boundary

**Files:**
- Create: `backend/src/services/adapters/eggfans-video.ts`
- Create: `backend/src/services/adapters/__tests__/eggfans-video.test.ts`
- Modify: `backend/src/services/adapters/registry.ts`

- [ ] **Step 1: Write video adapter tests**

Create `backend/src/services/adapters/__tests__/eggfans-video.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { EggfansVideoAdapter } from '../eggfans-video.js'

const adapter = new EggfansVideoAdapter()

test('EggfansVideoAdapter builds HappyHorse AliBailian video requests', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'happyhorse-1.0-i2v',
    },
    {
      id: 1,
      model: 'happyhorse-1.0-i2v',
      prompt: 'cat running',
      referenceMode: 'single',
      imageUrl: 'https://cdn.example/cat.png',
      duration: 5,
      aspectRatio: '16:9',
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/alibailian/api/v1/services/aigc/video-generation/video-synthesis')
  assert.equal(req.method, 'POST')
  assert.equal(req.body.model, 'happyhorse-1.0-i2v')
  assert.deepEqual(req.body.input.media, [{ type: 'first_frame', url: 'https://cdn.example/cat.png' }])
  assert.equal(req.body.parameters.duration, 5)
  assert.equal(req.body.parameters.resolution, '720P')
})

test('EggfansVideoAdapter refuses Seedance 2.0 models', () => {
  assert.throws(
    () => adapter.buildGenerateRequest(
      {
        provider: 'eggfans',
        baseUrl: 'https://api.eggfans.com',
        apiKey: 'secret',
        model: 'doubao-seedance-2-0-pro-260215',
      },
      { id: 1, prompt: 'scene', model: 'doubao-seedance-2-0-pro-260215' },
    ),
    /official VolcEngine/i,
  )
})

test('EggfansVideoAdapter parses AliBailian task responses', () => {
  assert.deepEqual(adapter.parseGenerateResponse({ output: { task_id: 'task-1', task_status: 'PENDING' } }), {
    isAsync: true,
    taskId: 'task-1',
  })
  assert.deepEqual(adapter.parsePollResponse({ output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example/v.mp4' } }), {
    status: 'completed',
    videoUrl: 'https://cdn.example/v.mp4',
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd backend
npm test -- src/services/adapters/__tests__/eggfans-video.test.ts
```

Expected: FAIL because `eggfans-video.ts` does not exist.

- [ ] **Step 3: Implement video adapter**

Create `backend/src/services/adapters/eggfans-video.ts`:

```ts
import type {
  AIConfig,
  ProviderRequest,
  VideoGenResponse,
  VideoGenerationRecord,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types.js'
import { joinProviderUrl } from './url.js'
import { shouldUseOfficialVolcengineVideo } from '../eggfans/routing.js'

export class EggfansVideoAdapter implements VideoProviderAdapter {
  provider = 'eggfans'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model
    if (shouldUseOfficialVolcengineVideo(model)) {
      throw new Error(`${model} must use the official VolcEngine Seedance 2.0 adapter, not Eggfans`)
    }

    if (model.includes('happyhorse')) {
      return this.buildAliBailianRequest(config, record, model)
    }

    return this.buildOpenAIVideoRequest(config, record, model)
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = result.output?.task_id || result.id || result.task_id
    if (taskId) return { isAsync: true, taskId }

    const videoUrl = this.extractVideoUrl(result)
    if (videoUrl) return { isAsync: false, videoUrl }

    throw new Error('No Eggfans video task id or video URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    if (taskId.startsWith('video_') || taskId.startsWith('vid_')) {
      return {
        url: joinProviderUrl(config.baseUrl, '/v1', `/videos/${taskId}`),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${config.apiKey}` },
        body: undefined,
      }
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/alibailian/api/v1', `/tasks/${taskId}`),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = result.output?.task_status || result.status
    if (['SUCCEEDED', 'succeeded', 'completed'].includes(status)) {
      return { status: 'completed', videoUrl: this.extractVideoUrl(result) || undefined }
    }
    if (['FAILED', 'failed', 'cancelled'].includes(status)) {
      return { status: 'failed', error: result.message || result.error?.message || 'Eggfans video generation failed' }
    }
    if (['PENDING', 'RUNNING', 'queued', 'in_progress', 'processing'].includes(status)) {
      return { status: 'processing' }
    }
    return { status: 'pending' }
  }

  extractVideoUrl(result: any): string | null {
    return result.output?.video_url
      || result.output?.results?.[0]?.url
      || result.data?.video_url
      || result.video_url
      || result.url
      || null
  }

  private buildAliBailianRequest(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    const input: any = { prompt: record.prompt || '' }
    const media = this.buildMedia(record)
    if (media.length) input.media = media

    return {
      url: joinProviderUrl(config.baseUrl, '/alibailian/api/v1', '/services/aigc/video-generation/video-synthesis'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: {
        model,
        input,
        parameters: {
          resolution: '720P',
          duration: normalizeDuration(record.duration),
        },
      },
    }
  }

  private buildOpenAIVideoRequest(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/videos'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: {
        model,
        prompt: record.prompt || '',
        seconds: normalizeDuration(record.duration),
        input_reference: record.imageUrl || record.firstFrameUrl || undefined,
        size: record.aspectRatio || '16:9',
      },
    }
  }

  private buildMedia(record: VideoGenerationRecord) {
    const media: Array<{ type: string; url: string }> = []
    if (record.referenceMode === 'single' && record.imageUrl) {
      media.push({ type: 'first_frame', url: record.imageUrl })
    }
    if (record.referenceMode === 'first_last') {
      if (record.firstFrameUrl) media.push({ type: 'first_frame', url: record.firstFrameUrl })
      if (record.lastFrameUrl) media.push({ type: 'last_frame', url: record.lastFrameUrl })
    }
    if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
      try {
        const refs = JSON.parse(record.referenceImageUrls)
        if (Array.isArray(refs)) {
          refs.filter((url): url is string => typeof url === 'string' && !!url)
            .slice(0, 9)
            .forEach(url => media.push({ type: 'reference_image', url }))
        }
      } catch {}
    }
    return media
  }
}

function normalizeDuration(duration?: number | null) {
  const parsed = Math.round(Number(duration || 5))
  if (!Number.isFinite(parsed)) return 5
  return Math.min(12, Math.max(3, parsed))
}
```

- [ ] **Step 4: Register adapter**

Modify `backend/src/services/adapters/registry.ts`:

```ts
import { EggfansVideoAdapter } from './eggfans-video'
```

Add to `videoAdapters`:

```ts
eggfans: new EggfansVideoAdapter(),
```

- [ ] **Step 5: Run video adapter tests**

Run:

```bash
cd backend
npm test -- src/services/adapters/__tests__/eggfans-video.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/adapters/eggfans-video.ts backend/src/services/adapters/__tests__/eggfans-video.test.ts backend/src/services/adapters/registry.ts
git commit -m "feat: add eggfans video adapter"
```

## Task 7: TTS Contract And Eggfans TTS Adapter

**Files:**
- Modify: `backend/src/services/adapters/types.ts`
- Modify: `backend/src/services/tts-generation.ts`
- Create: `backend/src/services/adapters/eggfans-tts.ts`
- Create: `backend/src/services/adapters/__tests__/eggfans-tts.test.ts`
- Modify: `backend/src/services/adapters/registry.ts`

- [ ] **Step 1: Write TTS adapter tests**

Create `backend/src/services/adapters/__tests__/eggfans-tts.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { EggfansTTSAdapter } from '../eggfans-tts.js'

const adapter = new EggfansTTSAdapter()

test('EggfansTTSAdapter builds MiniMax sync TTS requests by default', () => {
  const req = adapter.buildGenerateRequest(
    {
      provider: 'eggfans',
      baseUrl: 'https://api.eggfans.com',
      apiKey: 'secret',
      model: 'speech-2.8-hd',
    },
    {
      text: '你好',
      voice: 'moss_audio_demo',
      speed: 1.1,
    },
  )

  assert.equal(req.url, 'https://api.eggfans.com/minimax/v1/t2a_v2')
  assert.equal(req.method, 'POST')
  assert.equal(req.body.model, 'speech-2.8-hd')
  assert.equal(req.body.text, '你好')
  assert.equal(req.body.voice_setting.voice_id, 'moss_audio_demo')
  assert.equal(req.body.voice_setting.speed, 1.1)
})

test('EggfansTTSAdapter parses hex audio response', () => {
  assert.deepEqual(adapter.parseResponse({
    data: {
      audio: 'ff00',
      extra_info: {
        audio_length: 1000,
        audio_sample_rate: 32000,
        audio_format: 'mp3',
        audio_channel: 1,
      },
    },
  }), {
    audioHex: 'ff00',
    audioLength: 1000,
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1,
  })
})

test('EggfansTTSAdapter parses URL audio response', () => {
  assert.deepEqual(adapter.parseResponse({ data: { audio_url: 'https://cdn.example/a.mp3' } }), {
    audioUrl: 'https://cdn.example/a.mp3',
    audioLength: 0,
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1,
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd backend
npm test -- src/services/adapters/__tests__/eggfans-tts.test.ts
```

Expected: FAIL because `eggfans-tts.ts` does not exist and `TTSProviderAdapter` return type does not allow `audioUrl`.

- [ ] **Step 3: Extend TTS result type**

Modify `backend/src/services/adapters/types.ts`:

```ts
export interface TTSProviderAdapter {
  provider: string

  buildGenerateRequest(config: AIConfig, params: any): ProviderRequest

  parseResponse(result: any): {
    audioHex?: string
    audioUrl?: string
    audioLength: number
    sampleRate: number
    bitrate: number
    format: string
    channel: number
  }
}
```

- [ ] **Step 4: Update TTS generation save logic**

Modify the save block in `backend/src/services/tts-generation.ts` after `const parsed = adapter.parseResponse(result)`:

```ts
let buffer: Buffer

if (parsed.audioHex) {
  buffer = Buffer.from(parsed.audioHex, 'hex')
} else if (parsed.audioUrl) {
  const audioResp = await fetch(parsed.audioUrl)
  if (!audioResp.ok) {
    throw new Error(`TTS audio download error ${audioResp.status}: ${await audioResp.text()}`)
  }
  buffer = Buffer.from(await audioResp.arrayBuffer())
} else {
  throw new Error('No audio data in TTS response')
}
```

Keep the existing directory creation, filename, write, and return path logic after this block.

- [ ] **Step 5: Implement Eggfans TTS adapter**

Create `backend/src/services/adapters/eggfans-tts.ts`:

```ts
import type { AIConfig, ProviderRequest, TTSProviderAdapter } from './types.js'
import { joinProviderUrl } from './url.js'

interface TTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
}

export class EggfansTTSAdapter implements TTSProviderAdapter {
  provider = 'eggfans'

  buildGenerateRequest(config: AIConfig, params: TTSParams): ProviderRequest {
    const model = params.model || config.model || 'speech-2.8-hd'
    return {
      url: joinProviderUrl(config.baseUrl, '/minimax/v1', '/t2a_v2'),
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        model,
        text: params.text,
        voice_setting: {
          voice_id: params.voice,
          speed: params.speed ?? 1,
          vol: 1,
          pitch: 0,
          emotion: params.emotion || undefined,
        },
      },
    }
  }

  parseResponse(result: any) {
    const data = result.data || result.output || result
    const audioHex = data.audio || data.audio_hex
    const audioUrl = data.audio_url || data.url
    if (!audioHex && !audioUrl) {
      throw new Error('No audio data in Eggfans TTS response')
    }

    return {
      audioHex,
      audioUrl,
      audioLength: data.extra_info?.audio_length || data.audio_length || 0,
      sampleRate: data.extra_info?.audio_sample_rate || data.sample_rate || 32000,
      bitrate: data.extra_info?.bitrate || data.bitrate || 128000,
      format: data.extra_info?.audio_format || data.format || 'mp3',
      channel: data.extra_info?.audio_channel || data.channel || 1,
    }
  }
}
```

- [ ] **Step 6: Register adapter**

Modify `backend/src/services/adapters/registry.ts`:

```ts
import { EggfansTTSAdapter } from './eggfans-tts'
```

Add to `ttsAdapters`:

```ts
eggfans: new EggfansTTSAdapter(),
```

- [ ] **Step 7: Run TTS tests**

Run:

```bash
cd backend
npm test -- src/services/adapters/__tests__/eggfans-tts.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/adapters/types.ts backend/src/services/tts-generation.ts backend/src/services/adapters/eggfans-tts.ts backend/src/services/adapters/__tests__/eggfans-tts.test.ts backend/src/services/adapters/registry.ts
git commit -m "feat: add eggfans tts adapter"
```

## Task 8: Eggfans Preset And Provider Probe

**Files:**
- Modify: `backend/src/routes/aiConfigs.ts`
- Create: `backend/src/routes/__tests__/aiConfigs-eggfans.test.ts`

- [ ] **Step 1: Extract probe builder for tests**

Modify `backend/src/routes/aiConfigs.ts`:

```ts
export function buildProbe(serviceType: string, provider: string, baseUrl: string, model?: string, apiKey?: string) {
```

Keep the function body in place.

- [ ] **Step 2: Write probe tests**

Create `backend/src/routes/__tests__/aiConfigs-eggfans.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProbe } from '../aiConfigs.js'

test('buildProbe uses Eggfans OpenAI model list endpoint', () => {
  const probe = buildProbe('text', 'eggfans', 'https://api.eggfans.com', 'qwen3.7-max', 'key')
  assert.equal(probe.method, 'GET')
  assert.equal(probe.url, 'https://api.eggfans.com/v1/models')
  assert.equal(probe.headers.Authorization, 'Bearer key')
})

test('buildProbe keeps VolcEngine probe for Seedance official configs', () => {
  const probe = buildProbe('video', 'volcengine', 'https://ark.cn-beijing.volces.com', 'doubao-seedance-2-0-pro-260215', 'key')
  assert.equal(probe.method, 'POST')
  assert.equal(probe.url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')
})
```

- [ ] **Step 3: Run probe tests**

Run:

```bash
cd backend
npm test -- src/routes/__tests__/aiConfigs-eggfans.test.ts
```

Expected: FAIL until the Eggfans branch is added.

- [ ] **Step 4: Add Eggfans probe branch**

In `buildProbe()` before the final fallback:

```ts
if (p === 'eggfans') {
  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '/v1', '/models'),
    headers: bearerHeaders(apiKey),
    body: undefined,
  }
}
```

- [ ] **Step 5: Add preset constants**

Add constants near `EGGFANS_PRESET_SERVICES`:

```ts
const EGGFANS_BASE_URL = 'https://api.eggfans.com'
const OFFICIAL_VOLCENGINE_BASE_URL = 'https://ark.cn-beijing.volces.com'

const EGGFANS_PRESET_SERVICES = [
  { serviceType: 'text', label: '文本', provider: 'eggfans', baseUrl: EGGFANS_BASE_URL, model: 'qwen3.7-max', priority: 100 },
  { serviceType: 'image', label: '图片', provider: 'eggfans', baseUrl: EGGFANS_BASE_URL, model: 'gpt-image-2', priority: 99 },
  { serviceType: 'video', label: '视频', provider: 'eggfans', baseUrl: EGGFANS_BASE_URL, model: 'happyhorse-1.0-i2v', priority: 98 },
  { serviceType: 'audio', label: '音频', provider: 'eggfans', baseUrl: EGGFANS_BASE_URL, model: 'speech-2.8-hd', priority: 97 },
] as const

const OFFICIAL_SEEDANCE_PRESET = {
  serviceType: 'video',
  label: 'Seedance 2.0 官方视频',
  provider: 'volcengine',
  baseUrl: OFFICIAL_VOLCENGINE_BASE_URL,
  model: 'doubao-seedance-2-0-pro-260215',
  priority: 110,
} as const
```

- [ ] **Step 6: Add `/eggfans-preset` route**

Add after `/eggfans-preset`:

```ts
app.post('/eggfans-preset', async (c) => {
  const body = await c.req.json()
  const apiKey = String(body.api_key || '').trim()
  const seedanceApiKey = String(body.seedance_api_key || apiKey).trim()
  if (!apiKey) return badRequest(c, 'api_key is required')

  const ts = now()
  const presets = [
    ...EGGFANS_PRESET_SERVICES,
    { ...OFFICIAL_SEEDANCE_PRESET, apiKey: seedanceApiKey },
  ]

  for (const preset of presets) {
    const [existing] = db.select().from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.serviceType, preset.serviceType))
      .all()
      .filter(row => row.provider === preset.provider && row.model?.includes(preset.model))

    const values = {
      serviceType: preset.serviceType,
      provider: preset.provider,
      name: preset.provider === 'volcengine' ? preset.label : `Eggfans ${preset.label}服务`,
      baseUrl: preset.baseUrl,
      apiKey: 'apiKey' in preset ? preset.apiKey : apiKey,
      model: JSON.stringify([preset.model]),
      priority: preset.priority,
      isActive: true,
      updatedAt: ts,
    }

    if (existing) {
      db.update(schema.aiServiceConfigs).set(values).where(eq(schema.aiServiceConfigs.id, existing.id)).run()
    } else {
      db.insert(schema.aiServiceConfigs).values({ ...values, createdAt: ts }).run()
    }
  }

  const configs = db.select().from(schema.aiServiceConfigs).all().map(toClientConfig)
  return success(c, { configs })
})
```

- [ ] **Step 7: Run probe tests**

Run:

```bash
cd backend
npm test -- src/routes/__tests__/aiConfigs-eggfans.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/aiConfigs.ts backend/src/routes/__tests__/aiConfigs-eggfans.test.ts
git commit -m "feat: add eggfans preset and probe"
```

## Task 9: Frontend Settings Integration

**Files:**
- Modify: `frontend/app/composables/useApi.ts`
- Modify: `frontend/app/pages/settings.vue`

- [ ] **Step 1: Add API client methods**

Modify `frontend/app/composables/useApi.ts`:

```ts
export const eggfansModelAPI = {
  list: (serviceType?: string) => api.get(`/eggfans/models${serviceType ? `?service_type=${serviceType}` : ''}`),
}
```

Add to `aiConfigAPI`:

```ts
eggfansPreset: (apiKey: string, seedanceApiKey?: string) => api.post('/ai-configs/eggfans-preset', {
  api_key: apiKey,
  seedance_api_key: seedanceApiKey,
}),
```

- [ ] **Step 2: Add provider and endpoint hint**

Modify `frontend/app/pages/settings.vue`:

```ts
const providers = ['ali', 'chatfire', 'eggfans', 'gemini', 'minimax', 'openai', 'openrouter', 'vidu', 'volcengine']
```

Add:

```ts
eggfans: '/v1',
```

to `endpointPrefixes`.

- [ ] **Step 3: Add Eggfans presets**

Modify `providerPresets`:

```ts
text: {
  eggfans: { label: 'Eggfans 推荐', baseUrl: 'https://api.eggfans.com', models: ['qwen3.7-max'] },
  chatfire: { label: 'ChatFire 推荐', baseUrl: 'https://api.chatfire.site', models: ['gemini-3-pro-preview'] },
  openrouter: { label: 'OpenRouter 推荐', baseUrl: 'https://openrouter.ai/api', models: ['google/gemini-3-flash-preview'] },
  openai: { label: 'OpenAI 推荐', baseUrl: 'https://api.openai.com', models: ['gpt-4.1-mini'] },
},
image: {
  eggfans: { label: 'Eggfans 推荐', baseUrl: 'https://api.eggfans.com', models: ['gpt-image-2'] },
  chatfire: { label: 'ChatFire 推荐', baseUrl: 'https://api.chatfire.site', models: ['doubao-seedream-4-5-251128'] },
  gemini: { label: 'Gemini 推荐', baseUrl: 'https://api.chatfire.site', models: ['gemini-3-pro-image-preview'] },
  volcengine: { label: '火山推荐', baseUrl: 'https://ark.cn-beijing.volces.com', models: ['doubao-seedream-4-0-250828'] },
},
video: {
  volcengine: { label: 'Seedance 2.0 官方', baseUrl: 'https://ark.cn-beijing.volces.com', models: ['doubao-seedance-2-0-pro-260215'] },
  eggfans: { label: 'Eggfans 视频', baseUrl: 'https://api.eggfans.com', models: ['happyhorse-1.0-i2v'] },
  vidu: { label: 'Vidu 推荐', baseUrl: 'https://api.vidu.com', models: ['viduq3-turbo'] },
  ali: { label: '阿里推荐', baseUrl: 'https://dashscope.aliyuncs.com', models: ['wan2.6-i2v-flash'] },
},
audio: {
  eggfans: { label: 'Eggfans 音频', baseUrl: 'https://api.eggfans.com', models: ['speech-2.8-hd'] },
  minimax: { label: 'Eggfans音频', baseUrl: 'https://api.chatfire.site/minimax', models: ['speech-2.8-hd'] },
},
```

- [ ] **Step 4: Add dynamic model loading state**

In `<script setup>`, import `eggfansModelAPI` where APIs are imported, then add:

```ts
const eggfansModels = ref({})
const eggfansModelsLoading = ref(false)

async function loadEggfansModels(type) {
  if (eggfansModels.value[type]) return
  eggfansModelsLoading.value = true
  try {
    const result = await eggfansModelAPI.list(type)
    eggfansModels.value[type] = result.models || []
  } catch (e) {
    toast.error(`Eggfans 模型加载失败：${e.message}`)
  } finally {
    eggfansModelsLoading.value = false
  }
}
```

- [ ] **Step 5: Load Eggfans models when selected**

Update `applyProviderPreset`:

```ts
function applyProviderPreset(type, provider) {
  const preset = providerPresets[type]?.[provider]
  if (!preset) return
  cfgForm.provider = provider
  cfgForm.base_url = preset.baseUrl
  cfgForm.modelStr = preset.models.join(', ')
  cfgForm.name = `${preset.label}-${serviceMeta[type].label}`
  if (provider === 'eggfans') loadEggfansModels(type)
}
```

- [ ] **Step 6: Add model select UI for Eggfans**

Inside the config modal near the existing model input, add:

```vue
<BaseSelect
  v-if="cfgForm.provider === 'eggfans'"
  :model-value="cfgForm.modelStr"
  :options="(eggfansModels[cfgForm.service_type] || []).map(m => ({
    label: `${m.name} · ${m.endpointTypes.join('/')}`,
    value: m.name,
  }))"
  :placeholder="eggfansModelsLoading ? '正在加载 Eggfans 模型' : '选择 Eggfans 模型'"
  searchable
  @update:model-value="value => { cfgForm.modelStr = value }"
/>
```

Keep the existing text input for non-Eggfans providers.

- [ ] **Step 7: Add Eggfans preset action**

Add a button beside the existing Eggfans preset button:

```vue
<button class="btn primary" @click="applyEggfansPreset">
  应用 Eggfans 聚合站配置
</button>
```

Add the handler:

```ts
async function applyEggfansPreset() {
  if (!eggfansForm.apiKey) {
    toast.warning('请填写 Eggfans API Key')
    return
  }
  try {
    await aiConfigAPI.eggfansPreset(eggfansForm.apiKey)
    await loadCfgs()
    presetDialog.value = false
    toast.success('Eggfans 配置已应用，Seedance 2.0 仍保留官方火山接口')
  } catch (e) {
    toast.error(e.message)
  }
}
```

- [ ] **Step 8: Build frontend**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/app/composables/useApi.ts frontend/app/pages/settings.vue
git commit -m "feat: add eggfans settings integration"
```

## Task 10: End-To-End Verification And Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add README setup section**

Add to `README.md`:

```md
## Eggfans 聚合站配置

项目支持把默认文本、图片、非 Seedance 视频和语音服务配置到 Eggfans 聚合站：

- Eggfans API Base URL: `https://api.eggfans.com`
- 模型目录来源: `https://eggfans.com/api/pricing_new`
- 文本模型使用 OpenAI 兼容接口 `/v1/chat/completions`
- 图片模型优先使用 `/v1/images/generations`
- HappyHorse 视频使用 `/alibailian/api/v1/services/aigc/video-generation/video-synthesis`
- MiniMax 同步语音使用 `/minimax/v1/t2a_v2`

Seedance 2.0 是例外：`doubao-seedance-2-*` / `doubao-seedance-2.0*` 继续使用火山官方接口：

- Provider: `volcengine`
- Base URL: `https://ark.cn-beijing.volces.com`
- Endpoint: `/api/v3/contents/generations/tasks`

这样可以把聚合站作为默认模型入口，同时保留 Seedance 2.0 官方链路的兼容性和稳定性。
```

- [ ] **Step 2: Run backend tests**

Run:

```bash
cd backend
npm test
```

Expected: all tests PASS.

- [ ] **Step 3: Run backend typecheck and build**

Run:

```bash
cd backend
npm run typecheck
npm run build
```

Expected: both PASS.

- [ ] **Step 4: Run frontend build**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS.

- [ ] **Step 5: Start stable single-service app**

Run:

```bash
screen -S eggfans-backend -X quit || true
screen -dmS eggfans-backend bash -lc 'cd /Users/xxx/Documents/火爆Eggfans/backend && npm start'
curl -sS http://localhost:5679/api/v1/health
```

Expected response includes:

```json
{"status":"ok"}
```

- [ ] **Step 6: Browser smoke check**

Open:

```text
http://localhost:5679/
```

Expected:

- Settings page loads without frontend errors.
- Eggfans appears in provider choices.
- Eggfans model list loads for text, image, video, and audio.
- Applying Eggfans preset creates four Eggfans configs plus one official VolcEngine Seedance 2.0 config if the preset route is used.
- Existing API keys are masked in list responses.

- [ ] **Step 7: Commit docs and final verification fixes**

```bash
git add README.md
git commit -m "docs: document eggfans provider setup"
```

## Acceptance Criteria

- `eggfans` is available as a provider for text, image, video, and audio.
- `https://eggfans.com/api/pricing_new` drives frontend model choices through a backend route.
- Eggfans text configs call `https://api.eggfans.com/v1`.
- Eggfans image requests use `https://api.eggfans.com/v1/images/generations`.
- Eggfans HappyHorse video requests use `https://api.eggfans.com/alibailian/api/v1/services/aigc/video-generation/video-synthesis`.
- Eggfans sync TTS requests use `https://api.eggfans.com/minimax/v1/t2a_v2`.
- Seedance 2.0 video models are not routed through Eggfans. They remain `provider=volcengine`, `base_url=https://ark.cn-beijing.volces.com`, endpoint `/api/v3/contents/generations/tasks`.
- Backend tests, backend typecheck, backend build, and frontend build pass.
- The app is available at `http://localhost:5679/` after implementation.

## Risks And Mitigations

- Eggfans docs include several endpoint families with similar names. Mitigation: route by `supported_endpoint_types` and add parser tests per family before enabling a model in the preset.
- TTS response format varies by endpoint. Mitigation: support hex and remote URL first; add binary response handling only when enabling OpenAI TTS.
- Video polling endpoint for OpenAI video format needs final confirmation from Apifox page response examples. Mitigation: HappyHorse/AliBailian is the first supported Eggfans video preset; OpenAI video route remains tested but not default until response fields are confirmed.
- Seedance naming may change. Mitigation: keep a regex-based official-provider guard for `doubao-seedance-2-*` and `doubao-seedance-2.0*`, and document the exception.

## Self-Review

- Spec coverage: The plan covers Eggfans replacement, current API chain, model catalog usage, per-service adapters, frontend settings, backend probes, tests, docs, and the explicit Seedance 2.0 official-interface exception.
- Placeholder scan: No step relies on unspecified TODO/TBD implementation. OpenAI video is deliberately marked non-default until docs response fields are confirmed.
- Type consistency: `EggfansServiceType`, `NormalizedEggfansModel`, `EggfansRoute`, and adapter method signatures match the existing adapter pattern and are reused consistently across tasks.
