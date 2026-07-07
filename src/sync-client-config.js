// 客户端配置同步模块：支持多平台统一控制
// 平台：claude-code / codex / opencode / continue / cursor / aider
// 默认不在启动时自动执行，由管理界面 / admin API 手动触发
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { log } from './logger.js'

// ── 通用工具 ──

function fixOwnership(filePath) {
  const uid = process.env.SETTINGS_UID ? Number(process.env.SETTINGS_UID) : -1
  const gid = process.env.SETTINGS_GID ? Number(process.env.SETTINGS_GID) : -1
  if (uid >= 0 && gid >= 0) {
    try { fs.chownSync(filePath, uid, gid) } catch {}
  }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  fixOwnership(p)
}

function backupIfNeeded(src, bak) {
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(src, bak)
    fixOwnership(bak)
  }
}

// ── Claude Code ──
const CLAUDE_PATH = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_BAK = CLAUDE_PATH + '.bak'
const EXPECTED_MODELS = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.2'
}

function claudeExpected(config) {
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.port}`,
    ANTHROPIC_AUTH_TOKEN: config.gatewayKey,
    ...EXPECTED_MODELS
  }
}

function claudeDetect() { return fs.existsSync(CLAUDE_PATH) }

function claudeStatus(config) {
  const data = readJson(CLAUDE_PATH)
  if (!data) return { available: false }
  const env = data.env || {}
  const expected = claudeExpected(config)
  const synced = Object.entries(expected).every(([k, v]) => env[k] === v)
  return {
    available: true, synced,
    hasBackup: fs.existsSync(CLAUDE_BAK),
    path: CLAUDE_PATH,
    current: {
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || null,
      ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN ? '***' : null,
      ANTHROPIC_DEFAULT_OPUS_MODEL: env.ANTHROPIC_DEFAULT_OPUS_MODEL || null,
      ANTHROPIC_DEFAULT_SONNET_MODEL: env.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || null
    }
  }
}

function claudeSync(config) {
  if (!config.gatewayKey) return { ok: false, error: '未配置 gatewayKey' }
  const data = readJson(CLAUDE_PATH)
  if (!data) return { ok: false, error: `读不到 ${CLAUDE_PATH}` }
  const expected = claudeExpected(config)
  const env = data.env || (data.env = {})
  const changes = []
  for (const [k, v] of Object.entries(expected)) {
    if (env[k] !== v) { changes.push(`${k}: ${JSON.stringify(env[k])} → ${JSON.stringify(v)}`); env[k] = v }
  }
  if (!changes.length) return { ok: true, alreadySynced: true }
  try { backupIfNeeded(CLAUDE_PATH, CLAUDE_BAK) } catch (e) {
    return { ok: false, error: `备份失败: ${e.message}` }
  }
  try { writeJson(CLAUDE_PATH, data) } catch (e) { return { ok: false, error: `写入失败: ${e.message}` } }
  log.info(`[sync] Claude Code 已同步（备份: ${CLAUDE_BAK}）`)
  changes.forEach(c => log.info(`  - ${c}`))
  return { ok: true, changes }
}

function claudeRestore() {
  if (!fs.existsSync(CLAUDE_BAK)) return { ok: false, error: '无备份文件' }
  try { fs.copyFileSync(CLAUDE_BAK, CLAUDE_PATH); fixOwnership(CLAUDE_PATH); return { ok: true, restored: true } }
  catch (e) { return { ok: false, error: `恢复失败: ${e.message}` } }
}

// ── Codex (OpenAI CLI) ──
const CODEX_PATH = path.join(os.homedir(), '.codex', 'config.json')
const CODEX_BAK = CODEX_PATH + '.bak'

function codexDetect() { return fs.existsSync(CODEX_PATH) }

function codexStatus(config) {
  const data = readJson(CODEX_PATH)
  if (!data) return { available: false }
  const expectedUrl = `http://127.0.0.1:${config.port}`
  return {
    available: true,
    synced: data.api_base_url === expectedUrl && data.api_key === config.gatewayKey,
    hasBackup: fs.existsSync(CODEX_BAK),
    path: CODEX_PATH,
    current: {
      api_base_url: data.api_base_url || null,
      api_key: data.api_key ? '***' : null
    }
  }
}

function codexSync(config) {
  if (!config.gatewayKey) return { ok: false, error: '未配置 gatewayKey' }
  const data = readJson(CODEX_PATH)
  if (!data) return { ok: false, error: `读不到 ${CODEX_PATH}` }
  const expectedUrl = `http://127.0.0.1:${config.port}`
  const changes = []
  if (data.api_base_url !== expectedUrl) { changes.push(`api_base_url: ${JSON.stringify(data.api_base_url)} → ${JSON.stringify(expectedUrl)}`); data.api_base_url = expectedUrl }
  if (data.api_key !== config.gatewayKey) { changes.push(`api_key: *** → ***`); data.api_key = config.gatewayKey }
  if (!changes.length) return { ok: true, alreadySynced: true }
  try { backupIfNeeded(CODEX_PATH, CODEX_BAK) } catch (e) { return { ok: false, error: `备份失败: ${e.message}` } }
  try { writeJson(CODEX_PATH, data) } catch (e) { return { ok: false, error: `写入失败: ${e.message}` } }
  log.info(`[sync] Codex 已同步（备份: ${CODEX_BAK}）`)
  return { ok: true, changes }
}

function codexRestore() {
  if (!fs.existsSync(CODEX_BAK)) return { ok: false, error: '无备份文件' }
  try { fs.copyFileSync(CODEX_BAK, CODEX_PATH); fixOwnership(CODEX_PATH); return { ok: true, restored: true } }
  catch (e) { return { ok: false, error: `恢复失败: ${e.message}` } }
}

// ── OpenCode ──
const OPENCODE_PATH = path.join(os.homedir(), '.opencode', 'config.json')
const OPENCODE_BAK = OPENCODE_PATH + '.bak'

function opencodeDetect() { return fs.existsSync(OPENCODE_PATH) }

function opencodeStatus(config) {
  const data = readJson(OPENCODE_PATH)
  if (!data) return { available: false }
  const openai = data.openai || {}
  const expectedUrl = `http://127.0.0.1:${config.port}`
  return {
    available: true,
    synced: openai.base_url === expectedUrl && openai.api_key === config.gatewayKey,
    hasBackup: fs.existsSync(OPENCODE_BAK),
    path: OPENCODE_PATH,
    current: {
      base_url: openai.base_url || null,
      api_key: openai.api_key ? '***' : null
    }
  }
}

function opencodeSync(config) {
  if (!config.gatewayKey) return { ok: false, error: '未配置 gatewayKey' }
  const data = readJson(OPENCODE_PATH)
  if (!data) return { ok: false, error: `读不到 ${OPENCODE_PATH}` }
  const openai = data.openai || (data.openai = {})
  const expectedUrl = `http://127.0.0.1:${config.port}`
  const changes = []
  if (openai.base_url !== expectedUrl) { changes.push(`base_url: ${JSON.stringify(openai.base_url)} → ${JSON.stringify(expectedUrl)}`); openai.base_url = expectedUrl }
  if (openai.api_key !== config.gatewayKey) { changes.push(`api_key: *** → ***`); openai.api_key = config.gatewayKey }
  if (!changes.length) return { ok: true, alreadySynced: true }
  try { backupIfNeeded(OPENCODE_PATH, OPENCODE_BAK) } catch (e) { return { ok: false, error: `备份失败: ${e.message}` } }
  try { writeJson(OPENCODE_PATH, data) } catch (e) { return { ok: false, error: `写入失败: ${e.message}` } }
  log.info(`[sync] OpenCode 已同步（备份: ${OPENCODE_BAK}）`)
  return { ok: true, changes }
}

function opencodeRestore() {
  if (!fs.existsSync(OPENCODE_BAK)) return { ok: false, error: '无备份文件' }
  try { fs.copyFileSync(OPENCODE_BAK, OPENCODE_PATH); fixOwnership(OPENCODE_PATH); return { ok: true, restored: true } }
  catch (e) { return { ok: false, error: `恢复失败: ${e.message}` } }
}

// ── Continue ──
const CONTINUE_PATH = path.join(os.homedir(), '.continue', 'config.json')
const CONTINUE_BAK = CONTINUE_PATH + '.bak'

function continueDetect() { return fs.existsSync(CONTINUE_PATH) }

function continueStatus(config) {
  const data = readJson(CONTINUE_PATH)
  if (!data) return { available: false }
  // 找第一个 model 的 apiBase（简化处理）
  const models = data.models || []
  const first = models[0] || {}
  const expectedUrl = `http://127.0.0.1:${config.port}`
  return {
    available: true,
    synced: first.apiBase === expectedUrl && first.apiKey === config.gatewayKey,
    hasBackup: fs.existsSync(CONTINUE_BAK),
    path: CONTINUE_PATH,
    current: {
      apiBase: first.apiBase || null,
      apiKey: first.apiKey ? '***' : null,
      title: first.title || null
    }
  }
}

function continueSync(config) {
  if (!config.gatewayKey) return { ok: false, error: '未配置 gatewayKey' }
  const data = readJson(CONTINUE_PATH)
  if (!data) return { ok: false, error: `读不到 ${CONTINUE_PATH}` }
  const models = data.models || (data.models = [])
  if (!models.length) models.push({ provider: 'openai', title: 'api-failover-proxy' })
  const m = models[0]
  const expectedUrl = `http://127.0.0.1:${config.port}`
  const changes = []
  if (m.apiBase !== expectedUrl) { changes.push(`apiBase: ${JSON.stringify(m.apiBase)} → ${JSON.stringify(expectedUrl)}`); m.apiBase = expectedUrl }
  if (m.apiKey !== config.gatewayKey) { changes.push(`apiKey: *** → ***`); m.apiKey = config.gatewayKey }
  if (!changes.length) return { ok: true, alreadySynced: true }
  try { backupIfNeeded(CONTINUE_PATH, CONTINUE_BAK) } catch (e) { return { ok: false, error: `备份失败: ${e.message}` } }
  try { writeJson(CONTINUE_PATH, data) } catch (e) { return { ok: false, error: `写入失败: ${e.message}` } }
  log.info(`[sync] Continue 已同步（备份: ${CONTINUE_BAK}）`)
  return { ok: true, changes }
}

function continueRestore() {
  if (!fs.existsSync(CONTINUE_BAK)) return { ok: false, error: '无备份文件' }
  try { fs.copyFileSync(CONTINUE_BAK, CONTINUE_PATH); fixOwnership(CONTINUE_PATH); return { ok: true, restored: true } }
  catch (e) { return { ok: false, error: `恢复失败: ${e.message}` } }
}

// ── Cursor ──
// Cursor 配置文件可能是 ~/.cursor/settings.json 或 IDE 内 SQLite 存储
// 我们尝试读取 JSON 配置，如果不存在则标记为手动配置
const CURSOR_PATH = path.join(os.homedir(), '.cursor', 'settings.json')
const CURSOR_BAK = CURSOR_PATH + '.bak'

function cursorDetect() { return fs.existsSync(CURSOR_PATH) }

function cursorStatus(config) {
  const data = readJson(CURSOR_PATH)
  if (!data) return { available: false }
  const expectedUrl = `http://127.0.0.1:${config.port}`
  // Cursor 可能的字段名：openai.api_base 或 api_base
  const baseUrl = data.openai?.api_base || data.api_base || null
  const apiKey = data.openai?.api_key || data.api_key || null
  return {
    available: true,
    synced: baseUrl === expectedUrl && apiKey === config.gatewayKey,
    hasBackup: fs.existsSync(CURSOR_BAK),
    path: CURSOR_PATH,
    current: { api_base: baseUrl, api_key: apiKey ? '***' : null }
  }
}

function cursorSync(config) {
  if (!config.gatewayKey) return { ok: false, error: '未配置 gatewayKey' }
  const data = readJson(CURSOR_PATH)
  if (!data) return { ok: false, error: `读不到 ${CURSOR_PATH}` }
  const expectedUrl = `http://127.0.0.1:${config.port}`
  const changes = []
  // 优先改 openai 嵌套结构，如果不存在则改顶层
  if (data.openai) {
    if (data.openai.api_base !== expectedUrl) { changes.push(`openai.api_base: ${JSON.stringify(data.openai.api_base)} → ${JSON.stringify(expectedUrl)}`); data.openai.api_base = expectedUrl }
    if (data.openai.api_key !== config.gatewayKey) { changes.push(`openai.api_key: *** → ***`); data.openai.api_key = config.gatewayKey }
  } else {
    if (data.api_base !== expectedUrl) { changes.push(`api_base: ${JSON.stringify(data.api_base)} → ${JSON.stringify(expectedUrl)}`); data.api_base = expectedUrl }
    if (data.api_key !== config.gatewayKey) { changes.push(`api_key: *** → ***`); data.api_key = config.gatewayKey }
  }
  if (!changes.length) return { ok: true, alreadySynced: true }
  try { backupIfNeeded(CURSOR_PATH, CURSOR_BAK) } catch (e) { return { ok: false, error: `备份失败: ${e.message}` } }
  try { writeJson(CURSOR_PATH, data) } catch (e) { return { ok: false, error: `写入失败: ${e.message}` } }
  log.info(`[sync] Cursor 已同步（备份: ${CURSOR_BAK}）`)
  return { ok: true, changes }
}

function cursorRestore() {
  if (!fs.existsSync(CURSOR_BAK)) return { ok: false, error: '无备份文件' }
  try { fs.copyFileSync(CURSOR_BAK, CURSOR_PATH); fixOwnership(CURSOR_PATH); return { ok: true, restored: true } }
  catch (e) { return { ok: false, error: `恢复失败: ${e.message}` } }
}

// ── Aider ──
// Aider 无标准配置文件，主要靠环境变量或命令行参数
// 我们检测 ~/.aider/.env 是否存在，如不存在则提示手动配置
const AIDER_DIR = path.join(os.homedir(), '.aider')
const AIDER_ENV = path.join(AIDER_DIR, '.env')
const AIDER_BAK = AIDER_ENV + '.bak'

function aiderDetect() { return fs.existsSync(AIDER_DIR) || fs.existsSync(AIDER_ENV) }

function aiderStatus(config) {
  const expectedUrl = `http://127.0.0.1:${config.port}`
  // 读 ~/.aider/.env
  let envUrl = null, envKey = null
  try {
    const text = fs.readFileSync(AIDER_ENV, 'utf8')
    const urlMatch = text.match(/^OPENAI_API_BASE=(.+)$/m)
    const keyMatch = text.match(/^OPENAI_API_KEY=(.+)$/m)
    if (urlMatch) envUrl = urlMatch[1].trim()
    if (keyMatch) envKey = keyMatch[1].trim()
  } catch {}
  return {
    available: fs.existsSync(AIDER_ENV),
    synced: envUrl === expectedUrl && envKey === config.gatewayKey,
    hasBackup: fs.existsSync(AIDER_BAK),
    path: AIDER_ENV,
    current: { OPENAI_API_BASE: envUrl, OPENAI_API_KEY: envKey ? '***' : null },
    manual: true
  }
}

function aiderSync(config) {
  if (!config.gatewayKey) return { ok: false, error: '未配置 gatewayKey' }
  const expectedUrl = `http://127.0.0.1:${config.port}`
  let text = ''
  try { text = fs.readFileSync(AIDER_ENV, 'utf8') } catch {}
  const changes = []
  const setOrAdd = (key, val) => {
    const re = new RegExp(`^${key}=.+$`, 'm')
    if (re.test(text)) {
      if (!text.match(new RegExp(`^${key}=${val}$`, 'm'))) {
        changes.push(`${key}: ... → ${val}`)
        text = text.replace(re, `${key}=${val}`)
      }
    } else {
      changes.push(`${key}: (新增) → ${val}`)
      text += `\n${key}=${val}\n`
    }
  }
  setOrAdd('OPENAI_API_BASE', expectedUrl)
  setOrAdd('OPENAI_API_KEY', config.gatewayKey)
  if (!changes.length) return { ok: true, alreadySynced: true }
  try {
    if (!fs.existsSync(AIDER_DIR)) fs.mkdirSync(AIDER_DIR, { recursive: true })
    backupIfNeeded(AIDER_ENV, AIDER_BAK)
  } catch (e) { return { ok: false, error: `备份失败: ${e.message}` } }
  try { fs.writeFileSync(AIDER_ENV, text); fixOwnership(AIDER_ENV) } catch (e) { return { ok: false, error: `写入失败: ${e.message}` } }
  log.info(`[sync] Aider 已同步（备份: ${AIDER_BAK}）`)
  return { ok: true, changes }
}

function aiderRestore() {
  if (!fs.existsSync(AIDER_BAK)) return { ok: false, error: '无备份文件' }
  try { fs.copyFileSync(AIDER_BAK, AIDER_ENV); fixOwnership(AIDER_ENV); return { ok: true, restored: true } }
  catch (e) { return { ok: false, error: `恢复失败: ${e.message}` } }
}

// ── 平台注册表 ──

const PLATFORM_REGISTRY = {
  'claude-code': { name: 'Claude Code', detect: claudeDetect, status: claudeStatus, sync: claudeSync, restore: claudeRestore },
  'codex': { name: 'Codex', detect: codexDetect, status: codexStatus, sync: codexSync, restore: codexRestore },
  'opencode': { name: 'OpenCode', detect: opencodeDetect, status: opencodeStatus, sync: opencodeSync, restore: opencodeRestore },
  'continue': { name: 'Continue', detect: continueDetect, status: continueStatus, sync: continueSync, restore: continueRestore },
  'cursor': { name: 'Cursor', detect: cursorDetect, status: cursorStatus, sync: cursorSync, restore: cursorRestore },
  'aider': { name: 'Aider', detect: aiderDetect, status: aiderStatus, sync: aiderSync, restore: aiderRestore }
}

export function listPlatforms() {
  return Object.keys(PLATFORM_REGISTRY)
}

export function detectAllPlatforms(config) {
  return Object.entries(PLATFORM_REGISTRY).map(([id, p]) => {
    const detected = p.detect()
    const status = detected ? p.status(config) : { available: false }
    return { id, name: p.name, ...status }
  })
}

export function syncPlatform(id, config) {
  const p = PLATFORM_REGISTRY[id]
  if (!p) return { ok: false, error: `未知平台: ${id}` }
  if (!p.detect()) return { ok: false, error: `${p.name} 未安装（配置文件不存在）` }
  return p.sync(config)
}

export function restorePlatform(id) {
  const p = PLATFORM_REGISTRY[id]
  if (!p) return { ok: false, error: `未知平台: ${id}` }
  return p.restore()
}

// 向后兼容：原有 Claude Code 专用导出
export function getSyncStatus(config) { return claudeStatus(config) }
export function syncClaudeSettings(config) { return claudeSync(config) }
export function restoreClaudeSettings() { return claudeRestore() }
