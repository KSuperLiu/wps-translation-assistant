import { parseWorkbook } from "./model.js";

export async function readSheetScope(host, bookKey, names, language, profiles = [], options = {}, onProgress = () => {}) {
  const snapshot = await host.snapshotSheets(names, bookKey, onProgress);
  const failed = snapshot.sheets.find(sheet => sheet.error);
  if (failed) throw new Error(failed.name + "：" + failed.error);
  return { snapshot, model: parseWorkbook(snapshot.sheets, language, profiles, options) };
}

// 同名工作表替换更新，其他表的条目和校验结果沿用，避免重读、重建全工作簿。
export function mergeSheetScope(snapshot, model, scope) {
  if (snapshot.bookKey !== scope.snapshot.bookKey || model.language !== scope.model.language) throw new Error("工作簿或任务语言已变化，请重新识别。");
  const fresh = new Map(scope.snapshot.sheets.map(sheet => [sheet.name, sheet]));
  const known = new Set(snapshot.sheets.map(sheet => sheet.name));
  if ([...fresh.keys()].some(name => !known.has(name))) throw new Error("工作表范围已变化，请重新识别。");
  const unitsBySheet = new Map(), diagnosticsBySheet = new Map(model.diagnosticsBySheet);
  for (const unit of model.units) {
    if (!unitsBySheet.has(unit.sheet)) unitsBySheet.set(unit.sheet, []);
    unitsBySheet.get(unit.sheet).push(unit);
  }
  for (const name of fresh.keys()) { unitsBySheet.set(name, []); diagnosticsBySheet.set(name, scope.model.diagnosticsBySheet.get(name) || []); }
  for (const unit of scope.model.units) unitsBySheet.get(unit.sheet).push(unit);
  const sheets = snapshot.sheets.map(sheet => fresh.get(sheet.name) || sheet);
  return {
    snapshot: { ...snapshot, sheets },
    model: { ...model, units: sheets.flatMap(sheet => unitsBySheet.get(sheet.name) || []), diagnosticsBySheet,
      diagnostics: sheets.flatMap(sheet => diagnosticsBySheet.get(sheet.name) || []) },
  };
}
