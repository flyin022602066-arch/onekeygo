import { sanitizeApiLogPayload } from '~/utils/log-redaction'

const BASE = '/api/v1'

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    cache: method === 'GET' ? 'no-store' : 'default',
  }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', body ? sanitizeApiLogPayload(body) : '')

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const json = await resp.json()
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      throw new Error(json.message || `${resp.status}`)
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json.data ?? json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas'),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  generateTTS: (id: number, options?: { config_id?: number | null; model?: string | null }) => api.post(`/storyboards/${id}/generate-tts`, {
    config_id: options?.config_id || undefined,
    model: options?.model || undefined,
  }),
  del: (id: number) => api.del(`/storyboards/${id}`),
}

export const characterAPI = {
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  voiceSample: (id: number, episodeId: number, options?: { config_id?: number | null; model?: string | null }) => api.post(`/characters/${id}/generate-voice-sample`, {
    episode_id: episodeId,
    config_id: options?.config_id || undefined,
    model: options?.model || undefined,
  }),
  generateImage: (id: number, episodeId: number, options?: { config_id?: number | null; model?: string | null; size?: string | null }) => api.post(`/characters/${id}/generate-image`, {
    episode_id: episodeId,
    config_id: options?.config_id || undefined,
    model: options?.model || undefined,
    size: options?.size || undefined,
  }),
  batchImages: (ids: number[], episodeId: number, options?: { config_id?: number | null; model?: string | null; size?: string | null }) => api.post('/characters/batch-generate-images', {
    character_ids: ids,
    episode_id: episodeId,
    config_id: options?.config_id || undefined,
    model: options?.model || undefined,
    size: options?.size || undefined,
  }),
}

export const sceneAPI = {
  generateImage: (id: number, episodeId: number, options?: { config_id?: number | null; model?: string | null; size?: string | null }) => api.post(`/scenes/${id}/generate-image`, {
    episode_id: episodeId,
    config_id: options?.config_id || undefined,
    model: options?.model || undefined,
    size: options?.size || undefined,
  }),
}

export const imageAPI = {
  generate: (d: any) => api.post('/images', d),
  get: (id: number) => api.get(`/images/${id}`),
  retry: (id: number, options?: { config_id?: number | null; model?: string | null; size?: string | null; episode_id?: number | null }) => api.post(`/images/${id}/retry`, {
    config_id: options?.config_id || undefined,
    model: options?.model || undefined,
    size: options?.size || undefined,
    episode_id: options?.episode_id || undefined,
  }),
  list: (params?: { drama_id?: number; storyboard_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    return api.get(`/images${query.size ? `?${query.toString()}` : ''}`)
  },
}
export const gridAPI = {
  prompt: (d: any) => api.post('/grid/prompt', d),
  generate: (d: any) => api.post('/grid/generate', d),
  status: (id: number) => api.get(`/grid/status/${id}`),
  split: (d: any) => api.post('/grid/split', d),
}
export const assetAPI = {
  list: (params?: { drama_id?: number; provider?: string }) => {
    const query = new URLSearchParams()
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.provider) query.set('provider', params.provider)
    return api.get(`/assets${query.size ? `?${query.toString()}` : ''}`)
  },
  update: (id: number, data: any) => api.put(`/assets/${id}`, data),
  syncVolc: (references: any[], options?: { force?: boolean; drama_id?: number; episode_id?: number; group_name?: string }) => api.post('/assets/volc/sync', {
    references,
    force: options?.force === true,
    drama_id: options?.drama_id,
    episode_id: options?.episode_id,
    group_name: options?.group_name,
  }),
}
export const videoAPI = {
  generate: (d: any) => api.post('/videos', d),
  previewPrompt: (d: any) => api.post('/videos/preview-prompt', d),
  get: (id: number) => api.get(`/videos/${id}`),
  exportDesktop: (id: number) => api.post(`/videos/${id}/export-desktop`),
  list: (params?: { drama_id?: number; storyboard_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    return api.get(`/videos${query.size ? `?${query.toString()}` : ''}`)
  },
  startSequential: (d: any) => api.post('/videos/sequential', d),
  getSequentialByEpisode: (episodeId: number) => api.get(`/videos/sequential/episode/${episodeId}`),
  getSequential: (runId: number) => api.get(`/videos/sequential/${runId}`),
  retrySequential: (runId: number) => api.post(`/videos/sequential/${runId}/retry`),
  cancelSequential: (runId: number) => api.post(`/videos/sequential/${runId}/cancel`),
}
export const composeAPI = {
  shot: (id: number, options?: { audio_mode?: string; audioMode?: string; subtitle_mode?: string; subtitleMode?: string }) =>
    api.post(`/compose/storyboards/${id}/compose`, options),
  all: (epId: number, options?: { audio_mode?: string; audioMode?: string; subtitle_mode?: string; subtitleMode?: string }) =>
    api.post(`/compose/episodes/${epId}/compose-all`, options),
  status: (epId: number) => api.get(`/compose/episodes/${epId}/compose-status`),
}
export const mergeAPI = {
  merge: (epId: number) => api.post(`/merge/episodes/${epId}/merge`),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
  exportDesktop: (epId: number) => api.post(`/merge/episodes/${epId}/merge/export-desktop`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
  testExisting: (id: number) => api.post('/ai-configs/test', { id }),
  eggfansPreset: (apiKey: string, seedanceApiKey?: string, models?: Record<string, string>) => api.post('/ai-configs/eggfans-preset', {
    api_key: apiKey,
    seedance_api_key: seedanceApiKey,
    models,
  }),
}

export const preferenceAPI = {
  get: async <T = any>(key: string): Promise<T | null> => {
    try {
      const result = await api.get<{ value?: T }>(`/preferences/${encodeURIComponent(key)}`)
      return result?.value ?? null
    } catch (error: any) {
      // A missing preference is the normal first-run case.
      if (String(error?.message || '').toLowerCase().includes('not found')) return null
      throw error
    }
  },
  set: <T = any>(key: string, value: T) => api.put(`/preferences/${encodeURIComponent(key)}`, { value }),
}

export const agentAPI = {
  debug: (type: string) => api.get(`/agent/${encodeURIComponent(type)}/debug`),
}

export const eggfansModelAPI = {
  list: (serviceType?: string) => api.get(`/eggfans/models${serviceType ? `?service_type=${serviceType}` : ''}`),
}

export const mijingModelAPI = {
  list: (serviceType?: string, baseUrl?: string, configId?: number) => {
    const query = new URLSearchParams()
    if (serviceType) query.set('service_type', serviceType)
    if (baseUrl) query.set('base_url', baseUrl)
    if (configId) query.set('config_id', String(configId))
    return api.get(`/mijing/models${query.size ? `?${query.toString()}` : ''}`)
  },
}

export const agentConfigAPI = {
  list: () => api.get('/agent-configs'),
  get: (id: number) => api.get(`/agent-configs/${id}`),
  create: (d: any) => api.post('/agent-configs', d),
  update: (id: number, d: any) => api.put(`/agent-configs/${id}`, d),
  del: (id: number) => api.del(`/agent-configs/${id}`),
}

export const skillsAPI = {
  list: () => api.get('/skills'),
  get: (id: string) => api.get(`/skills/${id}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string) => api.put(`/skills/${id}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const voicesAPI = {
  list: (provider?: string) => api.get(`/ai-voices${provider ? `?provider=${provider}` : ''}`),
  sync: () => api.post('/ai-voices/sync', {}),
}
