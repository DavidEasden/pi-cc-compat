# pi-cc-compat

**English** | [简体中文](README.zh-CN.md)

Make the [pi](https://github.com/earendil-works/pi-mono) coding agent talk to Anthropic-compatible gateways (new-api / one-api and other relays that enforce group checks) in the exact request shape of a Claude Code client, so it can pass gateways that only allow "Claude Code clients only".

No pi source modification, no extra daemon process — just a pi extension plus `models.json` headers config.

## How it works

Some gateways fingerprint requests to verify the client identity and only let real Claude Code through. This extension was built by comparing captured traffic from a real Claude Code 2.1.259 client and fills in the following on pi's outgoing requests:

| Layer | What is added | Where |
|---|---|---|
| Request body | `metadata.user_id`: JSON `{"device_id":"<64hex>","account_uuid":"","session_id":"<uuid>"}`, with `device_id` persisted and `session_id` changing per session | extension (`before_provider_request`) |
| Request body | Two segments inserted before system: billing header (`x-anthropic-billing-header: cc_version=...`) + Agent SDK identity segment | extension |
| Request body | `thinking.display: "omitted"` alignment | extension |
| URL | `/v1/messages?beta=true` | extension (fetch wrapper) |
| Request headers | `x-claude-code-session-id` auto-synced to `metadata.user_id.session_id` (they are always identical in real CC; the static value in models.json is only a fallback) | extension (fetch wrapper) |
| Request headers | `Authorization: Bearer`, `user-agent: claude-cli/...`, `x-app`, full `X-Stainless-*` set, complete `anthropic-beta` list | `models.json` headers |

Authentication still uses your own gateway API key — only the transport shape changes from `x-api-key` to `Authorization: Bearer`.

## Installation

```bash
git clone https://github.com/<you>/pi-cc-compat.git
mkdir -p ~/.pi/agent/extensions/cc-compat
cp pi-cc-compat/extension/index.ts ~/.pi/agent/extensions/cc-compat/
# Optional: custom configuration
cp pi-cc-compat/extension/config.example.json ~/.pi/agent/extensions/cc-compat/config.json
```

pi auto-discovers and loads extensions by the `~/.pi/agent/extensions/*/index.ts` convention — no registration needed. The extension only intercepts requests for `claude-*` models and leaves other providers untouched.

## Configuring models.json

Config in the `providers.anthropic` block of `~/.pi/agent/models.json` (replace placeholders with your gateway address and key):

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "http://your-gateway.example.com",
      "headers": {
        "Authorization": "Bearer sk-your-gateway-key",
        "User-Agent": "claude-cli/2.1.259 (external, sdk-cli)",
        "x-app": "cli",
        "x-claude-code-session-id": "<a fixed uuid, used as fallback; overridden with the session id at request time>",
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

Notes:

- `apiKey` must stay — pi requires providers to have auth config to appear in `/model`; actual authentication is done via `Authorization: Bearer` in headers, and the extra `x-api-key` doesn't affect the gateway check.
- No `models` array needed — built-in Claude model entries (including `forceAdaptiveThinking`, pricing, and context metadata) are kept as-is and routed through the gateway.
- When the gateway runs locally, write `baseUrl` as `http://localhost:3000` rather than `127.0.0.1` (Claude Code behaves differently with IP literals; staying consistent avoids surprises).

## Verification

```bash
pi -p "say exactly: ok" --model anthropic/claude-sonnet-5
```

If it returns `ok`, you're through. If you get `503 ... only allows Claude Code clients`, see the next section.

## Troubleshooting (after the gateway tightens its checks)

The fingerprint is based on captured CC 2.1.259 traffic, and gateways may tighten validation at any time. Standard debugging flow:

1. Run the relay proxy to observe a **real** Claude Code's current requests:

   ```bash
   node tools/relay.mjs 9996 http://your-gateway.example.com
   ```

2. Temporarily set `env.ANTHROPIC_BASE_URL` to `http://localhost:9996` in `~/.claude/settings.json` (note: env in settings.json takes precedence over shell environment variables, so `export` won't override it).

3. Run a real Claude Code once: `claude -p "say ok" --model claude-sonnet-5`, and the relay prints the full request.

4. Restore `~/.claude/settings.json`.

5. Diff and sync the changes:
   - `cc_version` / identity segments changed → update `extension/config.json`
   - beta list, new headers → update `models.json` headers
   - `metadata.user_id` structure changed → update `extension/index.ts`

## config.json fields

| Field | Default | Description |
|---|---|---|
| `ccVersion` | `"2.1.259.9c8"` | cc_version in the billing header segment |
| `agentIdentity` | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | Second system segment identity text |
| `patchFetch` | `true` | Whether to append `?beta=true` to /v1/messages and sync the `x-claude-code-session-id` header |

`state/device.txt` is the device fingerprint generated on first run; it is git-ignored — never commit it.

## Scope and disclaimer

- This project is for accessing gateway groups **you hold keys for** that require Claude Code clients. It does not bypass any billing or access control of Anthropic's official service.
- Respect your gateway's and Anthropic's terms of service. If a gateway's validation changes break this extension, timely fixes are not guaranteed.

## License

MIT
