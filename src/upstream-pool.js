// 号池管理：SQLite 存储 upstreams，支持运行时热加载
// DB 路径默认 ./logs/upstreams.db（也可通过 config.poolDb 指定）
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB = path.join(__dirname, '..', 'logs', 'upstreams.db')

let db = null
let dbPath = DEFAULT_DB

export function initPool(opts = {}) {
  dbPath = opts.path || DEFAULT_DB
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS upstreams (
      name        TEXT PRIMARY KEY,
      type        TEXT NOT NULL,             -- 'openai' | 'anthropic'
      base        TEXT NOT NULL,
      api_key     TEXT NOT NULL,
      weight      INTEGER NOT NULL DEFAULT 1,
      force_stream INTEGER NOT NULL DEFAULT 0,  -- 0/1
      enabled     INTEGER NOT NULL DEFAULT 1,   -- 0/1，禁用的不参与调度
      priority    INTEGER NOT NULL DEFAULT 100, -- 数字越小越优先
      same_retries INTEGER NOT NULL DEFAULT 2,  -- 同上游快速重试次数
      same_retry_backoff_ms INTEGER NOT NULL DEFAULT 800, -- 同上游重试退避间隔
      model_map   TEXT,                          -- JSON 字符串，{ 请求模型: 上游模型 }
      extra       TEXT,                          -- JSON 字符串，预留扩展
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `)
  // 兼容已有 DB：若字段不存在则添加
  for (const col of ['priority', 'same_retries', 'same_retry_backoff_ms']) {
    try { db.exec(`ALTER TABLE upstreams ADD COLUMN ${col} INTEGER NOT NULL DEFAULT ${col === 'priority' ? 100 : (col === 'same_retries' ? 2 : 800)}`) } catch {}
  }
  return db
}

function rowToUpstream(row) {
  const u = {
    name: row.name,
    type: row.type,
    base: row.base,
    apiKey: row.api_key,
    weight: row.weight || 1,
    forceStream: row.force_stream === 1,
    enabled: row.enabled === 1,
    priority: row.priority ?? 100,
    sameRetries: row.same_retries ?? 2,
    sameRetryBackoffMs: row.same_retry_backoff_ms ?? 800
  }
  if (row.model_map) {
    try { u.modelMap = JSON.parse(row.model_map) } catch { u.modelMap = {} }
  } else {
    u.modelMap = {}
  }
  if (row.extra) {
    try { Object.assign(u, JSON.parse(row.extra)) } catch {}
  }
  return u
}

// 加载所有 enabled=1 的上游（按 priority ASC，数字越小越优先）
export function loadUpstreams() {
  if (!db) initPool()
  const rows = db.prepare('SELECT * FROM upstreams WHERE enabled = 1 ORDER BY priority ASC, name ASC').all()
  return rows.map(rowToUpstream)
}

// 加载全部（含禁用的），管理用
export function loadAllUpstreams() {
  if (!db) initPool()
  const rows = db.prepare('SELECT * FROM upstreams ORDER BY priority ASC, name ASC').all()
  return rows.map(rowToUpstream)
}

// 新增或覆盖（按 name 主键）
export function upsertUpstream(u) {
  if (!db) initPool()
  const stmt = db.prepare(`
    INSERT INTO upstreams (name, type, base, api_key, weight, force_stream, enabled, priority, same_retries, same_retry_backoff_ms, model_map, extra)
    VALUES (@name, @type, @base, @api_key, @weight, @force_stream, @enabled, @priority, @same_retries, @same_retry_backoff_ms, @model_map, @extra)
    ON CONFLICT(name) DO UPDATE SET
      type=excluded.type, base=excluded.base, api_key=excluded.api_key,
      weight=excluded.weight, force_stream=excluded.force_stream,
      enabled=excluded.enabled, priority=excluded.priority,
      same_retries=excluded.same_retries, same_retry_backoff_ms=excluded.same_retry_backoff_ms,
      model_map=excluded.model_map, extra=excluded.extra
  `)
  stmt.run({
    name: u.name,
    type: u.type,
    base: u.base,
    api_key: u.apiKey,
    weight: u.weight || 1,
    force_stream: u.forceStream ? 1 : 0,
    enabled: u.enabled === false ? 0 : 1,
    priority: u.priority ?? 100,
    same_retries: u.sameRetries ?? 2,
    same_retry_backoff_ms: u.sameRetryBackoffMs ?? 800,
    model_map: u.modelMap && Object.keys(u.modelMap).length ? JSON.stringify(u.modelMap) : null,
    extra: u.extra ? JSON.stringify(u.extra) : null
  })
}

export function deleteUpstream(name) {
  if (!db) initPool()
  db.prepare('DELETE FROM upstreams WHERE name = ?').run(name)
}

export function toggleUpstream(name, enabled) {
  if (!db) initPool()
  db.prepare('UPDATE upstreams SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name)
}

export function getDbPath() {
  return dbPath
}
