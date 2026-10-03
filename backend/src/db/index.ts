import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import fs from 'fs'
import path from 'path'
import { appConfig } from '../config.js'

const DB_PATH = appConfig.database.path
const LEGACY_SEEDANCE_2_MODEL = 'doubao-seedance-2-0-pro-260215'
const CURRENT_SEEDANCE_2_MODEL = 'doubao-seedance-2-0-260128'
const OFFICIAL_VOLCENGINE_BASE_URL = 'https://ark.cn-beijing.volces.com'
const OFFICIAL_SEEDANCE_NAME = 'Seedance 2.0 官方视频'
const OFFICIAL_SEEDANCE_ENDPOINT = '/api/v3/contents/generations/tasks'
const OFFICIAL_SEEDANCE_QUERY_ENDPOINT = '/api/v3/contents/generations/tasks/{task_id}'
const OFFICIAL_SEEDANCE_PRIORITY = 108
const COMFYUI_DEFAULT_LORA = 'minimaxh3\\minimax_h3_turbo_v4_step600_ema.safetensors'
const COMFYUI_LEGACY_LORA = 'minimaxh3\\minimax_h3_turbo_v4_step600_ema.safetensors'

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const sqlite = new Database(DB_PATH, { timeout: 30000 })
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('busy_timeout = 30000')

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS dramas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    genre TEXT,
    style TEXT DEFAULT 'realistic',
    total_episodes INTEGER DEFAULT 1,
    total_duration INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    thumbnail TEXT,
    tags TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
     deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    script_content TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    video_url TEXT,
    thumbnail TEXT,
    image_config_id INTEGER,
    video_config_id INTEGER,
    audio_config_id INTEGER,
    dubbing_enabled INTEGER DEFAULT 0,
    breakdown_mode TEXT DEFAULT 'standard',
    breakdown_language TEXT DEFAULT 'zh',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT,
    role TEXT,
    description TEXT,
    appearance TEXT,
    personality TEXT,
    voice_style TEXT,
    image_url TEXT,
    reference_images TEXT,
    seed_value TEXT,
    sort_order INTEGER,
    local_path TEXT,
    voice_sample_url TEXT,
    voice_provider TEXT,
    volc_character_asset_id TEXT,
    volc_character_uri TEXT,
    volc_character_local_asset_id INTEGER,
    volc_character_synced_at TEXT,
    volc_character_sync_status TEXT,
    volc_character_sync_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER,
    location TEXT NOT NULL,
    aliases TEXT,
    time TEXT NOT NULL,
    prompt TEXT NOT NULL,
    storyboard_count INTEGER DEFAULT 1,
    image_url TEXT,
    status TEXT DEFAULT 'pending',
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS storyboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER,
    storyboard_number INTEGER NOT NULL,
    title TEXT,
    location TEXT,
    time TEXT,
    shot_type TEXT,
    angle TEXT,
    movement TEXT,
    action TEXT,
    result TEXT,
    atmosphere TEXT,
    image_prompt TEXT,
    video_prompt TEXT,
    bgm_prompt TEXT,
    sound_effect TEXT,
    dialogue TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    composed_image TEXT,
    first_frame_image TEXT,
    last_frame_image TEXT,
    reference_images TEXT,
    video_url TEXT,
    tts_audio_url TEXT,
    subtitle_url TEXT,
    composed_video_url TEXT,
    composed_video_generation_id INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS episode_characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_episode_characters_episode_id
    ON episode_characters (episode_id);
  CREATE INDEX IF NOT EXISTS idx_episode_characters_character_id
    ON episode_characters (character_id);

  CREATE TABLE IF NOT EXISTS episode_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_episode_scenes_episode_id
    ON episode_scenes (episode_id);
  CREATE INDEX IF NOT EXISTS idx_episode_scenes_scene_id
    ON episode_scenes (scene_id);

  CREATE TABLE IF NOT EXISTS episode_props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    prop_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_episode_props_episode_id
    ON episode_props (episode_id);
  CREATE INDEX IF NOT EXISTS idx_episode_props_prop_id
    ON episode_props (prop_id);

  CREATE TABLE IF NOT EXISTS storyboard_characters (
    storyboard_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, character_id)
  );
  CREATE INDEX IF NOT EXISTS idx_storyboard_characters_storyboard_id
    ON storyboard_characters (storyboard_id);
  CREATE INDEX IF NOT EXISTS idx_storyboard_characters_character_id
    ON storyboard_characters (character_id);

  CREATE TABLE IF NOT EXISTS ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,
    provider TEXT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT,
    endpoint TEXT,
    query_endpoint TEXT,
    priority INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    settings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_service_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    display_name TEXT,
    service_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    default_url TEXT,
    preset_models TEXT,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_voices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_id TEXT NOT NULL UNIQUE,
    voice_name TEXT NOT NULL,
    description TEXT,
    language TEXT,
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    model TEXT,
    system_prompt TEXT,
    temperature REAL,
    max_tokens INTEGER,
    max_iterations INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS image_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER,
    drama_id INTEGER,
    scene_id INTEGER,
    character_id INTEGER,
    prop_id INTEGER,
    image_type TEXT,
    frame_type TEXT,
    provider TEXT,
    prompt TEXT,
    negative_prompt TEXT,
    model TEXT,
    size TEXT,
    quality TEXT,
    style TEXT,
    steps INTEGER,
    cfg_scale REAL,
    seed INTEGER,
    image_url TEXT,
    minio_url TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'pending',
    task_id TEXT,
    error_msg TEXT,
    width INTEGER,
    height INTEGER,
    reference_images TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS video_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER,
    drama_id INTEGER,
    provider TEXT,
    prompt TEXT,
    final_prompt TEXT,
    prompt_is_final INTEGER DEFAULT 0,
    model TEXT,
    image_gen_id INTEGER,
    reference_mode TEXT,
    image_url TEXT,
    first_frame_url TEXT,
    last_frame_url TEXT,
    reference_image_urls TEXT,
    duration INTEGER,
    fps INTEGER,
    resolution TEXT,
    aspect_ratio TEXT,
    megapixels REAL,
    steps INTEGER,
    lora_strength REAL,
    style TEXT,
    motion_level INTEGER,
    camera_motion TEXT,
    seed INTEGER,
    video_url TEXT,
    minio_url TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'pending',
    task_id TEXT,
    error_msg TEXT,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
     completed_at TEXT,
     deleted_at TEXT,
     sequence_run_id INTEGER,
     sequence_step_index INTEGER,
     continuity_mode TEXT,
     latent_path TEXT,
     latent_clip_index INTEGER,
     reference_video_local_path TEXT
  );

  CREATE TABLE IF NOT EXISTS video_sequence_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    config_id INTEGER,
    aspect_ratio TEXT,
    megapixels REAL,
     sampling_steps INTEGER,
     lora_strength REAL,
     continuity_mode TEXT NOT NULL DEFAULT 'standard_r2v',
    status TEXT NOT NULL DEFAULT 'queued',
    current_index INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    current_storyboard_id INTEGER,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
     completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS video_sequence_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    storyboard_id INTEGER NOT NULL,
    step_index INTEGER NOT NULL,
    storyboard_number INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    video_generation_id INTEGER,
    first_frame_local_path TEXT,
    first_frame_url TEXT,
    first_frame_asset_id TEXT,
    first_frame_asset_uri TEXT,
    tail_frame_local_path TEXT,
    tail_frame_url TEXT,
     tail_frame_asset_id TEXT,
     tail_frame_asset_uri TEXT,
     continuity_reference_local_path TEXT,
     continuity_reference_url TEXT,
     continuity_reference_asset_id TEXT,
     continuity_reference_asset_uri TEXT,
     asset_ids TEXT,
    asset_refs TEXT,
    reference_image_urls TEXT,
    prompt TEXT,
     error_msg TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     completed_at TEXT,
     latent_path TEXT,
     latent_clip_index INTEGER
  );

  CREATE TABLE IF NOT EXISTS video_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER,
    drama_id INTEGER,
    title TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    scenes TEXT,
    merged_url TEXT,
    duration INTEGER,
    task_id TEXT,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT,
    type TEXT,
    description TEXT,
    prompt TEXT,
    image_url TEXT,
    reference_images TEXT,
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER,
    episode_id INTEGER,
    storyboard_id INTEGER,
    storyboard_num INTEGER,
    name TEXT,
    description TEXT,
    type TEXT,
    category TEXT,
    url TEXT,
    thumbnail_url TEXT,
    local_path TEXT,
    file_size INTEGER,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    duration INTEGER,
    format TEXT,
    image_gen_id INTEGER,
    video_gen_id INTEGER,
    provider TEXT,
    provider_asset_id TEXT,
    asset_uri TEXT,
    provider_group_id TEXT,
    local_group_id TEXT,
    group_name TEXT,
    source TEXT,
    source_url TEXT,
    project_name TEXT,
    status TEXT,
    media_type TEXT,
    provider_url TEXT,
    expire_time TEXT,
    expire_time_desc TEXT,
    preview_cached_key TEXT,
    is_favorite INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
`)

function ensureColumn(table: string, column: string, definition: string) {
  const tableExists = sqlite.prepare(
    `SELECT 1 as ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
  ).get(table) as { ok: number } | undefined
  if (!tableExists) return
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some(col => col.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

ensureColumn('episodes', 'image_config_id', 'INTEGER')
ensureColumn('video_sequence_runs', 'aspect_ratio', 'TEXT')
ensureColumn('video_sequence_runs', 'megapixels', 'REAL')
ensureColumn('video_sequence_runs', 'sampling_steps', 'INTEGER')
ensureColumn('video_sequence_runs', 'lora_strength', 'REAL')
ensureColumn('video_sequence_runs', 'continuity_mode', "TEXT NOT NULL DEFAULT 'standard_r2v'")
  ensureColumn('video_sequence_steps', 'latent_path', 'TEXT')
  ensureColumn('video_sequence_steps', 'latent_clip_index', 'INTEGER')
  ensureColumn('video_sequence_steps', 'continuity_reference_local_path', 'TEXT')
  ensureColumn('video_sequence_steps', 'continuity_reference_url', 'TEXT')
  ensureColumn('video_sequence_steps', 'continuity_reference_asset_id', 'TEXT')
  ensureColumn('video_sequence_steps', 'continuity_reference_asset_uri', 'TEXT')
ensureColumn('video_generations', 'sequence_run_id', 'INTEGER')
ensureColumn('video_generations', 'sequence_step_index', 'INTEGER')
ensureColumn('video_generations', 'continuity_mode', 'TEXT')
ensureColumn('video_generations', 'latent_path', 'TEXT')
ensureColumn('video_generations', 'latent_clip_index', 'INTEGER')
ensureColumn('video_generations', 'reference_video_local_path', 'TEXT')
ensureColumn('video_generations', 'lora_strength', 'REAL')
ensureColumn('episodes', 'video_config_id', 'INTEGER')
ensureColumn('episodes', 'audio_config_id', 'INTEGER')
ensureColumn('episodes', 'dubbing_enabled', 'INTEGER DEFAULT 0')
ensureColumn('episodes', 'breakdown_mode', "TEXT DEFAULT 'standard'")
ensureColumn('episodes', 'breakdown_language', "TEXT DEFAULT 'zh'")
ensureColumn('scenes', 'aliases', 'TEXT')
ensureColumn('image_generations', 'prop_id', 'INTEGER')
ensureColumn('characters', 'volc_character_asset_id', 'TEXT')
ensureColumn('characters', 'aliases', 'TEXT')
ensureColumn('characters', 'volc_character_uri', 'TEXT')
ensureColumn('characters', 'volc_character_local_asset_id', 'INTEGER')
ensureColumn('characters', 'volc_character_synced_at', 'TEXT')
ensureColumn('characters', 'volc_character_sync_status', 'TEXT')
ensureColumn('characters', 'volc_character_sync_error', 'TEXT')
ensureColumn('video_generations', 'final_prompt', 'TEXT')
ensureColumn('video_generations', 'prompt_is_final', 'INTEGER DEFAULT 0')
ensureColumn('video_generations', 'megapixels', 'REAL')
ensureColumn('video_generations', 'steps', 'INTEGER')
ensureColumn('video_generations', 'reference_audio_urls', 'TEXT')
ensureColumn('storyboards', 'composed_video_generation_id', 'INTEGER')
ensureColumn('assets', 'provider', 'TEXT')
ensureColumn('assets', 'provider_asset_id', 'TEXT')
ensureColumn('assets', 'asset_uri', 'TEXT')
ensureColumn('assets', 'provider_group_id', 'TEXT')
ensureColumn('assets', 'local_group_id', 'TEXT')
ensureColumn('assets', 'group_name', 'TEXT')
ensureColumn('assets', 'source', 'TEXT')
ensureColumn('assets', 'source_url', 'TEXT')
ensureColumn('assets', 'project_name', 'TEXT')
ensureColumn('assets', 'status', 'TEXT')
ensureColumn('assets', 'media_type', 'TEXT')
ensureColumn('assets', 'provider_url', 'TEXT')
ensureColumn('assets', 'expire_time', 'TEXT')
ensureColumn('assets', 'expire_time_desc', 'TEXT')
ensureColumn('assets', 'preview_cached_key', 'TEXT')
ensureColumn('props', 'aliases', 'TEXT')

sqlite.prepare(`
  UPDATE ai_service_configs
  SET model = ?, updated_at = ?
  WHERE service_type = 'video'
    AND provider = 'volcengine'
    AND model = ?
`).run(JSON.stringify([CURRENT_SEEDANCE_2_MODEL]), new Date().toISOString(), JSON.stringify([LEGACY_SEEDANCE_2_MODEL]))

ensureOfficialSeedanceConfig()
upgradeLegacyComfyUiSettings()

export const db = drizzle(sqlite, { schema })
export { schema }
export type DB = typeof db

function upgradeLegacyComfyUiSettings() {
  const rows = sqlite.prepare(`
    SELECT id, settings
    FROM ai_service_configs
    WHERE service_type = 'video'
      AND provider = 'comfyui'
  `).all() as Array<{ id: number; settings?: string | null }>
  const update = sqlite.prepare(`
    UPDATE ai_service_configs
    SET settings = ?, updated_at = ?
    WHERE id = ?
  `)
  for (const row of rows) {
    let settings: Record<string, any>
    try {
      settings = row.settings ? JSON.parse(row.settings) : {}
    } catch {
      continue
    }
    const comfyui = settings.comfyui && typeof settings.comfyui === 'object'
      ? { ...settings.comfyui }
      : {}
    const legacyDefaults = comfyui.lowVram === true
      && (comfyui.clipDevice == null || comfyui.clipDevice === 'cpu')
      && (!comfyui.lora || comfyui.lora === COMFYUI_LEGACY_LORA)
    if (!legacyDefaults) continue
    comfyui.lowVram = false
    comfyui.clipDevice = 'default'
    comfyui.lora = COMFYUI_DEFAULT_LORA
    settings.comfyui = comfyui
    update.run(JSON.stringify(settings), new Date().toISOString(), row.id)
  }
}

function ensureOfficialSeedanceConfig() {
  const ts = new Date().toISOString()
  const modelJson = JSON.stringify([CURRENT_SEEDANCE_2_MODEL])
  const metadata = buildOfficialSeedanceSettings()
  const existing = sqlite.prepare(`
    SELECT id, api_key
    FROM ai_service_configs
    WHERE service_type = 'video'
      AND provider = 'volcengine'
      AND model = ?
    LIMIT 1
  `).get(modelJson) as { id: number; api_key?: string | null } | undefined

  if (existing) {
    sqlite.prepare(`
      UPDATE ai_service_configs
      SET name = ?,
          base_url = ?,
          endpoint = ?,
          query_endpoint = ?,
          priority = ?,
          settings = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      OFFICIAL_SEEDANCE_NAME,
      OFFICIAL_VOLCENGINE_BASE_URL,
      OFFICIAL_SEEDANCE_ENDPOINT,
      OFFICIAL_SEEDANCE_QUERY_ENDPOINT,
      OFFICIAL_SEEDANCE_PRIORITY,
      metadata,
      ts,
      existing.id,
    )
    return
  }

  sqlite.prepare(`
    INSERT INTO ai_service_configs (
      service_type,
      provider,
      name,
      base_url,
      api_key,
      model,
      endpoint,
      query_endpoint,
      priority,
      is_default,
      is_active,
      settings,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'video',
    'volcengine',
    OFFICIAL_SEEDANCE_NAME,
    OFFICIAL_VOLCENGINE_BASE_URL,
    '',
    modelJson,
    OFFICIAL_SEEDANCE_ENDPOINT,
    OFFICIAL_SEEDANCE_QUERY_ENDPOINT,
    OFFICIAL_SEEDANCE_PRIORITY,
    0,
    1,
    metadata,
    ts,
    ts,
  )
}

function buildOfficialSeedanceSettings() {
  return JSON.stringify({
    seedance: {
      official: true,
      provider: 'volcengine',
      modelName: CURRENT_SEEDANCE_2_MODEL,
      requestPath: OFFICIAL_SEEDANCE_ENDPOINT,
      queryPath: OFFICIAL_SEEDANCE_QUERY_ENDPOINT,
      transmissionParameters: {
        requestShape: 'VolcEngine Seedance 2.0 content generation task',
        requiredFields: ['model', 'content'],
        optionalFields: ['duration', 'ratio', 'generate_audio', 'watermark'],
      },
      defaults: {
        generate_audio: true,
        watermark: false,
        ratio: 'adaptive',
      },
      duration: {
        min: 4,
        max: 12,
        default: 5,
      },
      referenceMode: 'Use uploaded Volc asset IDs in prompt text with @asset://...',
    },
  })
}
