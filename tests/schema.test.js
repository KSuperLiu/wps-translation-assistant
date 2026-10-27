import test from "node:test";
import assert from "node:assert/strict";
import { canonicalLanguage, headerRole } from "../src/languages.js";
import { inspectWorkbook, createManualProfile, schemaSignature } from "../src/schema.js";
import { discoverLanguages, parseWorkbook } from "../src/model.js";
import { loadProfiles } from "../src/mapping-ui.js";
import { sampleSheets } from "./fixtures.js";

const sheet = (values, name = "任意工作表") => ({ name, rows: values.length, columns: Math.max(...values.map(r => r.length)), values });
for (const [input, expected] of [
  ["FR", "FR"], ["de", "DE"], ["JA", "JA"], ["ES", "ES"], ["pt_BR", "PT-BR"], ["pt-PT", "PT-PT"],
  ["zh_Hans", "ZH-HANS"], ["zh-Hant", "ZH-HANT"], ["es-419", "ES-419"], ["fil", "FIL"], ["ar", "AR"],
  ["ID", "ID"], ["tr", "TR"], ["vi", "VI"], ["th", "TH"], ["hi", "HI"], ["pl", "PL"],
  ["uk", "UK"], ["sv", "SV"], ["nl", "NL"], ["cs", "CS"], ["ru", "RU"], ["KO", "KO"],
]) test("标准语种与地区代码：" + input, () => {
  const s = sheet([["LanguageKey", "Source Text", input, input + " (old)", input + "_AI"], ["Key1", "你好 {0}", "Hello {0}", "", "Hi {0}"]]);
  assert.deepEqual(discoverLanguages([s]), [expected]);
  const model = parseWorkbook([s], input.toLowerCase());
  assert.equal(model.units.length, 1); assert.equal(model.units[0].cell, "C2"); assert.equal(model.units[0].ai, "Hi {0}");
});

test("英文、中文、原生语言名与旧代码别名统一", () => {
  for (const [name, code] of [["English", "EN"], ["Korean", "KO"], ["韩语", "KO"], ["한국어", "KO"], ["日本語", "JA"], ["JP", "JA"], ["KR", "KO"], ["French", "FR"], ["Portuguese (pt_BR)", "PT-BR"]]) {
    assert.equal(canonicalLanguage(name), code);
  }
  assert.equal(headerRole("KO（旧译文）").role, "old");
  assert.deepEqual(headerRole("参考译文 EN"), { role: "reference", language: "EN" });
});

test("Key、AI、URL 和辅助标记不会成为目标语种", () => {
  const s = sheet([["LanguageKey", "Source Text", "FR", "AI", "URL", "SKU", "Notes"], ["K", "原文", "Texte", "Texte AI"]]);
  assert.deepEqual(discoverLanguages([s]), ["FR"]);
});

test("表名、表头行和列顺序均可变化", () => {
  const s = sheet([["任务标题"], ["请在下方填写译文"], ["pt_BR_AI", "PT-BR (old)", "原文", "pt-BR", "Key"], ["Novo {0}", "Anterior {0}", "新 {0}", "Atual {0}", "RowKey"]], "道具任务");
  const model = parseWorkbook([s], "pt_BR");
  assert.deepEqual(discoverLanguages([s]), ["PT-BR"]);
  assert.equal(model.units[0].cell, "D4"); assert.equal(model.units[0].sourceCell, "C4");
  assert.equal(model.units[0].aiCell, "A4"); assert.equal(model.units[0].key, "RowKey");
});

test("配置组插入备注列后不再按五列步长定位", () => {
  const s = sampleSheets()[2];
  s.values.forEach((row, i) => row.splice(3, 0, i === 2 ? "Notes" : "")); s.columns++;
  const model = parseWorkbook([s], "EN");
  assert.equal(model.units.length, 2);
  assert.equal(model.units.find(u => u.field === "Name").cell, "G4");
  assert.equal(model.units.find(u => u.field === "Desc").cell, "L4");
});

test("配置表标题增加两行后仍能定位表头与数据", () => {
  const s = sampleSheets()[2]; s.values.unshift(["翻译任务"], ["日期说明"]); s.rows += 2;
  const model = parseWorkbook([s], "EN");
  assert.equal(model.units.length, 2); assert.equal(model.units[0].cell, "F6");
});

test("有旧新配对时，配置表的独立 EN 列被视为参考", () => {
  const s = sheet([
    [], ["Id", "", "Desc", "", "", "", "Desc_i18N"],
    ["", "Source Text (old)", "中文字段说明", "EN", "KO (old)", "KO", "完整Key"],
    ["1", "旧原文", "原文", "English reference", "한국어 이전", "한국어", "1_desc"],
  ]);
  assert.deepEqual(discoverLanguages([s]), ["KO"]);
  const unit = parseWorkbook([s], "KO").units[0];
  assert.deepEqual(unit.referenceLanguages, ["EN"]); assert.equal(unit.cell, "F4");
});

test("多目标语言不静默选择；通用 AI 不能同时分配给两种语种", () => {
  const s = sheet([["Key", "Source", "FR", "DE", "AI", "FR_AI"], ["K", "原文", "FR text", "DE text", "Ambiguous", "FR AI"]]);
  assert.deepEqual(discoverLanguages([s]), ["FR", "DE"]);
  assert.equal(parseWorkbook([s], "FR").units[0].ai, "FR AI");
  assert.equal(parseWorkbook([s], "DE").units[0].ai, "");
  assert.ok(parseWorkbook([s], "DE").diagnostics.some(d => d.includes("AI")));
});

test("语言别名造成重复列时拒绝歧义写入", () => {
  const s = sheet([["Key", "Source", "KO", "Korean"], ["K", "原文", "one", "two"]]);
  const model = parseWorkbook([s], "KO");
  assert.equal(model.units.length, 0); assert.ok(model.diagnostics.some(d => d.includes("冲突")));
});

test("同一字段可有多个配对目标语种而不是固定目标偏移", () => {
  const s = sampleSheets()[2];
  s.values.forEach((row, r) => row.splice(6, 0, r === 2 ? "FR (old)" : "", r === 2 ? "FR" : r === 3 ? "Carpe" : "")); s.columns += 2;
  assert.deepEqual(discoverLanguages([s]), ["EN", "FR"]);
  const model = parseWorkbook([s], "FR");
  assert.equal(model.units.length, 1); assert.equal(model.units[0].target, "Carpe"); assert.equal(model.units[0].cell, "H4");
});

test("未知结构可映射一次，并在另一份同表头工作簿复用，不保存正文", () => {
  const original = sheet([["编号", "说明文本", "待填", "旧稿", "建议"], ["K", "SECRET_SOURCE", "SECRET_TARGET", "旧", "建议"]]);
  const entry = { headerRow: 1, dataStartRow: 2, sourceCol: 2, keyCol: 1, targetCol: 3, oldCol: 4, aiCol: 5, language: "French", field: "Desc" };
  const profile = createManualProfile(original, entry);
  assert.ok(!JSON.stringify(profile).includes("SECRET"));
  const other = structuredClone(original); other.name = "另一份表"; other.values[1] = ["K2", "其他原文", "Autre", "", "AI autre"];
  assert.deepEqual(discoverLanguages([other], [profile]), ["FR"]);
  assert.equal(parseWorkbook([other], "FR", [profile]).units[0].key, "K2");
  assert.equal(parseWorkbook([other], "FR", [profile]).units[0].cell, "C2");
  assert.equal(parseWorkbook([other], "FR", [profile]).units[0].ai, "AI autre");
});

test("映射可添加多个字段，变化的表头不会套用旧配置", () => {
  const s = sheet([["编号", "说明一", "译文一", "说明二", "译文二"], ["K", "原文一", "Target 1", "原文二", "Target 2"]]);
  const first = createManualProfile(s, { headerRow: 1, dataStartRow: 2, keyCol: 1, sourceCol: 2, targetCol: 3, language: "FR", field: "One" });
  const profile = createManualProfile(s, { headerRow: 1, dataStartRow: 2, keyCol: 1, sourceCol: 4, targetCol: 5, language: "FR", field: "Two" }, first);
  assert.equal(profile.entries.length, 2); assert.equal(inspectWorkbook([s], [profile]).groups.length, 2);
  const moved = structuredClone(s); moved.values[0][2] = "另一个角色";
  assert.notEqual(schemaSignature(moved, 1), profile.signature);
  assert.equal(parseWorkbook([moved], "FR", [profile]).units.length, 0);
});

test("手动配置不能将原文、Key、AI 和目标映射到同一列", () => {
  const s = sheet([["A", "B", "C"], ["K", "原文", "译文"]]);
  assert.throws(() => createManualProfile(s, { headerRow: 1, dataStartRow: 2, sourceCol: 2, keyCol: 1, targetCol: 2, language: "KO" }), /不同/);
  assert.throws(() => createManualProfile(s, { headerRow: 1, dataStartRow: 1, sourceCol: 2, keyCol: 1, targetCol: 3, language: "KO" }), /起始行/);
});

test("不同字段的目标列不能覆盖另一字段的原文或 AI", () => {
  const s = sheet([["Key", "S1", "T1", "S2", "T2", "AI1"], ["K", "原文一", "译文一", "原文二", "译文二", "AI"]]);
  const first = createManualProfile(s, { headerRow: 1, dataStartRow: 2, sourceCol: 2, keyCol: 1, targetCol: 3, aiCol: 6, language: "FR" });
  for (const targetCol of [2, 3, 6]) {
    assert.throws(() => createManualProfile(s, { headerRow: 1, dataStartRow: 2, sourceCol: 4, keyCol: 1, targetCol, language: "FR" }, first), /相互冲突/);
  }
});

test("同结构任务的标题或正文变化不会失去手动配置", () => {
  const s = sheet([["任务 A"], ["本周任务"], ["编号", "内容", "待填"], ["K", "原文", "译文"]]);
  const profile = createManualProfile(s, { headerRow: 3, dataStartRow: 4, sourceCol: 2, keyCol: 1, targetCol: 3, language: "DE" });
  const other = structuredClone(s); other.values[0][0] = "任务 B"; other.values[1][0] = "下周任务";
  assert.equal(schemaSignature(other, 3), profile.signature);
  assert.equal(parseWorkbook([other], "DE", [profile]).units.length, 1);
});

test("损坏的映射缓存不会直接进入表格写入", () => {
  assert.deepEqual(loadProfiles({ getItem: () => "not-json" }), []);
  const s = sheet([["A", "B", "C"], ["K", "原文", "译文"]]);
  const malformed = { headerRow: 1, signature: schemaSignature(s, 1), entries: [{ headerRow: 1, dataStartRow: 2, sourceCol: 2, keyCol: 1, targetCol: 999, language: "KO" }] };
  const schema = inspectWorkbook([s], [malformed]);
  assert.equal(schema.groups.length, 0); assert.ok(schema.diagnostics.length > 0);
});
