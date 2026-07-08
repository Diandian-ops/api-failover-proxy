// ============================================================
//  协议转换模块：Anthropic ↔ OpenAI
//  支持：请求体转换、非流式响应转换、SSE 流式响应转换
// ============================================================

import { log } from './logger.js'
import { normalizeUsage } from './cache/usage.js'

// ----------------------------------------------------------
//  请求转换
// ----------------------------------------------------------

/**
 * Anthropic 请求体 → OpenAI 请求体
 */
export function anthropicToOpenAIRequest(body, modelMap = {}) {
  const messages = []

  // system 字段 → system message
  if (body.system) {
    const sysContent = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.map(b => b.text || '').join('\n') : '')
    if (sysContent) {
      messages.push({ role: 'system', content: sysContent })
    }
  }

  // 转换 messages
  for (const msg of (body.messages || [])) {
    messages.push(anthropicMessageToOpenAI(msg))
  }

  const mappedModel = modelMap[body.model] || body.model

  const result = {
    model: mappedModel,
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: body.stream || false
  }

  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p
  if (body.stop_sequences) result.stop = body.stop_sequences

  // tools 转换
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {}
      }
    }))
  }

  // tool_choice 转换
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') result.tool_choice = 'auto'
    else if (body.tool_choice.type === 'any') result.tool_choice = 'required'
    else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
      result.tool_choice = { type: 'function', function: { name: body.tool_choice.name } }
    }
  }

  return result
}

/**
 * OpenAI 请求体 → Anthropic 请求体
 */
export function openaiToAnthropicRequest(body, modelMap = {}) {
  const messages = []
  let system = ''

  for (const msg of (body.messages || [])) {
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : '')
      continue
    }
    messages.push(openAIMessageToAnthropic(msg))
  }

  const mappedModel = modelMap[body.model] || body.model

  const result = {
    model: mappedModel,
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: body.stream || false
  }

  if (system) result.system = system
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]

  // tools 转换
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || '',
      input_schema: t.function?.parameters || {}
    }))
  }

  // tool_choice 转换
  if (body.tool_choice) {
    if (body.tool_choice === 'auto') result.tool_choice = { type: 'auto' }
    else if (body.tool_choice === 'required') result.tool_choice = { type: 'any' }
    else if (body.tool_choice === 'none') delete result.tool_choice
    else if (typeof body.tool_choice === 'object' && body.tool_choice.function?.name) {
      result.tool_choice = { type: 'tool', name: body.tool_choice.function.name }
    }
  }

  return result
}

// ----------------------------------------------------------
//  单条消息转换
// ----------------------------------------------------------

function anthropicMessageToOpenAI(msg) {
  const role = msg.role === 'assistant' ? 'assistant' : 'user'

  // content 为字符串
  if (typeof msg.content === 'string') {
    return { role, content: msg.content }
  }

  // content 为数组
  if (Array.isArray(msg.content)) {
    const parts = []
    const toolCalls = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        // OpenAI image_url format
        parts.push({
          type: 'image_url',
          image_url: {
            url: block.source?.type === 'base64'
              ? `data:${block.source.media_type};base64,${block.source.data}`
              : block.source?.url || ''
          }
        })
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {})
          }
        })
      } else if (block.type === 'tool_result') {
        // tool_result 在 OpenAI 中是单独的 tool message
        // 这里返回一个特殊标记，caller 需要处理
        const content = typeof block.content === 'string'
          ? block.content
          : (Array.isArray(block.content) ? block.content.map(c => c.text || '').join('') : '')
        return {
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content
        }
      }
    }

    const result = { role }
    if (toolCalls.length > 0) {
      result.tool_calls = toolCalls
      // 如果有文本部分，也保留
      if (parts.length > 0 && parts.some(p => p.type === 'text')) {
        result.content = parts.filter(p => p.type === 'text').map(p => p.text).join('')
      }
    } else {
      result.content = parts.length === 1 && parts[0].type === 'text'
        ? parts[0].text
        : parts
    }
    return result
  }

  return { role, content: '' }
}

function openAIMessageToAnthropic(msg) {
  const role = msg.role === 'assistant' ? 'assistant' : 'user'

  // tool message → tool_result
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content
      }]
    }
  }

  // content 为字符串
  if (typeof msg.content === 'string') {
    return { role, content: msg.content }
  }

  // content 为数组
  if (Array.isArray(msg.content)) {
    const blocks = []
    for (const part of msg.content) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'image_url') {
        const url = part.image_url?.url || ''
        const base64Match = url.match(/^data:(.+?);base64,(.+)$/)
        if (base64Match) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: base64Match[1], data: base64Match[2] }
          })
        }
      }
    }
    return { role, content: blocks.length > 0 ? blocks : '' }
  }

  // 有 tool_calls 的 assistant message
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const blocks = []
    if (msg.content) {
      blocks.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' })
    }
    for (const tc of msg.tool_calls) {
      let input = {}
      try { input = JSON.parse(tc.function?.arguments || '{}') } catch {}
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input
      })
    }
    return { role: 'assistant', content: blocks }
  }

  return { role, content: msg.content || '' }
}

// ----------------------------------------------------------
//  非流式响应转换
// ----------------------------------------------------------

/**
 * OpenAI 响应 → Anthropic 响应
 */
export function openaiToAnthropicResponse(json, requestModel) {
  const choice = json.choices?.[0]
  if (!choice) {
    return { type: 'error', error: { type: 'api_error', message: 'no choices in response' } }
  }

  const content = []
  const msg = choice.message || {}

  if (msg.content) {
    content.push({ type: 'text', text: msg.content })
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input = {}
      try { input = JSON.parse(tc.function?.arguments || '{}') } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input
      })
    }
  }

  const stopReasonMap = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'end_turn'
  }

  return {
    id: `msg_${json.id || Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: stopReasonMap[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens || 0,
      output_tokens: json.usage?.completion_tokens || 0
    }
  }
}

/**
 * Anthropic 响应 → OpenAI 响应
 */
export function anthropicToOpenAIResponse(json, requestModel) {
  const contentBlocks = json.content || []
  let textContent = ''
  const toolCalls = []

  for (const block of contentBlocks) {
    if (block.type === 'text') {
      textContent += block.text
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      })
    }
  }

  const finishReasonMap = {
    end_turn: 'stop',
    max_tokens: 'length',
    tool_use: 'tool_calls',
    stop_sequence: 'stop'
  }

  const message = { role: 'assistant' }
  if (textContent) message.content = textContent
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  if (!textContent && toolCalls.length === 0) message.content = ''

  return {
    id: `chatcmpl-${json.id || Date.now()}`,
    object: 'chat.completion',
    choices: [{
      index: 0,
      message,
      finish_reason: finishReasonMap[json.stop_reason] || 'stop'
    }],
    model: requestModel,
    usage: {
      prompt_tokens: json.usage?.input_tokens || 0,
      completion_tokens: json.usage?.output_tokens || 0,
      total_tokens: (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0)
    }
  }
}

// ----------------------------------------------------------
//  SSE 流式转换
// ----------------------------------------------------------

/**
 * OpenAI SSE 流 → Anthropic SSE 流
 * 输入：OpenAI 格式的 SSE 文本块
 * 输出：Anthropic 格式的 SSE 文本块
 */
export class OpenAIToAnthropicStreamConverter {
  constructor(requestModel) {
    this.requestModel = requestModel
    this.started = false
    this.blockIndex = 0
    this.currentBlockType = null // 'text' | 'tool_use'
    this.outputTokens = 0
    this.inputTokens = 0
    this.cacheReadTokens = 0
    this.cacheCreationTokens = 0
    this.buffer = ''
    this.toolCallIndex = -1
    this.toolCallBuffers = [] // {id, name, argsBuffer}
  }

  /**
   * 处理一段原始文本，返回转换后的 SSE 文本
   */
  feed(chunk) {
    this.buffer += chunk
    const events = this._extractSSEEvents()
    let output = ''
    for (const evt of events) {
      output += this._convertEvent(evt)
    }
    return output
  }

  /**
   * 流结束，返回剩余的转换输出
   */
  flush() {
    // 处理剩余 buffer
    if (this.buffer.trim()) {
      const events = this._extractSSEEvents()
      let output = ''
      for (const evt of events) {
        output += this._convertEvent(evt)
      }
      this.buffer = ''
      return output
    }
    // 确保关闭
    let output = ''
    if (this.currentBlockType !== null) {
      output += this._sseEvent('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })
      this.currentBlockType = null
    }
    if (this.started) {
      output += this._sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: this.outputTokens }
      })
      output += this._sseEvent('message_stop', { type: 'message_stop' })
    }
    return output
  }

  _extractSSEEvents() {
    const events = []
    while (true) {
      const idx = this.buffer.indexOf('\n\n')
      if (idx === -1) break
      const raw = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      // 解析 data: 行
      const lines = raw.split('\n')
      const dataLines = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
      if (dataLines.length === 0) continue
      const dataStr = dataLines.join('\n')
      if (dataStr === '[DONE]') {
        events.push({ done: true })
        continue
      }
      try {
        const json = JSON.parse(dataStr)
        events.push({ json })
      } catch {
        // 忽略解析失败
      }
    }
    return events
  }

  _convertEvent(evt) {
    if (evt.done) {
      // [DONE] → 关闭所有打开的块 + message_delta + message_stop
      let out = ''
      if (this.currentBlockType !== null) {
        out += this._sseEvent('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })
        this.currentBlockType = null
      }
      if (this.started) {
        out += this._sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: this.outputTokens }
        })
        out += this._sseEvent('message_stop', { type: 'message_stop' })
      }
      return out
    }

    const json = evt.json
    const choice = json.choices?.[0]
    if (!choice) return ''

    const delta = choice.delta || {}

    // 首次：发送 message_start
    if (!this.started) {
      this.started = true
      const n0 = normalizeUsage(json.usage)
      this.inputTokens = n0.input
      this.cacheReadTokens = n0.cacheRead
      this.cacheCreationTokens = n0.cacheCreation
      let out = this._sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${json.id || Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model: this.requestModel,
          stop_reason: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 }
        }
      })
      // 如果有初始文本
      if (delta.content) {
        out += this._startTextBlock()
        out += this._textDelta(delta.content)
      }
      // 如果有 tool_calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          out += this._startToolBlock(tc)
        }
      }
      return out
    }

    let out = ''

    // 文本内容
    if (delta.content) {
      if (this.currentBlockType !== 'text') {
        if (this.currentBlockType !== null) {
          out += this._sseEvent('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })
          this.blockIndex++
        }
        out += this._startTextBlock()
      }
      out += this._textDelta(delta.content)
    }

    // tool_calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0
        // 如果是新 tool call
        if (tcIndex >= this.toolCallBuffers.length) {
          if (this.currentBlockType !== null) {
            out += this._sseEvent('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })
            this.blockIndex++
          }
          this.toolCallBuffers[tcIndex] = { id: tc.id, name: tc.function?.name, argsBuffer: '' }
          out += this._startToolBlock(tc, tcIndex)
        }
        // argument 增量
        if (tc.function?.arguments) {
          this.toolCallBuffers[tcIndex].argsBuffer += tc.function.arguments
          out += this._sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndex,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
          })
        }
      }
    }

    // finish_reason
    if (choice.finish_reason) {
      if (this.currentBlockType !== null) {
        out += this._sseEvent('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })
        this.currentBlockType = null
      }
      const stopReasonMap = {
        stop: 'end_turn',
        length: 'max_tokens',
        tool_calls: 'tool_use',
        content_filter: 'end_turn'
      }
      const stopReason = stopReasonMap[choice.finish_reason] || 'end_turn'
      if (json.usage) {
        const n = normalizeUsage(json.usage)
        if (n.output) this.outputTokens = n.output
        if (n.input) this.inputTokens = n.input
        if (n.cacheRead) this.cacheReadTokens = n.cacheRead
        if (n.cacheCreation) this.cacheCreationTokens = n.cacheCreation
      }
      out += this._sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: this.outputTokens }
      })
      out += this._sseEvent('message_stop', { type: 'message_stop' })
    }

    return out
  }

  _startTextBlock() {
    this.currentBlockType = 'text'
    return this._sseEvent('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: { type: 'text', text: '' }
    })
  }

  _textDelta(text) {
    this.outputTokens += Math.ceil(text.length / 4) // 粗略估计
    return this._sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'text_delta', text }
    })
  }

  _startToolBlock(tc, tcIndex) {
    this.currentBlockType = 'tool_use'
    const id = tc.id || `toolu_${Date.now()}_${tcIndex}`
    const name = tc.function?.name || ''
    return this._sseEvent('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: { type: 'tool_use', id, name, input: {} }
    })
  }

  _sseEvent(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
  }
}

/**
 * Anthropic SSE 流 → OpenAI SSE 流
 */
export class AnthropicToOpenAIStreamConverter {
  constructor(requestModel) {
    this.requestModel = requestModel
    this.started = false
    this.buffer = ''
    this.currentBlockIndex = -1
    this.currentBlockType = null
    this.toolCallId = null
    this.toolCallName = null
    this.finishReason = null
    this.id = `chatcmpl-${Date.now()}`
    this.inputTokens = 0
    this.outputTokens = 0
    this.cacheReadTokens = 0
    this.cacheCreationTokens = 0
  }

  feed(chunk) {
    this.buffer += chunk
    const events = this._extractSSEEvents()
    let output = ''
    for (const evt of events) {
      output += this._convertEvent(evt)
    }
    return output
  }

  flush() {
    if (this.buffer.trim()) {
      const events = this._extractSSEEvents()
      let output = ''
      for (const evt of events) {
        output += this._convertEvent(evt)
      }
      this.buffer = ''
      return output
    }
    // 如果还没发过 finish，补上
    if (this.started && !this.finishReason) {
      return this._openAIChunk({}, 'stop') + 'data: [DONE]\n\n'
    }
    return ''
  }

  _extractSSEEvents() {
    const events = []
    while (true) {
      const idx = this.buffer.indexOf('\n\n')
      if (idx === -1) break
      const raw = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      const lines = raw.split('\n')
      let eventType = 'data'
      const dataLines = []
      for (const line of lines) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (dataLines.length === 0) continue
      try {
        const json = JSON.parse(dataLines.join('\n'))
        events.push({ eventType, json })
      } catch {}
    }
    return events
  }

  _convertEvent(evt) {
    const { eventType, json } = evt
    let out = ''

    switch (json.type || eventType) {
      case 'message_start': {
        this.started = true
        if (json.message?.usage) {
          const n = normalizeUsage(json.message.usage)
          this.inputTokens = n.input
          this.cacheReadTokens = n.cacheRead
          this.cacheCreationTokens = n.cacheCreation
        }
        // 发送初始 chunk（role: assistant）
        out += this._openAIChunk({ role: 'assistant' }, null)
        break
      }

      case 'content_block_start': {
        this.currentBlockIndex = json.index
        this.currentBlockType = json.content_block?.type
        if (this.currentBlockType === 'tool_use') {
          this.toolCallId = json.content_block?.id
          this.toolCallName = json.content_block?.name
          // 发送 tool_call 开始
          out += this._openAIChunk({
            tool_calls: [{
              index: json.index,
              id: this.toolCallId,
              type: 'function',
              function: { name: this.toolCallName, arguments: '' }
            }]
          }, null)
        }
        break
      }

      case 'content_block_delta': {
        const delta = json.delta
        if (!delta) break

        if (delta.type === 'text_delta') {
          out += this._openAIChunk({ content: delta.text }, null)
        } else if (delta.type === 'input_json_delta') {
          out += this._openAIChunk({
            tool_calls: [{
              index: json.index,
              function: { arguments: delta.partial_json }
            }]
          }, null)
        }
        break
      }

      case 'content_block_stop': {
        this.currentBlockType = null
        break
      }

      case 'message_delta': {
        const stopReason = json.delta?.stop_reason
        if (json.usage) {
          const n = normalizeUsage(json.usage)
          if (n.input) this.inputTokens = n.input
          if (n.output) this.outputTokens = n.output
          if (n.cacheRead) this.cacheReadTokens = n.cacheRead
          if (n.cacheCreation) this.cacheCreationTokens = n.cacheCreation
        }
        const finishMap = {
          end_turn: 'stop',
          max_tokens: 'length',
          tool_use: 'tool_calls',
          stop_sequence: 'stop'
        }
        this.finishReason = finishMap[stopReason] || 'stop'
        // 不在这里发 finish，等 message_stop
        break
      }

      case 'message_stop': {
        out += this._openAIChunk({}, this.finishReason || 'stop')
        out += 'data: [DONE]\n\n'
        break
      }

      case 'error': {
        out += this._openAIChunk({ content: `[error: ${json.error?.message || 'unknown'}]` }, 'stop')
        out += 'data: [DONE]\n\n'
        break
      }
    }

    return out
  }

  _openAIChunk(delta, finishReason) {
    const chunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.requestModel,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason
      }]
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }
}

// ----------------------------------------------------------
//  辅助：判断是否需要协议转换
// ----------------------------------------------------------

/**
 * 判断请求协议和上游协议是否兼容
 * @param {string} reqType - 'openai' | 'anthropic'
 * @param {string} upstreamType - 'openai' | 'anthropic'
 * @returns {boolean} true 表示需要转换
 */
export function needsConversion(reqType, upstreamType) {
  return reqType !== upstreamType
}
