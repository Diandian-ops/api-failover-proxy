// Claude Code settings.json 同步模块
// 提供手动开关：启用=把 Claude Code 指向本代理；禁用=从 .bak 恢复原始配置
// 默认不在启动时自动执行，由管理界面 / admin API 手动触发
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { log } from './logger.js'

const SETTINGS_PATH = process.env.CLAUDE_SETTINGS_PATH ||
  path.join(os.homedir(), '.claude', 'settings.json')
const BACKUP_PATH = SETTINGS_PATH + '.bak'

// 期望 Claude Code 使用的模型名
const EXPECTED_MODELS = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.2'
}

function getExpectedEnv(config) {
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.port}`,
    ANTHROPIC_AUTH_TOKEN: config.gatewayKey,
    ...EXPECTED_MODELS
  }
}

// 修复文件属主（容器内 root 写文件后把属主改回本机用户）
function fixOwnership(filePath) {
  const uid = process.env.SETTINGS_UID ? Number(process.env.SETTINGS_UID) : -1
  const gid = process.env.SETTINGS_GID ? Number(process.env.SETTINGS_GID) : -1
  if (uid >= 0 && gid >= 0) {
    try { fs.chownSync(filePath, uid, gid) } catch {}
  }
}

/**
 * 查询当前同步状态：settings.json 是否指向本代理
 */
export function getSyncStatus(config) {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    const env = settings.env || {}
    const expected = getExpectedEnv(config)
    const synced = Object.entries(expected).every(([k, v]) => env[k] === v)
    const hasBackup = fs.existsSync(BACKUP_PATH)
    return {
      available: true,
      synced,
      hasBackup,
      path: SETTINGS_PATH,
      current: {
        ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || null,
        ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN ? '***' : null,
        ANTHROPIC_DEFAULT_OPUS_MODEL: env.ANTHROPIC_DEFAULT_OPUS_MODEL || null,
        ANTHROPIC_DEFAULT_SONNET_MODEL: env.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || null
      }
    }
  } catch {
    return { available: false, synced: false, hasBackup: false, path: SETTINGS_PATH }
  }
}

/**
 * 启用同步：把 Claude Code 的 settings.json 指向本代理
 * 会先备份原文件到 .bak
 */
export function syncClaudeSettings(config) {
  if (!config.gatewayKey) {
    return { ok: false, error: '未配置 gatewayKey，无法同步' }
  }

  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
  } catch {
    return { ok: false, error: `读不到 ${SETTINGS_PATH}` }
  }

  const expectedEnv = getExpectedEnv(config)
  const env = settings.env || (settings.env = {})
  let changed = false
  const changes = []

  for (const [k, v] of Object.entries(expectedEnv)) {
    if (env[k] !== v) {
      changes.push(`${k}: ${JSON.stringify(env[k])} → ${JSON.stringify(v)}`)
      env[k] = v
      changed = true
    }
  }

  if (!changed) {
    return { ok: true, alreadySynced: true, message: 'settings.json 已指向本代理，无需修改' }
  }

  // 备份原文件（如果还没有备份的话，避免覆盖最早的原始备份）
  let backupCreated = false
  if (!fs.existsSync(BACKUP_PATH)) {
    try {
      fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH)
      fixOwnership(BACKUP_PATH)
      backupCreated = true
    } catch (e) {
      log.warn(`[sync] 备份写入失败: ${e.message}（恢复功能将不可用）`)
      return { ok: false, error: `备份写入失败（${e.message}），已中止同步。请检查挂载目录是否可写。` }
    }
  } else {
    backupCreated = true
  }

  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2))
    fixOwnership(SETTINGS_PATH)
    log.info(`[sync] 已同步 settings.json（备份: ${BACKUP_PATH}）`)
    changes.forEach(c => log.info(`  - ${c}`))
    log.warn('[sync] 改动需重启 Claude Code 才生效')
    return { ok: true, changes }
  } catch (e) {
    return { ok: false, error: `写入失败: ${e.message}` }
  }
}

/**
 * 禁用同步：从 .bak 恢复原始 settings.json
 */
export function restoreClaudeSettings() {
  if (!fs.existsSync(BACKUP_PATH)) {
    return { ok: false, error: `无备份文件 ${BACKUP_PATH}，无法恢复` }
  }
  try {
    fs.copyFileSync(BACKUP_PATH, SETTINGS_PATH)
    fixOwnership(SETTINGS_PATH)
    log.info(`[sync] 已从备份恢复 settings.json`)
    log.warn('[sync] 改动需重启 Claude Code 才生效')
    return { ok: true, restored: true }
  } catch (e) {
    return { ok: false, error: `恢复失败: ${e.message}` }
  }
}
