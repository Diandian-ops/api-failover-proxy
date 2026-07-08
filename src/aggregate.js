// SSE 流式响应聚合器：把 SSE 流聚合成完整的 JSON 响应
// 用于 forceStream 场景（如讯飞只支持流式，但客户端要非流式）

import { normalizeUsage } from './cache/usage.js'

/**
 * Anthropic SSE 流 → Anthropic 非流式 JSON
 * 解析 message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop
 */
export class AnthropicStreamAggregator {
  constructor() {
    this.result = {
      id: '',
      type: 'message',
      role: 'assistant',
      content: [],
      model: '',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    }
    this.currentBlock = null
    this.toolInputBuffer = ''
    this.buffer = ''
    this.done = false
  }

  feed(chunk) {
    this.buffer += chunk
    const events = this._extractEvents()
    for (const evt of events) {
      this._handleEvent(evt)
      if (evt.type === 'message_stop') this.done = true
    }
  }

  getResult() {
    return this.result
  }

  _extractEvents() {
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
        events.push({ type: json.type || eventType, json })
      } catch {}
    }
    return events
  }

  _handleEvent(evt) {
    const { type, json } = evt
    switch (type) {
      case 'message_start': {
        const msg = json.message || {}
        this.result.id = msg.id || ''
        this.result.model = msg.model || ''
        if (msg.usage) {
          const n = normalizeUsage(msg.usage)
          this.result.usage.input_tokens = n.input
          this.result.usage.cache_read_input_tokens = n.cacheRead
          this.result.usage.cache_creation_input_tokens = n.cacheCreation
        }
        break
      }
      case 'content_block_start': {
        const block = json.content_block || {}
        this.currentBlock = { ...block, index: json.index }
        if (block.type === 'text') {
          this.currentBlock.text = ''
        } else if (block.type === 'tool_use') {
          this.currentBlock.input = {}
          this.toolInputBuffer = ''
        }
        break
      }
      case 'content_block_delta': {
        const delta = json.delta || {}
        if (delta.type === 'text_delta' && this.currentBlock) {
          this.currentBlock.text += delta.text
        } else if (delta.type === 'input_json_delta' && this.currentBlock) {
          this.toolInputBuffer += delta.partial_json
        }
        break
      }
      case 'content_block_stop': {
        if (this.currentBlock) {
          if (this.currentBlock.type === 'tool_use') {
            try { this.currentBlock.input = JSON.parse(this.toolInputBuffer || '{}') } catch {}
            delete this.currentBlock.index
            this.result.content.push({
              type: 'tool_use',
              id: this.currentBlock.id,
              name: this.currentBlock.name,
              input: this.currentBlock.input
            })
          } else if (this.currentBlock.type === 'text') {
            this.result.content.push({
              type: 'text',
              text: this.currentBlock.text
            })
          }
          this.currentBlock = null
        }
        break
      }
      case 'message_delta': {
        const delta = json.delta || {}
        if (delta.stop_reason) this.result.stop_reason = delta.stop_reason
        if (delta.stop_sequence !== undefined) this.result.stop_sequence = delta.stop_sequence
        if (json.usage) {
          const n = normalizeUsage(json.usage)
          if (n.output) this.result.usage.output_tokens = n.output
          if (n.input) this.result.usage.input_tokens = n.input
          if (n.cacheRead) this.result.usage.cache_read_input_tokens = n.cacheRead
          if (n.cacheCreation) this.result.usage.cache_creation_input_tokens = n.cacheCreation
        }
        break
      }
      case 'message_stop': {
        this.done = true
        break
      }
    }
  }
}

/**
 * OpenAI SSE 流 → OpenAI 非流式 JSON
 */
export class OpenAIStreamAggregator {
  constructor(model) {
    this.model = model
    this.result = {
      id: '',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: null
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }
    }
    this.toolCalls = []
    this.buffer = ''
    this.done = false
  }

  feed(chunk) {
    this.buffer += chunk
    const events = this._extractEvents()
    for (const evt of events) {
      this._handleEvent(evt)
    }
  }

  getResult() {
    const choice = this.result.choices[0]
    if (this.toolCalls.length > 0) {
      choice.message.tool_calls = this.toolCalls
    }
    this.result.usage.total_tokens = this.result.usage.prompt_tokens + this.result.usage.completion_tokens
    return this.result
  }

  _extractEvents() {
    const events = []
    while (true) {
      const idx = this.buffer.indexOf('\n\n')
      if (idx === -1) break
      const raw = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      const lines = raw.split('\n')
      const dataLines = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
      if (dataLines.length === 0) continue
      const dataStr = dataLines.join('\n')
      if (dataStr === '[DONE]') {
        events.push({ done: true })
        continue
      }
      try {
        events.push({ json: JSON.parse(dataStr) })
      } catch {}
    }
    return events
  }

  _handleEvent(evt) {
    if (evt.done) { this.done = true; return }
    const json = evt.json
    if (!this.result.id && json.id) this.result.id = json.id
    if (json.model && !this.model) this.model = json.model

    // usage 提取必须在 choice 检查之前：流末尾 usage chunk 的 choices 可能为空
    if (json.usage) {
      const n = normalizeUsage(json.usage)
      this.result.usage.prompt_tokens = n.input
      this.result.usage.completion_tokens = n.output
      this.result.usage.cache_read_tokens = n.cacheRead
      this.result.usage.cache_creation_tokens = n.cacheCreation
    }

    const choice = json.choices?.[0]
    if (!choice) return

    const delta = choice.delta || {}
    if (delta.role && !this.result.choices[0].message.role) {
      this.result.choices[0].message.role = delta.role
    }
    if (delta.content) {
      this.result.choices[0].message.content += delta.content
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (!this.toolCalls[idx]) {
          this.toolCalls[idx] = {
            id: tc.id,
            type: 'function',
            function: { name: '', arguments: '' }
          }
        }
        if (tc.function?.name) this.toolCalls[idx].function.name += tc.function.name
        if (tc.function?.arguments) this.toolCalls[idx].function.arguments += tc.function.arguments
      }
    }
    if (choice.finish_reason) {
      this.result.choices[0].finish_reason = choice.finish_reason
    }
  }
}
