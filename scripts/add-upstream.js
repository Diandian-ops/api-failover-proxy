#!/usr/bin/env node
// 添加单个上游到号池
// 用法：
//   node scripts/add-upstream.js --name xxx --type anthropic --base https://xxx/v1 --apiKey sk-xxx
//   可选：--weight 5 --forceStream --modelMap 'claude-3-5-sonnet=glm-5.2;claude-3-5-haiku=glm-5.2'
//   或通过 --json '{"name":"xxx","type":"anthropic",...}' 一次性传
import { initPool, upsertUpstream, getDbPath } from '../src/upstream-pool.js'

function parseArgs() {
  const args = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const k = args[i]
    if (k === '--json') { out._json = args[++i]; continue }
    if (k.startsWith('--')) {
      const key = k.slice(2)
      let v = args[++i]
      if (v === 'true') v = true
      else if (v === 'false') v = false
      else if (/^\d+$/.test(v)) v = Number(v)
      out[key] = v
    }
  }
  return out
}

const args = parseArgs()

let u
if (args._json) {
  u = JSON.parse(args._json)
} else {
  if (!args.name || !args.type || !args.base || !args.apiKey) {
    console.error('用法: node scripts/add-upstream.js --name xxx --type anthropic|openai --base URL --apiKey KEY [--weight N] [--forceStream] [--modelMap "a=b;c=d"]')
    process.exit(1)
  }
  u = {
    name: args.name,
    type: args.type,
    base: args.base,
    apiKey: args.apiKey,
    weight: args.weight || 1,
    forceStream: !!args.forceStream,
    enabled: args.enabled !== false,
    modelMap: {}
  }
  if (args.modelMap && typeof args.modelMap === 'string') {
    // 格式：claude-3-5-sonnet=glm-5.2;claude-3-5-haiku=glm-5.2
    for (const pair of args.modelMap.split(';')) {
      const [k, v] = pair.split('=')
      if (k && v) u.modelMap[k.trim()] = v.trim()
    }
  } else if (args.modelMap && typeof args.modelMap === 'object') {
    u.modelMap = args.modelMap
  }
}

initPool()
upsertUpstream(u)
console.log(`已保存上游: ${u.name} -> ${getDbPath()}`)
console.log(`  type=${u.type} base=${u.base} weight=${u.weight||1} forceStream=${!!u.forceStream}`)
if (u.modelMap && Object.keys(u.modelMap).length) {
  console.log(`  modelMap: ${JSON.stringify(u.modelMap)}`)
}
console.log(`\n热加载生效：curl -X POST http://127.0.0.1:9090/admin/reload -H "Authorization: Bearer <gatewayKey>"`)
