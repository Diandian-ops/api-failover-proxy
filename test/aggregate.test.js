import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicStreamAggregator, OpenAIStreamAggregator } from '../src/aggregate.js'

// 构造一个 Anthropic SSE 事件
function anthroEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

test('AnthropicStreamAggregator: 聚合文本 + usage', () => {
  const agg = new AnthropicStreamAggregator('m')
  const stream =
    anthroEvent('message_start', { message: { id: 'msg_1', model: 'm', usage: { input_tokens: 10, output_tokens: 0 } } }) +
    anthroEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    anthroEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好' } }) +
    anthroEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '世界' } }) +
    anthroEvent('content_block_stop', { index: 0 }) +
    anthroEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }) +
    anthroEvent('message_stop', {})
  agg.feed(stream)
  const r = agg.getResult()
  assert.equal(r.id, 'msg_1')
  assert.equal(r.stop_reason, 'end_turn')
  const textBlock = r.content.find(b => b.type === 'text')
  assert.equal(textBlock.text, '你好世界')
  assert.equal(r.usage.input_tokens, 10)
  assert.equal(r.usage.output_tokens, 4)
})

test('AnthropicStreamAggregator: 跨边界分片', () => {
  const agg = new AnthropicStreamAggregator('m')
  const e = anthroEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'abc' } })
  const half = Math.floor(e.length / 2)
  agg.feed(e.slice(0, half))
  agg.feed(e.slice(half))
  // 没有完整事件前 getResult 不应崩
  const r = agg.getResult()
  assert.ok(r)
})

test('OpenAIStreamAggregator: 聚合文本 + usage + [DONE]', () => {
  const agg = new OpenAIStreamAggregator('gpt-4o')
  const chunk = (delta, finish = null, usage) => {
    const obj = {
      id: 'cc_1',
      model: 'gpt-4o',
      choices: [{ index: 0, delta, finish_reason: finish }]
    }
    if (usage) obj.usage = usage
    return `data: ${JSON.stringify(obj)}\n\n`
  }
  const stream =
    chunk({ role: 'assistant' }) +
    chunk({ content: 'hello' }) +
    chunk({ content: ' world' }) +
    chunk({}, 'stop', { prompt_tokens: 8, completion_tokens: 2 }) +
    'data: [DONE]\n\n'
  agg.feed(stream)
  const r = agg.getResult()
  assert.equal(r.id, 'cc_1')
  assert.equal(r.choices[0].message.content, 'hello world')
  assert.equal(r.choices[0].finish_reason, 'stop')
  assert.equal(r.usage.prompt_tokens, 8)
  assert.equal(r.usage.completion_tokens, 2)
  assert.equal(r.usage.total_tokens, 10)
})

test('OpenAIStreamAggregator: tool_calls 聚合', () => {
  const agg = new OpenAIStreamAggregator('m')
  const stream =
    `data: ${JSON.stringify({ id: '1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ id: '1', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ id: '1', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '北京"}' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ id: '1', choices: [{ finish_reason: 'tool_calls' }] })}\n\n` +
    'data: [DONE]\n\n'
  agg.feed(stream)
  const r = agg.getResult()
  assert.equal(r.choices[0].message.tool_calls[0].function.name, 'get_weather')
  assert.deepEqual(r.choices[0].message.tool_calls[0].function.arguments, '{"city":"北京"}')
  assert.equal(r.choices[0].finish_reason, 'tool_calls')
})
