import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicToOpenAIRequest,
  openaiToAnthropicRequest,
  openaiToAnthropicResponse,
  anthropicToOpenAIResponse,
  OpenAIToAnthropicStreamConverter,
  AnthropicToOpenAIStreamConverter
} from '../src/convert.js'

// ── 请求转换 ──

test('anthropicToOpenAIRequest: system + user 文本', () => {
  const r = anthropicToOpenAIRequest({
    model: 'claude-3-5',
    system: '你是助手',
    messages: [{ role: 'user', content: '你好' }],
    max_tokens: 100
  })
  assert.equal(r.model, 'claude-3-5')
  assert.equal(r.max_tokens, 100)
  assert.deepEqual(r.messages, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' }
  ])
})

test('anthropicToOpenAIRequest: modelMap 生效', () => {
  const r = anthropicToOpenAIRequest(
    { model: 'claude-3-5', messages: [{ role: 'user', content: 'hi' }] },
    { 'claude-3-5': 'gpt-4o' }
  )
  assert.equal(r.model, 'gpt-4o')
})

test('anthropicToOpenAIRequest: tools / tool_choice 转换', () => {
  const r = anthropicToOpenAIRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' }
  })
  assert.equal(r.tools[0].type, 'function')
  assert.equal(r.tools[0].function.name, 'get_weather')
  assert.equal(r.tool_choice, 'auto')
})

test('openaiToAnthropicRequest: system message 提到顶层 system', () => {
  const r = openaiToAnthropicRequest({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]
  })
  assert.equal(r.system, 'sys')
  assert.equal(r.messages.length, 1)
  assert.equal(r.messages[0].role, 'user')
})

// ── 响应转换 ──

test('openaiToAnthropicResponse: 文本 + usage', () => {
  const r = openaiToAnthropicResponse({
    id: 'abc',
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }, 'req-model')
  assert.equal(r.type, 'message')
  assert.equal(r.role, 'assistant')
  assert.equal(r.model, 'req-model')
  assert.equal(r.stop_reason, 'end_turn')
  assert.equal(r.content[0].type, 'text')
  assert.equal(r.content[0].text, 'hello')
  assert.equal(r.usage.input_tokens, 10)
  assert.equal(r.usage.output_tokens, 5)
})

test('openaiToAnthropicResponse: tool_calls 转换', () => {
  const r = openaiToAnthropicResponse({
    id: 'abc',
    choices: [{
      message: {
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'get_weather', arguments: '{"city":"北京"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  }, 'm')
  assert.equal(r.stop_reason, 'tool_use')
  const tu = r.content.find(b => b.type === 'tool_use')
  assert.equal(tu.id, 'call_1')
  assert.equal(tu.name, 'get_weather')
  assert.deepEqual(tu.input, { city: '北京' })
})

test('anthropicToOpenAIResponse: 文本 + tool_use 混合', () => {
  const r = anthropicToOpenAIResponse({
    content: [
      { type: 'text', text: '查一下' },
      { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: '上海' } }
    ],
    stop_reason: 'tool_use'
  }, 'm')
  assert.equal(r.choices[0].message.content, '查一下')
  assert.equal(r.choices[0].message.tool_calls[0].function.name, 'get_weather')
  assert.deepEqual(JSON.parse(r.choices[0].message.tool_calls[0].function.arguments), { city: '上海' })
  assert.equal(r.choices[0].finish_reason, 'tool_calls')
})

// ── 流转换器：跨事件边界分片 ──

test('OpenAIToAnthropicStreamConverter: 跨边界分片能正确缓冲', () => {
  const c = new OpenAIToAnthropicStreamConverter('m')
  // 故意把一个 OpenAI chunk 切成两半
  const chunk = JSON.stringify({
    id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' }, finish_reason: null }]
  })
  const half = Math.floor(chunk.length / 2)
  const out1 = c.feed(`data: ${chunk.slice(0, half)}`)
  const out2 = c.feed(`${chunk.slice(half)}\n\n`)
  const out3 = c.flush()
  const combined = out1 + out2 + out3
  // 应该产出了 message_start 事件
  assert.ok(combined.includes('message_start'), '应包含 message_start')
  assert.ok(combined.includes('"text":"hi"') || combined.includes('"text": "hi"'))
})

test('AnthropicToOpenAIStreamConverter: message_start + delta 转 OpenAI chunk', () => {
  const c = new AnthropicToOpenAIStreamConverter('m')
  const sse1 = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: 'm', usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`
  const sse2 = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } })}\n\n`
  const out = c.feed(sse1 + sse2) + c.flush()
  assert.ok(out.includes('chat.completion.chunk'))
  assert.ok(out.includes('你好'))
  assert.ok(out.includes('[DONE]'))
})
