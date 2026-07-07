#!/usr/bin/env node
// 一键迁移：把 config.local.js 里的 upstreams 导入 SQLite 号池
// 用法：node scripts/init-db.js
// 重复运行安全（按 name upsert）
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const localPath = path.join(root, 'config.local.js')
if (!fs.existsSync(localPath)) {
  console.error('找不到 config.local.js，无法迁移')
  process.exit(1)
}

const { default: baseConfig } = await import('../config.local.js')
const { initPool, loadAllUpstreams, upsertUpstream, getDbPath } = await import('../src/upstream-pool.js')

initPool({ path: baseConfig.poolDb })

const existing = new Set(loadAllUpstreams().map(u => u.name))
let added = 0, updated = 0

for (const u of baseConfig.upstreams) {
  upsertUpstream({
    name: u.name,
    type: u.type,
    base: u.base,
    apiKey: u.apiKey,
    weight: u.weight || 1,
    forceStream: !!u.forceStream,
    enabled: true,
    modelMap: u.modelMap || {}
  })
  if (existing.has(u.name)) updated++; else added++
}

console.log(`迁移完成 -> ${getDbPath()}`)
console.log(`  新增 ${added} 个，更新 ${updated} 个，共 ${baseConfig.upstreams.length} 个上游`)
console.log(`\n下一步：重启代理 (npm start)，代理将从 DB 加载上游`)
