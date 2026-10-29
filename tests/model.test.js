import test from "node:test";
import assert from "node:assert/strict";
import { validateText, extractTokens } from "../src/validation.js";
import { parseWorkbook, discoverLanguages, statistics, filterUnits, selectedUnit, adoptionProblem, sameReviewedUnit } from "../src/model.js";
import { normalizeMatrix } from "../src/wps-host.js";
import { sampleSheets } from "./fixtures.js";

test("占位符按出现次数比较，不能只比较集合", () => {
  assert.deepEqual(validateText("{0} + {0}", "{0}"), ["缺少受保护片段：{0}"]);
  assert.deepEqual(validateText("{0}", "{0} {0}"), ["新增或修改了受保护片段：{0}"]);
});
test("格式占位符、命名参数、转义换行与属性原样保留", () => {
  const source = "{name} %2$s %d\\n<color=#fff>{0}</color>";
  assert.equal(extractTokens(source).length, 7);
  assert.deepEqual(validateText(source, source), []);
  assert.ok(validateText(source, source.replace("#fff", "#000")).length === 2);
});

test("允许译文新增一个或多个字面量换行标记，不要求数量与原文相等", () => {
  assert.deepEqual(validateText("你好", "Hello\\nworld\\n"), []);
  assert.deepEqual(validateText("你好\\n世界 {0}", "Hello\\n\\nworld {0}\\n"), []);
});

test("原文已有的字面量换行被删减时仍提示，单元格实际换行不能替代它", () => {
  assert.deepEqual(validateText("你好\\n世界\\n", "Hello\\nworld"), ["译文比原文少了 1 个换行标记 \\n（反斜杠 + n，不是单元格实际换行）"]);
  assert.ok(validateText("你好\\n世界", "Hello\nworld").some(e => e.includes("少了 1 个换行标记")));
});

test("允许额外换行不放过占位符缺失、额外占位符和标签错误", () => {
  assert.deepEqual(validateText("{0} {0}", "{0}\\n"), ["缺少受保护片段：{0}"]);
  assert.deepEqual(validateText("{0}", "{0}\\n{1}"), ["新增或修改了受保护片段：{1}"]);
  assert.ok(validateText("<b>{0}</b>", "<b>{0}\\n").some(e => e.includes("未闭合")));
});
test("标签嵌套次序错误及自闭合标签与工作台一致", () => {
  assert.ok(validateText("<b><i>x</i></b>", "<b><i>x</b></i>").some(e => e.includes("顺序")));
  assert.deepEqual(validateText('<sprite name="fish"><br><space=2>', '<sprite name="fish"><br><space=2>'), []);
  assert.deepEqual(validateText("<B>x</B>", "<B>y</B>"), []);
});
test("同时识别 Language 和配置表中两个五列字段组", () => {
  const sheets = sampleSheets(), model = parseWorkbook(sheets, "EN");
  assert.deepEqual(discoverLanguages(sheets), ["EN"]);
  assert.equal(model.units.length, 6);
  assert.equal(model.diagnostics.length, 0);
  assert.equal(model.units.find(u => u.key === "Fish/Name").cell, "F4");
  assert.equal(model.units.find(u => u.key === "Fish/Desc").cell, "K4");
  assert.equal(model.units.find(u => u.key === "Fish/Desc").ai, "Weight {0}");
});
test("未翻译与校验错误分开统计，AI 错误不混算成当前译文错误", () => {
  const model = parseWorkbook(sampleSheets(), "EN");
  assert.deepEqual(statistics(model.units), { total: 6, translated: 3, untranslated: 3, errors: 1, progress: 50 });
  assert.equal(filterUnits(model.units, { status: "issues" }).length, 1);
  assert.equal(filterUnits(model.units, { sheet: "FishCfg", status: "untranslated" }).length, 1);
  assert.equal(filterUnits(model.units, { query: "WEIGHT {0}" }).length, 1);
});
test("同一配置行按所选字段组定位正确译文", () => {
  const units = parseWorkbook(sampleSheets(), "EN").units;
  assert.equal(selectedUnit(units, "FishCfg", 4, 10).key, "Fish/Desc");
  assert.equal(selectedUnit(units, "FishCfg", 4, 6).key, "Fish/Name");
});
test("配置表缺少 i18N 值时沿用 baseKey/field 规则", () => {
  const sheets = sampleSheets(); sheets[2].values[3][14] = "";
  assert.ok(parseWorkbook(sheets, "EN").units.some(u => u.key === "fish1/Desc"));
});

test("真实导出布局：原文表头空白但相邻表头完整，仍识别两个字段组", () => {
  const sheets = sampleSheets();
  sheets[2].values[2][1] = "Source Text (old)";
  sheets[2].values[2][2] = "";
  sheets[2].values[2][6] = "Source Text (old)";
  sheets[2].values[2][7] = "";
  const model = parseWorkbook(sheets, "EN");
  assert.equal(model.units.length, 6);
  assert.deepEqual(model.diagnostics, []);
  assert.deepEqual(discoverLanguages([sheets[2]]), ["EN"]);
  assert.equal(model.units.find(u => u.key === "Fish/Name").cell, "F4");
  assert.equal(model.units.find(u => u.key === "Fish/Desc").cell, "K4");
});

test("空白原文表头不能绕过旧原文及旧新语种配对校验", () => {
  for (const [column, wrongValue] of [[1, "Notes"], [4, "FR (old)"]]) {
    const sheets = sampleSheets();
    sheets[2].values[2][1] = "Source Text (old)";
    sheets[2].values[2][2] = "";
    sheets[2].values[2][column] = wrongValue;
    const model = parseWorkbook(sheets, "EN");
    assert.ok(!model.units.some(u => u.key === "Fish/Name"));
    assert.ok(model.units.some(u => u.key === "Fish/Desc"));
    assert.ok(model.diagnostics.some(d => d.includes("Name")));
  }
});

test("自定义原文说明按 Key 和旧新译文关系识别，不限定说明文案", () => {
  const sheets = sampleSheets();
  sheets[2].values[2][1] = "Source Text (old)";
  sheets[2].values[2][2] = "Notes";
  assert.ok(parseWorkbook(sheets, "EN").units.some(u => u.key === "Fish/Name"));
});

function referenceLanguageSheet() {
  const sheet = sampleSheets()[2];
  sheet.values[2][1] = "Source Text (old)";
  sheet.values[2][2] = "道具名称\n（最多24个字符）";
  sheet.values[2][3] = "EN";
  sheet.values[2][4] = "KO (old)";
  sheet.values[2][5] = "KO";
  sheet.values[2][6] = "Source Text (old)";
  sheet.values[2][7] = "功能说明&道具描述";
  sheet.values[2][8] = "EN";
  sheet.values[2][9] = "KO (old)";
  sheet.values[2][10] = "KO";
  sheet.values[1][12] = "Name_il8N";
  sheet.values[1][14] = "Desc_il8N";
  sheet.values[3][12] = "-1221017913_name";
  sheet.values[3][14] = "-1221017913_description";
  return sheet;
}

test("KO 导出表：中文字段说明、EN 参考列和 il8N Key 列可正确识别目标语言", () => {
  const sheet = referenceLanguageSheet();
  assert.deepEqual(discoverLanguages([sheet]), ["KO"]);
  const model = parseWorkbook([sheet], "KO");
  assert.equal(model.units.length, 2);
  assert.deepEqual(model.diagnostics, []);
  assert.equal(model.units[0].key, "-1221017913_name");
  assert.equal(model.units[0].cell, "F4");
  assert.equal(model.units[1].key, "-1221017913_description");
  assert.equal(model.units[1].cell, "K4");
  assert.equal(parseWorkbook([sheet], "EN").units.length, 0);
});

test("参考语言格式旧目标语种不匹配时不猜测写入目标", () => {
  for (const failure of ["old-target"]) {
    const sheet = referenceLanguageSheet();
    if (failure === "missing-key") sheet.values[1][12] = "Notes";
    if (failure === "old-target") sheet.values[2][4] = "FR (old)";
    if (failure === "reference") sheet.values[2][3] = "Notes";
    const model = parseWorkbook([sheet], "KO");
    assert.ok(!model.units.some(u => u.field === "Name"));
    assert.ok(model.units.some(u => u.field === "Desc"));
    assert.ok(model.diagnostics.length > 0);
  }
});

test("参考列或权重列改名不影响目标语种关系，完整 Key 空缺仍可按 Id/field 回退", () => {
  const sheet = referenceLanguageSheet();
  sheet.values[2][3] = "Notes";
  sheet.values[1][12] = "Other";
  const model = parseWorkbook([sheet], "KO");
  assert.ok(model.units.some(u => u.key === "fish1/Name" && u.cell === "F4"));
  assert.deepEqual(discoverLanguages([sheet]), ["KO"]);
});

test("标准 i18N 和旧拼写 il8N 同时存在时拒绝歧义映射", () => {
  const sheet = sampleSheets()[2];
  sheet.values[1][13] = "Name_il8N";
  const model = parseWorkbook([sheet], "EN");
  assert.ok(!model.units.some(u => u.field === "Name"));
  assert.ok(model.diagnostics.some(d => d.includes("映射重复")));
});
test("同一工作表内重复 Key 全部标记，并禁止采用 AI", () => {
  const sheets = sampleSheets(); sheets[1].values[2][0] = "Coin";
  const duplicated = parseWorkbook(sheets, "EN").units.filter(u => u.duplicate);
  assert.equal(duplicated.length, 2);
  assert.ok(duplicated.every(u => adoptionProblem(u).includes("重复")));
});

test("不同工作表共用完整 Key 时不判重，即使原文或译文不同", () => {
  const sheets = sampleSheets(), other = structuredClone(sheets[1]);
  other.name = "Other";
  other.values[1][2] = "奖励 {0}";
  other.values[1][5] = "Reward {0}";
  sheets.push(other);
  const units = parseWorkbook(sheets, "EN").units;
  assert.equal(units.length, 10);
  assert.ok(units.every(u => !u.duplicate));
  assert.equal(adoptionProblem(units.find(u => u.sheet === "Language" && u.key === "Coin")), "");
});

test("同一行相同编号的不同字段后缀属于不同完整 Key", () => {
  const sheet = sampleSheets()[2];
  sheet.values[3][12] = "-42_groupName";
  sheet.values[3][14] = "-42_groupDesc";
  const units = parseWorkbook([sheet], "EN").units;
  assert.deepEqual(units.map(u => u.key), ["-42_groupName", "-42_groupDesc"]);
  assert.ok(units.every(u => !u.duplicate));
});

test("同一工作表不同字段共用同一个完整 Key 仍判重，不影响其他表", () => {
  const sheet = sampleSheets()[2];
  sheet.values[3][12] = "-42_groupName";
  sheet.values[3][14] = "-42_groupName";
  const other = structuredClone(sampleSheets()[1]);
  other.name = "Other";
  other.values[1][0] = "-42_groupName";
  const units = parseWorkbook([sheet, other], "EN").units;
  assert.equal(units.filter(u => u.duplicate).length, 2);
  assert.ok(units.filter(u => u.sheet === sheet.name).every(u => u.errors.some(e => e.includes("当前工作表内重复 Key"))));
  assert.ok(units.filter(u => u.sheet === other.name).every(u => !u.duplicate));
});
test("不采用其他语言的 AI 列，也不猜测多语言目标", () => {
  const sheets = sampleSheets(); sheets[1].values[0][6] = "FR_AI";
  sheets[1].values[0].push("FR"); sheets[1].columns++;
  assert.deepEqual(discoverLanguages(sheets), ["EN", "FR"]);
  assert.equal(parseWorkbook(sheets, "EN").units[0].ai, "");
});
test("明确语言 AI 列优先；通用 AI 列兼容旧表", () => {
  const sheets = sampleSheets(); sheets[1].values[0][6] = "AI 建议";
  assert.equal(parseWorkbook(sheets, "EN").units[0].ai, "Get {0} coins");
});
test("重复目标表头阻止解析，不能静默写到第一列", () => {
  const sheets = sampleSheets(); sheets[1].values[0][6] = "EN";
  const model = parseWorkbook(sheets, "EN");
  assert.equal(model.units.filter(u => u.sheet === "Language").length, 0);
  assert.ok(model.diagnostics[0].includes("重复"));
});
test("不合格 AI 建议禁止采用", () => {
  const units = parseWorkbook(sampleSheets(), "EN").units;
  assert.ok(adoptionProblem(units.find(u => u.key === "UnsafeAI")).includes("未通过"));
  assert.equal(adoptionProblem(units.find(u => u.key === "Coin")), "");
});
test("原文、AI、译文或定位表头变化使预览失效", () => {
  const u = parseWorkbook(sampleSheets(), "EN").units[0];
  assert.equal(sameReviewedUnit(u, structuredClone(u)), true);
  for (const key of ["source", "target", "ai", "key", "id"]) assert.equal(sameReviewedUnit(u, { ...u, [key]: "changed" }), false);
});
test("兼容零基、一基矩形和单值，保留 0 与 false", () => {
  assert.deepEqual(normalizeMatrix([["a", 0], [false, null]], 2, 2), [["a", "0"], ["false", ""]]);
  assert.deepEqual(normalizeMatrix([null, [null, "a", "b"], [null, "c", "d"]], 2, 2), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(normalizeMatrix(0, 1, 1), [["0"]]);
  assert.deepEqual(normalizeMatrix(["a", "b"], 1, 2), [["a", "b"]]);
  assert.throws(() => normalizeMatrix([["a"]], 2, 2), /行数/);
});
