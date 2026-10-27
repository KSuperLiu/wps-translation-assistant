import { adoptionProblem, sameReviewedUnit } from "./model.js";
import { isBlank } from "./validation.js";
import { pause } from "./wps-host.js";

// 每次写入都从刚读取的模型重新确认，旧页面中的行地址不能直接用于写入。
export async function applySuggestions(host, bookKey, reviewed, freshUnits, { onlyEmpty = false, confirm = () => true } = {}) {
  host.assertBook(bookKey);
  const freshMap = new Map(freshUnits.map(u => [u.id, u]));
  const plan = [];
  let skipped = 0;
  for (const previous of reviewed) {
    const fresh = freshMap.get(previous.id);
    if (!sameReviewedUnit(previous, fresh)) throw new Error("表格内容或位置已变化，已刷新检查结果。请确认后重新采用。");
    if (adoptionProblem(fresh) || (onlyEmpty && !isBlank(fresh.target))) { skipped++; continue; }
    const rawBefore = host.verifyUnit(fresh, bookKey, fresh.target).Value2;
    plan.push({ unit: fresh, before: fresh.target, beforeRaw: rawBefore, after: fresh.ai });
  }
  if (!plan.length) return { changes: [], skipped, cancelled: false, error: "" };
  if (!confirm(plan)) return { changes: [], skipped, cancelled: true, error: "" };
  const changes = [];
  let error = "";
  for (const item of plan) {
    try {
      host.writeText(item.unit, bookKey, item.before, item.after);
      changes.push(item);
      if (changes.length % 20 === 0) await pause();
    } catch (exception) {
      error = exception.message || String(exception);
      break;
    }
  }
  return { changes, skipped, cancelled: false, error };
}

export async function undoSuggestions(host, bookKey, changes) {
  host.assertBook(bookKey);
  const remaining = [], errors = [];
  let restored = 0;
  for (const item of [...changes].reverse()) {
    try {
      // 不撤销后来人工改过的译文，也不要求 AI 列仍是旧值。
      host.writeText(item.unit, bookKey, item.after, item.beforeRaw ?? "", null);
      restored++;
    } catch (error) {
      remaining.unshift(item);
      errors.push(item.unit.sheet + "!" + item.unit.cell + "：" + (error.message || error));
    }
    if ((restored + remaining.length) % 20 === 0) await pause();
  }
  return { remaining, restored, errors };
}
