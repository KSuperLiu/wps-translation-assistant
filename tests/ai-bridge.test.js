import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createEnvBridge } from "../scripts/ai-local-bridge.mjs";
import { generateAITranslation } from "../src/ai-client.js";

async function fixture(t, options = {}) {
  const bridge = createEnvBridge({ baseURL: "https://litellm.example/team", token: "test-pair-code", env: { LITELLM_API_KEY: "server-only-key" }, ...options });
  bridge.server.listen(0, "127.0.0.1"); await once(bridge.server, "listening");
  t.after(() => { bridge.server.closeAllConnections(); bridge.server.close(); });
  const root = "http://127.0.0.1:" + bridge.server.address().port;
  const headers = { Authorization: "Bearer test-pair-code", "X-Wps-Gateway": "https://litellm.example/team/v1", Origin: "null" };
  return { ...bridge, root, headers };
}
test("本机桥使用进程环境变量注入上游鉴权，不返回真实 Key", async t => {
  const f = await fixture(t, { fetcher: async (url, options) => {
    assert.equal(url, "https://litellm.example/team/v1/models");
    assert.equal(options.headers.Authorization, "Bearer server-only-key");
    assert.equal(options.redirect, "error");
    return Response.json({ data: [{ id: "team-translator", debug: "ignored" }], debug: "ignored" });
  } });
  const response = await fetch(f.root + "/v1/models", { headers: f.headers }), text = await response.text();
  assert.equal(response.status, 200); assert.equal(response.headers.get("access-control-allow-origin"), "null");
  assert.deepEqual(JSON.parse(text), { data: [{ id: "team-translator" }] }); assert.doesNotMatch(text, /server-only-key/);
});
test("本机桥使用不带路径的网关地址时只补一个 /v1", async t => {
  const f = await fixture(t, { baseURL: "http://127.0.0.1:4000" });
  assert.equal(f.gateway, "http://127.0.0.1:4000/v1");
});
test("本机桥拒绝未配对、其他网页、错网关和未设置的变量，不发上游请求", async t => {
  let calls = 0; const f = await fixture(t, { fetcher: async () => { calls++; return Response.json({}); } });
  for (const [headers, status] of [
    [{ ...f.headers, Authorization: "Bearer wrong" }, 401],
    [{ ...f.headers, Origin: "https://other.example" }, 403],
    [{ ...f.headers, "X-Wps-Gateway": "https://steal.example/v1" }, 409],
  ]) assert.equal((await fetch(f.root + "/v1/models", { headers })).status, status);
  const missing = await fixture(t, { env: {}, fetcher: async () => { calls++; } });
  assert.equal((await fetch(missing.root + "/v1/models", { headers: missing.headers })).status, 503);
  assert.equal(calls, 0);
});
test("本机桥没有读取环境变量的通用接口，只开放翻译与模型列表", async t => {
  const f = await fixture(t);
  for (const path of ["/env", "/v1/key/info", "/v1/models?url=https://steal.example", "/v1/chat/completions?x=1"])
    assert.equal((await fetch(f.root + path, { headers: f.headers })).status, 404);
  const preflight = await fetch(f.root + "/v1/models", { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Headers": "Authorization,X-Wps-Gateway" } });
  assert.equal(preflight.status, 204); assert.match(preflight.headers.get("access-control-allow-headers"), /X-Wps-Gateway/);
});
test("SDK → 本机桥 → 模拟 LiteLLM 完整调用，Key 只在上游一跳", async t => {
  let upstreamCalls = 0;
  const f = await fixture(t, { fetcher: async (url, options) => {
    upstreamCalls++; assert.equal(url, "https://litellm.example/team/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer server-only-key");
    const body = JSON.parse(options.body); assert.equal(body.model, "team-translator"); assert.equal(body.stream, false);
    return Response.json({ choices: [{ message: { content: "Coins {0}" }, finish_reason: "stop" }], debug: "ignored" });
  } });
  const text = await generateAITranslation({ provider: "litellm", baseURL: "https://litellm.example/team", model: "team-translator", useEnv: true, apiKey: "unused-key", bridgeToken: "test-pair-code" },
    { source: "金币 {0}", language: "EN" }, { fetcher: async (url, options) => {
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer test-pair-code");
      return fetch(url.replace("http://127.0.0.1:3892", f.root), options);
    } });
  assert.equal(text, "Coins {0}"); assert.equal(upstreamCalls, 1);
});
test("本机桥丢弃上游错误正文，避免 Key 回显", async t => {
  const f = await fixture(t, { fetcher: async () => Response.json({ error: "Key server-only-key invalid" }, { status: 401 }) });
  const response = await fetch(f.root + "/v1/models", { headers: f.headers });
  assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), /server-only-key/);
});
test("本机桥拒绝在成功响应中回显环境变量 Key 的上游", async t => {
  const f = await fixture(t, { fetcher: async () => Response.json({ data: [{ id: "server-only-key" }] }) });
  const response = await fetch(f.root + "/v1/models", { headers: f.headers });
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /server-only-key/);
});
test("本机桥拒绝工具和过大请求，不透传任意 API", async t => {
  let calls = 0; const f = await fixture(t, { fetcher: async () => { calls++; } });
  for (const body of [{ model: "x", messages: [], tools: [{ type: "function" }] }, { model: "x", messages: [{ role: "user", content: "x".repeat(300000) }] }]) {
    const response = await fetch(f.root + "/v1/chat/completions", { method: "POST", headers: { ...f.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok([400, 413].includes(response.status)); await response.text();
  }
  assert.equal(calls, 0);
});
