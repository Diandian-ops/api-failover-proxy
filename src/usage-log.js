// 请求日志 / 用量统计
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.join(__dirname, '..', 'logs')

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

function logFile() {
  const d = new Date().toISOString().slice(0, 10)
  return path.join(LOG_DIR, `requests-${d}.jsonl`)
}

function usageFile() {
  const d = new Date().toISOString().slice(0, 10).slice(0, 7) // YYYY-MM
  return path.join(LOG_DIR, `usage-${d}.jsonl`)
}

/**
 * 记录一次请求
 */
export function logRequest(entry) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry
  }) + '\n'

  // 异步写入，不阻塞响应
  fs.appendFile(logFile(), line, err => {
    if (err) console.error('[usage] 写入日志失败:', err.message)
  })
}

/**
 * 记录用量统计（按天聚合）
 */
export function logUsage(entry) {
  const line = JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    ...entry
  }) + '\n'

  fs.appendFile(usageFile(), line, err => {
    if (err) console.error('[usage] 写入用量失败:', err.message)
  })
}

/**
 * 读取用量统计摘要
 */
export function getUsageSummary() {
  const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('usage-'))
  const summary = {}
  for (const f of files) {
    const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        const key = `${e.date}|${e.upstream}|${e.model}`
        if (!summary[key]) summary[key] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, fails: 0 }
        summary[key].requests += 1
        summary[key].inputTokens += e.inputTokens || 0
        summary[key].outputTokens += e.outputTokens || 0
        summary[key].cacheReadTokens += e.cacheReadTokens || 0
        summary[key].cacheCreationTokens += e.cacheCreationTokens || 0
        if (e.success === false) summary[key].fails += 1
      } catch {}
    }
  }
  return summary
}

/**
 * 清理过期日志文件（启动时调用）
 * - requests-YYYY-MM-DD.jsonl：保留 logRetentionDays 天
 * - usage-YYYY-MM.jsonl：保留 logRetentionMonths 个月
 * 不会删除 upstreams.db* / last-upstream.json 等非日志文件
 * 返回删除的文件数
 */
export function cleanupOldLogs(cfg = {}) {
  // 默认保留 30 天 / 6 个月；配置里显式给 0 才关闭清理
  const keepDays = cfg.logRetentionDays === undefined ? 30 : Number(cfg.logRetentionDays)
  const keepMonths = cfg.logRetentionMonths === undefined ? 6 : Number(cfg.logRetentionMonths)
  if ((keepDays <= 0 || isNaN(keepDays)) && (keepMonths <= 0 || isNaN(keepMonths))) return 0

  let removed = 0
  const now = Date.now()
  let files
  try { files = fs.readdirSync(LOG_DIR) } catch { return 0 }

  for (const f of files) {
    let cutoff = 0
    let match = f.match(/^requests-(\d{4})-(\d{2})-(\d{2})\.jsonl$/)
    if (match && keepDays > 0) {
      const d = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`)
      cutoff = now - keepDays * 86400000
      if (d.getTime() < cutoff) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); removed++ } catch {}
      }
      continue
    }
    match = f.match(/^usage-(\d{4})-(\d{2})\.jsonl$/)
    if (match && keepMonths > 0) {
      // 按月首日计算
      const d = new Date(`${match[1]}-${match[2]}-01T00:00:00Z`)
      cutoff = now - keepMonths * 30 * 86400000
      if (d.getTime() < cutoff) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); removed++ } catch {}
      }
      continue
    }
  }
  return removed
}
