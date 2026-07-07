// 启动时自动同步 ~/.claude/settings.json 的 env 字段，确保 Claude Code 走本代理
// 只改 env 里的 5 个字段，其他字段（permissions/hooks/effortLevel 等）保留不动
// 容器环境（无 ~/.claude 或只读）下自动跳过
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { log } from './logger.js'

const SETTINGS_PATH = process.env.CLAUDE_SETTINGS_PATH ||
  path.join(os.homedir(), '.claude', 'settings.json')

// 期望 Claude Code 使用的模型名
// 用 glm-5.2（how88 原生模型名）—— Claude Code 对未知模型放行 auto 模式，
// 而对 claude-opus-4-20250514 等官方名反而可能限制 auto
const EXPECTED_MODELS = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.2'
}

export function syncClaudeSettings(config) {
  if (!config.gatewayKey) {
    log.info('[sync] 未配置 gatewayKey，跳过 settings.json 同步')
    return
  }

  // 容器/服务器环境禁用：通过 DISABLE_CLAUDE_SYNC=1 或 config.disableClaudeSync 开关
  if (process.env.DISABLE_CLAUDE_SYNC === '1' || config.disableClaudeSync) {
    log.info('[sync] 已禁用 settings.json 同步（容器/服务器模式）')
    return
  }

  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
  } catch {
    log.warn(`[sync] 读不到 ${SETTINGS_PATH}，跳过同步`)
    return
  }

  const expectedEnv = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.port}`,
    ANTHROPIC_AUTH_TOKEN: config.gatewayKey,
    ...EXPECTED_MODELS
  }

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
    log.info('[sync] settings.json env 已是预期值，无需同步')
    return
  }

  // 备份原文件
  const backupPath = SETTINGS_PATH + '.bak'
  try {
    fs.copyFileSync(SETTINGS_PATH, backupPath)
  } catch {}

  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2))
    // 挂载进容器时，容器内 root 写文件会把属主改成 root，本机用户改不动
    // 通过 SETTINGS_UID/SETTINGS_GID 传入本机属主，写完修回去
    const uid = process.env.SETTINGS_UID ? Number(process.env.SETTINGS_UID) : -1
    const gid = process.env.SETTINGS_GID ? Number(process.env.SETTINGS_GID) : -1
    if (uid >= 0 && gid >= 0) {
      try { fs.chownSync(SETTINGS_PATH, uid, gid) } catch {}
      try { fs.chownSync(backupPath, uid, gid) } catch {}
    }
    log.info(`[sync] 已同步 settings.json（备份: ${backupPath}）`)
    changes.forEach(c => log.info(`  - ${c}`))
    log.warn('[sync] 改动需重启 Claude Code 才生效')
  } catch (e) {
    log.error(`[sync] 写入 settings.json 失败: ${e.message}`)
  }
}
