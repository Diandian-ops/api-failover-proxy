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
if (fs.existsSync(localPath)) {
  baseConfig = (await import('../config.local.js')).default
} else {
  baseConfig = (await import('../config.example.js')).default
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
if (!config.upstreams || config.upstreams.length === 0) {
  throw new Error('config.upstreams 不能为空：号池 DB 为空且 config.local.js 也无上游')
}

export default config
