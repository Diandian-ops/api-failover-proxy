// 缓存计费感知：把各上游/协议返回的 usage 字段统一归一化
// 阶段 1（observe）：只解析不改动请求流，零侵入
//
// 上游无关设计：按字段名探测，不依赖上游类型判定
//   - Anthropic 原生：cache_read_input_tokens / cache_creation_input_tokens
//   - DeepSeek 官方：prompt_cache_hit_tokens（命中=cacheRead）/ prompt_cache_miss_tokens（未命中写入≈cacheCreation）
//   - OpenAI 官方：prompt_tokens_details.cached_tokens（仅命中，无独立写入字段）
//   - 智谱/火山等自动缓存型：多数在前缀稳定时自动命中，usage 里命中数也走上述字段
//
// 估算实际成本（以 input 价为 1 倍）：
//   output×1 + cacheCreation×1.25 + cacheRead×0.1 + (input - cacheRead - cacheCreation)×1
// 自动缓存型通常无 1.25 写入惩罚（或不显式计费），命中即省钱。

/**
 * 归一化 usage
 * @param {object} rawUsage - 上游返回的 usage 对象（可能来自非流式 JSON 或 SSE 事件）
 * @returns {{input:number, output:number, cacheRead:number, cacheCreation:number}}
 */
export function normalizeUsage(rawUsage) {
  const u = rawUsage && typeof rawUsage === 'object' ? rawUsage : {}
  const input = num(u.input_tokens ?? u.prompt_tokens)
  const output = num(u.output_tokens ?? u.completion_tokens)
  // 命中（读取）：多协议字段名探测，取最先命中的
  const cacheRead = num(
    u.cache_read_input_tokens
    ?? u.prompt_cache_hit_tokens
    ?? u.prompt_tokens_details?.cached_tokens
    ?? u.cached_tokens
  )
  // 写入（创建）：Anthropic 显式标记型才有独立字段；DeepSeek 的 miss 表示未命中需写入
  const cacheCreation = num(
    u.cache_creation_input_tokens
    ?? u.prompt_cache_miss_tokens
  )
  return { input, output, cacheRead, cacheCreation }
}

/**
 * 估算实际成本（input 价倍数）。命中越多越省。
 * - input 里已包含 cacheRead + cacheCreation（上游计费口径），故普通部分 = input - cacheRead - cacheCreation
 * - 自动缓存型无 cacheCreation（为 0），命中部分按 0.1x
 */
export function estimateCost({ input, output, cacheRead, cacheCreation }) {
  const normal = Math.max(0, (input || 0) - (cacheRead || 0) - (cacheCreation || 0))
  return (output || 0) * 1 + (cacheCreation || 0) * 1.25 + (cacheRead || 0) * 0.1 + normal * 1
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}
