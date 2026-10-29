import test from "node:test";
import assert from "node:assert/strict";
import { loadValidationSettings, setupValidationSettings } from "../src/validation-settings.js";
import { parseWorkbook, revalidateUnits, adoptionProblem, sameReviewedUnit } from "../src/model.js";
import { workflowSummary, draftProblem } from "../src/workflow.js";
import { sampleSheets } from "./fixtures.js";

function controls(storage, changed = () => {}) {
  const elements = { "check-newlines": { checked: false }, "validation-settings-status": { hidden: true, textContent: "" } };
  const settings = setupValidationSettings({ getStorage: () => storage, changed, document: { getElementById: id => elements[id] } });
  return { settings, elements, toggle: value => { elements["check-newlines"].checked = value; return elements["check-newlines"].onchange(); } };
}

test("无设置、损坏设置及存储不可用时默认开启换行检查", () => {
  for (const value of [null, "not-json", "null", "{}", '{"checkNewlines":"false"}', '{"checkNewlines":0}']) {
    assert.deepEqual(loadValidationSettings({ getItem: () => value }), { checkNewlines: true });
  }
  assert.deepEqual(loadValidationSettings({ getItem: () => { throw new Error("blocked"); } }), { checkNewlines: true });
});

test("明确保存关闭或开启时读取相应设置", () => {
  assert.deepEqual(loadValidationSettings({ getItem: () => '{"checkNewlines":false}' }), { checkNewlines: false });
  assert.deepEqual(loadValidationSettings({ getItem: () => '{"checkNewlines":true}' }), { checkNewlines: true });
});

test("设置控件默认勾选，初始化不写存储或触发重新检查", () => {
  let writes = 0, changes = 0;
  const ui = controls({ getItem: () => null, setItem: () => writes++ }, () => changes++);
  assert.equal(ui.elements["check-newlines"].checked, true);
  assert.equal(writes, 0);
  assert.equal(changes, 0);
});

test("切换保存本机偏好并立即生效，重新打开控件恢复上次选择", async () => {
  let stored = null, changed;
  const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  const ui = controls(storage, value => { changed = value; });
  await ui.toggle(false);
  assert.deepEqual(changed, { checkNewlines: false });
  assert.equal(controls(storage).elements["check-newlines"].checked, false);
  assert.match(ui.elements["validation-settings-status"].textContent, /保存在本机/);
  await ui.toggle(true);
  assert.equal(controls(storage).settings.value.checkNewlines, true);
});

test("存储受限仍可切换并提示仅当前会话生效", async () => {
  let changed;
  const ui = controls({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }, value => { changed = value; });
  await ui.toggle(false);
  assert.equal(changed.checkNewlines, false);
  assert.equal(ui.settings.value.checkNewlines, false);
  assert.match(ui.elements["validation-settings-status"].textContent, /仅在本次窗格会话/);
});

test("大表异步重算期间立即显示已取消勾选和更新中，完成后恢复操作", async () => {
  let finish;
  const ui = controls({ getItem: () => null, setItem: () => {} }, () => new Promise(resolve => { finish = resolve; }));
  const pending = ui.toggle(false);
  assert.equal(ui.elements["check-newlines"].checked, false);
  assert.equal(ui.settings.value.checkNewlines, false);
  assert.match(ui.elements["validation-settings-status"].textContent, /已关闭.*正在更新/);
  assert.equal(ui.elements["check-newlines"].disabled, true);
  finish();
  await pending;
  assert.equal(ui.elements["check-newlines"].disabled, false);
  assert.match(ui.elements["validation-settings-status"].textContent, /检查结果已更新/);
});

test("重新检查失败不误报完成，控件可恢复并提示重新识别", async () => {
  const ui = controls({ getItem: () => null, setItem: () => {} }, async () => { throw new Error("failed"); });
  await ui.toggle(false);
  assert.equal(ui.elements["check-newlines"].disabled, false);
  assert.match(ui.elements["validation-settings-status"].textContent, /未能更新，请重新识别/);
});

test("分批重算与完整解析校验结果一致，保留重复 Key、条目位置和旧草稿依据", async () => {
  const sheets = sampleSheets();
  sheets[1].values[1][5] = "Get {0}\\ncoins";
  sheets[1].values[1][6] = "Get {0}\\ncoins";
  sheets[1].values[2][0] = "Coin";
  const original = parseWorkbook(sheets, "EN").units, saved = structuredClone(original);
  const relaxed = await revalidateUnits(original, { checkNewlines: false });
  assert.deepEqual(relaxed, parseWorkbook(sheets, "EN", [], { checkNewlines: false }).units);
  assert.deepEqual(original, saved);
  assert.ok(relaxed[0].errors.some(e => e.includes("重复 Key")));
  assert.equal(sameReviewedUnit(original[0], relaxed[0]), true);
  assert.equal(relaxed[0].guards, original[0].guards);
  assert.deepEqual(await revalidateUnits(relaxed, { checkNewlines: true }), original);
});

test("大列表在计算前和批次之间让出线程，避免整次检查阻塞勾选刷新", async () => {
  const seed = parseWorkbook(sampleSheets(), "EN").units[0];
  const units = Array.from({ length: 1001 }, () => seed);
  let yields = 0;
  const pending = revalidateUnits(units, { checkNewlines: false }, { yieldControl: async () => { yields++; } });
  assert.equal(yields, 1);
  const result = await pending;
  assert.equal(result.length, units.length);
  assert.equal(yields, 3);
});

test("换行设置统一影响译文、AI、草稿和交付检查，不使已保留草稿失效", () => {
  const sheet = sampleSheets()[1];
  sheet.values = [sheet.values[0], ["K", "", "获得 {0}", "", "", "Get {0}\\ncoins", "Get {0}\\ncoins"]];
  sheet.rows = 2;
  const strict = parseWorkbook([sheet], "EN").units;
  const relaxed = parseWorkbook([sheet], "EN", [], { checkNewlines: false }).units;
  assert.ok(strict[0].errors.length && strict[0].aiErrors.length);
  assert.deepEqual(relaxed[0].errors, []);
  assert.deepEqual(relaxed[0].aiErrors, []);
  assert.equal(draftProblem(relaxed[0], "Get {0}\\ncoins"), "");
  assert.match(draftProblem(strict[0], "Get {0}\\ncoins"), /换行标记/);
  assert.equal(workflowSummary(strict).ready, false);
  assert.equal(workflowSummary(relaxed).ready, true);
  assert.equal(sameReviewedUnit(strict[0], relaxed[0]), true);
  assert.match(draftProblem(relaxed[0], "Get\\ncoins"), /缺少受保护片段/);
  assert.match(adoptionProblem({ ...strict[0], target: "" }), /未通过/);
  assert.equal(adoptionProblem({ ...relaxed[0], target: "" }), "");
});
