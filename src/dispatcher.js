// 路由与故障转移调度：支持顺序故障转移 / 加权轮询 / 协议转换 / 用量统计
import { log } from './logger.js'
import {
  shouldRetry,
  buildUpstreamRequest,
  sendUpstream,
  isSSEResponse,
  StreamForwarder,
  readJSON,
  EmptyStreamError
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
import { normalizeUsage } from './cache/usage.js'

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
 * 应用 modelMap：把请求里的 model 名映射成上游实际支持的 model 名
 * 支持两种 key：
 *   - 精确匹配：{ "claude-3-5-sonnet": "astron-code-latest" }
 *   - 通配匹配：{ "claude-3-5-*": "astron-code-latest" } （* 匹配任意后缀）
 * 精确匹配优先于通配；无匹配则原样返回
 */
function applyModelMap(body, upstream) {
  const map = upstream.modelMap
  if (!map || Object.keys(map).length === 0) return body
  const model = body.model
  if (!model) return body
  // 1. 精确匹配
  if (map[model]) {
    return { ...body, model: map[model] }
  }
  // 2. 通配匹配（key 含 *）：按 key 长度降序，最长前缀优先
  const wildcardKeys = Object.keys(map).filter(k => k.includes('*'))
  for (const k of wildcardKeys.sort((a, b) => b.length - a.length)) {
    // 把 glob 风格 * 转成正则 .*，锚定首尾
    const re = new RegExp('^' + k.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    if (re.test(model)) {
      return { ...body, model: map[k] }
    }
  }
  return body
}

/**
 * 核心调度
 */
export async function dispatch(reqPath, req, res, config, breaker, rateLimiter) {
  const apiType = detectApiType(reqPath)
  if (!apiType) {
    res.status(404).json({ error: { message: `未知路径: ${reqPath}`, type: 'proxy_error', request_id: req.requestId || null } })
    return
  }

  const upstreams = pickUpstreams(apiType, config, breaker)
  if (upstreams.length === 0) {
    res.status(503).json({ error: { message: `没有可用的上游（可能都被熔断）`, type: 'all_upstreams_failed', request_id: req.requestId || null } })
    return
  }

  // 记录本次请求尝试过的上游（用于错误响应里透传给客户端）
  const attempted = []

  // 绑定 requestId 的用量日志闭包（避免每个调用点都传 requestId）
  const requestId = req.requestId || null
  // 归一化 usage：把各协议 cache_read/cache_creation 字段统一，供计费感知
  // rawUsage 可为上游原始 usage 或转换后 JSON 的 usage；二者字段名都被 normalizeUsage 覆盖
  const logUsage2 = (upstream, model, success, usage, startTime, ctx = {}) =>
    _logUsage(config, upstream, model, success, usage, startTime, requestId, ctx)

  const body = req.body
  if (!body) {
    res.status(400).json({ error: { message: '请求体为空', type: 'proxy_error', request_id: req.requestId || null } })
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
        upstreamBody = anthropicToOpenAIRequest(upstreamBody)
      } else if (apiType === 'openai' && upstream.type === 'anthropic') {
        upstreamBody = openaiToAnthropicRequest(upstreamBody)
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

      // ── 限流 acquire ──
      const acquired = await rateLimiter.acquire(upstream.name)
      if (!acquired) {
        log.warn(`[dispatch] ${upstream.name} 并发超限，限流跳过`)
        lastStatus = 429
        lastErr = new Error(`upstream ${upstream.name} rate limited`)
        attempted.push({ upstream: upstream.name, status: 429, error: 'rate limited' })
        break
      }

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
        logUsage2(upstream, originalModel, false, {}, startTime, { usedModel: originalModel, converted: convert, stream: wantStream })
        if (sr < sameRetries) {
          rateLimiter.release(upstream.name)
          await sleep(sameBackoff)
          continue
        }
        // 同上游重试耗尽，整组只记一次熔断
        attempted.push({ upstream: upstream.name, status: 0, error: e.message })
        breaker.recordFail(upstream.name)
        rateLimiter.release(upstream.name)
        break  // 跳出同上游重试，切到下一个上游
      }

      const status = response.status

      if (!shouldRetry(status, null)) {
        breaker.recordSuccess(upstream.name)

        // ── 客户端要流式 ──
        if (wantStream && isSSEResponse(response)) {
          const forwarder = new StreamForwarder(res, opts)
          try {
            if (convert) {
              await forwarder.pipeSSEWithConversion(response, controller, apiType, upstream.type, originalModel)
            } else {
              await forwarder.pipeSSE(response, controller, requestModel)
            }
          } catch (e) {
            // 空流：尚未向客户端写任何数据，可重试/切上游
            if (e instanceof EmptyStreamError) {
              log.warn(`[dispatch] ${upstream.name} 流式响应为空，视为畸形响应`)
              lastStatus = 502
              lastErr = new Error(`upstream ${upstream.name} returned empty stream (HTTP 200)`)
              logUsage2(upstream, originalModel, false, {}, startTime, { usedModel: originalModel, converted: convert, stream: wantStream })
              if (sr >= sameRetries) {
                attempted.push({ upstream: upstream.name, status: 502, error: 'empty stream' })
                breaker.recordFail(upstream.name)
              }
              rateLimiter.release(upstream.name)
              if (sr < sameRetries) {
                await sleep(sameBackoff)
                continue
              }
              break
            }
            rateLimiter.release(upstream.name)
            throw e
          }
          const dur = Date.now() - startTime
          log.info(`[dispatch] ${upstream.name} 流式完成 ${forwarder.bytesSent}B ${dur}ms`)
          logUsage2(upstream, originalModel, true,
            { input: forwarder.inputTokens, output: forwarder.outputTokens || forwarder.bytesSent,
              cacheRead: forwarder.cacheReadTokens, cacheCreation: forwarder.cacheCreationTokens },
            startTime, { usedModel: originalModel, converted: convert, stream: wantStream })
          rateLimiter.release(upstream.name)
          return
        }

        // ── forceStream 聚合：上游流式，客户端要非流式 ──
        if (forceStream && !wantStream && isSSEResponse(response)) {
          const aggregated = await aggregateSSE(response, apiType, upstream.type, convert, requestModel)
          // 空聚合结果（上游流为空或无内容）：视为畸形响应，重试/切上游
          if (!aggregated || typeof aggregated !== 'object' ||
              (aggregated._raw !== undefined && !aggregated._raw)) {
            log.warn(`[dispatch] ${upstream.name} forceStream 聚合结果为空，视为畸形响应`)
            lastStatus = 502
            lastErr = new Error(`upstream ${upstream.name} returned empty aggregation (HTTP 200)`)
            logUsage2(upstream, originalModel, false, {}, startTime, { usedModel: originalModel, converted: convert, stream: wantStream })
            if (sr >= sameRetries) {
              attempted.push({ upstream: upstream.name, status: 502, error: 'empty aggregation' })
              breaker.recordFail(upstream.name)
            }
            rateLimiter.release(upstream.name)
            if (sr < sameRetries) {
              await sleep(sameBackoff)
              continue
            }
            break
          }
          if (typeof aggregated === 'object') aggregated.model = requestModel
          const dur = Date.now() - startTime
          res.status(status).json(aggregated)
          log.info(`[dispatch] ${upstream.name} forceStream 聚合完成 ${dur}ms`)
          logUsage2(upstream, originalModel, true,
            normalizeUsage(aggregated.usage),
            startTime, { usedModel: originalModel, converted: convert, stream: true })
          rateLimiter.release(upstream.name)
          return
        }

        // ── 非流式 JSON ──
        const json = await readJSON(response)

        // 空响应/畸形响应检测：上游返回 200 但 body 为空或非 JSON，
        // 视为上游异常，重试/切上游而不是把空响应转发给客户端
        const isEmpty = !json || (json._raw !== undefined && !json._raw)
        const isMalformed = json && json._raw !== undefined && json._raw && !json._raw.trim().startsWith('{') && !json._raw.trim().startsWith('[')
        if (isEmpty || isMalformed) {
          const reason = isEmpty ? '响应体为空' : '畸形JSON响应'
          log.warn(`[dispatch] ${upstream.name} 返回 200 但${reason}，视为畸形响应`)
          lastStatus = 502
          lastErr = new Error(`upstream ${upstream.name} returned ${isEmpty ? 'empty body' : 'malformed JSON'} (HTTP 200)`)
          logUsage2(upstream, originalModel, false, {}, startTime, { usedModel: originalModel, converted: convert, stream: wantStream })
          if (sr >= sameRetries) {
            attempted.push({ upstream: upstream.name, status: 502, error: isEmpty ? 'empty response body' : 'malformed JSON' })
            breaker.recordFail(upstream.name)
          }
          rateLimiter.release(upstream.name)
          if (sr < sameRetries) {
            await sleep(sameBackoff)
            continue
          }
          break
        }

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
        logUsage2(upstream, originalModel, true,
          normalizeUsage(outJson.usage),
          startTime, { usedModel: originalModel, converted: convert, stream: wantStream })
        rateLimiter.release(upstream.name)
        return
      }

      // 需要重试：先释放信号量
      rateLimiter.release(upstream.name)
      let errText = ''
      try { errText = await response.text() } catch {}
      log.warn(`[dispatch] ${upstream.name} 返回 ${status}${sr < sameRetries ? `，同上游重试` : `，切换下一个上游`}。错误: ${errText.slice(0, 200)}`)
      logUsage2(upstream, originalModel, false, {}, startTime, { usedModel: originalModel, converted: convert, stream: wantStream })

      lastStatus = status
      lastErr = new Error(`upstream ${upstream.name} returned ${status}`)

      // 整组重试耗尽时再 push，避免同组重复
      if (sr >= sameRetries) {
        attempted.push({ upstream: upstream.name, status, error: errText.slice(0, 200) })
      }

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

  // 全部失败：返回结构化代理错误，便于客户端/监控排查
  const msg = lastErr ? lastErr.message : 'all upstreams failed'
  log.error(`[dispatch] 所有上游均失败: ${msg}`)
  if (!res.headersSent) {
    res.status(lastStatus || 502).json({
      error: {
        message: `所有上游 API 均不可用: ${msg}`,
        type: 'all_upstreams_failed',
        last_status: lastStatus,
        request_id: req.requestId || null,
        upstreams_tried: attempted
      }
    })
  }
}

function _logUsage(config, upstream, model, success, usage, startTime, requestId = null, ctx = {}) {
  if (!config.usageLog?.enabled) return
  const duration = Date.now() - startTime
  const u = usage || {}
  logRequest({
    requestId,
    upstream: upstream.name,
    upstreamType: upstream.type,
    model, success,
    usedModel: ctx.usedModel ?? model,
    converted: ctx.converted === true,
    stream: ctx.stream === true,
    inputTokens: u.input || 0,
    outputTokens: u.output || 0,
    cacheReadTokens: u.cacheRead || 0,
    cacheCreationTokens: u.cacheCreation || 0,
    duration
  })
  logUsage({
    upstream: upstream.name,
    model, success,
    inputTokens: u.input || 0,
    outputTokens: u.output || 0,
    cacheReadTokens: u.cacheRead || 0,
    cacheCreationTokens: u.cacheCreation || 0,
    duration
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
