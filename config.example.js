// ============================================================
//  API Failover Proxy 配置文件
//  复制本文件为 config.local.js 并修改为你自己的 API 配置
// ============================================================

export default {
  // 代理监听端口
  port: process.env.PROXY_PORT || 9090,

  // 监听地址，本机用 127.0.0.1，局域网/容器用 0.0.0.0
  host: process.env.PROXY_HOST || '127.0.0.1',

  // 访问校验：客户端请求需携带该 key（放在 Authorization: Bearer <key>）
  // 留空则不校验
  gatewayKey: process.env.GATEWAY_KEY || '',

  // 单次请求总超时（毫秒），含所有重试
  totalTimeout: 180000,

  // 单个上游连接超时（毫秒）
  connectTimeout: 15000,

  // 首字节超时：建立连接后多久没收到响应就判定失败（毫秒）
  firstByteTimeout: 30000,

  // SSE 流式响应：开始流式输出后，多久没有新数据判定为断流（毫秒）
  streamStallTimeout: 60000,

  // 最大重试次数（不含首次请求）
  maxRetries: 3,

  // 重试之间的退避间隔（毫秒）
  retryBackoffMs: 300,

  // 连续失败 N 次后熔断该上游，单位秒内不再尝试
  circuitBreaker: {
    failThreshold: 5,
    cooldownSec: 60
  },

  // 日志保留：启动时清理超期日志文件（0 表示永不清理）
  logRetentionDays: 30,     // requests-*.jsonl 保留天数
  logRetentionMonths: 6,    // usage-*.jsonl 保留月数

  // 上游 API 列表 —— 按顺序尝试，前面的失败后自动切到后面的
  // type: 'openai'    -> 转发到 {base}/chat/completions
  // type: 'anthropic' -> 转发到 {base}/messages
  // name: 任意标识，用于日志
  // weight: 可选，预留加权轮询（当前实现为顺序故障转移）
  upstreams: [
    {
      name: 'openai-primary',
      type: 'openai',
      base: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY || 'sk-xxxxxxxx',
      // 可选：固定覆盖的 model 前缀映射，例如把 gpt-4o 路由到该上游时强制使用 gpt-4o-2024-08-06
      modelMap: {}
    },
    {
      name: 'openai-backup',
      type: 'openai',
      base: 'https://api.backup.com/v1',
      apiKey: process.env.OPENAI_BACKUP_KEY || 'sk-xxxxxxxx',
      modelMap: {}
    },
    {
      name: 'anthropic-primary',
      type: 'anthropic',
      base: 'https://api.anthropic.com/v1',
      apiKey: process.env.ANTHROPIC_API_KEY || 'sk-ant-xxxxxxxx',
      modelMap: {}
    }
  ]
}
