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
  assert.deepEqual(m.units.map(taskKind), ["待修订", "待补译", "待补译", "旧译复核", "待补译"]);
  assert.deepEqual({ total: s.total, revision: s.revision, translation: s.translation, review: s.review, unfilled: s.unfilled, errors: s.errors, filled: s.filled }, { total: 5, revision: 1, translation: 3, review: 1, unfilled: 3, errors: 1, filled: 2 });
  assert.equal(s.ready, false);
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
