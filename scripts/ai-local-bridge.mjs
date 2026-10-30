// 可独立运行，不依赖 npm 包。环境变量仅由本进程读取，不返回浏览器。
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

function gatewayURL(value) {
  let url; try { url = new URL(value); } catch { throw new Error("请提供有效的网关基础地址。"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("网关需使用 HTTPS；本机网关可用 HTTP。");
  if (url.username || url.password || url.search || url.hash) throw new Error("网关地址不能包含凭据、查询参数或 #。");
  let pathname = url.pathname.replace(/\/+$/, "");
  if (/\/(chat\/completions|models|messages|responses)$/.test(pathname)) throw new Error("请填写网关基础地址。");
  if (!pathname.endsWith("/v1")) pathname += "/v1";
  url.pathname = pathname;
  return url.href.replace(/\/$/, "");
}
const sameToken = (actual, expected) => {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
export function createEnvBridge({ baseURL, token = randomBytes(32).toString("hex"), env = process.env, fetcher = globalThis.fetch } = {}) {
  const gateway = gatewayURL(baseURL);
  const allowedOrigin = origin => !origin || origin === "null" || origin === "https://ksuperliu.github.io" || /^http:\/\/127\.0\.0\.1:389[01]$/.test(origin);
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const reply = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(value));
    };
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || "") || !allowedOrigin(origin)) return reply(403, { error: "origin_denied" });
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    const route = req.url === "/v1/models" && req.method === "GET" ? "/models"
      : req.url === "/v1/chat/completions" && req.method === "POST" ? "/chat/completions" : "";
    if (req.method === "OPTIONS") {
      if (!["/v1/models", "/v1/chat/completions"].includes(req.url)) return reply(404, { error: "not_found" });
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Wps-Gateway, ai-sdk-version");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.writeHead(204); res.end(); return;
    }
    if (!route) return reply(404, { error: "not_found" });
    if (!sameToken(req.headers.authorization || "", "Bearer " + token)) return reply(401, { error: "pairing_required" });
    // 固定上游，避免调用方把环境变量 Key 转发到任意地址。
    if (req.headers["x-wps-gateway"] !== gateway) return reply(409, { error: "gateway_mismatch" });
    const key = typeof env.LITELLM_API_KEY === "string" ? env.LITELLM_API_KEY.trim() : "";
    if (!key || /[\r\n]/.test(key)) return reply(503, { error: "environment_key_missing" });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
    req.on("aborted", () => controller.abort());
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      let body;
      if (route === "/chat/completions") {
        if (!(req.headers["content-type"] || "").startsWith("application/json")) return reply(415, { error: "json_required" });
        let bytes = 0; const chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 256 * 1024) return reply(413, { error: "request_too_large" }); chunks.push(chunk); }
        let data; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(400, { error: "invalid_json" }); }
        // 仅文本翻译，无工具、外部文件或流式通道；不透传任意上游参数。
        if (typeof data.model !== "string" || !data.model.trim() || !Array.isArray(data.messages)
          || data.messages.length > 4 || data.messages.some(m => !["system", "user"].includes(m.role) || typeof m.content !== "string")
          || data.stream === true || data.tools) return reply(400, { error: "text_translation_required" });
        body = JSON.stringify({ model: data.model, messages: data.messages,
          max_tokens: Math.min(4096, Math.max(1, Number(data.max_tokens || data.max_completion_tokens) || 4096)), stream: false });
      }
      const upstream = await fetcher(gateway + route, { method: req.method, redirect: "error", signal: controller.signal,
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body });
      // 上游错误正文可能回显 Key/请求，不送回窗格或日志。
      if (!upstream.ok) { await upstream.body?.cancel(); return reply(upstream.status === 503 ? 502 : upstream.status, { error: "gateway_request_failed" }); }
      if (!upstream.body) return reply(502, { error: "empty_gateway_response" });
      const chunks = []; let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { controller.abort(); return reply(502, { error: "response_too_large" }); }
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (JSON.stringify(data).includes(key)) return reply(502, { error: "credential_in_gateway_response" });
      if (route === "/models") return reply(200, { data: Array.isArray(data.data) ? data.data.filter(x => typeof x.id === "string").map(x => ({ id: x.id })) : [] });
      const choice = data.choices?.[0];
      if (!choice || typeof choice.message?.content !== "string") return reply(502, { error: "invalid_translation_response" });
      // 仅返回 SDK 所需字段，排除上游调试信息/凭据。
      reply(200, { id: "local-translation", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body && JSON.parse(body).model,
        choices: [{ index: 0, message: { role: "assistant", content: choice.message.content }, finish_reason: choice.finish_reason || "stop" }] });
    } catch { reply(502, { error: "gateway_unavailable" }); }
    finally { clearTimeout(timer); }
  });
  server.requestTimeout = 65_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
  return { server, token, gateway };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const index = process.argv.indexOf("--base-url"), baseURL = index >= 0 ? process.argv[index + 1] : process.env.LITELLM_BASE_URL;
    if (!baseURL) throw new Error("请提供 --base-url https://网关地址/v1，或设置 LITELLM_BASE_URL。");
    if (!process.env.LITELLM_API_KEY?.trim()) throw new Error("未设置 LITELLM_API_KEY。请在启动本服务的环境中设置后重试。");
    const { server, token, gateway } = createEnvBridge({ baseURL });
    server.on("error", () => { console.error("无法启动本机服务，请检查 3892 端口是否已被占用。"); process.exitCode = 1; });
    server.listen(3892, "127.0.0.1", () => {
      console.log("WPS 翻译助手 · 环境变量连接服务\n网关：" + gateway + "\n地址：http://127.0.0.1:3892\n本机连接码：" + token + "\nLITELLM_API_KEY 已读取（不显示内容）。关闭此进程即可停止；重启后连接码会更换。");
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
