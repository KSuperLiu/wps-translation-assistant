import { adoptionProblem, sameReviewedUnit } from "./model.js";
import { isBlank } from "./validation.js";
import { pause } from "./wps-host.js";
import { draftProblem } from "./workflow.js";

export function applyDraft(host, bookKey, reviewed, freshUnits, value) {
  host.assertBook(bookKey);
  const fresh = freshUnits.find(u => u.id === reviewed?.id);
  if (!sameReviewedUnit(reviewed, fresh)) throw new Error("表格内容或位置已变化，草稿尚未写入。请重新载入当前译文后核对。");
  const problem = draftProblem(fresh, value);
  if (problem) throw new Error(problem);
  const rawBefore = host.verifyUnit(fresh, bookKey, fresh.target).Value2;
  if (fresh.target === value) return null;
  host.writeText(fresh, bookKey, fresh.target, value);
  return { unit: fresh, before: fresh.target, beforeRaw: rawBefore, after: value };
}

// 空白译文一键采用；已有译文或不同的人工草稿仅用一次确认，取消时保留全部内容。
export async function applyCurrentSuggestion(host, bookKey, reviewed, freshUnits, { draft = null, confirm = () => true } = {}) {
  host.assertBook(bookKey);
  const fresh = freshUnits.find(u => u.id === reviewed?.id);
  if (!sameReviewedUnit(reviewed, fresh) || (draft && !sameReviewedUnit(draft.reviewed, fresh))) {
    throw new Error("表格内容或位置已变化，未采用 AI。请重新载入当前译文后核对。");
  }
  const problem = adoptionProblem(fresh);
  if (problem) throw new Error(problem);
  const discardDraft = !!draft && draft.value !== fresh.target && draft.value !== fresh.ai;
  return applySuggestions(host, bookKey, [reviewed], freshUnits, {
    confirm: plan => {
      const overwriteExisting = !isBlank(plan[0].before);
      return (!discardDraft && !overwriteExisting) || confirm({ unit: fresh, discardDraft, overwriteExisting });
    },
  });
}

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
