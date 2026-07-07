import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CircuitBreaker } from '../src/circuit-breaker.js'

test('连续失败达阈值后熔断', () => {
  const b = new CircuitBreaker({ failThreshold: 3, cooldownSec: 60 })
  assert.equal(b.isOpen('a'), false)
  b.recordFail('a')
  b.recordFail('a')
  assert.equal(b.isOpen('a'), false) // 还没到阈值
  b.recordFail('a')
  assert.equal(b.isOpen('a'), true) // 达到 3 次熔断
})

test('recordSuccess 清零计数', () => {
  const b = new CircuitBreaker({ failThreshold: 3, cooldownSec: 60 })
  b.recordFail('a')
  b.recordFail('a')
  b.recordSuccess('a')
  assert.equal(b.isOpen('a'), false)
  b.recordFail('a')
  assert.equal(b.isOpen('a'), false) // 计数已清零，1 次不够
})

test('冷却结束后半开（清空计数）', async () => {
  const b = new CircuitBreaker({ failThreshold: 2, cooldownSec: 1 })
  b.recordFail('a')
  b.recordFail('a')
  assert.equal(b.isOpen('a'), true)
  // 等 1.1s 过冷却
  await new Promise(r => setTimeout(r, 1100))
  assert.equal(b.isOpen('a'), false) // 半开，返回 false
  // 计数应已清零，需再次达阈值才熔断
  b.recordFail('a')
  assert.equal(b.isOpen('a'), false)
  b.recordFail('a')
  assert.equal(b.isOpen('a'), true)
})

test('snapshot 返回正确结构', () => {
  const b = new CircuitBreaker({ failThreshold: 5, cooldownSec: 60 })
  b.recordFail('x')
  b.recordFail('x')
  const snap = b.snapshot()
  assert.equal(snap.length, 1)
  assert.equal(snap[0].name, 'x')
  assert.equal(snap[0].fails, 2)
  assert.equal(snap[0].failThreshold, 5)
  assert.ok(!snap[0].open) // 未熔断（open 字段可能是 0 或 false，都是 falsy）
})

test('未记录的上游 isOpen 返回 false', () => {
  const b = new CircuitBreaker({ failThreshold: 3, cooldownSec: 60 })
  assert.equal(b.isOpen('unknown'), false)
})
