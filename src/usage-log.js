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
        if (!summary[key]) summary[key] = { requests: 0, inputTokens: 0, outputTokens: 0, fails: 0 }
        summary[key].requests += 1
        summary[key].inputTokens += e.inputTokens || 0
        summary[key].outputTokens += e.outputTokens || 0
        if (e.success === false) summary[key].fails += 1
      } catch {}
    }
  }
  return summary
}
