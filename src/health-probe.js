// 上游健康探测：后台定时检测上游是否存活，提前发现故障
// 探测方式：带鉴权头对上游发轻量 GET
//   - 网络层失败（DNS/连接/超时）→ recordFail 加速熔断
//   - 鉴权层失败（401/403）→ recordFail，能发现 key 失效
//   - 其他 HTTP 响应（404/500/200）→ 视为存活（网络通、key 有效）
import { log } from './logger.js'

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
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), timeout)
      // 带鉴权头探测：能同时发现网络层和鉴权层故障
      const headers = this._probeHeaders(upstream)
      const url = this._probeUrl(upstream)
      const resp = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      })
      clearTimeout(t)
      // 401/403 → key 失效，视为不健康
      if (resp.status === 401 || resp.status === 403) {
        log.warn(`[probe] ${upstream.name} 鉴权失败 (HTTP ${resp.status})，key 可能失效`)
        this.breaker.recordFail(upstream.name)
        return
      }
      // 其他 HTTP 响应（404/500/200）→ 网络通且 key 有效，视为存活
      // 不记录 success（避免探针覆盖用户真实体验），只让真实请求来重置熔断
    } catch (e) {
      const msg = e.name === 'AbortError' ? '超时' : e.message
      log.warn(`[probe] ${upstream.name} 探测失败: ${msg}`)
      // 向熔断器记录失败，加速熔断，让用户请求不再打到已死上游
      this.breaker.recordFail(upstream.name)
    }
  }

  // 构造探测用的鉴权头（复用上游的 key）
  _probeHeaders(upstream) {
    const headers = { 'User-Agent': 'api-failover-proxy/health-probe' }
    if (upstream.type === 'openai') {
      headers['Authorization'] = `Bearer ${upstream.apiKey}`
    } else if (upstream.type === 'anthropic') {
      headers['x-api-key'] = upstream.apiKey
      headers['anthropic-version'] = '2023-06-01'
    }
    return headers
  }

  // 探测 URL：对 base 发 GET（去掉尾斜杠）
  _probeUrl(upstream) {
    return upstream.base.replace(/\/$/, '')
  }
}
