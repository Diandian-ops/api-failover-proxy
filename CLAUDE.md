# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

模型 API 故障自动切换代理。上游不稳定/断连时自动切换到备用上游重试，同时支持 OpenAI 与 Anthropic 两种协议，支持 SSE 流式响应、协议转换、熔断、用量统计。Node.js (ESM, Node ≥18)，仅依赖 `express`。

## 常用命令

```bash
npm install          # 安装依赖
npm start            # 启动生产模式：node src/server.js
npm run dev          # 开发模式：node --watch src/server.js（文件改动自动重启）
npm test             # 冒烟测试（需先启动代理）
DEBUG=1 npm start    # 开启调试日志

# Docker
docker compose up -d
docker compose logs -f
```

冒烟测试需要代理已运行（默认 `http://127.0.0.1:8787`）：
```bash
npm start &
PROXY_URL=http://127.0.0.1:8787 npm test
```

## 配置

- `config.example.js` — 配置模板，提交到仓库
- `config.local.js` — 实际配置，**被 .gitignore 忽略，不要提交**
- `src/config.js` — 加载器：优先 `config.local.js`，回退 `config.example.js`

**安全提示：** `config.local.js` 是本地实际配置，已被 `.gitignore` 忽略，不要提交。密钥应通过 `process.env.XXX` 读取，不要把密钥写进 `config.example.js` 或任何已提交文件。

启动后客户端把 base_url 指向 `http://127.0.0.1:8787`，`api_key` 填 `gatewayKey`（或留空则不校验）。

## 架构

请求流：`客户端 → Express 路由 → dispatch() → 依次尝试上游 → 返回（SSE 转发 / 聚合 / JSON）`

### 核心模块（src/）

- **server.js** — Express 入口。注册鉴权中间件（校验 `gatewayKey`，校验后删除 `Authorization` 头避免转发给上游）、请求总超时中间件、路由（`/v1/chat/completions`、`/v1/messages` 及无 `v1` 前缀的变体）、`/health`、`/usage`。所有路由委托给 `breakerWrap` → `dispatch`。
- **dispatcher.js** — 故障转移调度核心。`detectApiType()` 按路径判定 openai/anthropic；`pickUpstreams()` 按调度策略（`failover` 顺序 / `weighted` 加权随机）筛选未熔断上游；`dispatch()` 是主循环，负责协议转换判定、`modelMap` 应用、`forceStream` 处理、同上游快速重试、跨上游故障转移。
- **upstream.js** — 上游请求转发。`shouldRetry(status, err)` 定义重试判定（网络错误/5xx/429 重试，其他 4xx 不重试）；`buildUpstreamRequest()` 按上游类型构造鉴权头（openai 用 `Authorization: Bearer`，anthropic 用 `x-api-key` + `anthropic-version`）；`StreamForwarder` 类负责 SSE 流转发，含断流检测（`streamStallTimeout`）和"已开始输出后断流则优雅结束不重试"语义。
- **convert.js** — 协议转换：Anthropic ↔ OpenAI 的请求体、非流式响应、SSE 流式响应双向转换。`needsConversion(apiType, upstreamType)` 判定是否需要转换。
- **aggregate.js** — SSE 流聚合器（`AnthropicStreamAggregator` / `OpenAIStreamAggregator`），把流式响应聚合成完整 JSON，供 `forceStream` 场景使用。
- **circuit-breaker.js** — 熔断器。连续失败达 `failThreshold` 次后冷却 `cooldownSec` 秒；冷却结束后半开（清空计数）。
- **usage-log.js** — 请求日志（按天 jsonl）和用量统计（按月 jsonl，按 upstream×model 聚合），`/usage` 端点读取。
- **logger.js** — 简单日志，`DEBUG=1` 输出调试信息。

### 关键设计点

1. **协议匹配与转换**：`enableConversion=false` 时只选同类型上游（openai 备 openai，anthropic 备 anthropic）；`=true` 时任意类型上游可承接任意请求，由 `convert.js` 做双向转换。客户端协议由路径决定，上游协议由 `upstream.type` 决定。
2. **forceStream**：某些上游（如讯飞）非流式会 503，`forceStream=true` 强制以 `stream:true` 发起，再由 `aggregate.js` 聚合成非流式 JSON 返给客户端。流式请求则直接转发流。
3. **同上游快速重试 vs 跨上游故障转移**：`sameUpstreamRetries` 先对同一上游快速重试几次（应对间歇性 503/429），耗尽后整组只记一次熔断失败，再切到下一个上游。`maxRetries` 控制跨上游尝试次数（不含首次，且不超过 `upstreams.length - 1`）。
4. **流式不可重放**：SSE 一旦开始向客户端输出（`started && bytesSent > 0`），中途断流只能优雅结束，不能切换上游重试（除非尚未开始输出）。
5. **熔断只记一次**：同上游一组重试耗尽才记一次 `recordFail`，避免单次请求把计数打满。
6. **modelMap**：按上游把请求中的 model 名映射到该上游实际支持的 model（如 `claude-3-5-sonnet` → `astron-code-latest`）。

### 路由

| 路径 | 客户端协议 |
|------|-----------|
| `/v1/chat/completions`, `/chat/completions` | OpenAI |
| `/v1/messages`, `/messages` | Anthropic |
| `/health` | 健康检查 |
| `/usage` | 用量统计 |

## 注意事项

- `config.local.js` 是本地实际配置，已被 `.gitignore` 忽略；密钥应通过 `process.env.XXX` 读取，避免泄露到提交文件或日志。
- 上游按 `config.upstreams` 顺序尝试（failover 模式），前面失败自动切后面。
- 同类型上游才会互相备份，除非开启 `enableConversion` 做跨协议转换。

## 开发规范

- **密钥**：一律通过 `process.env.XXX` 读取，禁止硬编码到任何已提交文件（源码、配置模板、文档、日志）。
- **不提交的文件**：`config.local.js`、`logs/`（含 `upstreams.db*`、`*.jsonl`）、`node_modules/`、`.aionrs/` 已在 `.gitignore`；新增运行时产物若含敏感信息，记得补进 `.gitignore`。
- **提交前自检**：`git show --stat HEAD --name-only | grep -iE "config.local|upstreams.db|logs/|sk-[a-z0-9]{20}"`，无输出才算干净。
- **提交信息**：用 Conventional Commits（`feat` / `fix` / `docs` / `refactor` / `chore` 等），中英文均可。
- **测试**：改动后运行 `npm test`（需先启动代理）确认冒烟测试通过；测试未过不要标记完成。
- **代码风格**：ESM、Node ≥18、保持现有依赖（`express` + `better-sqlite3`），新增依赖前说明理由。
- **号池改动**：走 admin API / 网页端（写完 DB 自动热加载），不要直接改 SQLite 文件后忘 reload。

