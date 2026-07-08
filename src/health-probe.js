// 上游健康探测：后台定时检测上游是否存活，提前发现故障
// 两种探测模式：
//   - light（后台探测）：GET /models，免费，仅判定网络连通；/models 的 401 视为"无法验证"
//     （部分网关不开放 /models 或鉴权方式不同），不误熔断
//   - real（手动连通性测试）：POST 转发端点最小请求（max_tokens:1），准确验证 key，耗 1-2 token
import { log } from './logger.js'
import { buildUpstreamRequest } from './upstream.js'

// light 模式探测用的鉴权头
export function probeHeaders(upstream) {
  const headers = { 'User-Agent': 'api-failover-proxy/health-probe' }
  if (upstream.type === 'openai') {
    headers['Authorization'] = `Bearer ${upstream.apiKey}`
  } else if (upstream.type === 'anthropic') {
    headers['x-api-key'] = upstream.apiKey
    headers['anthropic-version'] = '2023-06-01'
  }
  return headers
}

// light 模式探测 URL：/models 端点（标准、免费）
export function probeUrl(upstream) {
  return upstream.base.replace(/\/$/, '') + '/models'
}

// real 模式：挑一个测试用 model 名（优先 modelMap 实际模型，其次请求名，最后协议默认）
function pickTestModel(upstream) {
  const mm = upstream.modelMap || {}
  const vals = Object.values(mm)
  if (vals.length) return vals[0]
  const keys = Object.keys(mm)
  if (keys.length) return keys[0]
  return upstream.type === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gpt-3.5-turbo'
}

// 对单个上游探测，返回结构化结果（无副作用，不碰熔断器）
// mode: 'light'（后台，GET /models）| 'real'（手动，POST 最小请求）
// 返回 { reachable, status, authOk, latencyMs, message }
//   - reachable: 网络层是否通
//   - authOk:    true=有效；false=失效(仅 real 模式 401/403)；null=无法验证
export async function probeUpstream(upstream, timeoutMs = 8000, mode = 'light') {
  const start = Date.now()
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let resp
    if (mode === 'real') {
      // 真实最小请求到转发端点，准确验证 key + 模型可用性
      const reqPath = upstream.type === 'openai' ? '/chat/completions' : '/messages'
      const body = { model: pickTestModel(upstream), messages: [{ role: 'user', content: '.' }], max_tokens: 1, stream: false }
      const params = buildUpstreamRequest(upstream, reqPath, body, {})
      resp = await fetch(params.url, {
        method: 'POST',
        headers: params.headers,
        body: params.body,
        signal: controller.signal
      })
    } else {
      resp = await fetch(probeUrl(upstream), {
        method: 'GET',
        headers: probeHeaders(upstream),
        signal: controller.signal
      })
    }
    clearTimeout(t)
    const latencyMs = Date.now() - start
    const status = resp.status
    // 401/403：real 模式明确 key 失效；light 模式 /models 不可靠，视为无法验证
    if (status === 401 || status === 403) {
      if (mode === 'real') {
        return { reachable: true, status, authOk: false, latencyMs, message: `鉴权失败 (HTTP ${status})，key 可能失效` }
      }
      return { reachable: true, status, authOk: null, latencyMs, message: `连通 (HTTP ${status}，/models 鉴权不可用，key 未验证)` }
    }
    // light 模式：/models 不支持 -> 无法验证 key，但网络连通
    if (mode === 'light' && (status === 404 || status === 405)) {
      return { reachable: true, status, authOk: null, latencyMs, message: `连通 (HTTP ${status}，/models 不支持，key 未验证)` }
    }
    // real 模式：4xx（非 401/403/429）说明 auth 已通过，只是请求体/模型问题，key 有效
    if (mode === 'real' && status >= 400 && status < 500 && status !== 429) {
      return { reachable: true, status, authOk: true, latencyMs, message: `连通 (HTTP ${status}，key 有效)` }
    }
    // 2xx / 429 / 5xx：网络通；429 限流也算 key 有效
    return { reachable: true, status, authOk: true, latencyMs, message: `连通 (HTTP ${status})` }
  } catch (e) {
    clearTimeout(t)
    const latencyMs = Date.now() - start
    const isTimeout = e.name === 'AbortError'
    const message = isTimeout ? `超时 (${timeoutMs}ms)` : `连接失败: ${e.message}`
    // 网络错误：无法验证 key
    return { reachable: false, status: 0, authOk: null, latencyMs, message }
  }
}

export class HealthProbe {
  constructor(config, breaker) {
    this.config = config
    this.breaker = breaker
    this.timer = null
  }

  start() {
    // 幂等：重复调用先停掉旧 timer，避免 interval 泄漏
    this.stop()
    if (!this.config.healthProbe?.enabled) {
      log.info('[probe] 健康探测已禁用')
      return
    }
    const interval = this.config.healthProbe.intervalMs || 30000
    log.info(`[probe] 启动健康探测，间隔 ${interval}ms，上游数 ${this.config.upstreams.length}`)
    this.timer = setInterval(() => this._tick(), interval)
    this._tick() // 立即执行一次
  }

  // 配置热加载后调用，用新配置重启探测
  restart(newConfig) {
    if (newConfig) this.config = newConfig
    log.info('[probe] 配置更新，重启健康探测')
    this.start()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      log.info('[probe] 健康探测已停止')
    }
  }

  async _tick() {
    const timeout = this.config.healthProbe.timeoutMs || 5000
    const ups = this.config.upstreams || []
    if (!ups.length) return
    // 加随机抖动（±20%），避免所有上游同时被探测
    for (const u of ups) {
      const jitter = Math.random() * timeout * 0.2
      setTimeout(() => this._probeOne(u, timeout).catch(() => {}), jitter)
    }
  }

  async _probeOne(upstream, timeout) {
    // 后台探测用 light 模式（免费）；light 模式不会返回 authOk===false，
    // 故只有网络不可达才 recordFail，避免 /models 误报导致误熔断
    const r = await probeUpstream(upstream, timeout, 'light')
    if (!r.reachable) {
      log.warn(`[probe] ${upstream.name} ${r.message}`)
      this.breaker.recordFail(upstream.name)
    }
    // reachable=true（含 authOk=null 无法验证）：不记失败，由真实请求判定
  }
}
