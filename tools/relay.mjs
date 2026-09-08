/**
 * relay.mjs — 观测真实 Claude Code 请求的本地中继代理。
 *
 * 用途：当网关更新客户端校验导致扩展失效时，用它抓取一份当前能通过校验的
 * 真实请求，与扩展产出的请求对比，把差异同步回 extension/config.json 与
 * models.json headers。
 *
 * 用法：
 *   1. node tools/relay.mjs [listenPort=9996] [upstream=http://localhost:3000]
 *   2. 临时修改 ~/.claude/settings.json 的 env：
 *      "ANTHROPIC_BASE_URL": "http://localhost:<listenPort>"
 *      （注意：必须写 localhost，写 127.0.0.1 会被 Claude Code 区别对待）
 *   3. 运行一次真实 Claude Code：claude -p "say ok" --model claude-sonnet-5
 *   4. 本脚本会把每个请求的 URL/headers/body 摘要打印到 stdout（或写入 relay.log）
 *   5. 记得恢复 ~/.claude/settings.json
 *
 * 注意：Claude Code 的 settings.json env 优先级高于 shell 环境变量，
 * 不要用 export ANTHROPIC_BASE_URL 覆盖，改文件才生效。
 */
import http from "node:http";

const listenPort = Number(process.argv[2] ?? 9996);
const upstream = process.argv[3] ?? "http://localhost:3000";
const upstreamUrl = new URL(upstream);

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		console.log("\n=== REQUEST ===", req.method, req.url);
		console.log("HEADERS:", JSON.stringify(req.headers, null, 2));
		if (req.url.includes("/v1/messages") && req.method === "POST") {
			try {
				const b = JSON.parse(body);
				console.log("BODY keys:", Object.keys(b).join(","));
				console.log("metadata:", JSON.stringify(b.metadata));
				console.log("system:", Array.isArray(b.system)
					? b.system.map((s) => ({ len: s.text?.length, head: String(s.text).slice(0, 150) }))
					: String(b.system).slice(0, 150));
				console.log("tools:", (b.tools ?? []).map((t) => t.name).join(","));
				console.log("context_management:", JSON.stringify(b.context_management));
				console.log("params:", JSON.stringify({
					stream: b.stream, max_tokens: b.max_tokens,
					thinking: b.thinking, output_config: b.output_config,
				}));
			} catch {
				console.log("body parse fail");
			}
		}
		const opts = {
			method: req.method,
			headers: { ...req.headers, host: upstreamUrl.host },
		};
		const up = http.request(`${upstream}${req.url}`, opts, (ur) => {
			res.writeHead(ur.statusCode ?? 502, ur.headers);
			ur.on("data", (c) => res.write(c));
			ur.on("end", () => res.end());
		});
		up.on("error", (e) => {
			console.log("upstream error:", e.message);
			res.writeHead(502);
			res.end();
		});
		if (body) up.write(body);
		up.end();
	});
});

server.listen(listenPort, () => {
	console.log(`relay on http://localhost:${listenPort} -> ${upstream}`);
	console.log("下一步：把 ~/.claude/settings.json 的 ANTHROPIC_BASE_URL 指到上面的地址，跑一次真实 Claude Code。");
});
