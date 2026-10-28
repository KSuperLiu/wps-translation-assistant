import { isBlank, validateText } from "./validation.js";
import { filterUnits } from "./model.js";

export function taskKind(unit) {
  if (isBlank(unit.source)) return "需核实";
  if (!isBlank(unit.oldSource) && unit.oldSource !== unit.source) return "待修订";
  return isBlank(unit.old) ? "待补译" : "旧译复核";
}
export function processingStatus(unit) {
  if (isBlank(unit.source)) return "需核实原文";
  if (unit.errors.length) return "有格式或 Key 问题";
  return unit.untranslated ? "待填写" : "已填写 · 格式检查通过";
}
export const pending = unit => isBlank(unit.source) || unit.untranslated || unit.errors.length > 0;

export function workflowSummary(units, diagnostics = []) {
  const count = test => units.filter(test).length;
  const unclear = count(u => isBlank(u.source));
  const unfilled = count(u => !isBlank(u.source) && u.untranslated);
  const errors = count(u => !isBlank(u.source) && u.errors.length > 0);
  return { total: units.length, sheets: new Set(units.map(u => u.sheet)).size, unclear, unfilled, errors,
    filled: count(u => !isBlank(u.source) && !u.untranslated),
    revision: count(u => taskKind(u) === "待修订"), translation: count(u => taskKind(u) === "待补译"),
    review: count(u => taskKind(u) === "旧译复核"), ai: count(u => !isBlank(u.ai)),
    remaining: count(pending), diagnostics: diagnostics.length,
    ready: units.length > 0 && !units.some(pending) && !diagnostics.length };
}
export function workflowUnits(units, { sheet = "", query = "", status = "pending" } = {}) {
  return filterUnits(units, { sheet, query }).filter(u => {
    if (status === "pending") return pending(u);
    if (status === "unclear") return isBlank(u.source);
    if (status === "revision") return taskKind(u) === "待修订";
    if (status === "translation") return taskKind(u) === "待补译";
    if (status === "filled") return !isBlank(u.source) && !u.untranslated;
    if (status === "issues") return u.errors.length > 0;
    if (status === "ai") return !isBlank(u.ai) && u.ai !== u.target;
    return true;
  });
}
export function nextPending(units, selectedId, scope = {}, { skipUnclear = true } = {}) {
  const candidates = workflowUnits(units, { sheet: scope.sheet, query: scope.query, status: scope.status || "all" });
  const index = candidates.findIndex(u => u.id === selectedId);
  for (let offset = 1; offset <= candidates.length; offset++) {
    const unit = candidates[(index + offset + candidates.length) % candidates.length];
    if (pending(unit) && (!skipUnclear || !isBlank(unit.source))) return unit;
  }
  return null;
}
export function draftProblem(unit, value) {
  if (!unit) return "请先选择一条翻译记录。";
  if (isBlank(unit.source)) return "原文为空，请向需求方核实。";
  if (unit.duplicate) return "Key 重复，请先核实重复项。";
  if (isBlank(value)) return "请填写最终译文。";
  return validateText(unit.source, value).join("\n");
}
// 用连续差异片段展示变化，避免长文本为逐字符 diff 带来平方级开销。
export function sourceDifference(before = "", after = "") {
  let start = 0, endBefore = before.length, endAfter = after.length;
  while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  return { prefix: before.slice(0, start), removed: before.slice(start, endBefore), added: after.slice(start, endAfter), suffix: after.slice(endAfter) };
}
