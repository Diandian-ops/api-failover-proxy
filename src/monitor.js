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

// 今日统计：从所有请求日志聚合（不限制条数，真实总数）
router.get('/today-stats', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('requests-'))
      .sort().reverse()
    let total = 0, ok = 0, fail = 0, totalDur = 0, inTok = 0, outTok = 0, cacheRead = 0, cacheCreate = 0
    for (const f of files) {
      const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const e = JSON.parse(line)
          if (!e.timestamp || !e.timestamp.startsWith(today)) continue
          total++
          if (e.success) ok++; else fail++
          totalDur += e.duration || 0
          inTok += e.inputTokens || 0
          outTok += e.outputTokens || 0
          cacheRead += e.cacheReadTokens || 0
          cacheCreate += e.cacheCreationTokens || 0
        } catch {}
      }
    }
    const avg = total ? Math.round(totalDur / total) : 0
    const rate = total ? ((ok / total) * 100).toFixed(1) : '-'
    // 节省成本估算：命中部分按 0.1x（原 1x），即省 0.9x；写入按 1.25x（-0.25x）
    const saved = Math.round(cacheRead * 0.9 - cacheCreate * 0.25)
    res.json({ ok: true, today, total, ok, fail, rate, avgDuration: avg, inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreate, savedTokens: saved })
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
