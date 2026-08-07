import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '../..')

export type AppConfig = {
  projectRoot: string
  server: {
    port: number
    host: string
    corsOrigins: string[]
  }
  database: {
    path: string
  }
  storage: {
    localPath: string
    baseUrl: string
  }
}

type LoadConfigOptions = {
  configPath?: string
  projectRoot?: string
  env?: Record<string, string | undefined>
}

const DEFAULT_CORS_ORIGINS = ['http://localhost:3013', 'http://localhost:5679']

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT
  const env = options.env || process.env
  const configPath = options.configPath || env.CONFIG_PATH || path.join(projectRoot, 'configs/config.yaml')
  const rawConfig = readYamlConfig(configPath)

  const yamlServer = asRecord(rawConfig.server)
  const yamlDatabase = asRecord(rawConfig.database)
  const yamlStorage = asRecord(rawConfig.storage)
  const port = numberFrom(env.PORT, yamlServer.port, 5679)
  const host = stringFrom(env.HOST, yamlServer.host, '0.0.0.0')
  const corsOrigins = listFrom(env.CORS_ORIGINS, yamlServer.cors_origins, DEFAULT_CORS_ORIGINS)
  const dbPath = resolveProjectPath(projectRoot, stringFrom(env.DB_PATH, yamlDatabase.path, './data/eggfans_drama.db'))
  const storagePath = resolveProjectPath(projectRoot, stringFrom(env.STORAGE_PATH, yamlStorage.local_path, './data/static'))
  const baseUrl = stringFrom(env.STORAGE_BASE_URL, yamlStorage.base_url, `http://localhost:${port}/static`)

  return {
    projectRoot,
    server: { port, host, corsOrigins },
    database: { path: dbPath },
    storage: { localPath: storagePath, baseUrl },
  }
}

export const appConfig = loadConfig()

function readYamlConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {}
  const parsed = parse(fs.readFileSync(configPath, 'utf-8'))
  return asRecord(parsed)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringFrom(primary: unknown, secondary: unknown, fallback: string) {
  for (const value of [primary, secondary]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return fallback
}

function numberFrom(primary: unknown, secondary: unknown, fallback: number) {
  for (const value of [primary, secondary]) {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed
  }
  return fallback
}

function listFrom(primary: unknown, secondary: unknown, fallback: string[]) {
  const values = primary ?? secondary
  if (typeof values === 'string') {
    const items = values.split(',').map(item => item.trim()).filter(Boolean)
    if (items.length) return items
  }
  if (Array.isArray(values)) {
    const items = values.filter((item): item is string => typeof item === 'string' && !!item.trim())
      .map(item => item.trim())
    if (items.length) return items
  }
  return fallback
}

function resolveProjectPath(projectRoot: string, value: string) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value)
}
