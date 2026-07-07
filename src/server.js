// Express 服务器入口
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from './config.js'
import { log } from './logger.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { dispatch } from './dispatcher.js'
import { getUsageSummary, cleanupOldLogs } from './usage-log.js'
import { syncClaudeSettings } from './sync-claude-settings.js'
import adminRouter from './admin.js'
import monitorRouter from './monitor.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const version = pkg.version

const app = express()
app.use(express.json({ limit: '10mb' }))

// 网页端管理界面（页面本身免鉴权，API 仍需 gatewayKey）
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')))
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'monitor.html')))
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'monitor.html')))
// 健康检查免鉴权，供 Docker healthcheck / 监控探测
// liveness：进程存活即 ok，附带版本/运行时间/上游/熔断状态
app.get('/health', (req, res) => {
  const breaker = req.app.locals.breaker
  res.json({
    ok: true,
    version,
    uptime: Math.round(process.uptime()),
    upstreams: config.upstreams.map(u => ({ name: u.name, type: u.type })),
    breakers: breaker ? breaker.snapshot() : []
  })
})

// 就绪检查免鉴权：所有上游熔断或无上游时返回 503，供 K8s/负载均衡流量控制
app.get('/ready', (req, res) => {
  const breaker = req.app.locals.breaker
  if (!config.upstreams || config.upstreams.length === 0) {
    return res.status(503).json({ ready: false, reason: '无可用上游' })
  }
  // 是否所有上游都被熔断
  const allOpen = config.upstreams.every(u => breaker && breaker.isOpen(u.name))
  if (allOpen) {
    return res.status(503).json({ ready: false, reason: '所有上游均熔断' })
  }
  res.json({ ready: true, version, upstreams: config.upstreams.length })
})

// 网关鉴权中间件
app.use((req, res, next) => {
  if (config.gatewayKey) {
    const auth = req.headers['authorization'] || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    if (token !== config.gatewayKey) {
      return res.status(401).json({ error: { message: 'invalid gateway key', type: 'proxy_error' } })
    }
  }
  // 移除网关鉴权头，避免转发给上游
  delete req.headers['authorization']
  next()
})

// 请求总超时中间件
app.use((req, res, next) => {
  if (config.totalTimeout > 0) {
    req._timeout = setTimeout(() => {
      if (!res.headersSent) {
        log.warn(`[timeout] 请求总超时 ${req.path}`)
        res.status(504).json({ error: { message: 'gateway total timeout', type: 'proxy_error' } })
      }
    }, config.totalTimeout)
    res.on('finish', () => clearTimeout(req._timeout))
  }
  next()
})

// 健康检查（已移到鉴权中间件之前，此处删除）

// 用量统计
app.get('/usage', (req, res) => {
  try {
    const summary = getUsageSummary()
    res.json(summary)
  } catch (e) {
    res.status(500).json({ error: { message: e.message } })
  }
})

// 管理路由：热加载号池、增删改查上游（复用网关鉴权中间件）
app.locals.config = config
app.locals.breaker = null  // breaker 创建后赋值
app.use('/admin', adminRouter)
app.use('/monitor', monitorRouter)

// OpenAI 兼容路由
app.post('/v1/chat/completions', (req, res) => breakerWrap(req, res, '/v1/chat/completions'))
app.post('/chat/completions', (req, res) => breakerWrap(req, res, '/chat/completions'))

// Anthropic 兼容路由
app.post('/v1/messages', (req, res) => breakerWrap(req, res, '/v1/messages'))
app.post('/messages', (req, res) => breakerWrap(req, res, '/messages'))

// 兜底
app.use((req, res) => {
  log.warn(`[404] 未路由的请求: ${req.method} ${req.path}`)
  res.status(404).json({ error: { message: `not found: ${req.method} ${req.path}`, type: 'proxy_error' } })
})

// 全局错误处理
app.use((err, req, res, next) => {
  log.error('[server] 未捕获错误:', err.message)
  if (res.headersSent) return
  res.status(500).json({ error: { message: err.message, type: 'proxy_error' } })
})

const breaker = new CircuitBreaker(config.circuitBreaker)
app.locals.breaker = breaker

async function breakerWrap(req, res, path) {
  try {
    await dispatch(path, req, res, config, breaker)
  } catch (e) {
    log.error('[server] dispatch 异常:', e.message)
    if (!res.headersSent) {
      res.status(500).json({ error: { message: e.message, type: 'proxy_error' } })
    }
  }
}

const server = app.listen(config.port, config.host, () => {
  log.info(`API Failover Proxy v${version} 启动`)
  log.info(`监听: http://${config.host}:${config.port}`)
  log.info(`上游数量: ${config.upstreams.length}`)
  config.upstreams.forEach(u => log.info(`  - ${u.name} (${u.type}) -> ${u.base}`))
  if (config.gatewayKey) log.info(`网关鉴权: 已启用`)
  else log.info(`网关鉴权: 未启用`)
  // 启动时清理过期日志（请求日志按天、usage 按月）
  try {
    const removed = cleanupOldLogs(config)
    if (removed > 0) log.info(`已清理 ${removed} 个过期日志文件`)
  } catch (e) {
    log.warn(`日志清理失败（不影响启动）: ${e.message}`)
  }
  // 启动时自动同步 ~/.claude/settings.json，确保 Claude Code 走本代理
  syncClaudeSettings(config)
})

// 端口冲突等启动错误友好提示
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log.error(`端口 ${config.port} 已被占用，请改 PROXY_PORT 或停掉占用程序（lsof -ti:${config.port}）`)
    process.exit(1)
  }
  log.error('服务器错误:', e.message)
  process.exit(1)
})

// 优雅关闭：SIGTERM/SIGINT → 停接新请求 → 等存量结束 → 超时强退
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`收到 ${signal}，停止接收新请求，等待在途请求完成...`)
  // 10s 超时强制退出兜底
  const forceTimer = setTimeout(() => {
    log.warn('优雅关闭超时，强制退出')
    process.exit(1)
  }, 10000)
  forceTimer.unref?.()
  server.close(() => {
    clearTimeout(forceTimer)
    log.info('所有在途请求已完成，退出')
    process.exit(0)
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
