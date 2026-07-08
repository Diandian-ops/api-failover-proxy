// 熔断器：连续失败 N 次后冷却一段时间
import { log } from './logger.js'

export class CircuitBreaker {
  constructor(opts = {}) {
    this.failThreshold = opts.failThreshold || 5
    this.cooldownSec = opts.cooldownSec || 60
    // name -> { fails, openUntil }
    this.state = new Map()
  }

  isOpen(name) {
    const s = this.state.get(name)
    if (!s) return false
    if (s.openUntil && Date.now() < s.openUntil) return true
    if (s.openUntil && Date.now() >= s.openUntil) {
      // 冷却结束，半开：清空计数
      s.openUntil = 0
      s.fails = 0
      log.info(`[breaker] ${name} 冷却结束，进入半开状态`)
      return false
    }
    return false
  }

  recordFail(name) {
    const s = this.state.get(name) || { fails: 0, openUntil: 0 }
    s.fails += 1
    this.state.set(name, s)
    if (s.fails >= this.failThreshold) {
      s.openUntil = Date.now() + this.cooldownSec * 1000
      log.warn(`[breaker] ${name} 连续失败 ${s.fails} 次，熔断 ${this.cooldownSec}s`)
    }
  }

  recordSuccess(name) {
    const s = this.state.get(name)
    if (s) {
      // 之前处于熔断或半开状态，记录恢复
      const wasOpen = s.openUntil > 0
      const wasHalfOpen = s.fails > 0 && s.openUntil === 0
      s.fails = 0
      s.openUntil = 0
      if (wasOpen) {
        log.info(`[breaker] ${name} 熔断后请求成功，已恢复`)
      } else if (wasHalfOpen) {
        log.info(`[breaker] ${name} 失败计数清零（半开恢复）`)
      }
    }
  }

  // 导出所有上游的熔断状态，供监控页使用
  snapshot() {
    const out = []
    for (const [name, s] of this.state.entries()) {
      const open = s.openUntil && Date.now() < s.openUntil
      out.push({
        name,
        fails: s.fails || 0,
        failThreshold: this.failThreshold,
        open,
        openUntil: s.openUntil || 0,
        cooldownRemaining: open ? Math.max(0, Math.round((s.openUntil - Date.now()) / 1000)) : 0
      })
    }
    return out
  }
}
