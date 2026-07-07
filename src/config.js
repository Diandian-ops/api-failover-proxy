// 配置加载：
// 1. 读 config.local.js（或 config.example.js）作为基础配置（port/timeout/策略等）
// 2. upstreams 从 SQLite 号池加载；DB 为空则回退 config.local.js 的 upstreams
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initPool, loadUpstreams } from './upstream-pool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const localPath = path.join(__dirname, '..', 'config.local.js')
const examplePath = path.join(__dirname, '..', 'config.example.js')

let baseConfig
const configPath = fs.existsSync(localPath) ? localPath : examplePath
try {
  baseConfig = (await import(configPath)).default
} catch (e) {
  // 配置文件语法错误时给出友好提示，而非原生堆栈
  const rel = configPath === localPath ? 'config.local.js' : 'config.example.js'
  throw new Error(`配置文件 ${rel} 语法错误: ${e.message}`)
}

// 初始化号池 DB（路径可通过 baseConfig.poolDb 覆盖）
initPool({ path: baseConfig.poolDb })

// 从 DB 加载上游；为空则回退 config.local.js 里的 upstreams
const dbUpstreams = loadUpstreams()
const upstreams = dbUpstreams.length > 0 ? dbUpstreams : baseConfig.upstreams

const config = {
  ...baseConfig,
  upstreams,
  // 标记上游来源，方便调试
  _upstreamSource: dbUpstreams.length > 0 ? 'sqlite' : 'config-file'
}

// 基本校验
function validateConfig(cfg) {
  const err = (msg) => new Error(`配置错误: ${msg}`)

  // 端口/地址（port 可能来自 env 是字符串，先转数字）
  const port = Number(cfg.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw err(`port 必须是 1-65535 的整数，当前值=${cfg.port}`)
  }
  cfg.port = port
  if (!cfg.host || typeof cfg.host !== 'string') {
    throw err(`host 不能为空，当前值=${cfg.host}`)
  }

  // 超时（毫秒，正数；可能来自 env 是字符串）
  for (const k of ['totalTimeout', 'connectTimeout', 'firstByteTimeout', 'streamStallTimeout']) {
    const v = Number(cfg[k])
    if (!Number.isFinite(v) || v <= 0) throw err(`${k} 必须是正数，当前值=${cfg[k]}`)
    cfg[k] = v
  }

  // 重试
  const maxRetries = Number(cfg.maxRetries)
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw err(`maxRetries 必须是非负整数，当前值=${cfg.maxRetries}`)
  }
  cfg.maxRetries = maxRetries
  const retryBackoffMs = Number(cfg.retryBackoffMs)
  if (!Number.isFinite(retryBackoffMs) || retryBackoffMs <= 0) {
    throw err(`retryBackoffMs 必须是正数，当前值=${cfg.retryBackoffMs}`)
  }
  cfg.retryBackoffMs = retryBackoffMs

  // 熔断
  const cb = cfg.circuitBreaker || {}
  const failThreshold = Number(cb.failThreshold)
  if (!Number.isInteger(failThreshold) || failThreshold <= 0) {
    throw err(`circuitBreaker.failThreshold 必须是正整数，当前值=${cb.failThreshold}`)
  }
  cb.failThreshold = failThreshold
  const cooldownSec = Number(cb.cooldownSec)
  if (!Number.isInteger(cooldownSec) || cooldownSec <= 0) {
    throw err(`circuitBreaker.cooldownSec 必须是正整数，当前值=${cb.cooldownSec}`)
  }
  cb.cooldownSec = cooldownSec

  // 上游列表
  if (!cfg.upstreams || !Array.isArray(cfg.upstreams) || cfg.upstreams.length === 0) {
    throw err('upstreams 不能为空：号池 DB 为空且配置文件也无上游')
  }
  const names = new Set()
  cfg.upstreams.forEach((u, i) => {
    const at = `upstreams[${i}] (${u.name || '<未命名>'})`
    if (!u.name) throw err(`${at}: name 不能为空`)
    if (names.has(u.name)) throw err(`${at}: name "${u.name}" 重复`)
    names.add(u.name)
    if (!['openai', 'anthropic'].includes(u.type)) {
      throw err(`${at}: type 必须是 openai 或 anthropic，当前值=${u.type}`)
    }
    try { new URL(u.base) } catch { throw err(`${at}: base 不是合法 URL，当前值=${u.base}`) }
    if (!u.apiKey) throw err(`${at}: apiKey 不能为空`)
    if (u.modelMap != null && (typeof u.modelMap !== 'object' || Array.isArray(u.modelMap))) {
      throw err(`${at}: modelMap 必须是对象`)
    }
  })
}

validateConfig(config)

export default config
