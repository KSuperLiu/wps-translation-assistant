import test from "node:test";
import assert from "node:assert/strict";
import { WpsHost } from "../src/wps-host.js";
import { parseWorkbook } from "../src/model.js";
import { applyDraft, applyCurrentSuggestion } from "../src/operations.js";
import { readSheetScope, mergeSheetScope } from "../src/sheet-refresh.js";
import { sampleSheets } from "./fixtures.js";

function setup() {
  const sheets = sampleSheets(), reads = [], writes = [];
  const snapshot = { bookKey: "C:/task.xlsx", name: "task.xlsx", sheets: structuredClone(sheets) };
  const model = parseWorkbook(snapshot.sheets, "EN");
  const column = name => [...name].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);
  const coords = cell => { const [, col, row] = /^([A-Z]+)(\d+)$/.exec(cell); return [Number(row), column(col)]; };
  const book = { FullName: snapshot.bookKey, Name: snapshot.name, Worksheets: {
    get Count() { throw new Error("单表核对不应枚举全工作簿"); },
    Item: name => {
      if (typeof name !== "string") throw new Error("不应按序遍历其他工作表");
      const sheet = sheets.find(s => s.name === name);
      if (!sheet) throw new Error("Missing sheet");
      return { Name: name, ProtectContents: false,
        UsedRange: { Row: 1, Column: 1, Rows: { Count: sheet.rows }, Columns: { Count: sheet.columns } },
        Range: address => {
          const [start, end] = address.split(":"), [r, c] = coords(start);
          return {
            get Value2() {
              if (!end) return sheet.values[r - 1]?.[c - 1] ?? "";
              reads.push(name);
              const [lastRow, lastCol] = coords(end);
              return Array.from({ length: lastRow - r + 1 }, (_, i) => Array.from({ length: lastCol - c + 1 }, (_, j) => sheet.values[r + i - 1]?.[c + j - 1] ?? ""));
            },
            set Value2(value) { sheet.values[r - 1][c - 1] = value; writes.push(name + "!" + start); },
            NumberFormat: "General", HasFormula: false, MergeCells: false, Locked: false,
          };
        },
      };
    },
  } };
  const app = { ActiveWorkbook: book }, host = new WpsHost(app);
  host.snapshot = () => { throw new Error("单条写入不应全工作簿读取"); };
  return { sheets, snapshot, model, host, app, reads, writes };
}

test("单条写入前后只读取当前工作表，增量更新进度并保留其他表条目对象", async () => {
  const s = setup(), reviewed = s.model.units[0], other = s.model.units.find(u => u.sheet === "FishCfg");
  const before = await readSheetScope(s.host, s.snapshot.bookKey, ["Language"], "EN");
  applyDraft(s.host, s.snapshot.bookKey, reviewed, before.model.units, "Get {0} coins");
  const after = await readSheetScope(s.host, s.snapshot.bookKey, ["Language"], "EN");
  const updated = mergeSheetScope(s.snapshot, s.model, after);
  assert.deepEqual(s.reads, ["Language", "Language"]);
  assert.deepEqual(s.writes, ["Language!F2"]);
  assert.equal(updated.model.units.find(u => u.id === reviewed.id).target, "Get {0} coins");
  assert.equal(updated.model.units.find(u => u.id === reviewed.id).untranslated, false);
  assert.equal(updated.model.units.find(u => u.id === other.id), other);
  assert.equal(updated.snapshot.sheets[2], s.snapshot.sheets[2]);
  assert.equal(updated.snapshot.sheets[1].values[1][5], "Get {0} coins");
  assert.equal(s.snapshot.sheets[1].values[1][5], "");
  assert.deepEqual(updated.model.units, parseWorkbook(updated.snapshot.sheets, "EN").units);
});

test("单条 AI 采用使用当前表新数据，不需要读取其他工作表", async () => {
  const s = setup(), reviewed = s.model.units[0];
  const scope = await readSheetScope(s.host, s.snapshot.bookKey, ["Language", "Language"], "EN");
  const result = await applyCurrentSuggestion(s.host, s.snapshot.bookKey, reviewed, scope.model.units);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(s.reads, ["Language"]);
  assert.deepEqual(s.writes, ["Language!F2"]);
});

test("局部核对仍拒绝排序、表头变化和 AI 变化后的旧草稿或建议", async () => {
  for (const change of [
    s => { [s.sheets[1].values[1], s.sheets[1].values[2]] = [s.sheets[1].values[2], s.sheets[1].values[1]]; },
    s => { s.sheets[1].values[0][5] = "FR"; },
    s => { s.sheets[1].values[1][6] = "Other {0}"; },
  ]) {
    const s = setup(), reviewed = s.model.units[0]; change(s);
    const scope = await readSheetScope(s.host, s.snapshot.bookKey, ["Language"], "EN");
    assert.throws(() => applyDraft(s.host, s.snapshot.bookKey, reviewed, scope.model.units, "Get {0} coins"), /变化/);
    assert.deepEqual(s.writes, []);
  }
});

test("当前表其他行新增重复 Key 仍阻止写入，核对之后目标格被修改也不覆盖", async () => {
  const duplicate = setup(), reviewed = duplicate.model.units[0];
  duplicate.sheets[1].values[2][0] = "Coin";
  const scope = await readSheetScope(duplicate.host, duplicate.snapshot.bookKey, ["Language"], "EN");
  assert.throws(() => applyDraft(duplicate.host, duplicate.snapshot.bookKey, reviewed, scope.model.units, "Get {0} coins"), /重复/);
  const changed = setup(), current = await readSheetScope(changed.host, changed.snapshot.bookKey, ["Language"], "EN");
  changed.sheets[1].values[1][5] = "Manual {0}";
  assert.throws(() => applyDraft(changed.host, changed.snapshot.bookKey, changed.model.units[0], current.model.units, "Get {0} coins"), /译文已变化/);
  assert.deepEqual(duplicate.writes, []); assert.deepEqual(changed.writes, []);
});

test("读取期间切换工作簿时拒绝结果，不把其他工作簿内容合并到原任务", async () => {
  const s = setup(), read = s.host.readSheet.bind(s.host);
  s.host.readSheet = async (...args) => { const result = await read(...args); s.app.ActiveWorkbook = { FullName: "C:/other.xlsx" }; return result; };
  await assert.rejects(readSheetScope(s.host, s.snapshot.bookKey, ["Language"], "EN"), /工作簿已切换/);
  const other = { snapshot: { ...s.snapshot, bookKey: "other" }, model: s.model };
  assert.throws(() => mergeSheetScope(s.snapshot, s.model, other), /工作簿或任务语言/);
  assert.deepEqual(s.writes, []);
});

test("当前工作表读取失败时明确报错，不沿用旧数据确认写入", async () => {
  const s = setup();
  s.host.readSheet = async () => ({ name: "Language", rows: 0, columns: 0, values: [], error: "Read failed" });
  await assert.rejects(readSheetScope(s.host, s.snapshot.bookKey, ["Language"], "EN"), /Language：Read failed/);
  assert.deepEqual(s.writes, []);
});

test("增量刷新准确替换当前表诊断，保留其他表提示，支持清除旧诊断", () => {
  const sheets = sampleSheets();
  sheets[1].values[1][0] = "";
  sheets.push({ name: "OtherBad", rows: 2, columns: 2, values: [["A", "B"], ["X", "Y"]] });
  const snapshot = { bookKey: "task", sheets }, model = parseWorkbook(sheets, "EN");
  assert.ok(model.diagnosticsBySheet.get("Language").length);
  const fixed = structuredClone(sheets[1]); fixed.values[1][0] = "Coin";
  const scope = { snapshot: { bookKey: "task", sheets: [fixed] }, model: parseWorkbook([fixed], "EN") };
  const updated = mergeSheetScope(snapshot, model, scope);
  assert.deepEqual(updated.model.diagnosticsBySheet.get("Language"), []);
  assert.deepEqual(updated.model.diagnosticsBySheet.get("OtherBad"), model.diagnosticsBySheet.get("OtherBad"));
  assert.deepEqual(updated.model.diagnostics, parseWorkbook(updated.snapshot.sheets, "EN").diagnostics);
  const broken = { name: "Language", rows: 0, columns: 0, values: [], error: "Read failed" };
  const failed = mergeSheetScope(updated.snapshot, updated.model, { snapshot: { bookKey: "task", sheets: [broken] }, model: parseWorkbook([broken], "EN") });
  assert.ok(failed.model.units.every(u => u.sheet !== "Language"));
  assert.ok(failed.model.diagnostics.some(d => d.includes("Read failed")));
});

test("局部核对沿用换行检查设置，合并后不改变其他表已使用的设置", async () => {
  const s = setup(); s.sheets[1].values[1][6] = "Get {0}\\ncoins";
  const scope = await readSheetScope(s.host, s.snapshot.bookKey, ["Language"], "EN", [], { checkNewlines: false });
  assert.deepEqual(scope.model.units[0].aiErrors, []);
  const merged = mergeSheetScope(s.snapshot, s.model, scope);
  assert.equal(merged.model.units.find(u => u.sheet === "Language").validationOptions.checkNewlines, false);
  assert.equal(merged.model.units.find(u => u.sheet === "FishCfg").validationOptions.checkNewlines, true);
  assert.throws(() => mergeSheetScope(s.snapshot, s.model, { ...scope, model: { ...scope.model, language: "FR" } }), /任务语言/);
});
