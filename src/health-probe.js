// 上游健康探测：后台定时检测上游是否存活，提前发现故障
// 探测方式：对上游 base URL 发轻量 GET，任何 HTTP 响应（含 404/401）即视为存活
// 连接失败 / 超时 / DNS 错误 视为死亡，向熔断器记录失败加速熔断
import { log } from './logger.js'

export class HealthProbe {
  constructor(config, breaker) {
    this.config = config
    this.breaker = breaker
    this.timer = null
  }

  start() {
    if (!this.config.healthProbe?.enabled) {
      log.info('[probe] 健康探测已禁用')
      return
    }
    const interval = this.config.healthProbe.intervalMs || 30000
    log.info(`[probe] 启动健康探测，间隔 ${interval}ms，上游数 ${this.config.upstreams.length}`)
    this.timer = setInterval(() => this._tick(), interval)
    this._tick() // 立即执行一次
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
    for (const u of ups) {
      this._probeOne(u, timeout).catch(() => {})
    }
  }

  async _probeOne(upstream, timeout) {
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), timeout)
      // 对 base URL 发 GET，任何 HTTP 响应（含 404/401/500）都视为存活
      await fetch(upstream.base, {
        method: 'GET',
        headers: { 'User-Agent': 'api-failover-proxy/health-probe' },
        signal: controller.signal
      })
      clearTimeout(t)
      // 不记录 success（避免探针覆盖用户真实体验），只让真实请求来重置熔断
    } catch (e) {
      const msg = e.name === 'AbortError' ? '超时' : e.message
      log.warn(`[probe] ${upstream.name} 探测失败: ${msg}`)
      // 向熔断器记录失败，加速熔断，让用户请求不再打到已死上游
      this.breaker.recordFail(upstream.name)
    }
  }
}
