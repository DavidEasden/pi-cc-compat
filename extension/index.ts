/**
 * pi-cc-compat — 让 pi 以 Claude Code 客户端身份访问要求 CC 校验的 Anthropic 兼容网关。
 *
 * 工作方式（基于 2026-09 对真实 Claude Code 2.1.270 的抓包对比，
 * build 2026-09-12 / git sha 97ecbf7）：
 * 1. before_provider_request 注入 metadata.user_id（JSON 格式：
 *    {"device_id":"<64hex>","account_uuid":"","session_id":"<uuid>"}，device_id 持久化）。
 * 2. 在 system 前插入两段 Claude Code 标识：billing header 段 + Agent SDK 身份段。
 *    billing header 形如
 *      x-anthropic-billing-header: cc_version=2.1.270.<3hex>; cc_entrypoint=sdk-cli;
 *    cc_version 逐请求派生（见 ccVersionFor），不用静态值——真实 CC 的后缀是首条 user
 *    消息文本的函数，静态后缀对绝大多数请求都不匹配。
 * 3. 把 thinking.display 对齐为 "omitted"。type 由 pi 决定：内建 Claude 模型
 *    （forceAdaptiveThinking）pi 本就发 adaptive，扩展只覆盖 display；其它 reasoning
 *    模型的 thinking 形态保持不变。
 * 4. 包装 globalThis.fetch，为 /v1/messages 追加 ?beta=true，并把
 *    x-claude-code-session-id 头同步为与 metadata.session_id 一致的值
 *    （真实 CC 中二者恒等，models.json 里的静态值仅作兜底）。
 *
 * 鉴权头（Authorization: Bearer）、UA、X-Stainless-*、anthropic-beta 等由 models.json
 * 的 provider headers 配置，见仓库 README。
 *
 * 可调参数放在 ~/.pi/agent/cc-compat/config.json（可选），字段（空字符串 = 用默认值）：
 * {
 *   "ccVersion":  "",                        // 固定 cc_version 覆盖值；留空则按 2.1.270 算法派生
 *   "agentIdentity": "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
 *   "cch":         "",                        // 额外的 cch= 段；默认留空（见下）
 *   "patchFetch": true                        // 是否追加 ?beta=true 并同步会话头
 * }
 *
 * cch 默认不发送：真实 CC 只在「等效 first-party / vertex」时才拼入该段，且二进制里的
 * 字面量 " cch=00000;" 是占位符，发出前会被替换成每次请求不同的 5 位 hex。因此在网关
 * 场景（自定义 baseUrl）下真实 CC 的 header 里根本没有 cch；仅当你的网关明确要求时才配置。
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
// 用户数据目录：config.json 与设备指纹持久化到固定位置（~/.pi/agent/cc-compat/），
// 包升级/重装不会丢失配置与 device_id。
const USER_DATA_DIR = join(homedir(), ".pi", "agent", "cc-compat");
const STATE_DIR = join(USER_DATA_DIR, "state");

// ---- 可选 config.json ----
type Config = { ccVersion?: string; agentIdentity?: string; cch?: string; patchFetch?: boolean };
let config: Config = {};
try {
	config = JSON.parse(readFileSync(join(USER_DATA_DIR, "config.json"), "utf-8")) as Config;
} catch {
	// 向后兼容：手动复制安装时代的包内 config.json 仍生效
	try {
		config = JSON.parse(readFileSync(join(DIR, "config.json"), "utf-8")) as Config;
	} catch {
		/* 无配置文件时使用默认值 */
	}
}
// 空/空白字符串按「未设置」处理，这样示例配置可以用 "" 表示「走默认行为」。
function optional(v: string | undefined): string | undefined {
	const t = typeof v === "string" ? v.trim() : "";
	return t === "" ? undefined : t;
}
const CC_VERSION_OVERRIDE = optional(config.ccVersion);
const CCH = optional(config.cch);
const AGENT_IDENTITY =
	optional(config.agentIdentity) ?? "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const PATCH_FETCH = config.patchFetch ?? true;

// ---- billing header 的 cc_version 派生 ----
// 真实 CC 2.1.270 为：`${VERSION}.${sha256(SALT + s + VERSION).hex.slice(0,3)}`，
// 其中 s 取首条 user 消息文本的第 4/7/20 个字符（越界补 "0"）。
// 实测校准：首条消息 "say ok" -> 2.1.270.4c5；"hi" -> 2.1.270.ffc，两次抓包均命中。
const CC_VERSION_BASE = "2.1.270";
const CC_VERSION_SALT = "59cf53e54c78";

function ccVersionFor(text: string): string {
	const probe = [4, 7, 20].map((i) => text[i] || "0").join("");
	const suffix = createHash("sha256")
		.update(`${CC_VERSION_SALT}${probe}${CC_VERSION_BASE}`)
		.digest("hex")
		.slice(0, 3);
	return `${CC_VERSION_BASE}.${suffix}`;
}

// 与真实 CC 的 dzo() 等价：取首条非 meta 的 user 消息的文本（字符串，或首个 text block）。
function firstUserText(messages: any[]): string {
	const msg = messages.find((m) => m?.role === "user" && m?.isMeta !== true);
	if (!msg) return "";
	const content = msg.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const block = content.find((b) => b?.type === "text");
		if (block && typeof block.text === "string") return block.text;
	}
	return "";
}

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

// 真实 CC：`x-anthropic-billing-header: cc_version=...; cc_entrypoint=<CLAUDE_CODE_ENTRYPOINT>;`，
// SDK 场景下 entrypoint 为 sdk-cli；cch 段只在等效 first-party 时附加，故默认为空。
function billingHeader(text: string): string {
	const ccVersion = CC_VERSION_OVERRIDE ?? ccVersionFor(text);
	let header = `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=sdk-cli;`;
	if (CCH) header += ` cch=${CCH};`;
	return header;
}

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
		const billing = billingHeader(firstUserText(p.messages));
		if (Array.isArray(p.system)) {
			const first = String(p.system[0]?.text ?? "");
			if (!first.startsWith("x-anthropic-billing-header")) {
				p.system.unshift(
					{ type: "text", text: billing },
					{ type: "text", text: AGENT_IDENTITY },
				);
			}
		} else if (typeof p.system === "string") {
			p.system = [
				{ type: "text", text: billing },
				{ type: "text", text: AGENT_IDENTITY },
				{ type: "text", text: p.system },
			];
		} else {
			p.system = [
				{ type: "text", text: billing },
				{ type: "text", text: AGENT_IDENTITY },
			];
		}
		if (p.thinking?.type === "adaptive") {
			p.thinking = { ...p.thinking, display: "omitted" };
		}
		return p;
	});
}
