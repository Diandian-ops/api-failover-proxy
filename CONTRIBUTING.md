# 贡献指南

感谢你愿意为 api-failover-proxy 贡献代码！本文说明本地开发流程与提交规范。

## 本地开发

```bash
git clone https://github.com/Diandian-ops/api-failover-proxy.git
cd api-failover-proxy
npm install
cp config.example.js config.local.js   # 填入你的上游配置
npm run dev          # 开发模式，文件改动自动重启
```

## 测试

```bash
npm test             # 单元测试（无需启动代理）
npm run test:smoke   # 冒烟测试（需先启动代理：npm start &）
```

- 单元测试覆盖 `convert` / `aggregate` / `circuit-breaker` 纯逻辑模块，用 Node 内置 `node:test`，零依赖。
- 改动核心逻辑后，务必跑 `npm test` 确认不回归。

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)，中英文均可：

- `feat:` 新功能
- `fix:` 修复 bug
- `docs:` 文档
- `refactor:` 重构（不改行为）
- `test:` 测试
- `chore:` 杂项

示例：`feat: 新增 /ready 就绪检查端点`

## 提 PR 前自检

1. `npm test` 全绿
2. 改动涉及请求路径时，`npm run test:smoke` 通过
3. 确认无敏感信息泄露：

```bash
git diff origin/main --name-only | grep -iE "config.local|upstreams.db|logs/"
# 应无输出
```

4. 密钥一律走 `process.env.XXX`，不硬编码到任何已提交文件
5. `config.local.js`、`logs/` 已在 `.gitignore`，不要 `git add -f`

## 报告 Issue

提 issue 时请附上：
- 代理版本（`curl http://<host>:<port>/health` 里的 `version`）
- 复现步骤、期望行为、实际行为
- 相关日志（**务必抹掉 API key**）
- 上游类型与协议（openai/anthropic、是否开启 `enableConversion`）

## 代码风格

- ESM、Node ≥18
- 保持现有依赖（`express` + `better-sqlite3`），新增依赖前在 issue/PR 里说明理由
- 注释用中文，与现有代码一致
