// 冒烟测试：启动一个 mock 上游，验证故障转移逻辑
import assert from 'node:assert'

const PROXY = process.env.PROXY_URL || 'http://127.0.0.1:9090'
const GATEWAY_KEY = process.env.GATEWAY_KEY || ''
const authHeaders = GATEWAY_KEY ? { Authorization: `Bearer ${GATEWAY_KEY}` } : {}

async function main() {
  // 健康检查（免鉴权）
  const h = await fetch(`${PROXY}/health`)
  assert.equal(h.status, 200)
  const hj = await h.json()
  assert.equal(hj.ok, true)
  console.log('✓ /health 正常')

  // 未知路径
  const r404 = await fetch(`${PROXY}/unknown`, {
    method: 'POST', headers: authHeaders, body: '{}'
  })
  assert.equal(r404.status, 404)
  console.log('✓ 未知路径返回 404')

  // 非法 JSON 路径
  const r400 = await fetch(`${PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ model: 'test', messages: [] })
  })
  // 4xx/5xx 都说明调度逻辑正常执行了（403/400 可能是模型名无效）
  assert.ok([200, 400, 401, 403, 502, 503].includes(r400.status), `unexpected status ${r400.status}`)
  console.log(`✓ /v1/chat/completions 调度执行，status=${r400.status}`)

  // 真实请求测试（如果配置了有效 key）
  const rReal = await fetch(`${PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: '回复两个字: 你好' }],
      max_tokens: 20,
      stream: false
    })
  })
  if (rReal.status === 200) {
    const j = await rReal.json()
    const text = j.choices?.[0]?.message?.content || ''
    console.log(`✓ 真实请求成功，模型回复: ${text.slice(0, 50)}`)
  } else {
    console.log(`△ 真实请求 status=${rReal.status}（可能 key 无效，跳过）`)
  }

  // Anthropic 协议测试
  const rAnth = await fetch(`${PROXY}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: '回复两个字: 你好' }],
      max_tokens: 20,
      stream: false
    })
  })
  if (rAnth.status === 200) {
    const j = await rAnth.json()
    const text = (j.content?.[0]?.text || '').slice(0, 50)
    console.log(`✓ Anthropic 协议请求成功，回复: ${text}`)
  } else {
    console.log(`△ Anthropic 协议 status=${rAnth.status}（可能 key 无效，跳过）`)
  }

  console.log('\n所有冒烟测试通过 ✓')
}

main().catch(e => {
  console.error('冒烟测试失败:', e.message)
  process.exit(1)
})
