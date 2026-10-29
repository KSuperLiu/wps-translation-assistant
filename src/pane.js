import "./style.css";
import "./mapping.css";
import "./updates.css";
import "./clipboard.css";
import { WpsHost } from "./wps-host.js";
import { discoverLanguages, parseWorkbook, selectedUnit, adoptionProblem, sameReviewedUnit, columnName } from "./model.js";
import { applyDraft, applyCurrentSuggestion, applySuggestions, undoSuggestions } from "./operations.js";
import { isBlank } from "./validation.js";
import { workflowSummary, workflowUnits, nextPending, taskKind, processingStatus, draftProblem, sourceDifference } from "./workflow.js";
import { loadProfiles, setupMapping } from "./mapping-ui.js";
import { setupUpdateControls } from "./update-ui.js";
import { copyText } from "./clipboard.js";

const $ = id => document.getElementById(id);
const host = new WpsHost(window.Application);
setupUpdateControls({ version: __APP_VERSION__, app: host.app });
let savedProfiles = [];
try { savedProfiles = loadProfiles(window.localStorage); } catch { /* 不提供持久存储时仅在会话生效。 */ }
const state = { snapshot: null, model: { units: [], diagnostics: [] }, language: "", selected: null,
  page: 0, stage: "receive", busy: false, writing: false, journal: [], journalBook: "", journals: new Map(),
  drafts: new Map(), fullRefresh: false, dirty: new Set(), timer: null, lastCommand: "", checkedAt: null, profiles: savedProfiles };
const pageSize = 30, commandKey = "WpsTranslationAssistant.command";
let copyRequest = 0;
function message(value, kind = "") { $("message").textContent = value; $("message").className = kind; }
function current() { return state.model.units.find(u => u.id === state.selected) ?? null; }
function scope() { return { sheet: $("sheet").value, query: $("search").value }; }
function filtered() { return workflowUnits(state.model.units, { ...scope(), status: $("filter").value }); }
function bookDrafts() {
  const key = state.snapshot?.bookKey || "";
  if (!state.drafts.has(key)) state.drafts.set(key, new Map());
  return state.drafts.get(key);
}
const draftKey = u => u.language + ":" + u.id;
function draftFor(u = current()) { return u ? bookDrafts().get(draftKey(u)) || { value: u.target, reviewed: u } : null; }
function rememberDraft(value) {
  const u = current(); if (!u) return;
  const previous = draftFor(u);
  bookDrafts().set(draftKey(u), { value, reviewed: previous.reviewed });
  renderDraftStatus(); updateActions();
}
function draftCount() {
  return [...bookDrafts().values()].filter(d => d.reviewed.language === state.language
    && d.value !== (state.model.units.find(u => u.id === d.reviewed.id)?.target ?? d.reviewed.target)).length;
}
function busy(value) {
  state.busy = value;
  for (const id of ["scan", "language", "sheet", "filter", "search", "delivery-refresh", "tab-work", "tab-delivery", "task-overview"]) $(id).disabled = value;
  updateActions();
}
function updateActions() {
  const u = current(), draft = draftFor(u), stale = draft && !sameReviewedUnit(draft.reviewed, u);
  $("begin").disabled = state.busy || !state.language || !state.model.units.length;
  $("adopt").disabled = state.busy || !!adoptionProblem(u) || stale;
  $("adopt").textContent = u && !isBlank(u.ai) && u.ai === u.target ? "AI 建议已写入" : "采用 AI 并写入";
  $("load-ai").disabled = state.busy || !u || !u.ai?.trim() || !!draftProblem(u, u.ai) || stale;
  $("use-old").disabled = state.busy || !u || isBlank(u.old) || isBlank(u.source) || stale;
  $("target").disabled = state.busy || !u || isBlank(u.source) || stale;
  $("commit").disabled = state.busy || !draft || stale || !!draftProblem(u, draft?.value || "");
  $("skip").disabled = state.busy || !u;
  $("locate").disabled = state.busy || !u;
  $("copy-key").disabled = state.busy || !u?.key;
  $("next").disabled = state.busy || !state.model.units.length;
  $("batch").disabled = state.busy || !filtered().some(u => u.untranslated && !adoptionProblem(u));
  $("undo").disabled = state.busy || !state.journal.length || state.journalBook !== state.snapshot?.bookKey;
  $("mapping-save").disabled = state.busy || !state.snapshot;
  $("mapping-reset").disabled = state.busy || !state.profiles.length;
  $("discard-draft").disabled = state.busy;
}
function option(value, label) { const o = document.createElement("option"); o.value = value; o.textContent = label; return o; }
function updateLanguages(languages) {
  $("language").replaceChildren(option("", languages.length > 1 ? "请选择目标语言" : "未识别语言"), ...languages.map(l => option(l, l)));
  if (!languages.some(l => l.toLowerCase() === state.language.toLowerCase())) state.language = languages.length === 1 ? languages[0] : "";
  else state.language = languages.find(l => l.toLowerCase() === state.language.toLowerCase());
  $("language").value = state.language;
}
function rebuild() {
  state.model = state.snapshot ? parseWorkbook(state.snapshot.sheets, state.language, state.profiles) : { units: [], diagnostics: [] };
  const previous = $("sheet").value, names = [...new Set(state.model.units.map(u => u.sheet))];
  $("sheet").replaceChildren(option("", "全部工作表"), ...names.map(n => option(n, n)));
  $("sheet").value = names.includes(previous) ? previous : "";
  if (!current()) state.selected = null;
  render(); mapping.refresh();
}
function rows(element, values) {
  element.replaceChildren(...values.map(([label, count]) => {
    const row = document.createElement("div"), text = document.createElement("span"), number = document.createElement("strong");
    text.textContent = label; number.textContent = count.toLocaleString() + " 条"; row.append(text, number); return row;
  }));
}
function setStage(stage) {
  state.stage = stage;
  $("receive-view").hidden = stage !== "receive";
  $("work-view").hidden = stage !== "work";
  $("delivery-view").hidden = stage !== "delivery";
  $("tab-work").setAttribute("aria-pressed", String(stage !== "delivery"));
  $("tab-delivery").setAttribute("aria-pressed", String(stage === "delivery"));
}
function render() {
  const s = workflowSummary(state.model.units, state.model.diagnostics);
  $("book").textContent = state.snapshot?.name || "请打开翻译工作簿。";
  $("receive-summary").textContent = s.total ? state.language + " · " + s.sheets + " 张翻译工作表 · " + s.total.toLocaleString() + " 条记录" : "请选择目标语言，或展开“更多 → 识别设置”核实列关系。";
  rows($("task-breakdown"), [["已填写译文", s.filled], ["空译文，需补译", s.translation], ["原文有变更，需复核", s.revision], ...(s.review ? [["空译文，有旧译文可参考", s.review]] : [])]);
  const targets = [...new Set(state.model.units.map(u => columnName(u.targetCol)))];
  $("target-guide").textContent = s.total ? "只填写 " + state.language + " 最终译文列（本表涉及 " + targets.join("、") + " 列），原文、旧译文、AI 和 Key 保持原有用途。表内提供 " + s.ai + " 条 AI 建议。" : "列关系确认后才允许写入。";
  $("receive-warning").hidden = !s.diagnostics;
  $("receive-warning").textContent = s.diagnostics ? s.diagnostics + " 项识别提示，跳过内容未计入任务，请核实下方识别提示。" : "";
  $("begin").textContent = s.filled ? "继续翻译" : "开始翻译";
  $("work-language").textContent = state.language + " · 全工作簿 " + s.total.toLocaleString() + " 条";
  $("work-progress").textContent = "已填写 " + s.filled + " · 空译文 " + s.unfilled + " · 问题 " + s.errors;
  $("progress").value = s.total ? s.filled / s.total * 100 : 0;
  const diagnostics = state.model.diagnostics;
  $("diagnostic-box").hidden = !diagnostics.length;
  $("diagnostic-count").textContent = "识别提示 · " + diagnostics.length + " 项（跳过内容未计入任务）";
  $("diagnostics").replaceChildren(...diagnostics.map(t => { const li = document.createElement("li"); li.textContent = t; return li; }));
  setStage(state.stage); renderCurrent(); renderList(); renderDelivery(); updateActions();
}
function renderCurrent() {
  const u = current();
  $("current-content").hidden = !u;
  $("current-meta").hidden = !!u;
  if ($("current-key").textContent !== (u?.key || "")) {
    copyRequest++;
    $("copy-key-status").hidden = true;
    $("copy-key-status").textContent = "";
  }
  $("current-key").textContent = u?.key || "";
  $("current-location").textContent = u ? u.sheet + " · " + u.cell + " · " + u.field : "";
  $("current-meta").textContent = "在表格中选中译文，或点击下一条待处理。";
  if (!u) return;
  $("current-kind").textContent = taskKind(u);
  $("source").textContent = u.source || "（空）";
  $("old-source").textContent = u.oldSource || "";
  $("source-change").hidden = !u.oldSource || u.oldSource === u.source;
  const diff = sourceDifference(u.oldSource, u.source), node = $("source-diff");
  node.replaceChildren(document.createTextNode(diff.prefix));
  if (diff.removed) { const del = document.createElement("del"); del.textContent = diff.removed; node.append(del); }
  if (diff.added) { const ins = document.createElement("ins"); ins.textContent = diff.added; node.append(ins); }
  node.append(document.createTextNode(diff.suffix));
  $("old-box").hidden = isBlank(u.old); $("old").textContent = u.old || "";
  const value = draftFor(u).value;
  if ($("target").value !== value) $("target").value = value;
  $("ai-box").hidden = isBlank(u.ai); $("ai").textContent = u.ai || "";
  $("ai-errors").textContent = u.aiErrors.length ? "建议未通过格式检查，不能采用：\n" + u.aiErrors.join("\n") : "";
  renderDraftStatus();
}
function renderDraftStatus() {
  const u = current(), draft = draftFor(u); if (!u || !draft) return;
  const stale = !sameReviewedUnit(draft.reviewed, u), changed = draft.value !== u.target;
  $("current-errors").textContent = stale ? "表格内容或位置已变化。草稿已保留，请重新载入当前译文后核对。" : draftProblem(u, draft.value);
  $("discard-draft").hidden = !stale && !changed;
  $("draft-status").textContent = changed ? "草稿尚未写入；切换条目会在本次会话保留，关闭窗格会丢失。" : isBlank(u.source) ? "此条保持未解决，跳过不会计入已填写。" : isBlank(u.target) ? "可直接在表格中填写，也可在此编辑草稿。" : "当前译文已在工作簿中；是否保存到文件请查看交付检查。";
  $("draft-status").className = "muted" + (changed ? " draft-notice" : "");
}
function renderList() {
  const units = filtered(), pages = Math.ceil(units.length / pageSize);
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  $("queue-count").textContent = "· " + units.length;
  $("list-count").textContent = "当前筛选 " + units.length.toLocaleString() + " 条";
  $("list").replaceChildren(...units.slice(state.page * pageSize, (state.page + 1) * pageSize).map(u => {
    const b = document.createElement("button"); b.className = "entry" + (u.id === state.selected ? " selected" : "");
    const top = document.createElement("span"), source = document.createElement("span"), note = document.createElement("span");
    top.className = "entry-top"; top.textContent = u.sheet + " · " + u.cell;
    source.className = "entry-source"; source.textContent = u.source || u.key;
    note.className = "entry-note" + (u.errors.length || isBlank(u.source) ? " bad" : "");
    note.textContent = taskKind(u) + " · " + (u.errors[0] || processingStatus(u));
    b.append(top, source, note); b.disabled = state.busy; b.onclick = () => select(u, true); return b;
  }));
  if (!units.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "当前范围没有符合条件的记录。"; $("list").append(empty); }
  $("page").textContent = (pages ? state.page + 1 : 0) + " / " + pages;
  $("previous-page").disabled = state.busy || !state.page;
  $("next-page").disabled = state.busy || state.page >= pages - 1;
}
function renderDelivery() {
  const s = workflowSummary(state.model.units, state.model.diagnostics), drafts = draftCount();
  $("delivery-status").textContent = !state.language || !s.total ? "尚未识别有效的翻译任务，不能确认交付范围。" : state.busy || state.fullRefresh || state.dirty.size ? "正在更新检查结果，请等待。" : s.ready && !drafts ? "当前目标语言未发现格式或 Key 问题。请人工复核含义、术语后另存交付。" : "还有待处理事项，请逐项核实后再交付。";
  rows($("delivery-counts"), [["格式或 Key 问题条目", s.errors], ["侧栏未写入草稿", drafts]]);
  $("delivery-time").textContent = state.checkedAt ? "最近检查 " + new Date(state.checkedAt).toLocaleTimeString() + " · " + s.sheets + " 张翻译工作表 · " + s.total + " 条 · " + s.diagnostics + " 项识别提示" : "尚未完成全表检查。";
  const list = $("delivery-list"); list.replaceChildren();
  for (const [label, count, status] of [["格式或 Key 问题", s.errors, "issues"]]) {
    if (!count) continue;
    const row = document.createElement("div"), text = document.createElement("span"), b = document.createElement("button");
    row.className = "report-item"; text.textContent = label + " · " + count + " 条"; b.textContent = "去处理"; b.disabled = state.busy;
    b.onclick = () => { $("sheet").value = ""; $("search").value = ""; $("filter").value = status; state.page = 0; setStage("work"); $("queue-box").open = true; const u = filtered().find(u => status !== "pending" || (!isBlank(u.source) && u.untranslated)); if (u) select(u, true); renderList(); };
    row.append(text, b); list.append(row);
  }
  if (s.diagnostics) { const p = document.createElement("p"); p.className = "warning"; p.textContent = "有 " + s.diagnostics + " 项识别提示，跳过内容不能按已完成处理。展开下方“识别提示”核实，必要时配置列。"; list.append(p); }
  if (drafts) {
    const row = document.createElement("div"), text = document.createElement("span"), b = document.createElement("button");
    row.className = "report-item"; text.textContent = drafts + " 条侧栏草稿尚未写入。"; b.textContent = "查看草稿"; b.disabled = state.busy;
    b.onclick = () => {
      const d = [...bookDrafts().values()].find(d => d.reviewed.language === state.language && d.value !== (state.model.units.find(u => u.id === d.reviewed.id)?.target ?? d.reviewed.target));
      const u = d && state.model.units.find(u => u.id === d.reviewed.id);
      if (u) { setStage("work"); select(u, true); }
      else if (d) {
        const note = document.createElement("p"), value = document.createElement("pre"), remove = document.createElement("button");
        note.className = "warning"; note.textContent = "草稿原条目已移除或结构变化，不能写入旧地址。请先复制需要保留的内容：" + d.reviewed.key;
        value.textContent = d.value; remove.textContent = "丢弃这条未匹配草稿";
        remove.onclick = () => { if (window.confirm("丢弃这条未匹配的侧栏草稿？不会修改工作簿。")) { bookDrafts().delete(draftKey(d.reviewed)); renderDelivery(); } };
        b.disabled = true; list.append(note, value, remove);
      }
    }; row.append(text, b); list.append(row);
  }
  if (!list.children.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = s.total ? "本轮技术检查未发现上述问题。" : "请先识别任务。"; list.append(p); }
  renderSaveStatus();
}
function renderSaveStatus() {
  try {
    if (!state.snapshot) throw new Error();
    host.assertBook(state.snapshot.bookKey);
    const book = host.activeBook(), saved = book.Saved;
    $("save-status").textContent = (saved === true ? "WPS 报告当前文件已保存：" : saved === false ? "当前工作簿有未保存更改：" : "当前文件（无法读取保存状态）：") + host.bookKey(book);
  } catch { $("save-status").textContent = "保存状态不可用。请在 WPS 中确认另存成功和实际文件位置。"; }
}
function select(unit, locate) {
  if (state.busy) return;
  state.selected = unit.id; renderCurrent(); renderList(); updateActions();
  if (locate) { try { host.locate(unit, state.snapshot.bookKey); } catch (e) { message(e.message, "error"); } }
}
function followSelection() {
  if (!state.snapshot || state.busy || state.writing || state.stage !== "work") return;
  try { host.assertBook(state.snapshot.bookKey); const s = host.selection(); const u = s && selectedUnit(state.model.units, s.sheet, s.row, s.column); if (u?.id === state.selected) return; state.selected = u?.id ?? null; renderCurrent(); renderList(); updateActions(); } catch { /* 激活事件会重新读取工作簿。 */ }
}
async function scan(full = true) {
  if (state.busy) { state.fullRefresh ||= full; return false; }
  busy(true); state.checkedAt = null;
  const dirty = [...state.dirty]; state.dirty.clear(); state.fullRefresh = false;
  let ok = false;
  try {
    if (full || !state.snapshot) {
      const oldBook = state.snapshot?.bookKey;
      state.snapshot = await host.snapshot(value => message(value));
      if (oldBook !== state.snapshot.bookKey) {
        state.journal = state.journals.get(state.snapshot.bookKey) ?? []; state.journalBook = state.snapshot.bookKey;
        state.language = ""; state.selected = null; state.stage = "receive"; state.page = 0;
        $("sheet").value = ""; $("search").value = ""; $("filter").value = "pending";
      }
    } else {
      const key = state.snapshot.bookKey; host.assertBook(key);
      for (const name of dirty) { const i = state.snapshot.sheets.findIndex(s => s.name === name); if (i < 0) { state.fullRefresh = true; continue; } state.snapshot.sheets[i] = await host.readSheet(host.sheet(name, key), key); }
    }
    updateLanguages(discoverLanguages(state.snapshot.sheets, state.profiles));
    state.checkedAt = Date.now(); rebuild();
    if (!state.language) { state.stage = "receive"; $("more-box").open = true; if ($("language").options.length <= 1) $("mapping-box").open = true; message("请选择任务语言；没有可选项时请核实识别设置。", "error"); }
    else message("已更新任务 · " + state.model.units.length + " 条；内容仅在本机处理。", "success");
    ok = true;
  } catch (e) {
    state.snapshot = null; state.model = { units: [], diagnostics: [] }; state.selected = null; state.stage = "receive";
    message(e.message || String(e), "error");
  } finally {
    busy(false); render();
    if (state.fullRefresh || state.dirty.size) schedule();
  }
  return ok;
}
function schedule(full = false) { state.fullRefresh ||= full; state.checkedAt = null; if (state.stage === "delivery") renderDelivery(); clearTimeout(state.timer); state.timer = setTimeout(() => { if (!state.busy) scan(state.fullRefresh || !state.snapshot); }, 280); }
function goNext(skip = false) {
  if (state.busy || !state.snapshot) return;
  const u = nextPending(state.model.units, state.selected, { ...scope(), status: $("filter").value });
  if (u) { setStage("work"); select(u, true); if (skip) message("已暂跳过，本条仍保留在待处理范围。侧栏草稿仅在本次会话保留。"); }
  else { message("当前范围没有可继续填写的任务，请查看交付检查和识别提示。", "success"); if (!$("sheet").value && !$("search").value) setStage("delivery"); renderDelivery(); }
}
function journal(changes) { if (!changes.length) return; state.journal = changes; state.journalBook = state.snapshot.bookKey; state.journals.set(state.journalBook, changes); }
async function commit() {
  const u = current(), draft = draftFor(u);
  if (state.busy || !u || !draft) return;
  const key = state.snapshot.bookKey; busy(true); state.writing = true;
  let success = false;
  try {
    const fresh = await host.snapshot(v => message("写入前核对 · " + v));
    const model = parseWorkbook(fresh.sheets, state.language, state.profiles);
    const change = applyDraft(host, key, draft.reviewed, model.units, draft.value);
    if (change) journal([change]);
    bookDrafts().delete(draftKey(u)); success = true;
  } catch (e) { message(e.message || String(e), "error"); }
  finally { state.writing = false; busy(false); }
  if (success) { await scan(true); if (state.snapshot?.bookKey === key) { goNext(); message("译文已写入工作簿，已查找下一条待处理。请用 WPS 保存文件。", "success"); } }
  else { const failure = $("message").textContent; await scan(true); message(failure, "error"); }
}
function useReference(type) {
  const u = current(); if (state.busy || !u) return;
  if (type === "ai" && draftProblem(u, u.ai)) return message(draftProblem(u, u.ai), "error");
  const draft = draftFor(u); if (!sameReviewedUnit(draft.reviewed, u)) return message("表格已变化，请重新载入当前译文后核对。", "error");
  const value = type === "ai" ? u.ai : u.old;
  if (draft.value !== u.target && draft.value !== value && !window.confirm("当前条目有未写入草稿，是否用这份参考替换草稿？")) return;
  rememberDraft(value); renderCurrent(); message("已放入草稿，尚未写入表格。核对后点击“写入并下一条”。");
}
async function adoptCurrent() {
  const u = current(), draft = draftFor(u);
  if (state.busy || !u || !state.snapshot) return;
  const problem = adoptionProblem(u);
  if (problem) return message(problem, "error");
  const key = state.snapshot.bookKey; busy(true); state.writing = true;
  let result, failure = "";
  try {
    const fresh = await host.snapshot(v => message("采用前核对 · " + v));
    const model = parseWorkbook(fresh.sheets, state.language, state.profiles);
    result = await applyCurrentSuggestion(host, key, u, model.units, { draft,
      confirm: ({ unit, discardDraft, overwriteExisting }) => window.confirm([
        overwriteExisting ? "将替换 " + unit.sheet + "!" + unit.cell + " 的现有译文。" : "将填写 " + unit.sheet + "!" + unit.cell + "。",
        discardDraft ? "本条有不同的未写入草稿，采用后将丢弃该草稿。" : "",
        "是否采用表内 AI 建议并写入？可从“更多”撤销最近一次助手写入。",
      ].filter(Boolean).join("\n")) });
    if (result.changes.length) { journal(result.changes); bookDrafts().delete(draftKey(u)); }
    failure = result.error;
  } catch (e) { failure = e.message || String(e); }
  finally { state.writing = false; busy(false); await scan(true); }
  message(failure ? "未采用 AI。" + failure : result?.cancelled ? "已取消，译文和侧栏草稿均保留。" : "AI 建议已写入 " + u.sheet + "!" + u.cell + "。请核对并用 WPS 保存；点击下一条可继续。", failure ? "error" : "success");
}
async function batch() {
  if (state.busy || !state.snapshot) return;
  const reviewed = filtered().filter(u => isBlank(u.target) && !adoptionProblem(u));
  if (!reviewed.length) return;
  if (draftCount()) return message("本任务还有未写入侧栏草稿，请先写入或丢弃，再进行批量填充。", "error");
  const key = state.snapshot.bookKey; busy(true); state.writing = true; let result, failure = "";
  try {
    const fresh = await host.snapshot(v => message("填充前核对 · " + v));
    result = await applySuggestions(host, key, reviewed, parseWorkbook(fresh.sheets, state.language, state.profiles).units, { onlyEmpty: true,
      confirm: plan => window.confirm("将填充当前筛选内 " + plan.length + " 条空白译文。\nAI 仅通过格式检查，填充后仍需逐条复核含义和术语。是否继续？") });
    journal(result.changes); failure = result.error;
  } catch (e) { failure = e.message || String(e); }
  finally { state.writing = false; busy(false); await scan(true); }
  message(failure ? "已填充 " + (result?.changes.length || 0) + " 条，其余停止。" + failure : result?.cancelled ? "已取消。" : "已填充 " + (result?.changes.length || 0) + " 条，请逐条复核并用 WPS 保存。", failure ? "error" : "success");
}
async function undo() {
  if (state.busy || !state.journal.length) return;
  busy(true); state.writing = true; let result, failure;
  try { result = await undoSuggestions(host, state.journalBook, state.journal); state.journal = result.remaining; state.journals.set(state.journalBook, result.remaining); }
  catch (e) { failure = e.message; }
  finally { state.writing = false; busy(false); await scan(true); }
  message(failure || ("已撤销 " + result.restored + " 条。" + (result.remaining.length ? result.remaining.length + " 条因后续修改未撤销。" : "请用 WPS 保存。")), failure || result?.remaining.length ? "error" : "success");
}
async function delivery() { if (state.busy) return; if (await scan(true)) { setStage("delivery"); renderDelivery(); } }
$("begin").onclick = async () => { if (!await scan(true) || !state.language) return; $("sheet").value = ""; $("search").value = ""; $("filter").value = "pending"; setStage("work"); state.selected = null; goNext(); };
$("tab-work").onclick = () => setStage(state.language && state.model.units.length ? "work" : "receive");
$("tab-delivery").onclick = delivery; $("delivery-refresh").onclick = delivery;
$("task-overview").onclick = () => setStage("receive"); $("save-status-refresh").onclick = renderSaveStatus;
$("scan").onclick = () => scan(true);
$("language").onchange = () => { state.language = $("language").value; state.selected = null; state.page = 0; state.stage = "receive"; rebuild(); };
for (const id of ["sheet", "filter", "search"]) $(id).addEventListener(id === "search" ? "input" : "change", () => { state.page = 0; renderList(); updateActions(); });
$("previous-page").onclick = () => { state.page--; renderList(); }; $("next-page").onclick = () => { state.page++; renderList(); };
$("locate").onclick = () => { const u = current(); if (u) select(u, true); };
$("copy-key").onclick = async () => {
  const key = current()?.key;
  if (!key || state.busy) return;
  const request = ++copyRequest, status = $("copy-key-status");
  $("copy-key").disabled = true;
  status.hidden = true;
  try {
    await copyText(key);
    if (request !== copyRequest) return;
    status.textContent = "Key 已复制";
    status.className = "muted";
    status.hidden = false;
  } catch (error) {
    if (request !== copyRequest) return;
    status.textContent = error.message;
    status.className = "problem-text";
    status.hidden = false;
  } finally { updateActions(); }
};
$("next").onclick = () => goNext(); $("skip").onclick = () => goNext(true);
$("target").oninput = () => rememberDraft($("target").value);
$("adopt").onclick = adoptCurrent; $("load-ai").onclick = () => useReference("ai"); $("use-old").onclick = () => useReference("old");
$("discard-draft").onclick = () => { const u = current(); if (u && window.confirm("丢弃本条侧栏草稿并读取表格当前译文？")) { bookDrafts().delete(draftKey(u)); renderCurrent(); updateActions(); } };
$("commit").onclick = commit; $("batch").onclick = batch; $("undo").onclick = undo;
const mapping = setupMapping({ state, getStorage: () => window.localStorage, message, changed: () => { if (!state.snapshot) return; state.journal = []; state.journals.delete(state.snapshot.bookKey); state.page = 0; state.selected = null; updateLanguages(discoverLanguages(state.snapshot.sheets, state.profiles)); rebuild(); } });
const listeners = [];
function listen(event, callback) { try { host.app.ApiEvent.AddApiEventListener(event, callback); listeners.push(event); } catch { message("部分自动检查事件不可用，修改后请在“更多”中重新识别。", "error"); } }
function activation() { if (state.writing) return; try { if (state.snapshot?.bookKey !== host.bookKey()) schedule(true); } catch { state.snapshot = null; state.model = { units: [], diagnostics: [] }; state.selected = null; state.stage = "receive"; render(); } }
if (host.app) {
  listen("SheetSelectionChange", () => { activation(); followSelection(); });
  listen("SheetChange", sheet => { if (state.writing) return; try { if (!state.snapshot || host.bookKey() !== state.snapshot.bookKey) return schedule(true); if (sheet?.Parent && host.bookKey(sheet.Parent) !== state.snapshot.bookKey) return; if (sheet?.Name) state.dirty.add(String(sheet.Name)); else state.fullRefresh = true; schedule(); } catch { schedule(true); } });
  for (const event of ["WorkbookActivate", "WorkbookOpen", "NewWorkbook"]) listen(event, activation);
  for (const event of ["WorkbookNewSheet", "SheetBeforeDelete"]) listen(event, () => schedule(true));
  listen("SheetActivate", () => { activation(); followSelection(); });
}
window.addEventListener("beforeunload", () => { clearTimeout(state.timer); for (const event of listeners) { try { host.app.ApiEvent.RemoveApiEventListener(event); } catch { /* WPS 自动释放。 */ } } });
async function command(value) {
  let data; try { data = JSON.parse(value); } catch { return; }
  if (!data?.id || state.lastCommand === data.id) return;
  state.lastCommand = data.id; try { host.app.PluginStorage.setItem(commandKey, ""); } catch { /* 无命令缓存。 */ }
  if (state.busy) return;
  if (!state.snapshot) await scan(true);
  if (data.action === "delivery" || data.action === "scan") return delivery();
  if (data.action === "next") { setStage("work"); goNext(); }
  if (data.action === "adopt") { setStage("work"); followSelection(); await adoptCurrent(); }
}
if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel("WpsTranslationAssistant"); channel.onmessage = event => command(event.data); }
if (host.app) { let pending = ""; try { pending = host.app.PluginStorage.getItem(commandKey); } catch { /* 无待处理命令。 */ } if (pending) command(pending); else scan(true); }
else message("请在 Windows WPS 表格中点击“翻译助手 → 打开助手”。", "error");
render();
