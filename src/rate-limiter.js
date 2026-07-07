// 限流/并发控制：每上游信号量，保护上游不被突发流量打爆
// 策略：reject = 超并发立即返回 429；queue = 排队等待（默认最多 100 个排队）
import { log } from './logger.js'

export class RateLimiter {
  constructor(config = {}) {
    this.enabled = config.rateLimit?.enabled !== false
    this.maxConcurrent = config.rateLimit?.maxConcurrent || 5
    this.maxQueue = config.rateLimit?.maxQueue || 100
    this.strategy = config.rateLimit?.strategy || 'reject' // 'reject' | 'queue'
    this._map = new Map() // upstreamName -> { active: number, queue: Array<{ resolve, reject }> }
  }

  _get(upstreamName) {
    if (!this._map.has(upstreamName)) {
      this._map.set(upstreamName, { active: 0, queue: [] })
    }
    return this._map.get(upstreamName)
  }

  async acquire(upstreamName) {
    if (!this.enabled) return true

    const s = this._get(upstreamName)

    if (s.active < this.maxConcurrent) {
      s.active++
      return true
    }

    if (this.strategy === 'reject') {
      return false
    }

    // queue 策略
    if (s.queue.length >= this.maxQueue) {
      return false
    }

    return new Promise((resolve) => {
      s.queue.push({ resolve, expire: Date.now() + 30000 }) // 30s 排队超时
    })
  }

  release(upstreamName) {
    if (!this.enabled) return

    const s = this._get(upstreamName)
    s.active = Math.max(0, s.active - 1)

    // 清理超时排队
    const now = Date.now()
    while (s.queue.length > 0 && s.queue[0].expire < now) {
      const waiter = s.queue.shift()
      waiter.resolve(false) // 超时也算失败
    }

    // 唤醒下一个
    if (s.queue.length > 0 && s.active < this.maxConcurrent) {
      s.active++
      const waiter = s.queue.shift()
      waiter.resolve(true)
    }
  }

  snapshot() {
    const out = []
    for (const [name, s] of this._map) {
      out.push({ name, active: s.active, queue: s.queue.length })
    }
    return out
  }
}
