import test from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates, openUpdateWebsite, updateWebsite, updateManifestUrl } from "../src/updates.js";
import { setupUpdateControls } from "../src/update-ui.js";

const manifest = version => ({ name: "WpsTranslationAssistant", addonType: "et", online: "false", version,
  package: "packages/WpsTranslationAssistant-" + version + ".7z", sha256: "a".repeat(64), size: 100 });
const fetchVersion = version => async () => Response.json(manifest(version));
function controls(options = {}) {
  const elements = Object.fromEntries(["current-version", "check-updates", "update-status", "open-update-site", "update-link-fallback"].map(id => [id, { textContent: "", hidden: true, disabled: false, dataset: {} }]));
  setupUpdateControls({ version: "1.2.2", document: { getElementById: id => elements[id] }, ...options });
  return elements;
}

test("插件更新按数字版本比较，区分新版、最新和本机超前", async () => {
  assert.equal((await checkForUpdates("1.2.2", { fetcher: fetchVersion("1.10.0") })).status, "available");
  assert.equal((await checkForUpdates("1.2.2", { fetcher: fetchVersion("1.2.2") })).status, "current");
  assert.equal((await checkForUpdates("1.2.2", { fetcher: fetchVersion("1.2.1") })).status, "ahead");
});
test("检查更新只向固定地址发起无凭据 GET 请求，不携带工作簿内容", async () => {
  await checkForUpdates("1.2.2", { fetcher: async (url, options) => {
    assert.equal(url, updateManifestUrl); assert.equal(options.credentials, "omit");
    assert.equal(options.body, undefined); assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error"); assert.ok(options.signal);
    return Response.json(manifest("1.2.3"));
  } });
});
test("HTTP 失败、网络异常和无效清单不会误报为最新版本", async () => {
  await assert.rejects(checkForUpdates("1.2.2", { fetcher: async () => new Response("", { status: 503 }) }), /503/);
  await assert.rejects(checkForUpdates("1.2.2", { fetcher: async () => { throw new TypeError("network"); } }), /无法连接/);
  for (const value of [{ ...manifest("1.2.3"), name: "Other" }, { ...manifest("1.2.3"), version: "latest" }, { ...manifest("1.2.3"), package: "https://other.test/file.7z" }]) {
    await assert.rejects(checkForUpdates("1.2.2", { fetcher: async () => Response.json(value) }), /格式异常/);
  }
  await assert.rejects(checkForUpdates("1.2.2", { fetcher: async () => new Response("<html>error</html>") }), /格式异常/);
});
test("检查超时终止请求并显示超时，不报告无更新", async () => {
  await assert.rejects(checkForUpdates("1.2.2", { timeoutMs: 1, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) }), /超时/);
});
test("显示当前版本，打开面板时不会自动检查或打开网站", () => {
  let requests = 0, opens = 0;
  const el = controls({ check: () => requests++, open: () => opens++ });
  assert.equal(el["current-version"].textContent, "当前版本 v1.2.2");
  assert.equal(requests, 0); assert.equal(opens, 0);
});
test("发现新版后显示独立网站按钮，不自动打开，点击后调用打开接口", async () => {
  let opens = 0;
  const el = controls({ check: async () => ({ status: "available", latestVersion: "1.2.3" }), open: () => opens++ });
  await el["check-updates"].onclick();
  assert.match(el["update-status"].textContent, /发现新版本 v1.2.3/);
  assert.equal(el["open-update-site"].hidden, false); assert.equal(opens, 0);
  el["open-update-site"].onclick(); assert.equal(opens, 1);
});
test("同一轮检查阻止重复请求，结束后可再次检查且清除旧提示", async () => {
  let calls = 0, resolve;
  const el = controls({ check: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const first = el["check-updates"].onclick();
  await el["check-updates"].onclick();
  assert.equal(calls, 1); assert.equal(el["check-updates"].disabled, true);
  resolve({ status: "available", latestVersion: "1.2.3" }); await first;
  assert.equal(el["check-updates"].disabled, false);
  const second = el["check-updates"].onclick();
  assert.equal(el["open-update-site"].hidden, true);
  resolve({ status: "current", latestVersion: "1.2.2" }); await second;
  assert.match(el["update-status"].textContent, /已是最新/);
  assert.equal(el["open-update-site"].hidden, true);
});
test("离线失败允许重试并保留手动网站入口；浏览器打开失败显示固定链接", async () => {
  const el = controls({ check: async () => { throw new Error("网络失败"); }, open: () => { throw new Error("unsupported"); } });
  await el["check-updates"].onclick();
  assert.match(el["update-status"].textContent, /网络失败/);
  assert.equal(el["check-updates"].disabled, false); assert.equal(el["open-update-site"].hidden, false);
  el["open-update-site"].onclick();
  assert.equal(el["update-link-fallback"].hidden, false);
});
test("仅使用固定 HTTPS 网站调用 WPS ShellExecute，失败时不宣称成功", () => {
  let opened;
  openUpdateWebsite({ OAAssist: { ShellExecute: url => { opened = url; } } });
  assert.equal(opened, updateWebsite);
  assert.throws(() => openUpdateWebsite(null));
  assert.throws(() => openUpdateWebsite({ OAAssist: { ShellExecute: () => false } }));
});
