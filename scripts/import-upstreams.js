#!/usr/bin/env node
// 批量导入上游到号池（从 JSON 文件或 stdin）
// 用法：
//   node scripts/import-upstreams.js --file upstreams.json
//   cat upstreams.json | node scripts/import-upstreams.js
// JSON 为数组，字段同单条新增；同名上游覆盖。写完需热加载生效：
//   curl -X POST http://127.0.0.1:9090/admin/reload -H "Authorization: Bearer <gatewayKey>"
import fs from 'node:fs'
import { initPool, upsertUpstreamsBatch, validateUpstream, getDbPath } from '../src/upstream-pool.js'

let raw
if (process.argv.includes('--file')) {
  const i = process.argv.indexOf('--file')
  const f = process.argv[i + 1]
  if (!f) { console.error('--file 需指定文件路径'); process.exit(1) }
  raw = fs.readFileSync(f, 'utf8')
} else if (!process.stdin.isTTY) {
  raw = fs.readFileSync(0, 'utf8')
} else {
  console.error('用法: node scripts/import-upstreams.js --file upstreams.json')
  console.error('  或: cat upstreams.json | node scripts/import-upstreams.js')
  process.exit(1)
}

let list
try {
  list = JSON.parse(raw)
} catch (e) {
  console.error('JSON 解析失败:', e.message)
  process.exit(1)
}
if (!Array.isArray(list)) {
  console.error('JSON 需为数组')
  process.exit(1)
}

const errors = []
const valid = []
list.forEach((b, i) => {
  const v = validateUpstream(b)
  if (!v.ok) errors.push({ index: i, name: (b && b.name) || '(空)', msg: v.msg })
  else valid.push(v.upstream)
})

if (errors.length) {
  console.error(`❌ ${errors.length}/${list.length} 条校验失败，已拒绝整批导入：`)
  errors.forEach(e => console.error(`  [${e.index}] ${e.name}: ${e.msg}`))
  process.exit(1)
}

initPool()
upsertUpstreamsBatch(valid)
console.log(`✅ 批量导入完成: ${valid.length} 条 -> ${getDbPath()}`)
console.log(`\n热加载生效：curl -X POST http://127.0.0.1:9090/admin/reload -H "Authorization: Bearer <gatewayKey>"`)
