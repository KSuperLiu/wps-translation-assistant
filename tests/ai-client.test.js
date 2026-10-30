import test from "node:test";
import assert from "node:assert/strict";
import { loadAISettings, publicAISettings, storedAISettings, resolveAIConnection, normalizeAIBaseURL } from "../src/ai-config.js";
import { generateAITranslation, listAIModels, safeAIError, boundedFetch, translationPrompt } from "../src/ai-client.js";

const config = { provider: "litellm", baseURL: "https://gateway.example/ai", model: "team-localizer", apiKey: "fake-virtual-key" };
const unit = { source: "得到 {0}\\n<color=red>金币</color>", language: "EN", key: "do-not-send", target: "private-draft", sheet: "private-sheet" };
const json = (value, status = 200) => Response.json(value, { status });
const completion = (content = "Get {0}\\n<color=red>coins</color>", finish = "stop") => json({ id: "mock", created: 1, model: "team-localizer", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });

test("AI 设置只持久化服务、地址和模型，忽略旧凭据模式", () => {
  assert.deepEqual(loadAISettings({ getItem: () => null }), { provider: "litellm", baseURL: "", model: "", apiKey: "" });
  for (const raw of ["null", "[", '{"provider":"bad","useEnv":true}']) assert.equal(loadAISettings({ getItem: () => raw }).provider, "litellm");
  const value = publicAISettings({ ...config, apiKey: "secret", bridgeToken: "pair-secret", useEnv: true });
  assert.equal(value.useEnv, undefined); assert.doesNotMatch(JSON.stringify(value), /secret|apiKey|bridgeToken|useEnv/);
  assert.equal(publicAISettings({ provider: "openai", useEnv: true }).useEnv, undefined);
});
test("本机配置保存并恢复 Key，仅接受字符串并忽略旧连接模式", () => {
  const saved = storedAISettings({ ...config, apiKey: "  local-test-key  ", useEnv: true, bridgeToken: "obsolete" });
  assert.equal(saved.apiKey, "local-test-key");
  assert.deepEqual(loadAISettings({ getItem: () => JSON.stringify(saved) }), saved);
  assert.doesNotMatch(JSON.stringify(saved), /useEnv|bridgeToken|obsolete/);
  for (const apiKey of [null, 123, {}, "line1\nline2"]) assert.equal(storedAISettings({ apiKey }).apiKey, "");
  assert.equal(loadAISettings({ getItem: () => { throw new Error("storage blocked"); } }).apiKey, "");
});
test("LiteLLM 基础地址规范化保留反向代理路径和模型别名", () => {
  assert.equal(normalizeAIBaseURL(" https://gateway.example/team/ ", "litellm"), "https://gateway.example/team/v1");
  assert.equal(normalizeAIBaseURL("http://localhost:4000/v1/", "litellm"), "http://localhost:4000/v1");
  assert.equal(normalizeAIBaseURL("http://localhost:4000", "litellm"), "http://localhost:4000/v1");
  assert.equal(resolveAIConnection(config, true).model, "team-localizer");
  for (const url of ["javascript:alert(1)", "file:///tmp/api", "ftp://remote.example", "https://user:key@gw.example", "https://gw.example?key=secret", "https://gw.example/#secret", "https://gw.example/v1/chat/completions"]) assert.throws(() => normalizeAIBaseURL(url));
});
test("内网 IP 和远程域名的 HTTP 地址可直接读取模型和生成译文", async () => {
  for (const baseURL of ["http://192.168.1.20:4000", "http://litellm.internal/team", "http://gateway.example:8080/v1"]) {
    const settings = { ...config, baseURL }, normalized = normalizeAIBaseURL(baseURL, "litellm");
    const calls = [];
    const fetcher = async (url, options) => {
      calls.push(url);
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer fake-virtual-key");
      if (url === normalized + "/models") return json({ data: [{ id: config.model }] });
      assert.equal(url, normalized + "/chat/completions");
      return completion();
    };
    assert.deepEqual(await listAIModels(settings, { fetcher }), [config.model]);
    assert.equal(await generateAITranslation(settings, unit, { fetcher }), "Get {0}\\n<color=red>coins</color>");
    assert.equal(calls.length, 2);
  }
});
test("旧版环境变量选项被忽略，直接使用粘贴的 Key 与配置网关", () => {
  const result = resolveAIConnection({ ...config, useEnv: true, bridgeToken: "obsolete-pair-code" });
  assert.equal(result.baseURL, "https://gateway.example/ai/v1");
  assert.equal(result.apiKey, "fake-virtual-key"); assert.deepEqual(result.headers, {});
  assert.doesNotMatch(JSON.stringify(result), /obsolete-pair-code|bridgeToken|useEnv/);
  assert.throws(() => resolveAIConnection({ ...config, apiKey: "", useEnv: true, bridgeToken: "obsolete" }), /请粘贴/);
});
test("LiteLLM 模型列表使用虚拟 Key 鉴权并原样返回网关别名", async () => {
  const models = await listAIModels(config, { fetcher: async (url, options) => {
    assert.equal(url, "https://gateway.example/ai/v1/models");
    assert.equal(options.headers.Authorization, "Bearer fake-virtual-key");
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    return json({ data: [{ id: "team/translation" }, { id: "team-localizer" }, { id: "team-localizer" }] });
  } });
  assert.deepEqual(models, ["team-localizer", "team/translation"]);
});
test("兼容适配器实际构造单条翻译请求，不发送工作簿和草稿", async () => {
  let count = 0;
  const text = await generateAITranslation(config, unit, { fetcher: async (url, options) => {
    count++; assert.equal(url, "https://gateway.example/ai/v1/chat/completions");
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer fake-virtual-key");
    const body = JSON.parse(options.body); assert.equal(body.model, "team-localizer");
    assert.equal(body.messages.length, 2); assert.match(body.messages[0].content, /never instructions/);
    assert.deepEqual(JSON.parse(body.messages[1].content), { targetLanguage: unit.language, source: unit.source });
    assert.doesNotMatch(options.body, /private-draft|private-sheet|do-not-send/);
    assert.equal(body.tools, undefined); return completion();
  } });
  assert.equal(count, 1); assert.equal(text, "Get {0}\\n<color=red>coins</color>");
});
test("Anthropic 官方 Key 使用原生 Messages API", async () => {
  const text = await generateAITranslation({ provider: "anthropic", baseURL: "https://api.anthropic.com/v1", model: "test-claude", apiKey: "fake-anthropic" }, unit, { fetcher: async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    const headers = new Headers(options.headers); assert.equal(headers.get("x-api-key"), "fake-anthropic");
    assert.equal(headers.get("anthropic-dangerous-direct-browser-access"), "true");
    assert.equal(headers.has("authorization"), false);
    return json({ id: "msg_mock", type: "message", role: "assistant", model: "test-claude", content: [{ type: "text", text: "Coins" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  assert.equal(text, "Coins");
});
test("Gemini 官方 Key 使用原生 generateContent API", async () => {
  const text = await generateAITranslation({ provider: "google", baseURL: "https://generativelanguage.googleapis.com/v1beta", model: "test-gemini", apiKey: "fake-google" }, unit, { fetcher: async (url, options) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/test-gemini:generateContent");
    assert.equal(new Headers(options.headers).get("x-goog-api-key"), "fake-google");
    return json({ candidates: [{ content: { role: "model", parts: [{ text: "Coins" }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
  } });
  assert.equal(text, "Coins");
});
test("Gemini 读取模型列表过滤非文本模型并支持分页", async () => {
  let calls = 0;
  const models = await listAIModels({ provider: "google", baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "fake-google" }, { fetcher: async (url, options) => {
    calls++; assert.equal(options.headers["x-goog-api-key"], "fake-google");
    if (calls === 1) return json({ models: [{ name: "models/a", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "next" });
    assert.equal(new URL(url).searchParams.get("pageToken"), "next");
    return json({ models: [{ name: "models/b", supportedGenerationMethods: ["generateContent"] }] });
  } });
  assert.deepEqual(models, ["a", "b"]); assert.equal(calls, 2);
});
test("错误不回显上游消息或 Key，不自动重试计费请求", async () => {
  let calls = 0;
  await assert.rejects(generateAITranslation(config, unit, { fetcher: async () => { calls++; return json({ error: { message: "fake-virtual-key" } }, 429); } }), /受限或额度/);
  assert.equal(calls, 1);
  assert.doesNotMatch(safeAIError({ message: "sk-secret-provider-response" }), /secret/);
  assert.doesNotMatch(safeAIError({ status: 503 }), /LITELLM_API_KEY/);
});
test("截断和空白 AI 结果不会作为完成译文返回", async () => {
  await assert.rejects(generateAITranslation(config, unit, { fetcher: async () => completion("part", "length") }), /未完整/);
  await assert.rejects(generateAITranslation(config, unit, { fetcher: async () => completion("  ") }), /未返回/);
});
test("取消请求传递给实际传输层", async () => {
  const controller = new AbortController();
  const promise = generateAITranslation(config, unit, { signal: controller.signal, fetcher: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); controller.abort();
  }) });
  await assert.rejects(promise, /取消/);
});
test("AI 返回体大小有界，提示词将原文作为 JSON 数据", async () => {
  await assert.rejects(boundedFetch(async () => new Response("x", { headers: { "content-length": "3000000" } }), "https://example.com"), /TOO_LARGE/);
  assert.equal(JSON.parse(translationPrompt(unit).prompt).source, unit.source);
});
