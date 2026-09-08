# pi-cc-compat

[English](README.md) | **简体中文**

让 [pi](https://github.com/earendil-works/pi-mono) coding agent 以 Claude Code 客户端的请求形态访问要求 "Claude Code clients only" 的 Anthropic 兼容网关（new-api / one-api 等中转站常见的分组校验）。

不修改 pi 源码、不需要额外常驻进程——就是一个 pi extension + `models.json` 的 headers 配置。

## 原理

部分网关按请求指纹校验客户端身份，仅放行真实 Claude Code。本扩展基于对真实 Claude Code 2.1.259 请求的抓包对比，在 pi 发出的请求上补齐以下内容：

| 层 | 补齐内容 | 实现位置 |
|---|---|---|
| 请求体 | `metadata.user_id`：JSON 格式 `{"device_id":"<64hex>","account_uuid":"","session_id":"<uuid>"}`，device_id 持久化、session_id 每会话变化 | extension（`before_provider_request`） |
| 请求体 | system 前插入两段：billing header（`x-anthropic-billing-header: cc_version=...`）+ Agent SDK 身份段 | extension |
| 请求体 | `thinking.display: "omitted"` 对齐 | extension |
| URL | `/v1/messages?beta=true` | extension（fetch 包装） |
| 请求头 | `x-claude-code-session-id` 自动同步为 `metadata.user_id.session_id`（真实 CC 二者恒等，models.json 里的静态值仅作兜底） | extension（fetch 包装） |
| 请求头 | `Authorization: Bearer`、`user-agent: claude-cli/...`、`x-app`、全套 `X-Stainless-*`、完整 `anthropic-beta` 列表 | `models.json` headers |

鉴权仍使用你自己的网关 API key，只是传递形态从 `x-api-key` 改为 `Authorization: Bearer`。

## 安装

```bash
git clone https://github.com/<you>/pi-cc-compat.git
mkdir -p ~/.pi/agent/extensions/cc-compat
cp pi-cc-compat/extension/index.ts ~/.pi/agent/extensions/cc-compat/
# 可选：自定义配置
cp pi-cc-compat/extension/config.example.json ~/.pi/agent/extensions/cc-compat/config.json
```

pi 按 `~/.pi/agent/extensions/*/index.ts` 约定自动发现并加载，无需注册。扩展只拦截 `claude-*` 模型的请求，不影响其他 provider。

## 配置 models.json

在 `~/.pi/agent/models.json` 的 `providers.anthropic` 块配置（占位符替换为你的网关地址与 key）：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "http://your-gateway.example.com",
      "headers": {
        "Authorization": "Bearer sk-your-gateway-key",
        "User-Agent": "claude-cli/2.1.259 (external, sdk-cli)",
        "x-app": "cli",
        "x-claude-code-session-id": "<一个固定 uuid，作为兜底；扩展会在请求时覆盖为会话 id>",
        "X-Stainless-Lang": "js",
        "X-Stainless-Package-Version": "0.112.1",
        "X-Stainless-OS": "MacOS",
        "X-Stainless-Arch": "arm64",
        "X-Stainless-Runtime": "node",
        "X-Stainless-Runtime-Version": "v26.3.0",
        "X-Stainless-Retry-Count": "0",
        "X-Stainless-Timeout": "600",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24"
      },
      "apiKey": "sk-your-gateway-key"
    }
  }
}
```

说明：

- `apiKey` 必须保留——pi 要求 provider 有 auth 配置才在 `/model` 中可用；实际鉴权以 headers 里的 `Authorization: Bearer` 为准，多发的 `x-api-key` 不影响校验。
- 模型不写 `models` 数组，内置 Claude 模型条目（含 `forceAdaptiveThinking`、价格、上下文元数据）原样保留并走网关。
- 网关地址在本机时，`baseUrl` 建议写 `http://localhost:3000` 而非 `127.0.0.1`（Claude Code 对 IP 字面量行为不同，保持一致少踩坑）。

## 验证

```bash
pi -p "say exactly: ok" --model anthropic/claude-sonnet-5
```

返回 `ok` 即通过。如果返回 `503 ... only allows Claude Code clients`，见下节。

## 失效排查（网关更新校验后）

指纹基于 CC 2.1.259 抓包，网关随时可能收紧校验。标准排查流程：

1. 跑中继代理观测**真实** Claude Code 的当前请求：

   ```bash
   node tools/relay.mjs 9996 http://your-gateway.example.com
   ```

2. 临时修改 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` 为 `http://localhost:9996`（注意：settings.json 的 env 优先级高于 shell 环境变量，用 export 覆盖无效）。

3. 运行一次真实 Claude Code：`claude -p "say ok" --model claude-sonnet-5`，relay 会打印完整请求。

4. 恢复 `~/.claude/settings.json`。

5. 对比差异并同步：
   - `cc_version` / 身份段变化 → 更新 `extension/config.json`
   - beta 列表、新增头 → 更新 `models.json` headers
   - `metadata.user_id` 结构变化 → 更新 `extension/index.ts`

## config.json 字段

| 字段 | 默认值 | 说明 |
|---|---|---|
| `ccVersion` | `"2.1.259.9c8"` | billing header 段中的 cc_version |
| `agentIdentity` | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | system 第二段身份文本 |
| `patchFetch` | `true` | 是否为 /v1/messages 追加 `?beta=true` 并同步 `x-claude-code-session-id` 头 |

`state/device.txt` 为首次运行自动生成的设备指纹，加入 `.gitignore`，勿提交。

## 适用范围与声明

- 本项目用于让 pi 访问**你自己持有 key 的、要求 Claude Code 客户端的网关分组**，不涉及绕过 Anthropic 官方服务的任何计费或访问控制。
- 请遵守你的网关与 Anthropic 的服务条款；因网关校验策略变化导致的失效，本项目不保证及时修复。

## License

MIT
