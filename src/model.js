import { isBlank, validateText } from "./validation.js";
import { canonicalLanguage } from "./languages.js";
import { inspectWorkbook, readCell } from "./schema.js";

export function columnName(column) {
  let name = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}
export const address = (row, column) => columnName(column) + row;
export const discoverLanguages = (sheets, profiles = []) => inspectWorkbook(sheets, profiles).languages;

function textChecks(unit, validationOptions) {
  const { source, target, ai } = unit;
  const errors = isBlank(target) || isBlank(source) ? [] : validateText(source, target, validationOptions);
  if (unit.duplicate) errors.push("当前工作表内重复 Key：" + unit.key);
  return { validationOptions, errors, aiErrors: isBlank(ai) || isBlank(source) ? [] : validateText(source, ai, validationOptions) };
}

// 设置变化只重算校验，保留条目位置和识别结果；每批让出线程供控件刷新。
export async function revalidateUnits(units, options = {}, { yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  const validationOptions = { checkNewlines: options.checkNewlines !== false }, result = [];
  await yieldControl();
  for (let start = 0; start < units.length; start += 500) {
    for (const unit of units.slice(start, start + 500)) result.push({ ...unit, ...textChecks(unit, validationOptions) });
    if (start + 500 < units.length) await yieldControl();
  }
  return result;
}

export function parseWorkbook(sheets, language, profiles = [], options = {}) {
  const validationOptions = { checkNewlines: options.checkNewlines !== false };
  const schema = inspectWorkbook(sheets, profiles), units = [], diagnostics = [...schema.diagnostics];
  const targetLanguage = canonicalLanguage(language);
  for (const group of schema.groups) {
    const target = group.targets.find(t => t.language === targetLanguage);
    if (!target) continue;
    const sheet = sheets.find(s => s.name === group.sheet);
    const { sourceCol, oldSourceCol, keyCol, baseKeyCol, field, headerRow, fieldRow } = group;
    const { targetCol, oldCol, aiCol } = target;
    const roles = [...new Set([sourceCol, oldSourceCol, keyCol, baseKeyCol, ...group.targets.flatMap(t => [t.targetCol, t.oldCol, t.aiCol])].filter(Boolean))];
    let missingKeys = 0;
    for (let row = group.dataStartRow; row <= sheet.rows; row++) {
      const source = readCell(sheet, row, sourceCol), baseKey = readCell(sheet, row, baseKeyCol).trim();
      const explicitKey = keyCol ? readCell(sheet, row, keyCol).trim() : "";
      const key = explicitKey || (baseKey && !isBlank(source) ? baseKey + "/" + field : "");
      if (!key) { if (!isBlank(source)) missingKeys++; continue; }
      // 有完整 Key 的记录保留；没有字段 Key 的空配置格不制造虚假任务。
      const value = readCell(sheet, row, targetCol), ai = aiCol ? readCell(sheet, row, aiCol) : "";
      const coords = roles.map(c => [headerRow, c]);
      if (fieldRow) coords.push(...roles.map(c => [fieldRow, c]));
      coords.push([row, sourceCol]);
      if (oldSourceCol) coords.push([row, oldSourceCol]);
      if (oldCol) coords.push([row, oldCol]);
      if (keyCol) coords.push([row, keyCol]);
      if (baseKeyCol) coords.push([row, baseKeyCol]);
      const seen = new Set();
      const guards = coords.filter(([r, c]) => {
        const id = address(r, c); if (seen.has(id)) return false; seen.add(id); return true;
      }).map(([r, c]) => ({ cell: address(r, c), value: readCell(sheet, r, c) }));
      units.push({
        id: JSON.stringify([sheet.name, row, targetCol]), sheet: sheet.name, row, field, key,
        language: targetLanguage, source, oldSource: oldSourceCol ? readCell(sheet, row, oldSourceCol) : "", target: value, ai, old: oldCol ? readCell(sheet, row, oldCol) : "",
        targetCol, sourceCol, aiCol, groupStart: Math.min(group.groupStart, group.groupEnd), groupEnd: Math.max(group.groupStart, group.groupEnd),
        cell: address(row, targetCol), sourceCell: address(row, sourceCol), aiCell: aiCol ? address(row, aiCol) : null,
        referenceLanguages: group.referenceLanguages, guards,
        untranslated: isBlank(value), ...textChecks({ source, target: value, ai }, validationOptions),
      });
    }
    if (missingKeys) diagnostics.push(group.sheet + " · " + field + "：有 " + missingKeys + " 条非空原文缺少 Key，未计入任务，请核实。");
  }
  const counts = new Map();
  const scopedKey = unit => JSON.stringify([unit.sheet, unit.key]);
  for (const unit of units) {
    const key = scopedKey(unit);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const unit of units) {
    unit.duplicate = counts.get(scopedKey(unit)) > 1;
    if (unit.duplicate) unit.errors.push("当前工作表内重复 Key：" + unit.key);
  }
  return { language: targetLanguage, units, diagnostics };
}

export function statistics(units) {
  const total = units.length, untranslated = units.filter(u => u.untranslated).length;
  return { total, translated: total - untranslated, untranslated, errors: units.filter(u => u.errors.length).length,
    progress: total ? Math.round((total - untranslated) * 100 / total) : 0 };
}

export function filterUnits(units, { sheet = "", status = "all", query = "" } = {}) {
  const q = query.trim().toLocaleLowerCase();
  return units.filter(u => (!sheet || u.sheet === sheet)
    && (status !== "issues" || u.errors.length > 0)
    && (status !== "untranslated" || u.untranslated)
    && (!q || [u.key, u.source, u.oldSource || "", u.target, u.old, u.ai, u.field].some(s => s.toLocaleLowerCase().includes(q))));
}

export function selectedUnit(units, sheet, row, column) {
  const sameRow = units.filter(u => u.sheet === sheet && u.row === row);
  return sameRow.find(u => column === u.targetCol) ?? sameRow.find(u => column >= u.groupStart && column <= u.groupEnd) ?? sameRow[0] ?? null;
}

export function sameReviewedUnit(a, b) {
  return !!a && !!b && a.id === b.id && a.language === b.language && a.key === b.key && a.source === b.source && a.oldSource === b.oldSource && a.old === b.old && a.target === b.target && a.ai === b.ai
    && JSON.stringify(a.guards) === JSON.stringify(b.guards);
}

export function adoptionProblem(unit) {
  if (!unit) return "没有选中翻译条目。";
  if (unit.duplicate) return "当前工作表内 Key 重复，请先处理重复项。";
  if (isBlank(unit.ai)) return "这一条没有 AI 建议。";
  if (unit.ai === unit.target) return "当前译文与 AI 建议相同，无需采用。";
  if (unit.aiErrors.length) return "AI 建议未通过校验：" + unit.aiErrors.join("；");
  return "";
}
