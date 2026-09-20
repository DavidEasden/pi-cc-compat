# pi-cc-compat

[English](README.md) | **简体中文**

让 [pi](https://github.com/earendil-works/pi-mono) coding agent 以 Claude Code 客户端的请求形态访问要求 "Claude Code clients only" 的 Anthropic 兼容网关（new-api / one-api 等中转站常见的分组校验）。

不修改 pi 源码、不需要额外常驻进程——就是一个 pi extension + `models.json` 的 headers 配置。

## 原理

部分网关按请求指纹校验客户端身份，仅放行真实 Claude Code。本扩展基于对真实 Claude Code 2.1.270（build 2026-09-12）请求的抓包对比，在 pi 发出的请求上补齐以下内容：

| 层 | 补齐内容 | 实现位置 |
|---|---|---|
| 请求体 | `metadata.user_id`：JSON 格式 `{"device_id":"<64hex>","account_uuid":"","session_id":"<uuid>"}`，device_id 持久化、session_id 每会话变化 | extension（`before_provider_request`） |
| 请求体 | system 前插入两段：billing header + Agent SDK 身份段。billing header 形如 `x-anthropic-billing-header: cc_version=2.1.270.<3hex>; cc_entrypoint=sdk-cli;`，其中后缀逐请求派生（使用 0 基下标 4/7/20，见下） | extension |
| 请求体 | `thinking.display: "omitted"` 对齐 | extension |
| URL | `/v1/messages?beta=true` | extension（fetch 包装） |
| 请求头 | `x-claude-code-session-id` 自动同步为 `metadata.user_id.session_id`（真实 CC 二者恒等，models.json 里的静态值仅作兜底） | extension（fetch 包装） |
| 请求头 | `Authorization: Bearer`、`user-agent: claude-cli/2.1.270 (external, sdk-cli)`、`x-app`、全套 `X-Stainless-*`、完整 `anthropic-beta` 列表 | `models.json` headers |

### 关于 `cc_version`

真实 Claude Code 的 `cc_version` 不是固定值。2.1.270 的算法是：

```
suffix = sha256("59cf53e54c78" + s + "2.1.270").hex.slice(0, 3)
s      = [4, 7, 20].map(i => 首条 user 消息文本[i] || "0").join("")
```

即取首条 user 消息文本的 0 基下标 4/7/20。已用两次真实抓包校准：首条消息 `"say ok"` → `2.1.270.4c5`，`"hi"` → `2.1.270.ffc`。扩展复现的就是这个派生过程，不再发送写死的值；只有需要精确固定某个字符串时才设 `config.json` 里的 `ccVersion`。

### 关于 `cch`

Claude Code 的 billing header 里还有一段 `cch=`，但**当 `ANTHROPIC_BASE_URL` 指向网关时（也就是本扩展的场景）它根本不会被发送**。只有在等效 base URL 为 `api.anthropic.com`（或设了 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`）时才出现；而且即使出现，二进制里那个字面量 `cch=00000;` 也只是占位符，发出前会被替换成两次相同请求都不一样的值（实测出现过的 `cch` 值：`032a5`、`30ebd`、`c0f1a`）。

所以扩展默认不发送 `cch`，与真实 Claude Code 在网关后的实际行为一致。如果你的网关明确要求，再在 `config.json` 里设 `cch`。

### 关于 `thinking`

真实 Claude Code 2.1.270 发的是 `thinking: {"type":"adaptive","display":"omitted"}`。内建 Claude 模型（`forceAdaptiveThinking`）pi 本来就发 `type: "adaptive"`，所以扩展只把 `display` 对齐为 `"omitted"`，不动 pi 选定的 `type`；配成非 adaptive `thinking` 的模型保持原形态。

鉴权仍使用你自己的网关 API key，只是传递形态从 `x-api-key` 改为 `Authorization: Bearer`。

## 安装

### 作为 pi 包安装（推荐）

```bash
pi install npm:pi-cc-compat
# 或直接从 GitHub 安装（无需发布 npm）：
pi install git:github.com/DavidEasden/pi-cc-compat@v0.1.3
```

### 手动安装

```bash
git clone https://github.com/DavidEasden/pi-cc-compat.git
mkdir -p ~/.pi/agent/extensions/cc-compat
cp pi-cc-compat/extension/index.ts ~/.pi/agent/extensions/cc-compat/
```

pi 按 `~/.pi/agent/extensions/*/index.ts` 约定自动发现并加载，无需注册。扩展只拦截 `claude-*` 模型的请求，不影响其他 provider。

### 可选：自定义配置

```bash
mkdir -p ~/.pi/agent/cc-compat
cp pi-cc-compat/extension/config.example.json ~/.pi/agent/cc-compat/config.json
```

## 配置 models.json

在 `~/.pi/agent/models.json` 的 `providers.anthropic` 块配置（占位符替换为你的网关地址与 key）：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "http://your-gateway.example.com",
      "headers": {
        "Authorization": "Bearer sk-your-gateway-key",
        "User-Agent": "claude-cli/2.1.270 (external, sdk-cli)",
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
- 上面 `anthropic-beta` 列表与每个 `X-Stainless-*` 值都已核对为与真实 2.1.270 请求逐字节一致；需要跟进 Claude Code 版本的只有 `User-Agent`。

## 验证

```bash
pi -p "say exactly: ok" --model anthropic/claude-sonnet-5
```

返回 `ok` 即通过。如果返回 `503 ... only allows Claude Code clients`，见下节。

## 失效排查（网关更新校验后）

指纹基于 CC 2.1.270 抓包，网关随时可能收紧校验。标准排查流程：

1. 跑中继代理观测**真实** Claude Code 的当前请求（上游支持 `http://` 与 `https://`）：

   ```bash
   node tools/relay.mjs 9996 http://your-gateway.example.com
   ```

2. 临时修改 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` 为 `http://localhost:9996`（注意：settings.json 的 env 优先级高于 shell 环境变量，用 export 覆盖无效）。

3. 运行一次真实 Claude Code：`claude -p "say ok" --model claude-sonnet-5`，relay 会打印完整请求。

4. 恢复 `~/.claude/settings.json`。

5. 对比差异并同步：
   - `cc_version` / 身份段变化 → 更新 `extension/index.ts` 里的派生算法（或用 `config.json` 的 `ccVersion` 固定）
   - beta 列表、新增头 → 更新 `models.json` headers
   - `metadata.user_id` 结构变化 → 更新 `extension/index.ts`
   - 网关场景下也开始出现 `cch=` 段 → 在 `config.json` 里设 `cch`

## config.json 字段

| 字段 | 默认值 | 说明 |
|---|---|---|
| `ccVersion` | 派生值（`2.1.270.<3hex>`） | 固定 `cc_version` 到指定字符串；留空则按首条 user 消息推导出真实 CC 的值 |
| `agentIdentity` | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | system 第二段身份文本 |
| `cch` | 空（不发送） | 额外的 `cch=` 段。默认为空，因为真实 Claude Code 在网关后并不发它 |
| `patchFetch` | `true` | 是否为 /v1/messages 追加 `?beta=true` 并同步 `x-claude-code-session-id` 头 |

`config.json` 与 `state/device.txt` 均位于 `~/.pi/agent/cc-compat/`（首次运行自动创建），包升级不会清除你的配置与设备指纹。`state/device.txt` 加入 `.gitignore`，勿提交。

## 适用范围与声明

- 本项目用于让 pi 访问**你自己持有 key 的、要求 Claude Code 客户端的网关分组**，不涉及绕过 Anthropic 官方服务的任何计费或访问控制。
- 请遵守你的网关与 Anthropic 的服务条款；因网关校验策略变化导致的失效，本项目不保证及时修复。

## License

MIT
