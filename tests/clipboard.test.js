import test from "node:test";
import assert from "node:assert/strict";
import { copyText } from "../src/clipboard.js";

const key = "FishVariationMainTagInfoCfg/3/MainTag";
function legacy(result = true) {
  const calls = [], input = { style: {}, focus: () => calls.push("focus"), select: () => calls.push("select"), remove: () => calls.push("remove") };
  const document = { activeElement: { focus: () => calls.push("restore") },
    createElement: tag => { assert.equal(tag, "textarea"); return input; },
    body: { append: node => { assert.equal(node, input); calls.push("append"); } },
    execCommand: command => { assert.equal(command, "copy"); calls.push("copy"); return result; } };
  return { document, input, calls };
}

test("复制完整 Key 原文，不追加位置、标签或改变空白", async () => {
  let copied;
  await copyText(" " + key + " ", { navigator: { clipboard: { writeText: async value => { copied = value; } } }, document: null });
  assert.equal(copied, " " + key + " ");
});
test("本地加载项缺少 Clipboard API 时复制并清理临时控件、恢复焦点", async () => {
  const env = legacy();
  await copyText(key, { navigator: {}, document: env.document });
  assert.equal(env.input.value, key);
  assert.deepEqual(env.calls, ["append", "focus", "select", "copy", "remove", "restore"]);
});
test("Clipboard API 拒绝访问后仍可通过兼容路径复制", async () => {
  const env = legacy();
  await copyText(key, { navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } }, document: env.document });
  assert.equal(env.input.value, key);
  assert.ok(env.calls.includes("copy"));
});
test("复制失败明确报错，并清理临时控件与恢复焦点", async () => {
  const env = legacy(false);
  await assert.rejects(copyText(key, { navigator: {}, document: env.document }), /未能复制/);
  assert.deepEqual(env.calls.slice(-2), ["remove", "restore"]);
  await assert.rejects(copyText(key, { navigator: {}, document: null }), /未能复制/);
});
test("没有 Key 时不调用系统剪贴板", async () => {
  await assert.rejects(copyText("", { navigator: null, document: null }), /没有可复制/);
});
