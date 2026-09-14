# pi-cc-compat

**English** | [简体中文](README.zh-CN.md)

Make the [pi](https://github.com/earendil-works/pi-mono) coding agent talk to Anthropic-compatible gateways (new-api / one-api and other relays that enforce group checks) in the exact request shape of a Claude Code client, so it can pass gateways that only allow "Claude Code clients only".

No pi source modification, no extra daemon process — just a pi extension plus `models.json` headers config.

## How it works

Some gateways fingerprint requests to verify the client identity and only let real Claude Code through. This extension was built by comparing captured traffic from a real Claude Code 2.1.270 client (build 2026-09-12) and fills in the following on pi's outgoing requests:

| Layer | What is added | Where |
|---|---|---|
| Request body | `metadata.user_id`: JSON `{"device_id":"<64hex>","account_uuid":"","session_id":"<uuid>"}`, with `device_id` persisted and `session_id` changing per session | extension (`before_provider_request`) |
| Request body | Two segments inserted before system: billing header + Agent SDK identity segment. The billing header is `x-anthropic-billing-header: cc_version=2.1.270.<3hex>; cc_entrypoint=sdk-cli;`, where the suffix is derived per request (using zero-based indexes 4/7/20; see below) | extension |
| Request body | `thinking.display: "omitted"` alignment | extension |
| URL | `/v1/messages?beta=true` | extension (fetch wrapper) |
| Request headers | `x-claude-code-session-id` auto-synced to `metadata.user_id.session_id` (they are always identical in real CC; the static value in models.json is only a fallback) | extension (fetch wrapper) |
| Request headers | `Authorization: Bearer`, `user-agent: claude-cli/2.1.270 (external, sdk-cli)`, `x-app`, full `X-Stainless-*` set, complete `anthropic-beta` list | `models.json` headers |

### About `thinking`

Real Claude Code 2.1.270 sends `thinking: {"type":"adaptive","display":"omitted"}`. pi already sends `type: "adaptive"` for the built-in Claude models (`forceAdaptiveThinking`), so the extension only aligns `display` to `"omitted"` and leaves the `type` that pi chose alone. Models configured with a non-adaptive `thinking` keep their own shape.

### About `cc_version`

Real Claude Code does not use a fixed `cc_version` suffix. In 2.1.270 it is

```
suffix = sha256("59cf53e54c78" + s + "2.1.270").hex.slice(0, 3)
s      = [4, 7, 20].map(i => firstUserMessageText[i] || "0").join("")
```

i.e. zero-based indexes 4, 7 and 20 of the first user message text. Verified against two real captures: first message `"say ok"` → `2.1.270.4c5`, `"hi"` → `2.1.270.ffc`. The extension reproduces this derivation, so a frozen value is never sent. Set `ccVersion` in `config.json` only if you need to pin an exact string.

### About `cch`

Claude Code's billing header also has a `cch=` segment, but **it is not sent when `ANTHROPIC_BASE_URL` points at a gateway** — which is exactly this extension's scenario. It appears only when the effective base URL is `api.anthropic.com` (or `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` is set), and even then the literal `cch=00000;` found in the binary is only a placeholder: it is replaced before sending with a value that differs between two identical requests (`032a5`, `30ebd`, `c0f1a` were observed for `cch`).

So the extension omits `cch` by default, matching what real Claude Code actually puts on the wire behind a gateway. If your gateway ever asks for it, set `cch` in `config.json`.

Authentication still uses your own gateway API key — only the transport shape changes from `x-api-key` to `Authorization: Bearer`.

## Installation

### As a pi package (recommended)

```bash
pi install npm:pi-cc-compat
# or straight from GitHub (no npm publish needed):
pi install git:github.com/DavidEasden/pi-compat@v0.1.0
```

### Manual copy

```bash
git clone https://github.com/DavidEasden/pi-compat.git
mkdir -p ~/.pi/agent/extensions/cc-compat
cp pi-compat/extension/index.ts ~/.pi/agent/extensions/cc-compat/
```

pi auto-discovers and loads extensions by the `~/.pi/agent/extensions/*/index.ts` convention — no registration needed. The extension only intercepts requests for `claude-*` models and leaves other providers untouched.

### Optional: custom configuration

```bash
mkdir -p ~/.pi/agent/cc-compat
cp pi-compat/extension/config.example.json ~/.pi/agent/cc-compat/config.json
```

## Configuring models.json

Config in the `providers.anthropic` block of `~/.pi/agent/models.json` (replace placeholders with your gateway address and key):

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "http://your-gateway.example.com",
      "headers": {
        "Authorization": "Bearer sk-your-gateway-key",
        "User-Agent": "claude-cli/2.1.270 (external, sdk-cli)",
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
- The `anthropic-beta` list and every `X-Stainless-*` value above were verified to be byte-identical to a real 2.1.270 request; only the `User-Agent` version tracks the Claude Code release. The relay accepts both `http://` and `https://` upstreams.

## Verification

```bash
pi -p "say exactly: ok" --model anthropic/claude-sonnet-5
```

If it returns `ok`, you're through. If you get `503 ... only allows Claude Code clients`, see the next section.

## Troubleshooting (after the gateway tightens its checks)

The fingerprint is based on captured CC 2.1.270 traffic, and gateways may tighten validation at any time. Standard debugging flow:

1. Run the relay proxy to observe a **real** Claude Code's current requests:

   ```bash
   node tools/relay.mjs 9996 http://your-gateway.example.com
   ```

2. Temporarily set `env.ANTHROPIC_BASE_URL` to `http://localhost:9996` in `~/.claude/settings.json` (note: env in settings.json takes precedence over shell environment variables, so `export` won't override it).

3. Run a real Claude Code once: `claude -p "say ok" --model claude-sonnet-5`, and the relay prints the full request.

4. Restore `~/.claude/settings.json`.

5. Diff and sync the changes:
   - `cc_version` / identity segments changed → update the derivation in `extension/index.ts` (or pin `ccVersion` in `config.json`)
   - beta list, new headers → update `models.json` headers
   - `metadata.user_id` structure changed → update `extension/index.ts`
   - a `cch=` segment now appears even behind a gateway → set `cch` in `config.json`

## config.json fields

| Field | Default | Description |
|---|---|---|
| `ccVersion` | derived (`2.1.270.<3hex>`) | Pins an exact `cc_version` string. Leave empty to derive the real per-request value from the first user message |
| `agentIdentity` | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | Second system segment identity text |
| `cch` | empty (omitted) | Extra `cch=` segment. Empty by default because real Claude Code does not send it behind a gateway |
| `patchFetch` | `true` | Whether to append `?beta=true` to /v1/messages and sync the `x-claude-code-session-id` header |

Both `config.json` and `state/device.txt` live in `~/.pi/agent/cc-compat/` (created on first run), so package upgrades never wipe your config or device fingerprint. `state/device.txt` is git-ignored — never commit it.

## Scope and disclaimer

- This project is for accessing gateway groups **you hold keys for** that require Claude Code clients. It does not bypass any billing or access control of Anthropic's official service.
- Respect your gateway's and Anthropic's terms of service. If a gateway's validation changes break this extension, timely fixes are not guaranteed.

## License

MIT
