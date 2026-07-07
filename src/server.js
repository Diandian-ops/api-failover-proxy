// Express 服务器入口
import express from 'express'
import config from './config.js'
import { log } from './logger.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { dispatch } from './dispatcher.js'
import { getUsageSummary } from './usage-log.js'
import { syncClaudeSettings } from './sync-claude-settings.js'
import adminRouter from './admin.js'
import monitorRouter from './monitor.js'

const app = express()
app.use(express.json({ limit: '10mb' }))

// 网页端管理界面（页面本身免鉴权，API 仍需 gatewayKey）
import { fileURLToPath as _fileURLToPath } from 'node:url'
import _path from 'node:path'
const __dirname = _path.dirname(_fileURLToPath(import.meta.url))
app.get('/admin', (req, res) => res.sendFile(_path.join(__dirname, '..', 'public', 'admin.html')))
app.get('/monitor', (req, res) => res.sendFile(_path.join(__dirname, '..', 'public', 'monitor.html')))
app.get('/dashboard', (req, res) => res.sendFile(_path.join(__dirname, '..', 'public', 'monitor.html')))
// 健康检查免鉴权，供 Docker healthcheck / 监控探测
app.get('/health', (req, res) => {
  res.json({ ok: true, upstreams: config.upstreams.map(u => ({ name: u.name, type: u.type })) })
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

app.listen(config.port, config.host, () => {
  log.info(`API Failover Proxy 启动`)
  log.info(`监听: http://${config.host}:${config.port}`)
  log.info(`上游数量: ${config.upstreams.length}`)
  config.upstreams.forEach(u => log.info(`  - ${u.name} (${u.type}) -> ${u.base}`))
  if (config.gatewayKey) log.info(`网关鉴权: 已启用`)
  else log.info(`网关鉴权: 未启用`)
  // 启动时自动同步 ~/.claude/settings.json，确保 Claude Code 走本代理
  syncClaudeSettings(config)
})
