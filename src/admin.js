// 管理路由：热加载号池、增删改查上游
// 所有 /admin/* 路由需要网关鉴权（复用 server.js 的 gatewayKey 中间件）
import { Router } from 'express'
import { log } from './logger.js'
import {
  loadUpstreams,
  loadAllUpstreams,
  upsertUpstream,
  upsertUpstreamsBatch,
  validateUpstream,
  deleteUpstream,
  toggleUpstream,
  getDbPath
} from './upstream-pool.js'
import { detectAllPlatforms, syncPlatform, restorePlatform, getSyncStatus, syncClaudeSettings, restoreClaudeSettings } from './sync-client-config.js'

const router = Router()

// 热加载核心：重新从 DB 读取 enabled 上游，原地替换运行中的 config.upstreams
// 返回 { ok, count, skipped }：
//   ok=true  → 已刷新，count 为新上游数
//   ok=false → 空池保护触发（skipped=true），内存保留旧列表不变
// 写路由（增/删/启停）写完 DB 后调用本函数，使 DB 成为唯一数据源、改动立即生效
function applyReload(app) {
  const fresh = loadUpstreams()
  if (fresh.length === 0) {
    log.warn('[admin] DB 中无 enabled 上游，拒绝热加载（内存保留旧列表）')
    return { ok: false, count: 0, skipped: true }
  }
  app.locals.config.upstreams = fresh
  log.info(`[admin] 热加载完成，上游数量: ${fresh.length}`)
  fresh.forEach(u => log.info(`  - ${u.name} (${u.type}) -> ${u.base}`))
  return { ok: true, count: fresh.length, skipped: false }
}

// 手动热加载入口
// 用法：POST /admin/reload  body: { gatewayKey: "xxx" }（或通过 Authorization 头）
router.post('/reload', (req, res) => {
  try {
    const r = applyReload(req.app)
    if (r.skipped) {
      return res.status(400).json({ error: { message: 'DB 中无 enabled 上游，拒绝热加载（避免清空）' } })
    }
    const fresh = req.app.locals.config.upstreams
    res.json({ ok: true, count: r.count, upstreams: fresh.map(u => ({ name: u.name, type: u.type, base: u.base })) })
  } catch (e) {
    log.error('[admin] 热加载失败:', e.message)
    res.status(500).json({ error: { message: e.message } })
  }
})

// 列出所有上游（含禁用的）
router.get('/upstreams', (req, res) => {
  const all = loadAllUpstreams()
  res.json({ ok: true, db: getDbPath(), count: all.length, upstreams: all })
})

// 新增/覆盖上游
// body: { name, type, base, apiKey, weight?, forceStream?, enabled?, priority?, sameRetries?, sameRetryBackoffMs?, modelMap? }
router.post('/upstreams', (req, res) => {
  const b = req.body || {}
  if (!b.name || !b.type || !b.base || !b.apiKey) {
    return res.status(400).json({ error: { message: '缺少必填字段: name, type, base, apiKey' } })
  }
  if (!['openai', 'anthropic'].includes(b.type)) {
    return res.status(400).json({ error: { message: 'type 必须是 openai 或 anthropic' } })
  }
  try {
    upsertUpstream({
      name: b.name,
      type: b.type,
      base: b.base,
      apiKey: b.apiKey,
      weight: b.weight || 1,
      forceStream: !!b.forceStream,
      enabled: b.enabled !== false,
      priority: b.priority ?? 100,
      sameRetries: b.sameRetries ?? 2,
      sameRetryBackoffMs: b.sameRetryBackoffMs ?? 800,
      modelMap: b.modelMap || {}
    })
    log.info(`[admin] 上游已保存: ${b.name} (priority=${b.priority ?? 100}, sameRetries=${b.sameRetries ?? 2})`)
    const r = applyReload(req.app)
    res.json({
      ok: true,
      name: b.name,
      reloaded: r.ok,
      upstreamCount: r.count,
      ...(r.skipped && { warning: 'DB 中无 enabled 上游，内存保留旧列表' })
    })
  } catch (e) {
    res.status(500).json({ error: { message: e.message } })
  }
})

// 批量新增/覆盖上游（事务，任一校验失败整批拒绝，不部分导入）
// body: { upstreams: [{ name, type, base, apiKey, weight?, forceStream?, enabled?, priority?, sameRetries?, sameRetryBackoffMs?, modelMap? }] }
//      或直接传数组 [...]
router.post('/upstreams/batch', (req, res) => {
  let list = Array.isArray(req.body) ? req.body : req.body?.upstreams
  if (!Array.isArray(list) || list.length === 0) {
    return res.status(400).json({ error: { message: 'body 需为 { upstreams: [...] } 或顶层数组，且非空' } })
  }
  // 预检：逐条校验必填字段，收集错误（不落盘）
  const errors = []
  const valid = []
  list.forEach((b, i) => {
    const v = validateUpstream(b)
    if (!v.ok) errors.push({ index: i, name: (b && b.name) || '(空)', msg: v.msg })
    else valid.push(v.upstream)
  })
  if (errors.length) {
    return res.status(400).json({
      ok: false,
      error: { message: `${errors.length}/${list.length} 条校验失败，已拒绝整批导入` },
      errors,
      validCount: valid.length,
      totalCount: list.length
    })
  }
  try {
    upsertUpstreamsBatch(valid)
    log.info(`[admin] 批量导入完成: ${valid.length} 条`)
    const r = applyReload(req.app)
    res.json({
      ok: true,
      imported: valid.length,
      reloaded: r.ok,
      upstreamCount: r.count,
      ...(r.skipped && { warning: 'DB 中无 enabled 上游，内存保留旧列表' })
    })
  } catch (e) {
    log.error('[admin] 批量导入失败:', e.message)
    res.status(500).json({ error: { message: e.message } })
  }
})

// 删除上游
router.delete('/upstreams/:name', (req, res) => {
  try {
    deleteUpstream(req.params.name)
    log.info(`[admin] 上游已删除: ${req.params.name}`)
    const r = applyReload(req.app)
    res.json({
      ok: true,
      deleted: req.params.name,
      reloaded: r.ok,
      upstreamCount: r.count,
      ...(r.skipped && { warning: 'DB 中无 enabled 上游，内存保留旧列表' })
    })
  } catch (e) {
    res.status(500).json({ error: { message: e.message } })
  }
})

// 启用/禁用上游
router.patch('/upstreams/:name', (req, res) => {
  const enabled = req.body?.enabled
  if (enabled === undefined) {
    return res.status(400).json({ error: { message: 'body 需提供 enabled (true/false)' } })
  }
  try {
    toggleUpstream(req.params.name, !!enabled)
    log.info(`[admin] 上游 ${req.params.name} ${enabled ? '已启用' : '已禁用'}`)
    const r = applyReload(req.app)
    res.json({
      ok: true,
      name: req.params.name,
      enabled: !!enabled,
      reloaded: r.ok,
      upstreamCount: r.count,
      ...(r.skipped && { warning: 'DB 中无 enabled 上游，内存保留旧列表' })
    })
  } catch (e) {
    res.status(500).json({ error: { message: e.message } })
  }
})

// Claude Code settings.json 同步控制
// 查询状态：GET /admin/claude-sync
// 启用同步：POST /admin/claude-sync { action: 'sync' }
// 禁用同步（恢复备份）：POST /admin/claude-sync { action: 'restore' }
router.get('/claude-sync', (req, res) => {
  try {
    const status = getSyncStatus(req.app.locals.config)
    res.json({ ok: true, ...status })
  } catch (e) {
    res.status(500).json({ error: { message: e.message } })
  }
})

router.post('/claude-sync', (req, res) => {
  const action = req.body?.action
  if (!['sync', 'restore'].includes(action)) {
    return res.status(400).json({ error: { message: "action 必须是 'sync' 或 'restore'" } })
  }
  try {
    const result = action === 'sync'
      ? syncClaudeSettings(req.app.locals.config)
      : restoreClaudeSettings()
    if (!result.ok) {
      return res.status(400).json({ error: { message: result.error } })
    }
    log.info(`[admin] Claude Code 同步 ${action} 完成`)
    res.json({ ok: true, action, ...result })
  } catch (e) {
    res.status(500).json({ error: { message: e.message } })
  }
})

// 多平台客户端配置同步
// 查询所有平台状态：GET /admin/client-config
// 单平台操作：POST /admin/client-config/:platform { action: 'sync' | 'restore' }
router.get('/client-config', (req, res) => {
  try {
    const platforms = detectAllPlatforms(req.app.locals.config)
    res.json({ ok: true, platforms })
  } catch (e) {
    res.status(500).json({ error: { message: e.message } })
  }
})

router.post('/client-config/:platform', (req, res) => {
  const action = req.body?.action
  if (!['sync', 'restore'].includes(action)) {
    return res.status(400).json({ error: { message: "action 必须是 'sync' 或 'restore'" } })
  }
  try {
    const result = action === 'sync'
      ? syncPlatform(req.params.platform, req.app.locals.config)
      : restorePlatform(req.params.platform)
    if (!result.ok) {
      return res.status(400).json({ error: { message: result.error } })
    }
    log.info(`[admin] ${req.params.platform} 同步 ${action} 完成`)
    res.json({ ok: true, platform: req.params.platform, action, ...result })
  } catch (e) {
    res.status(500).json({ error: { message: e.message } })
  }
})

export default router
