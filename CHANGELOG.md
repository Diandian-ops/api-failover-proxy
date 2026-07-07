# Changelog

本项目所有重要变更均记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-07-07

### Added
- 配置启动校验：port/host/timeout/upstream 等关键字段，错误时给出字段名与当前值，配置文件语法错友好提示。
- 端口冲突友好提示：EADDRINUSE 时指明改 `PROXY_PORT` 或停掉占用程序。
- 优雅关闭：SIGTERM/SIGINT 停接新请求、等待在途请求、10s 超时强退。
- `/health` 扩展：返回 `version` / `uptime` / `breakers`（熔断状态）。
- `/ready` 就绪检查：所有上游熔断或无上游时返回 503，供 K8s/负载均衡流量控制。
- 日志 retention：启动时清理超期日志（`logRetentionDays` / `logRetentionMonths`，可配，默认 30 天 / 6 个月），不影响 `upstreams.db`。
- 单元测试：`convert` / `aggregate` / `circuit-breaker` 三个纯逻辑模块（node:test，零依赖）。
- `CHANGELOG.md`、`CONTRIBUTING.md`。

### Changed
- `npm test` 改为跑单元测试（`node --test test/`，无需启动代理）；原冒烟测试移至 `npm run test:smoke`。
- `/health` 输出新增 version/uptime/breakers 字段。
- `package.json` version 升至 1.1.0。

## [1.0.0] - 2026-07-06

### Added
- 双协议兼容：OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages`。
- 故障自动转移：按序尝试上游，失败/5xx/429 自动切换；同上游快速重试。
- SSE 流式转发：断流检测，已开始输出后断流优雅结束。
- 协议互转：Anthropic ↔ OpenAI 请求/响应/流式双向转换（`enableConversion`）。
- forceStream：对非流式 503 的上游强制流式发起再聚合。
- 熔断保护：连续失败达阈值冷却，半开恢复。
- 号池管理：SQLite 存储，运行时增删改查，admin API 写完 DB 自动热加载。
- 用量统计：按上游×模型 聚合 input/output tokens、请求数、成功/失败、耗时。
- 网关鉴权、Docker 部署、网页端管理界面。
