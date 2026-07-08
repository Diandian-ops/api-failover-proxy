// 上游请求转发核心：负责把请求体发给指定上游，处理超时、SSE 流式、错误判定
import { log } from './logger.js'
import { normalizeUsage } from './cache/usage.js'

/**
 * 空流错误：上游声明 SSE 但流为空（0 字节就 done），尚未向客户端写任何数据时抛出，
 * 供 dispatcher 捕获后重试/切上游，避免把空响应转发给客户端。
 */
export class EmptyStreamError extends Error {
  constructor(msg = 'upstream stream is empty') {
    super(msg)
    this.name = 'EmptyStreamError'
  }
}

/**
 * 判定是否应该重试该上游
 * - 网络错误、连接超时、5xx、429 重试
 * - 4xx（除 429）不重试（请求本身有问题）
 */
export function shouldRetry(status, err) {
  if (err) return true
  if (status === 0) return true
  if (status >= 500) return true
  if (status === 429) return true
  return false
}

/**
 * 构造发往上游的请求参数
 * @param {object} upstream - config.upstreams[i]
 * @param {string} path - 路径，如 '/chat/completions' 或 '/messages'
 * @param {object} body - 请求体（已解析的 JSON 对象）
 * @param {object} opts - { connectTimeout, firstByteTimeout, streamStallTimeout }
 */
export function buildUpstreamRequest(upstream, reqPath, body, opts) {
  const url = upstream.base.replace(/\/$/, '') + reqPath
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'api-failover-proxy/1.0'
  }
  if (upstream.type === 'openai') {
    headers['Authorization'] = `Bearer ${upstream.apiKey}`
  } else if (upstream.type === 'anthropic') {
    headers['x-api-key'] = upstream.apiKey
    headers['anthropic-version'] = body.anthropic_version || '2023-06-01'
  }
  return {
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    // AbortController 在 caller 里管理
  }
}

/**
 * 发起一次上游请求，返回 { response, firstByteTimer, controller }
 * - connectTimeout: 连接建立超时
 * - firstByteTimeout: 首字节超时
 */
export async function sendUpstream(reqParams, opts) {
  const controller = new AbortController()
  const timers = []

  const connectTimer = setTimeout(() => controller.abort(new Error('connect-timeout')), opts.connectTimeout)
  timers.push(connectTimer)

  let firstByteTimer = null
  let response
  try {
    response = await fetch(reqParams.url, {
      method: reqParams.method,
      headers: reqParams.headers,
      body: reqParams.body,
      signal: controller.signal
    })
  } catch (e) {
    clearTimeout(connectTimer)
    throw e
  }
  clearTimeout(connectTimer)

  // 首字节超时：response 已返回即视为收到首字节，无需额外定时器
  // （fetch resolve 时响应头已到）
  return { response, controller, timers }
}

/**
 * 读取上游响应并判断是否为 SSE 流式
 */
export function isSSEResponse(response) {
  const ct = response.headers.get('content-type') || ''
  return ct.includes('text/event-stream')
}

/**
 * 判断 SSE 流是否已经"提交"——即已经向客户端发送了流式数据
 * 一旦开始流式输出，就不能再切换上游重试了（除非客户端支持重连）
 */
export class StreamForwarder {
  constructor(res, opts) {
    this.res = res
    this.opts = opts
    this.started = false
    this.bytesSent = 0
    this.inputTokens = 0
    this.outputTokens = 0
    this.cacheReadTokens = 0
    this.cacheCreationTokens = 0
    this.stallTimer = null
    this.done = false
    this.aborted = false
    this.controller = null
  }

  /**
   * 开始把上游 SSE 流转发给客户端（无协议转换）
   * requestModel: 客户端请求时的 model 名，用于改写响应里的 model 字段
   */
  async pipeSSE(response, controller, requestModel) {
    this.controller = controller
    const reader = response.body.getReader()

    // SSE 缓冲：chunk 可能跨事件边界，按 \n\n 切完整事件再改写 model
    let sseBuffer = ''
    const decode = new TextDecoder()
    const flushEvents = (final = false) => {
      let idx
      while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
        const rawEvent = sseBuffer.slice(0, idx + 2)
        sseBuffer = sseBuffer.slice(idx + 2)
        this._writeSSEEvent(rawEvent, requestModel)
      }
      if (final && sseBuffer) {
        this._writeSSEEvent(sseBuffer, requestModel)
        sseBuffer = ''
      }
    }

    // 延迟写 header：先读第一个 chunk，若流为空（直接 done）则抛错供 dispatcher 重试
    const ensureHeader = () => {
      if (this.started) return
      this.res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      this.started = true
    }

    const resetStall = () => {
      if (this.stallTimer) clearTimeout(this.stallTimer)
      if (this.opts.streamStallTimeout > 0 && !this.done) {
        this.stallTimer = setTimeout(() => {
          if (!this.done) {
            log.warn('[stream] 流式响应超时断流')
            try { controller.abort(new Error('stream-stall')) } catch {}
            try { reader.cancel().catch(() => {}) } catch {}
          }
        }, this.opts.streamStallTimeout)
      }
    }
    resetStall()

    try {
      // 读第一块：空流则抛 EmptyStreamError（此时还没写 header，可重试）
      const first = await reader.read()
      if (first.done && this.bytesSent === 0) {
        throw new EmptyStreamError()
      }
      if (this.aborted) throw new Error('aborted')
      resetStall()
      ensureHeader()
      if (first.value) {
        sseBuffer += decode.decode(first.value, { stream: true })
        flushEvents(false)
      }

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (this.aborted) break
        resetStall()
        sseBuffer += decode.decode(value, { stream: true })
        flushEvents(false)
      }
      sseBuffer += decode.decode()
      flushEvents(true)
      this.done = true
      if (this.stallTimer) clearTimeout(this.stallTimer)
      this.res.end()
    } catch (e) {
      this.done = true
      if (this.stallTimer) clearTimeout(this.stallTimer)
      // 空流：还没写 header，直接抛出供 dispatcher 重试
      if (e instanceof EmptyStreamError) {
        throw e
      }
      if (this.started && this.bytesSent > 0) {
        log.warn('[stream] 流式中断，已发送部分数据，结束响应', e.message)
        try { this.res.end() } catch {}
      } else {
        try { this.res.end() } catch {}
        throw e
      }
    } finally {
      if (this.stallTimer) clearTimeout(this.stallTimer)
    }
  }

  /**
   * 写出一个 SSE 事件，把 data 行里所有 "model":"xxx" 改写为 requestModel
   * 用 regex 替换，兼容顶层和嵌套（Anthropic message_start 的 message.model）
   * 同时顺带解析 usage（input/output tokens），不改变转发内容
   */
  _writeSSEEvent(rawEvent, requestModel) {
    // 解析 usage：data 行拼接后 JSON.parse，按事件类型取 token
    const dataLines = []
    let eventType = ''
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length) {
      try {
        const json = JSON.parse(dataLines.join('\n'))
        this._extractUsage(json, eventType)
      } catch {} // 解析失败不影响转发
    }

    const buf = (requestModel && rawEvent.includes('"model"'))
      ? Buffer.from(rawEvent.replace(/"model"\s*:\s*"[^"]*"/g, `"model":"${requestModel}"`), 'utf8')
      : Buffer.from(rawEvent, 'utf8')
    this.res.write(buf)
    this.bytesSent += buf.length
  }

  /**
   * 从单个 SSE 事件的 JSON 提取 usage，累加到 inputTokens/outputTokens/cache*
   * 口径与 aggregate.js 一致，经 normalizeUsage 统一各协议字段名：
   *   Anthropic message_start → message.usage.input_tokens（+ cache_read/creation）
   *   Anthropic message_delta → usage.output_tokens（部分上游如讯飞也在此给 input）
   *   OpenAI 顶层 usage（prompt_tokens/completion_tokens + prompt_tokens_details.cached_tokens）
   */
  _extractUsage(json, eventType) {
    if (!json || typeof json !== 'object') return
    if (eventType === 'message_start' || json.type === 'message_start') {
      const u = json.message?.usage
      if (u) {
        const n = normalizeUsage(u)
        if (n.input) this.inputTokens = n.input
        if (n.output) this.outputTokens = n.output
        this.cacheReadTokens = n.cacheRead
        this.cacheCreationTokens = n.cacheCreation
      }
    } else if (eventType === 'message_delta' || json.type === 'message_delta') {
      // 部分上游（如讯飞）在 message_delta 里才给出最终的 input/output tokens
      if (json.usage) {
        const n = normalizeUsage(json.usage)
        if (n.input) this.inputTokens = n.input
        if (n.output) this.outputTokens = n.output
        if (n.cacheRead) this.cacheReadTokens = n.cacheRead
        if (n.cacheCreation) this.cacheCreationTokens = n.cacheCreation
      }
    }
    // OpenAI 流末尾 usage chunk（无 choices 或 choices 空时仍带 usage）
    if (json.usage) {
      const n = normalizeUsage(json.usage)
      if (n.input) this.inputTokens = n.input
      if (n.output) this.outputTokens = n.output
      if (n.cacheRead) this.cacheReadTokens = n.cacheRead
      if (n.cacheCreation) this.cacheCreationTokens = n.cacheCreation
    }
  }

  /**
   * 流式转发 + 协议转换
   * apiType: 客户端请求的协议（'openai' | 'anthropic'）
   * upstreamType: 上游协议（'openai' | 'anthropic'）
   */
  async pipeSSEWithConversion(response, controller, apiType, upstreamType, requestModel) {
    const { OpenAIToAnthropicStreamConverter, AnthropicToOpenAIStreamConverter } =
      await import('./convert.js')

    this.controller = controller
    const reader = response.body.getReader()

    // 选择转换器
    let converter = null
    if (apiType === 'anthropic' && upstreamType === 'openai') {
      converter = new OpenAIToAnthropicStreamConverter(requestModel)
    } else if (apiType === 'openai' && upstreamType === 'anthropic') {
      converter = new AnthropicToOpenAIStreamConverter(requestModel)
    }

    const ensureHeader = () => {
      if (this.started) return
      this.res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      this.started = true
    }

    const resetStall = () => {
      if (this.stallTimer) clearTimeout(this.stallTimer)
      if (this.opts.streamStallTimeout > 0 && !this.done) {
        this.stallTimer = setTimeout(() => {
          if (!this.done) {
            log.warn('[stream] 流式响应（转换）超时断流')
            try { controller.abort(new Error('stream-stall')) } catch {}
            try { reader.cancel().catch(() => {}) } catch {}
          }
        }, this.opts.streamStallTimeout)
      }
    }
    resetStall()

    try {
      // 读第一块：空流则抛 EmptyStreamError（此时还没写 header，可重试）
      const first = await reader.read()
      if (first.done && this.bytesSent === 0) {
        throw new EmptyStreamError()
      }
      if (this.aborted) throw new Error('aborted')
      resetStall()
      ensureHeader()
      if (first.value) {
        const chunkStr = new TextDecoder().decode(first.value)
        if (converter) {
          const converted = converter.feed(chunkStr)
          if (converted) {
            const buf = Buffer.from(converted, 'utf8')
            this.res.write(buf)
            this.bytesSent += buf.length
          }
        } else {
          this.res.write(first.value)
          this.bytesSent += first.value.length
        }
      }

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (this.aborted) break
        resetStall()

        const chunkStr = new TextDecoder().decode(value)
        if (converter) {
          const converted = converter.feed(chunkStr)
          if (converted) {
            const buf = Buffer.from(converted, 'utf8')
            this.res.write(buf)
            this.bytesSent += buf.length
          }
        } else {
          this.res.write(value)
          this.bytesSent += value.length
        }
      }
      // flush 转换器
      if (converter) {
        const rest = converter.flush()
        if (rest) {
          const buf = Buffer.from(rest, 'utf8')
          this.res.write(buf)
          this.bytesSent += buf.length
        }
        // 转换器内部已累加 input/output/cache tokens，读到 forwarder 上
        if (typeof converter.inputTokens === 'number') this.inputTokens = converter.inputTokens
        if (typeof converter.outputTokens === 'number') this.outputTokens = converter.outputTokens
        if (typeof converter.cacheReadTokens === 'number') this.cacheReadTokens = converter.cacheReadTokens
        if (typeof converter.cacheCreationTokens === 'number') this.cacheCreationTokens = converter.cacheCreationTokens
      }
      this.done = true
      if (this.stallTimer) clearTimeout(this.stallTimer)
      this.res.end()
    } catch (e) {
      this.done = true
      if (this.stallTimer) clearTimeout(this.stallTimer)
      // 空流：还没写 header，直接抛出供 dispatcher 重试
      if (e instanceof EmptyStreamError) {
        throw e
      }
      if (this.started && this.bytesSent > 0) {
        log.warn('[stream] 转换流式中断，已发送部分数据', e.message)
        try { this.res.end() } catch {}
      } else {
        try { this.res.end() } catch {}
        throw e
      }
    } finally {
      if (this.stallTimer) clearTimeout(this.stallTimer)
    }
  }
}

/**
 * 读取非流式 JSON 响应
 */
export async function readJSON(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text }
  }
}
