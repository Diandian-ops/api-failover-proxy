# API Failover Proxy

模型 API 故障自动切换代理。上游不稳定或断连时自动切换到备用上游重试，同时支持 OpenAI 与 Anthropic 两种协议、SSE 流式响应、协议互转、熔断与用量统计。

Node.js (ESM, Node ≥18)，仅依赖 `express` + `better-sqlite3`。

## 特性

- **故障转移**：按顺序或加权策略尝试多个上游，前者失败自动切后者；同上游快速重试应对间歇性 5xx/429。
- **双协议 + 互转**：客户端可用 OpenAI 或 Anthropic 协议；开启转换后任意上游可承接任意协议请求（Anthropic ↔ OpenAI 双向转换，含流式）。
- **SSE 流式**：完整转发流式响应，断流检测与"已开始输出后断流则优雅结束"语义。
- **forceStream**：对非流式会 503 的上游，强制以 `stream:true` 发起再聚合成非流式 JSON 返回。
- **熔断**：连续失败达阈值后冷却该上游，冷却结束半开恢复。
- **号池管理**：上游存于 SQLite，支持运行时增删改查与热加载（写完 DB 自动刷新，无需重启）。
- **用量统计**：按上游×模型 聚合 input/output tokens、请求数、成功/失败、耗时。
- **网关鉴权**：可选统一鉴权 key，避免代理被滥用。
- **Docker 部署**：提供 Dockerfile 和 docker-compose.yml。

## 快速开始

```bash
npm install
cp config.example.js config.local.js   # 填入你的上游配置
npm start
```

默认监听 `http://127.0.0.1:9090`。客户端把 `base_url` 指向该地址，`api_key` 填 `gatewayKey`（留空则不校验）。

配置示例（`config.local.js`）：

```js
upstreams: [
  { name: 'openai-primary',   type: 'openai',    base: 'https://api.openai.com/v1',    apiKey: process.env.OPENAI_API_KEY },
  { name: 'anthropic-primary', type: 'anthropic', base: 'https://api.anthropic.com/v1', apiKey: process.env.ANTHROPIC_API_KEY }
]
```

> 上游按顺序尝试，前者失败自动切后者。`enableConversion=false` 时同类型上游才互相备份；`=true` 时任意类型可互备（自动协议转换）。

### 客户端接入

```python
# OpenAI SDK
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:9090/v1", api_key="你的-key")

# Anthropic SDK
import anthropic
client = anthropic.Anthropic(base_url="http://127.0.0.1:9090", api_key="你的-key")
```

```bash
# Claude Code
ANTHROPIC_BASE_URL=http://127.0.0.1:9090 claude
```

## Docker

```bash
cp config.example.js config.local.js
docker compose up -d
docker compose logs -f
```

## 路由

| 路径 | 说明 |
|------|------|
| `/v1/chat/completions`、`/chat/completions` | OpenAI 协议 |
| `/v1/messages`、`/messages` | Anthropic 协议 |
| `/health` | 健康检查（返回当前生效上游） |
| `/usage` | 用量统计摘要 |
| `/admin/upstreams`（GET/POST/PATCH/DELETE）、`/admin/reload` | 号池管理（需 gatewayKey） |

## 配置项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `port` | 代理监听端口 | 9090 |
| `host` | 监听地址 | 127.0.0.1 |
| `gatewayKey` | 网关鉴权 key，留空则不校验 | '' |
| `totalTimeout` | 单次请求总超时（含重试） | 180000ms |
| `connectTimeout` | 单上游连接超时 | 15000ms |
| `firstByteTimeout` | 首字节超时 | 30000ms |
| `streamStallTimeout` | SSE 流断流超时 | 60000ms |
| `maxRetries` | 跨上游最大重试次数（不含首次） | 3 |
| `sameUpstreamRetries` | 同上游快速重试次数 | 2 |
| `enableConversion` | 是否开启跨协议转换 | false |
| `circuitBreaker.failThreshold` | 熔断阈值 | 5 次 |
| `circuitBreaker.cooldownSec` | 熔断冷却时间 | 60s |

完整字段见 `config.example.js` 注释。`config.local.js` 是本地实际配置，**已被 `.gitignore` 忽略，不要提交**；密钥通过 `process.env.XXX` 读取。

## 架构

```
客户端请求
    │
    ▼
┌─────────────┐
│  Express    │  /v1/chat/completions -> openai 协议
│  路由 + 鉴权 │  /v1/messages        -> anthropic 协议
└──────┬──────┘
       │
       ▼
┌─────────────┐     失败/超时/5xx/429
│  dispatch   │ ──────────────────┐
│  依次尝试上游 │                   │ 同上游快速重试耗尽 → 切下一个上游
└──────┬──────┘                   │
       │ 成功                     ▼
       │                  ┌──────────────┐
       │                  │ 切换下一个上游 │
       │                  │ (跳过熔断的)  │
       │                  └──────────────┘
       ▼
┌─────────────┐
│ 返回客户端   │  流式: SSE 转发 / 转换
│              │  非流式: JSON 返回 / forceStream 聚合
└─────────────┘
```

### 核心模块（src/）

- **server.js** — Express 入口。鉴权中间件、总超时中间件、路由注册。
- **dispatcher.js** — 故障转移调度核心。协议转换判定、`modelMap` 应用、`forceStream` 处理、同上游快速重试 vs 跨上游故障转移。
- **upstream.js** — 上游请求转发。重试判定、按上游类型构造鉴权头、`StreamForwarder` 负责 SSE 转发（含断流检测、流式 usage 解析）。
- **convert.js** — Anthropic ↔ OpenAI 请求体、非流式响应、SSE 流式响应双向转换。
- **aggregate.js** — SSE 流聚合器，把流式响应聚合成完整 JSON（forceStream 场景）。
- **circuit-breaker.js** — 熔断器。
- **upstream-pool.js** — SQLite 号池，运行时增删改查。
- **admin.js** — 号池管理路由，写完 DB 自动热加载。
- **usage-log.js** — 请求日志与用量统计。
- **logger.js** — 日志，`DEBUG=1` 输出调试信息。

### 关键设计点

1. **协议匹配与转换**：`enableConversion=false` 时只选同类型上游；`=true` 时任意类型上游可承接任意请求。客户端协议由路径决定，上游协议由 `upstream.type` 决定。
2. **forceStream**：对非流式会 503 的上游强制流式发起再聚合。
3. **同上游快速重试 vs 跨上游故障转移**：`sameUpstreamRetries` 先对同一上游快速重试几次，耗尽后整组只记一次熔断失败再切上游；`maxRetries` 控制跨上游尝试次数。
4. **流式不可重放**：SSE 一旦开始向客户端输出，中途断流只能优雅结束，不能切换上游重试。
5. **熔断只记一次**：同上游一组重试耗尽才记一次 `recordFail`。
6. **modelMap**：按上游把请求中的 model 名映射到该上游实际支持的 model。

**重试判定规则：**
- 网络错误、连接超时、HTTP 5xx、429 → 重试
- HTTP 4xx（除 429）→ 不重试（请求本身有问题，换上游也没用）
- SSE 流式已开始输出后断流 → 不重试（无法重放，优雅结束）

## 开发与测试

```bash
npm run dev          # node --watch 自动重启
DEBUG=1 npm start    # 调试日志
npm test             # 冒烟测试（需先启动代理）
```

## License

[MIT](./LICENSE)
