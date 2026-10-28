import test from "node:test";
import assert from "node:assert/strict";
import { WpsHost } from "../src/wps-host.js";
import { parseWorkbook } from "../src/model.js";
import { applyDraft, applyCurrentSuggestion, applySuggestions, undoSuggestions } from "../src/operations.js";
import { sampleSheets } from "./fixtures.js";

function setup() {
  const sheets = sampleSheets(), cells = new Map();
  for (const sheet of sheets) sheet.values.forEach((row, r) => row.forEach((value, c) => {
    let col = "", n = c + 1;
    while (n) { col = String.fromCharCode(65 + (n - 1) % 26) + col; n = Math.floor((n - 1) / 26); }
    cells.set(sheet.name + "!" + col + (r + 1), { Value2: value, NumberFormat: "General", HasFormula: false, MergeCells: false, Locked: false });
  }));
  const book = { Name: "task.xlsx", FullName: "C:/task.xlsx", Worksheets: { Item: name => ({
    Name: name, ProtectContents: false, Range: cell => {
      const id = name + "!" + cell;
      if (!cells.has(id)) cells.set(id, { Value2: "", NumberFormat: "General" });
      return cells.get(id);
    },
  }) } };
  const app = { ActiveWorkbook: book }, host = new WpsHost(app);
  return { sheets, cells, app, host, units: parseWorkbook(sheets, "EN").units, bookKey: book.FullName };
}

test("单条 AI 一键填空，无额外确认，且可撤销", async () => {
  const s = setup(), u = s.units[0]; let confirms = 0;
  const r = await applyCurrentSuggestion(s.host, s.bookKey, u, s.units, { confirm: () => { confirms++; return true; } });
  assert.equal(confirms, 0); assert.equal(r.changes.length, 1);
  assert.equal(s.cells.get("Language!F2").Value2, u.ai);
  assert.equal((await undoSuggestions(s.host, s.bookKey, r.changes)).restored, 1);
});
test("已有译文或不同的人工草稿合并确认，取消不写入", async () => {
  const s = setup(), u = s.units.find(u => u.key === "Welcome"), draft = { value: "My draft", reviewed: u };
  let confirms = 0;
  const r = await applyCurrentSuggestion(s.host, s.bookKey, u, s.units, { draft, confirm: options => {
    confirms++; assert.equal(options.overwriteExisting, true); assert.equal(options.discardDraft, true); return false;
  } });
  assert.equal(confirms, 1); assert.equal(r.cancelled, true);
  assert.equal(s.cells.get("Language!F3").Value2, "Hello"); assert.equal(draft.value, "My draft");
});
test("空白目标的不同人工草稿仍需确认，同 AI 草稿不多弹一次", async () => {
  const s = setup(), u = s.units[0]; let confirms = 0;
  const r = await applyCurrentSuggestion(s.host, s.bookKey, u, s.units, { draft: { value: "Human {0}", reviewed: u }, confirm: info => {
    confirms++; assert.equal(info.overwriteExisting, false); assert.equal(info.discardDraft, true); return false;
  } });
  assert.equal(r.cancelled, true); assert.equal(confirms, 1);
  const accepted = await applyCurrentSuggestion(s.host, s.bookKey, u, s.units, { draft: { value: u.ai, reviewed: u }, confirm: () => { throw new Error("不应弹窗"); } });
  assert.equal(accepted.changes.length, 1);
});
test("一键采用拒绝不合格 AI、外部变更与失效草稿", async () => {
  const s = setup(), u = s.units[0], invalid = s.units.find(u => u.key === "UnsafeAI");
  await assert.rejects(applyCurrentSuggestion(s.host, s.bookKey, invalid, s.units), /未通过/);
  await assert.rejects(applyCurrentSuggestion(s.host, s.bookKey, u, s.units, { draft: { value: "Human {0}", reviewed: { ...u, source: "Old" } } }), /已变化/);
  const changed = structuredClone(s.units); changed[0].ai = "Other {0}";
  await assert.rejects(applyCurrentSuggestion(s.host, s.bookKey, u, changed), /已变化/);
  assert.equal(s.cells.get("Language!F2").Value2, "");
});

test("人工草稿只写目标格，作为文本保留格式，且可撤销最近一次写入", async () => {
  const s = setup(), u = s.units[0];
  const change = applyDraft(s.host, s.bookKey, u, s.units, "=Get {0} coins");
  assert.equal(s.cells.get("Language!F2").Value2, "=Get {0} coins");
  assert.equal(s.cells.get("Language!F2").NumberFormat, "General");
  assert.equal(s.cells.get("Language!C2").Value2, u.source);
  assert.equal(s.cells.get("Language!G2").Value2, u.ai);
  const result = await undoSuggestions(s.host, s.bookKey, [change]);
  assert.equal(result.restored, 1); assert.equal(s.cells.get("Language!F2").Value2, "");
});
test("草稿遇到外部改表、缺失占位符、重复 Key 或工作簿切换时不写入", () => {
  const s = setup(), u = s.units[0];
  assert.throws(() => applyDraft(s.host, s.bookKey, u, s.units, "Get"), /缺少/);
  const changed = structuredClone(s.units); changed[0].source = "new";
  assert.throws(() => applyDraft(s.host, s.bookKey, u, changed, "Get {0}"), /变化/);
  s.cells.get("Language!F2").Value2 = "Other {0}";
  assert.throws(() => applyDraft(s.host, s.bookKey, u, s.units, "Get {0}"), /译文已变化/);
  s.app.ActiveWorkbook = { FullName: "other.xlsx" };
  assert.throws(() => applyDraft(s.host, s.bookKey, u, s.units, "Get {0}"), /工作簿/);
});
test("人工草稿不写公式、合并格和受保护单元格，空原文不能被 AI 猜译", () => {
  for (const flag of ["HasFormula", "MergeCells"]) {
    const s = setup(); s.cells.get("Language!F2")[flag] = true;
    assert.throws(() => applyDraft(s.host, s.bookKey, s.units[0], s.units, "Get {0}"));
  }
  const s = setup(), u = { ...s.units[0], source: "" };
  assert.doesNotThrow(() => applyDraft(s.host, s.bookKey, u, [u], "Guess"));
});

test("采用只写目标译文，保留原文、旧译文、AI 列和单元格格式", async () => {
  const s = setup(), u = s.units[0], before = new Map([...s.cells].map(([k, v]) => [k, structuredClone(v)]));
  const result = await applySuggestions(s.host, s.bookKey, [u], s.units);
  assert.equal(result.changes.length, 1);
  for (const [key, cell] of s.cells) {
    if (key === "Language!F2") { assert.equal(cell.Value2, "Get {0} coins"); assert.equal(cell.NumberFormat, "General"); }
    else assert.deepEqual(cell, before.get(key));
  }
});
test("预览之后排序或改值，整次采用在写入前停止", async () => {
  const s = setup(), fresh = structuredClone(s.units); fresh[0].source = "另一条原文";
  await assert.rejects(applySuggestions(s.host, s.bookKey, [s.units[0]], fresh), /已变化/);
  assert.equal(s.cells.get("Language!F2").Value2, "");
});
test("确认弹窗期间切换工作簿不会误写", async () => {
  const s = setup();
  const result = await applySuggestions(s.host, s.bookKey, [s.units[0]], s.units, { confirm: () => { s.app.ActiveWorkbook = { FullName: "other.xlsx" }; return true; } });
  assert.equal(result.changes.length, 0); assert.match(result.error, /工作簿/);
});
test("批量空白模式不覆盖现有译文，不采用损坏占位符的 AI", async () => {
  const s = setup();
  const result = await applySuggestions(s.host, s.bookKey, s.units, s.units, { onlyEmpty: true });
  assert.equal(result.changes.length, 2);
  assert.equal(s.cells.get("Language!F3").Value2, "Hello");
  assert.equal(s.cells.get("Language!F5").Value2, "");
  assert.equal(s.cells.get("FishCfg!K4").Value2, "Weight {0}");
});
test("可撤销 AI 采用，但不覆盖后来人工编辑的单元格", async () => {
  const s = setup();
  const applied = await applySuggestions(s.host, s.bookKey, s.units, s.units, { onlyEmpty: true });
  s.cells.get("Language!F2").Value2 = "人工修改 {0}";
  const undone = await undoSuggestions(s.host, s.bookKey, applied.changes);
  assert.equal(undone.restored, 1); assert.equal(undone.remaining.length, 1);
  assert.equal(s.cells.get("FishCfg!K4").Value2, "");
  assert.equal(s.cells.get("Language!F2").Value2, "人工修改 {0}");
});
test("目标公式、合并格或受保护格不写入", async () => {
  for (const flag of ["HasFormula", "MergeCells"]) {
    const s = setup(); s.cells.get("Language!F2")[flag] = true;
    await assert.rejects(applySuggestions(s.host, s.bookKey, [s.units[0]], s.units));
  }
});
test("用户取消确认后不产生任何写入", async () => {
  const s = setup();
  const result = await applySuggestions(s.host, s.bookKey, [s.units[0]], s.units, { confirm: () => false });
  assert.equal(result.cancelled, true); assert.equal(result.changes.length, 0);
  assert.equal(s.cells.get("Language!F2").Value2, "");
});

test("受保护工作表中锁定的译文格不可写", async () => {
  const s = setup(), getSheet = s.app.ActiveWorkbook.Worksheets.Item;
  s.cells.get("Language!F2").Locked = true;
  s.app.ActiveWorkbook.Worksheets.Item = name => ({ ...getSheet(name), ProtectContents: true });
  await assert.rejects(applySuggestions(s.host, s.bookKey, [s.units[0]], s.units), /受保护/);
  assert.equal(s.cells.get("Language!F2").Value2, "");
});

test("定位前发现排序或原文变化时，不跳到旧地址", () => {
  const s = setup(); s.cells.get("Language!C2").Value2 = "另一个条目";
  assert.throws(() => s.host.locate(s.units[0], s.bookKey), /位置或表结构/);
});
test("撤销还原原始数值类型，并允许 AI 列在采用后更新", async () => {
  const s = setup(); s.sheets[1].values[2][5] = 0; s.cells.get("Language!F3").Value2 = 0;
  const units = parseWorkbook(s.sheets, "EN").units, u = units.find(u => u.key === "Welcome");
  const applied = await applySuggestions(s.host, s.bookKey, [u], units);
  s.cells.get("Language!G3").Value2 = "Updated AI";
  const result = await undoSuggestions(s.host, s.bookKey, applied.changes);
  assert.equal(result.restored, 1); assert.equal(s.cells.get("Language!F3").Value2, 0);
});
