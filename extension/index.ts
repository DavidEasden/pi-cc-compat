/**
 * pi-cc-compat — 让 pi 以 Claude Code 客户端身份访问要求 CC 校验的 Anthropic 兼容网关。
 *
 * 工作方式（基于 2026-09 对真实 Claude Code 2.1.259 的抓包对比）：
 * 1. before_provider_request 注入 metadata.user_id（JSON 格式：
 *    {"device_id":"<64hex>","account_uuid":"","session_id":"<uuid>"}，device_id 持久化）。
 * 2. 在 system 前插入两段 Claude Code 标识：billing header 段 + Agent SDK 身份段。
 * 3. 将 thinking 对齐为 adaptive + omitted。
 * 4. 包装 globalThis.fetch，为 /v1/messages 追加 ?beta=true，并把
 *    x-claude-code-session-id 头同步为与 metadata.session_id 一致的值
 *    （真实 CC 中二者恒等，models.json 里的静态值仅作兜底）。
 *
 * 鉴权头（Authorization: Bearer）、UA、X-Stainless-*、anthropic-beta 等由 models.json
 * 的 provider headers 配置，见仓库 README。
 *
 * 可调参数放在同目录 config.json（可选），字段：
 * {
 *   "ccVersion":  "2.1.259.9c8",            // billing header 中的 cc_version
 *   "agentIdentity": "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
 *   "patchFetch": true                       // 是否追加 ?beta=true 并同步会话头
 * }
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(DIR, "state");

// ---- 可选 config.json ----
type Config = { ccVersion?: string; agentIdentity?: string; patchFetch?: boolean };
let config: Config = {};
try {
	config = JSON.parse(readFileSync(join(DIR, "config.json"), "utf-8")) as Config;
} catch {
	/* 无配置文件时使用默认值 */
}
const CC_VERSION = config.ccVersion ?? "2.1.259.9c8";
const AGENT_IDENTITY =
	config.agentIdentity ?? "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const PATCH_FETCH = config.patchFetch ?? true;

// ---- 持久化 device_id（64 位小写 hex，跨会话稳定） ----
function loadOrCreateDeviceId(): string {
	mkdirSync(STATE_DIR, { recursive: true });
	const file = join(STATE_DIR, "device.txt");
	if (existsSync(file)) {
		const v = readFileSync(file, "utf-8").trim();
		if (v) return v;
	}
	const v = Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
	writeFileSync(file, v, "utf-8");
	return v;
}

const DEVICE_ID = loadOrCreateDeviceId();

// ---- 当前会话 id：before_provider_request 写入，fetch 包装时同步到请求头 ----
let currentSessionId: string | null = null;

// ---- fetch 包装：/v1/messages 追加 ?beta=true + 同步会话头 ----
if (PATCH_FETCH && !(globalThis as any).__ccCompatFetchPatched) {
	(globalThis as any).__ccCompatFetchPatched = true;
	const origFetch = globalThis.fetch;
	globalThis.fetch = function ccCompatFetch(input: any, init?: any) {
		try {
			const url: string = typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: String(input?.url ?? "");
			if (/\/v1\/messages(\?|$)/.test(url)) {
				if (!url.includes("beta=true")) {
					const newUrl = url + (url.includes("?") ? "&" : "?") + "beta=true";
					if (typeof input === "string" || input instanceof URL) {
						input = newUrl;
					} else if (input instanceof Request) {
						input = new Request(newUrl, input);
					}
				}
				// 真实 CC 的 x-claude-code-session-id 与 metadata.session_id 恒等，
				// 用会话 id 覆盖 models.json 中静态配置的兜底值，保持二者严格一致。
				if (currentSessionId) {
					const hdrs = new Headers(
						init?.headers ?? (input instanceof Request ? input.headers : undefined),
					);
					hdrs.set("x-claude-code-session-id", currentSessionId);
					init = { ...(init ?? {}), headers: hdrs };
				}
			}
		} catch {
			/* 包装失败时原样放行 */
		}
		return origFetch(input, init);
	} as typeof fetch;
}

const CC_BILLING = `x-anthropic-billing-header: cc_version=${CC_VERSION}; cc_entrypoint=sdk-cli;`;

export default function (pi: any) {
	pi.on("before_provider_request", async (event: any, ctx: any) => {
		const p = event.payload;
		// 只处理 anthropic-messages 请求体：messages + max_tokens 且 model 为 claude-*
		if (!p || !Array.isArray(p.messages) || typeof p.max_tokens !== "number" || !String(p.model ?? "").startsWith("claude-")) {
			return undefined;
		}
		const sessionId = ctx?.sessionManager?.getSessionId?.() ?? randomUUID();
		currentSessionId = sessionId;
		p.metadata = {
			user_id: JSON.stringify({ device_id: DEVICE_ID, account_uuid: "", session_id: sessionId }),
		};
		if (Array.isArray(p.system)) {
			const first = String(p.system[0]?.text ?? "");
			if (!first.startsWith("x-anthropic-billing-header")) {
				p.system.unshift(
					{ type: "text", text: CC_BILLING },
					{ type: "text", text: AGENT_IDENTITY },
				);
			}
		} else if (typeof p.system === "string") {
			p.system = [
				{ type: "text", text: CC_BILLING },
				{ type: "text", text: AGENT_IDENTITY },
				{ type: "text", text: p.system },
			];
		}
		if (p.thinking && typeof p.thinking === "object") {
			p.thinking = { ...p.thinking, display: "omitted" };
		}
		return p;
	});
}
