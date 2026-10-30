import test from "node:test";
import assert from "node:assert/strict";
import { setupOnlineAI } from "../src/ai-ui.js";

function fixture(options = {}) {
  const elements = new Map(); let stored = options.saved || null, calls = 0, loads = [];
  const element = () => ({ value: "", checked: false, hidden: false, disabled: false, textContent: "", children: [],
    append(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  const $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  let context = { bookKey: "book-a", draft: "", busy: false, unit: { id: "1", language: "EN", source: "金币 {0}", target: "", guards: [] } };
  const ui = setupOnlineAI({ document: { getElementById: $, createElement: element },
    getStorage: () => options.storage || ({ getItem: () => stored, setItem: (_key, value) => { stored = value; } }),
    getContext: () => context, loadDraft: value => { loads.push(value); context = { ...context, draft: value }; },
    confirm: options.confirm || (() => true),
    listModels: options.listModels || (async () => { calls++; return ["team-translator"]; }),
    generate: options.generate || (async () => { calls++; return "Coins {0}"; }) });
  return { $, ui, calls: () => calls, loads, stored: () => stored, context: () => context, setContext: value => { context = value; } };
}
test("AI 初始化不请求或改配置，粘贴后保存 Key 并在重开时恢复全部配置", () => {
  const f = fixture(); assert.equal(f.calls(), 0); assert.deepEqual(f.loads, []); assert.equal(f.stored(), null);
  f.$("ai-base-url").value = "https://gateway.example/v1"; f.$("ai-base-url").oninput();
  f.$("ai-model").value = "team-model"; f.$("ai-model").oninput();
  f.$("ai-key").value = "private-key"; f.$("ai-key").oninput();
  assert.equal(JSON.parse(f.stored()).apiKey, "private-key");
  const reopened = fixture({ saved: f.stored() });
  assert.equal(reopened.$("ai-base-url").value, "https://gateway.example/v1");
  assert.equal(reopened.$("ai-model").value, "team-model");
  assert.equal(reopened.$("ai-key").value, "private-key");
  assert.equal(reopened.calls(), 0);
});
test("清除保存的 Key 后重开为空，地址和模型保持", () => {
  const f = fixture({ saved: JSON.stringify({ provider: "litellm", baseURL: "https://gateway.example/v1", model: "team-model", apiKey: "saved-key" }) });
  f.$("ai-clear-key").onclick();
  assert.equal(JSON.parse(f.stored()).apiKey, "");
  const reopened = fixture({ saved: f.stored() });
  assert.equal(reopened.$("ai-key").value, ""); assert.equal(reopened.$("ai-model").value, "team-model");
  assert.equal(reopened.$("ai-base-url").value, "https://gateway.example/v1");
});
test("修改服务地址会同步移除已保存的 Key", () => {
  const f = fixture({ saved: JSON.stringify({ provider: "litellm", baseURL: "https://gateway.example/v1", model: "team-model", apiKey: "saved-key" }) });
  f.$("ai-base-url").value = "https://other.example/v1"; f.$("ai-base-url").oninput();
  assert.equal(JSON.parse(f.stored()).apiKey, ""); assert.equal(f.$("ai-key").value, "");
});
test("存储被禁用时明确提示仅本次会话生效，仍可填写 Key", () => {
  const f = fixture({ storage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
  f.$("ai-key").value = "session-test-key"; f.$("ai-key").oninput();
  assert.equal(f.$("ai-key").value, "session-test-key");
  assert.match(f.$("ai-settings-status").textContent, /存储不可用.*本次窗格会话/);
});
test("误粘贴到地址中的凭据和查询 Key 不会持久化", () => {
  const f = fixture();
  for (const value of ["https://user:private-password@gateway.example", "https://gateway.example?key=private-query-key"]) {
    f.$("ai-base-url").value = value; f.$("ai-base-url").oninput();
    assert.doesNotMatch(f.stored(), /private/); assert.equal(f.$("ai-base-url").value, value);
  }
});
test("旧版保存的环境变量选项不会阻止直接粘贴 Key", async () => {
  let received;
  const f = fixture({ saved: JSON.stringify({ provider: "litellm", baseURL: "https://gateway.example/v1", model: "team-model", useEnv: true }),
    listModels: async settings => { received = settings; return ["team-model"]; } });
  assert.equal(f.$("ai-base-url").value, "https://gateway.example/v1");
  assert.equal(f.$("ai-model").value, "team-model");
  assert.equal(f.$("ai-key").disabled, false);
  f.$("ai-key").value = "pasted-virtual-key"; f.$("ai-key").oninput();
  await f.$("ai-models").onclick();
  assert.equal(received.apiKey, "pasted-virtual-key");
  assert.equal(received.useEnv, undefined); assert.equal(received.bridgeToken, undefined);
  assert.equal(JSON.parse(f.stored()).apiKey, "pasted-virtual-key");
  assert.doesNotMatch(f.stored(), /useEnv|bridgeToken/);
});
test("切换官方服务清空旧 Key 和模型", () => {
  const f = fixture(); f.$("ai-key").value = "old-key";
  f.$("ai-model").value = "old-model"; f.$("ai-provider").value = "google"; f.$("ai-provider").onchange();
  assert.equal(f.$("ai-key").value, ""); assert.equal(f.$("ai-model").value, "");
  assert.match(f.$("ai-base-url").value, /googleapis/);
});
test("生成仅发送当前原文与语言，先展示建议，再由用户载入草稿", async () => {
  const f = fixture({ generate: async (_settings, unit) => { assert.deepEqual(unit, { source: "金币 {0}", language: "EN" }); return "Coins {0}"; } });
  await f.$("online-ai-generate").onclick();
  assert.deepEqual(f.loads, []); assert.equal(f.$("online-ai-result").textContent, "Coins {0}");
  assert.equal(f.$("online-ai-result-box").hidden, false); assert.equal(f.$("online-ai-load").disabled, false);
  f.$("online-ai-load").onclick(); assert.deepEqual(f.loads, ["Coins {0}"]);
});
test("生成结束后格式问题可见，仍可载入草稿修改", async () => {
  const f = fixture({ generate: async () => "Coins" }); await f.$("online-ai-generate").onclick();
  assert.match(f.$("online-ai-errors").textContent, /缺少.*\{0\}/);
  assert.equal(f.$("online-ai-load").disabled, false);
});
test("覆盖已有草稿需要确认，取消时保持原草稿", async () => {
  const f = fixture({ confirm: () => false }); f.setContext({ ...f.context(), draft: "Original" });
  await f.$("online-ai-generate").onclick(); f.$("online-ai-load").onclick();
  assert.deepEqual(f.loads, []); assert.equal(f.context().draft, "Original");
});
test("生成期间切换工作簿取消请求，迟到结果不会应用到新条目", async () => {
  let finish, signal;
  const f = fixture({ generate: async (_settings, _unit, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  const task = f.$("online-ai-generate").onclick();
  f.setContext({ ...f.context(), bookKey: "book-b" }); f.ui.refresh();
  assert.equal(signal.aborted, true); finish("Wrong coins"); await task;
  assert.equal(f.$("online-ai-result-box").hidden, true); assert.deepEqual(f.loads, []);
});
test("已展示结果遇到原文变化或草稿编辑时失效", async () => {
  for (const mutate of [c => ({ ...c, draft: "typed" }), c => ({ ...c, unit: { ...c.unit, source: "new source" } })]) {
    const f = fixture(); await f.$("online-ai-generate").onclick();
    f.setContext(mutate(f.context())); f.ui.refresh(); f.$("online-ai-load").onclick();
    assert.equal(f.$("online-ai-result-box").hidden, true); assert.deepEqual(f.loads, []);
  }
});
test("取消按钮使晚到结果失效，随后可以再次生成", async () => {
  let finish;
  const f = fixture({ generate: async () => new Promise(resolve => { finish = resolve; }) });
  const task = f.$("online-ai-generate").onclick(); f.$("online-ai-cancel").onclick(); finish("late"); await task;
  assert.equal(f.$("online-ai-generate").disabled, false); assert.equal(f.$("online-ai-result-box").hidden, true);
});
test("接表阶段可读取模型并显示连接状态，不需要当前条目", async () => {
  const f = fixture(); f.setContext({ unit: null, bookKey: "", draft: "" });
  await f.$("ai-models").onclick();
  assert.equal(f.$("ai-model").value, "team-translator"); assert.match(f.$("ai-connection-status").textContent, /读取 1 个/);
  assert.equal(f.$("online-ai-generate").disabled, true); assert.equal(f.calls(), 1);
});
