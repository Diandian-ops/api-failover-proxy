#!/usr/bin/env node
// 列出号池里所有上游
// 用法：node scripts/list-upstreams.js
import { initPool, loadAllUpstreams, getDbPath } from '../src/upstream-pool.js'

initPool()
const all = loadAllUpstreams()
console.log(`DB: ${getDbPath()}`)
console.log(`共 ${all.length} 个上游：\n`)
for (const u of all) {
  const flag = []
  if (u.forceStream) flag.push('forceStream')
  if (!u.enabled) flag.push('DISABLED')
  const flagStr = flag.length ? ` [${flag.join(',')}]` : ''
  console.log(`  ${u.name} (${u.type}) w=${u.weight||1}${flagStr}`)
  console.log(`    base: ${u.base}`)
  console.log(`    apiKey: ${u.apiKey.slice(0,12)}...`)
  if (u.modelMap && Object.keys(u.modelMap).length) {
    console.log(`    modelMap: ${JSON.stringify(u.modelMap)}`)
  }
  console.log()
}
