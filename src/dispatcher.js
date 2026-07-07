// 路由与故障转移调度：支持顺序故障转移 / 加权轮询 / 协议转换 / 用量统计
import { log } from './logger.js'
import {
  shouldRetry,
  buildUpstreamRequest,
  sendUpstream,
  isSSEResponse,
  StreamForwarder,
  readJSON
} from './upstream.js'
import {
  needsConversion,
  anthropicToOpenAIRequest,
  openaiToAnthropicRequest,
  openaiToAnthropicResponse,
  anthropicToOpenAIResponse,
  OpenAIToAnthropicStreamConverter,
  AnthropicToOpenAIStreamConverter
} from './convert.js'
import { logRequest, logUsage } from './usage-log.js'
import { AnthropicStreamAggregator, OpenAIStreamAggregator } from './aggregate.js'

/**
 * 根据请求路径判断接口类型
 */
export function detectApiType(reqPath) {
  if (reqPath.includes('/chat/completions')) return 'openai'
  if (reqPath.includes('/messages')) return 'anthropic'
  return null
}

/**
 * 选择上游列表
 * - failover：按 config 顺序，跳过熔断的
 * - weighted：按权重加权随机排序，跳过熔断的
 */
export function pickUpstreams(apiType, config, breaker) {
  let pool = config.upstreams.filter(u => !breaker.isOpen(u.name))

  // 协议转换启用时，所有上游都可以承接任意类型请求
  // 协议转换未启用时，只选同类型的
  if (!config.enableConversion) {
    pool = pool.filter(u => u.type === apiType)
  }

  if (pool.length === 0) return []

  if (config.scheduleStrategy === 'weighted') {
    pool = weightedShuffle(pool)
  }
  // failover 模式：保持原顺序
  return pool
}

function weightedShuffle(pool) {
  // 加权随机：按权重随机排序，权重大的优先
  const arr = pool.map(u => ({ u, w: u.weight || 1, r: Math.random() * (u.weight || 1) }))
  arr.sort((a, b) => b.r - a.r)
  return arr.map(x => x.u)
}

/**
 * 应用 modelMap
 */
function applyModelMap(body, upstream) {
  if (!upstream.modelMap || Object.keys(upstream.modelMap).length === 0) return body
  if (body.model && upstream.modelMap[body.model]) {
    return { ...body, model: upstream.modelMap[body.model] }
  }
  return body
}

/**
 * 核心调度
 */
export async function dispatch(reqPath, req, res, config, breaker) {
  const apiType = detectApiType(reqPath)
  if (!apiType) {
    res.status(404).json({ error: { message: `未知路径: ${reqPath}`, type: 'proxy_error' } })
    return
  }

  const upstreams = pickUpstreams(apiType, config, breaker)
  if (upstreams.length === 0) {
    res.status(503).json({ error: { message: `没有可用的上游（可能都被熔断）`, type: 'proxy_error' } })
    return
  }

  const body = req.body
  if (!body) {
    res.status(400).json({ error: { message: '请求体为空', type: 'proxy_error' } })
    return
  }

  const opts = {
    connectTimeout: config.connectTimeout,
    firstByteTimeout: config.firstByteTimeout,
    streamStallTimeout: config.streamStallTimeout
  }

  const maxRetries = Math.min(config.maxRetries, upstreams.length - 1)
  // 全局默认值，每上游可在 DB 里覆盖
  const globalSameRetries = config.sameUpstreamRetries || 0
  const globalSameBackoff = config.sameUpstreamRetryBackoffMs || 500
  let lastErr = null
  let lastStatus = 0
  const startTime = Date.now()
  const requestModel = body.model || 'unknown'

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const upstream = upstreams[attempt]
    if (!upstream) break

    // 每上游的重试次数和退避间隔（DB 字段优先，回退全局配置）
    const sameRetries = upstream.sameRetries ?? globalSameRetries
    const sameBackoff = upstream.sameRetryBackoffMs ?? globalSameBackoff

    const wantStream = body.stream === true
    const convert = config.enableConversion && needsConversion(apiType, upstream.type)
    // forceStream: 上游只支持流式（如讯飞），强制用流式发起，代理聚合成非流式返回
    const forceStream = upstream.forceStream === true
    const upstreamStream = wantStream || forceStream

    // ── 构造请求体 ──
    let upstreamBody = applyModelMap(body, upstream)
    let originalModel = upstreamBody.model

    if (convert) {
      if (apiType === 'anthropic' && upstream.type === 'openai') {
        upstreamBody = anthropicToOpenAIRequest(upstreamBody, upstream.modelMap || {})
      } else if (apiType === 'openai' && upstream.type === 'anthropic') {
        upstreamBody = openaiToAnthropicRequest(upstreamBody, upstream.modelMap || {})
      }
    }

    // forceStream：强制把 stream 设为 true
    if (forceStream) {
      upstreamBody = { ...upstreamBody, stream: true }
    }

    const upstreamPath = upstream.type === 'openai' ? '/chat/completions' : '/messages'
    const reqParams = buildUpstreamRequest(upstream, upstreamPath, upstreamBody, opts)

    // ── 同上游快速重试（应对讯飞等间歇性 503）──
    let success = false
    for (let sr = 0; sr <= sameRetries; sr++) {
      log.info(`[dispatch] 第 ${attempt + 1}/${maxRetries + 1} 次 -> ${upstream.name}${sr > 0 ? ` 同上游重试 ${sr}/${sameRetries}` : ''} (${upstream.type})${convert ? ` [协议转换 ${apiType}→${upstream.type}]` : ''}${forceStream ? ' [forceStream]' : ''} stream=${upstreamStream}`)

      // ── 发送请求 ──
      let response, controller
      try {
        const r = await sendUpstream(reqParams, opts)
        response = r.response
        controller = r.controller
      } catch (e) {
        lastErr = e
        lastStatus = 0
        log.warn(`[dispatch] ${upstream.name} 连接失败: ${e.message}`)
        _logUsage(config, upstream, originalModel, false, 0, 0, startTime)
        if (sr < sameRetries) { await sleep(sameBackoff); continue }
        // 同上游重试耗尽，整组只记一次熔断
        breaker.recordFail(upstream.name)
        break  // 跳出同上游重试，切到下一个上游
      }

      const status = response.status

      if (!shouldRetry(status, null)) {
        breaker.recordSuccess(upstream.name)

        // ── 客户端要流式 ──
        if (wantStream && isSSEResponse(response)) {
          const forwarder = new StreamForwarder(res, opts)
          if (convert) {
            await forwarder.pipeSSEWithConversion(response, controller, apiType, upstream.type, originalModel)
          } else {
            await forwarder.pipeSSE(response, controller, requestModel)
          }
          const dur = Date.now() - startTime
          log.info(`[dispatch] ${upstream.name} 流式完成 ${forwarder.bytesSent}B ${dur}ms`)
          _logUsage(config, upstream, originalModel, true,
            forwarder.inputTokens,
            forwarder.outputTokens || forwarder.bytesSent,
            startTime)
          return
        }

        // ── forceStream 聚合：上游流式，客户端要非流式 ──
        if (forceStream && !wantStream && isSSEResponse(response)) {
          const aggregated = await aggregateSSE(response, apiType, upstream.type, convert, requestModel)
          if (aggregated && typeof aggregated === 'object') aggregated.model = requestModel
          const dur = Date.now() - startTime
          res.status(status).json(aggregated)
          log.info(`[dispatch] ${upstream.name} forceStream 聚合完成 ${dur}ms`)
          _logUsage(config, upstream, originalModel, true,
            aggregated.usage?.input_tokens || aggregated.usage?.prompt_tokens || 0,
            aggregated.usage?.output_tokens || aggregated.usage?.completion_tokens || 0,
            startTime)
          return
        }

        // ── 非流式 JSON ──
        const json = await readJSON(response)

        // 协议转换：响应体转换
        let outJson = json
        if (convert) {
          if (apiType === 'anthropic' && upstream.type === 'openai') {
            outJson = openaiToAnthropicResponse(json, requestModel)
          } else if (apiType === 'openai' && upstream.type === 'anthropic') {
            outJson = anthropicToOpenAIResponse(json, requestModel)
          }
        }
        // 统一把 model 改回客户端请求的模型名，避免客户端因 model 名不认识而禁用功能
        if (outJson && typeof outJson === 'object') outJson.model = requestModel

        res.status(status).json(outJson)
        const dur = Date.now() - startTime
        log.info(`[dispatch] ${upstream.name} 非流式完成 status=${status} ${dur}ms`)
        _logUsage(config, upstream, originalModel, true,
          outJson.usage?.input_tokens || outJson.usage?.prompt_tokens || 0,
          outJson.usage?.output_tokens || outJson.usage?.completion_tokens || 0,
          startTime)
        return
      }

      // 需要重试
      let errText = ''
      try { errText = await response.text() } catch {}
      log.warn(`[dispatch] ${upstream.name} 返回 ${status}${sr < sameRetries ? `，同上游重试` : `，切换下一个上游`}。错误: ${errText.slice(0, 200)}`)
      _logUsage(config, upstream, originalModel, false, 0, 0, startTime)

      lastStatus = status
      lastErr = new Error(`upstream ${upstream.name} returned ${status}`)

      if (sr < sameRetries) {
        await sleep(sameBackoff)
        continue
      }
      // 同上游重试耗尽，整组只记一次熔断
      breaker.recordFail(upstream.name)
      break
    }

    if (attempt < maxRetries) {
      await sleep(config.retryBackoffMs)
      continue
    }
  }

  // 全部失败
  const msg = lastErr ? lastErr.message : 'all upstreams failed'
  log.error(`[dispatch] 所有上游均失败: ${msg}`)
  if (!res.headersSent) {
    res.status(lastStatus || 502).json({
      error: { message: `所有上游 API 均不可用: ${msg}`, type: 'proxy_error', last_status: lastStatus }
    })
  }
}

function _logUsage(config, upstream, model, success, inputTokens, outputTokens, startTime) {
  if (!config.usageLog?.enabled) return
  const duration = Date.now() - startTime
  logRequest({
    upstream: upstream.name,
    upstreamType: upstream.type,
    model, success, inputTokens, outputTokens, duration
  })
  logUsage({
    upstream: upstream.name,
    model, success, inputTokens, outputTokens, duration
  })
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * 把上游 SSE 流聚合成非流式 JSON 响应
 * - 同协议：直接用对应聚合器
 * - 跨协议：先用上游协议聚合，再转换成客户端协议的 JSON
 */
async function aggregateSSE(response, apiType, upstreamType, convert, requestModel) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  // 选择聚合器（按上游协议）
  let agg
  if (upstreamType === 'anthropic') {
    agg = new AnthropicStreamAggregator()
  } else {
    agg = new OpenAIStreamAggregator(requestModel)
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    agg.feed(decoder.decode(value, { stream: true }))
  }
  // flush
  agg.feed(decoder.decode())

  let result = agg.getResult()

  // 跨协议转换（非流式 JSON 转换）
  if (convert) {
    if (apiType === 'anthropic' && upstreamType === 'openai') {
      result = openaiToAnthropicResponse(result, requestModel)
    } else if (apiType === 'openai' && upstreamType === 'anthropic') {
      result = anthropicToOpenAIResponse(result, requestModel)
    }
  }

  return result
}
