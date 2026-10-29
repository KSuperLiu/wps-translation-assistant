import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkbook, sameReviewedUnit, adoptionProblem } from "../src/model.js";
import { createManualProfile } from "../src/schema.js";
import { taskKind, workflowSummary, workflowUnits, nextPending, draftProblem, sourceDifference } from "../src/workflow.js";

const example = () => ({ name: "Task", rows: 6, columns: 7, values: [
  ["LanguageKey", "Source Text (old)", "Source Text", "WEIGHT", "EN (old)", "EN", "EN_AI"],
  ["revision", "伤害+32%", "伤害+10%", "", "DMG +32%", "", "DMG +10%"],
  ["translate", "", "获得 {0}", "", "", "", "Get {0}"],
  ["unclear", "", "", "", "", "", "Guess"],
  ["review", "你好", "你好", "", "Hello", "Hello", "Hello"],
  ["invalid", "", "剩余 {0}", "", "", "Remaining", "Remaining {0}"],
] });

test("接表区分原文修订、补译、旧译复核和空原文，状态不混同任务类型", () => {
  const m = parseWorkbook([example()], "EN"), s = workflowSummary(m.units, m.diagnostics);
  assert.deepEqual(m.units.map(taskKind), ["待修订", "待补译", "待补译", "已填写", "已填写"]);
  assert.deepEqual({ total: s.total, revision: s.revision, translation: s.translation, review: s.review, unfilled: s.unfilled, errors: s.errors, filled: s.filled }, { total: 5, revision: 1, translation: 2, review: 0, unfilled: 3, errors: 1, filled: 2 });
  assert.equal(s.ready, false);
});

test("当前译文已填写时不因旧译文为空而归为待补译，原文变化仍提示复核", () => {
  const sheet = example();
  sheet.values[1][5] = "DMG +10%";
  sheet.values[2][5] = "Get {0}";
  const units = parseWorkbook([sheet], "EN").units, s = workflowSummary(units);
  assert.equal(taskKind(units[0]), "待修订");
  assert.equal(taskKind(units[1]), "已填写");
  assert.deepEqual(workflowUnits(units, { status: "translation" }).map(u => u.key), ["unclear"]);
  assert.equal(workflowUnits(units, { status: "revision" }).length, 1);
  assert.equal(s.filled, 4);
  assert.equal(s.filled + s.unfilled, s.total);
  assert.equal(workflowUnits(units, { status: "pending" }).some(u => u.key === "invalid"), true);
});

test("空白译文保留补译、原文修订和旧译参考分类，已填写零文本不当成空白", () => {
  const sheet = example();
  sheet.values[4][5] = " ";
  sheet.values[5][5] = "0";
  const units = parseWorkbook([sheet], "EN").units, s = workflowSummary(units);
  assert.deepEqual(units.map(taskKind), ["待修订", "待补译", "待补译", "旧译复核", "已填写"]);
  assert.deepEqual({ filled:s.filled, translation:s.translation, revision:s.revision, review:s.review }, { filled:1, translation:2, revision:1, review:1 });
  assert.equal(s.filled + s.translation + s.revision + s.review, s.total);
});
test("自动读取旧原文并将旧原文、旧译文纳入写入前核对", () => {
  const u = parseWorkbook([example()], "EN").units[0];
  assert.equal(u.oldSource, "伤害+32%");
  assert.ok(u.guards.some(g => g.cell === "B2" && g.value === u.oldSource));
  assert.ok(u.guards.some(g => g.cell === "E2" && g.value === u.old));
  assert.equal(sameReviewedUnit(u, { ...u, oldSource: "changed" }), false);
  assert.equal(sameReviewedUnit(u, { ...u, old: "changed" }), false);
});
test("完成一条后跨表寻找下一条，跳过空原文；核实范围仍可定位空原文", () => {
  const m = parseWorkbook([example()], "EN"), units = m.units;
  assert.equal(nextPending(units, units[0].id).key, "translate");
  assert.equal(nextPending(units, units[1].id).key, "unclear");
  assert.equal(nextPending(units, units[1].id, {}, { skipUnclear: false }).key, "unclear");
  const other = { ...units[1], id: "other", sheet: "Other" };
  assert.equal(nextPending([...units, other], units.at(-1).id).key, "translate");
  assert.equal(nextPending([...units, other], null, { sheet: "Other" }).id, "other");
  assert.equal(nextPending(units, null, { query: "不存在" }), null);
  assert.equal(nextPending(units, units[0].id, { status: "translation" }).key, "translate");
  assert.equal(nextPending(units, null, { status: "filled" }).key, "invalid");
});
test("待处理、需核实和已填写筛选不互相冒充，搜索可以找到旧原文", () => {
  const u = parseWorkbook([example()], "EN").units;
  assert.equal(workflowUnits(u, { status: "pending" }).length, 4);
  assert.equal(workflowUnits(u, { status: "filled" }).length, 2);
  assert.equal(workflowUnits(u, { query: "伤害+32%" }).length, 1);
});

test("下一条优先跳转空译文，即使前面先遇到已有译文的校验问题", () => {
  const units = parseWorkbook([example()], "EN").units;
  assert.equal(nextPending(units, units[3].id).key, "revision");
  assert.equal(nextPending(units, units[0].id).key, "translate");
  const other = { ...units[1], id: "other", sheet: "Other" };
  assert.equal(nextPending([units[3], units[4], other], units[3].id).id, "other");
});

test("当前范围空译文全部填完后才跳转校验问题，没有问题时不返回已完成条目", () => {
  const units = parseWorkbook([example()], "EN").units.map(u => u.untranslated ? { ...u, untranslated: false, target: "Filled", errors: [] } : u);
  assert.equal(nextPending(units, units[3].id).key, "invalid");
  assert.equal(nextPending(units, units[4].id).key, "invalid");
  assert.equal(nextPending(units.map(u => ({ ...u, errors: [] })), units[3].id), null);
});

test("空译文优先级不突破工作表、搜索与任务筛选范围", () => {
  const units = parseWorkbook([example()], "EN").units;
  const other = { ...units[1], id: "other", sheet: "Other" };
  const candidates = [units[3], units[4], other];
  assert.equal(nextPending(candidates, units[3].id, { sheet: "Task" }).key, "invalid");
  assert.equal(nextPending(units, null, { query: "剩余" }).key, "invalid");
  assert.equal(nextPending(units, null, { status: "filled" }).key, "invalid");
  assert.equal(nextPending(units, null, { status: "issues" }).key, "invalid");
});

test("空译文按原条目顺序循环；唯一空译文及带 Key 问题的空译文仍优先", () => {
  const units = parseWorkbook([example()], "EN").units;
  assert.equal(nextPending(units, units[2].id).key, "revision");
  const blank = { ...units[1], duplicate: true, errors: ["重复 Key"] };
  assert.equal(nextPending([units[4], blank], units[4].id).id, blank.id);
  assert.equal(nextPending([units[4], blank], blank.id).id, blank.id);
  assert.equal(nextPending([], null), null);
});
test("草稿必须有原文、非空且保留占位符和 TMP；表内 AI 通过不等于人工译文通过", () => {
  const u = parseWorkbook([example()], "EN").units;
  assert.match(draftProblem(u[1], "Get"), /缺少/);
  assert.equal(draftProblem(u[1], "Get {0}"), "");
  assert.equal(draftProblem(u[1], "  "), "");
  assert.equal(draftProblem(u[2], "Guess"), "");
  assert.equal(adoptionProblem(u[2]), "");
  assert.equal(workflowSummary([u[1], u[2]], []).ready, true);
  assert.match(draftProblem({ ...u[1], source: "<b>{0}</b>" }, "<b>{0}"), /受保护|标签/);
});
test("空原文有完整字段 Key 时纳入需核实，无内容且没有字段 Key 的配置格不制造任务", () => {
  const s = { name: "Cfg", rows: 5, columns: 9, values: [
    ["表名", "Cfg"], ["标记字段", "", "Name", "", "", "", "", "Name_AI", "Name_i18N"],
    ["字段解释", "Source Text (old)", "", "WEIGHT", "EN (old)", "EN"],
    ["Cfg/1", "", "", "", "", "", "", "", "Cfg/1/Name"],
    ["Cfg/2", "", "", "", "", ""],
  ] };
  const m = parseWorkbook([s], "EN"); assert.equal(m.units.length, 1); assert.equal(taskKind(m.units[0]), "待补译");
});
test("非空原文无 Key、未识别区域都阻止报告技术检查就绪", () => {
  const s = example(); s.values[2][0] = "";
  const m = parseWorkbook([s], "EN"); assert.ok(m.diagnostics.some(d => d.includes("缺少 Key")));
  const good = m.units.filter(u => !u.untranslated && !u.errors.length && u.source);
  assert.equal(workflowSummary(good, []).ready, true);
  assert.equal(workflowSummary(good, m.diagnostics).ready, false);
  assert.equal(workflowSummary([], []).ready, false);
});
test("旧原文手动映射校验范围和列冲突，同结构可复用", () => {
  const s = example(), e = { language: "EN", field: "Text", headerRow: 1, dataStartRow: 2, keyCol: 1, oldSourceCol: 2, sourceCol: 3, oldCol: 5, targetCol: 6, aiCol: 7 };
  const p = createManualProfile(s, e), m = parseWorkbook([s], "EN", [p]);
  assert.equal(m.units[0].oldSource, "伤害+32%");
  assert.throws(() => createManualProfile(s, { ...e, oldSourceCol: 6 }), /不同|重复/);
  assert.throws(() => createManualProfile(s, { ...e, oldSourceCol: 9 }), /不同|重复/);
});
test("差异片段可重建新旧全文，支持删除、插入与完全相同文本", () => {
  for (const [a, b] of [["伤害+32%", "伤害+10%"], ["abc", "ab"], ["", "abc"], ["same", "same"]]) {
    const d = sourceDifference(a, b);
    assert.equal(d.prefix + d.removed + d.suffix, a);
    assert.equal(d.prefix + d.added + d.suffix, b);
  }
});
