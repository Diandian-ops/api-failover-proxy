// 监控路由：实时渠道、用量统计、最近请求、熔断状态
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getUsageSummary } from './usage-log.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.join(__dirname, '..', 'logs')

const router = Router()

// 最近一次请求用的上游/模型（从 last-upstream.json 读，若存在）
router.get('/last-upstream', (req, res) => {
  const f = path.join(LOG_DIR, 'last-upstream.json')
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'))
    res.json({ ok: true, ...data })
  } catch {
    res.json({ ok: false, message: '尚无请求记录' })
  }
})

// 用量统计（按 upstream×model 聚合）
router.get('/usage', (req, res) => {
  try {
    const summary = getUsageSummary()
    // 转成数组方便前端渲染
    const rows = Object.entries(summary).map(([key, v]) => {
      const [date, upstream, model] = key.split('|')
      return { date, upstream, model, ...v }
    }).sort((a, b) => b.date.localeCompare(a.date) || a.upstream.localeCompare(b.upstream))
    res.json({ ok: true, count: rows.length, rows })
  } catch (e) {
    res.status(500).json({ error: { message: e.message } })
  }
})

// 最近 N 条请求记录（默认 50）
router.get('/recent-requests', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500)
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('requests-'))
      .sort().reverse()
    const out = []
    for (const f of files) {
      if (out.length >= limit) break
      const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean).reverse()
      for (const line of lines) {
        try { out.push(JSON.parse(line)) } catch {}
        if (out.length >= limit) break
      }
    }
    res.json({ ok: true, count: out.length, requests: out })
  } catch (e) {
    res.status(500).json({ error: { message: e.message } })
  }
})

// 熔断器状态
router.get('/breakers', (req, res) => {
  const breaker = req.app.locals.breaker
  if (!breaker) return res.json({ ok: true, breakers: [] })
  res.json({ ok: true, breakers: breaker.snapshot() })
})

export default router
