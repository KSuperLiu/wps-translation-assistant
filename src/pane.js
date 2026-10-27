import "./style.css";
import "./mapping.css";
import { WpsHost } from "./wps-host.js";
import { discoverLanguages, parseWorkbook, statistics, filterUnits, selectedUnit, adoptionProblem } from "./model.js";
import { applySuggestions, undoSuggestions } from "./operations.js";
import { isBlank } from "./validation.js";
import { loadProfiles, setupMapping } from "./mapping-ui.js";

const $ = id => document.getElementById(id);
const host = new WpsHost(window.Application);
let savedProfiles = [];
try { savedProfiles = loadProfiles(window.localStorage); } catch { /* 当前环境不提供持久存储。 */ }
const state = { snapshot: null, model: { units: [], diagnostics: [] }, language: "", selected: null,
  page: 0, busy: false, writing: false, journal: [], journalBook: "", journals: new Map(), fullRefresh: false,
  dirty: new Set(), timer: null, lastCommand: "", profiles: savedProfiles };
const pageSize = 40;
const commandKey = "WpsTranslationAssistant.command";

function message(value, kind = "") { $("message").textContent = value; $("message").className = kind; }
function current() { return state.model.units.find(u => u.id === state.selected) ?? null; }
function filtered() { return filterUnits(state.model.units, { sheet: $("sheet").value, status: $("filter").value, query: $("search").value }); }
function busy(value) {
  state.busy = value;
  ["scan", "language", "sheet", "filter", "search"].forEach(id => { $(id).disabled = value; });
  updateActions();
}
function updateActions() {
  const u = current();
  $("adopt").disabled = state.busy || !!adoptionProblem(u);
  $("locate").disabled = state.busy || !u;
  $("next").disabled = state.busy || !state.model.units.some(u => u.untranslated || u.errors.length);
  $("batch").disabled = state.busy || !filtered().some(u => u.untranslated && !adoptionProblem(u));
  $("undo").disabled = state.busy || !state.journal.length || state.journalBook !== state.snapshot?.bookKey;
  $("mapping-save").disabled = state.busy || !state.snapshot;
  $("mapping-reset").disabled = state.busy || !state.profiles.length;
}
function option(value, label) { const node = document.createElement("option"); node.value = value; node.textContent = label; return node; }
function updateLanguages(languages) {
  $("language").replaceChildren(option("", languages.length > 1 ? "请选择目标语言" : "未识别语言"), ...languages.map(l => option(l, l)));
  if (!languages.some(l => l.toLowerCase() === state.language.toLowerCase())) state.language = languages.length === 1 ? languages[0] : "";
  else state.language = languages.find(l => l.toLowerCase() === state.language.toLowerCase());
  $("language").value = state.language;
}
function rebuild() {
  state.model = state.snapshot ? parseWorkbook(state.snapshot.sheets, state.language, state.profiles) : { units: [], diagnostics: [] };
  const previousSheet = $("sheet").value;
  const names = [...new Set(state.model.units.map(u => u.sheet))];
  $("sheet").replaceChildren(option("", "全部工作表"), ...names.map(name => option(name, name)));
  $("sheet").value = names.includes(previousSheet) ? previousSheet : "";
  if (!current()) state.selected = null;
  followSelection(false);
  render();
  mapping.refresh();
}
function render() {
  const stats = statistics(state.model.units);
  for (const key of ["translated", "untranslated", "errors"]) $(key).textContent = stats[key].toLocaleString();
  $("book").textContent = state.snapshot?.name || "打开翻译工作簿，开始检查。";
  $("total").textContent = "全工作簿 · " + stats.total.toLocaleString() + " 条";
  $("percent").textContent = stats.progress + "%";
  $("progress").value = stats.progress;
  const diagnostics = state.model.diagnostics;
  $("diagnostic-box").hidden = !diagnostics.length;
  $("diagnostic-count").textContent = "识别提示 · " + diagnostics.length + " 项（跳过的内容未计入统计）";
  $("diagnostics").replaceChildren(...diagnostics.map(value => { const li = document.createElement("li"); li.textContent = value; return li; }));
  renderCurrent(); renderList(); updateActions();
}
function renderCurrent() {
  const u = current();
  $("current-content").hidden = !u;
  $("current-key").textContent = u?.key || "";
  $("current-meta").textContent = u ? u.sheet + " · " + u.cell + " · " + u.field
    + (u.referenceLanguages?.length ? " · 参考 " + u.referenceLanguages.join(" / ") : "") : "在表格中选中一条译文，或点击下方列表。";
  for (const key of ["source", "old", "target", "ai"]) $(key).textContent = u ? (u[key] || "（空白）") : "";
  $("current-errors").textContent = u ? (u.untranslated ? "未翻译" : u.errors.join("\n")) : "";
  $("ai-errors").textContent = u?.aiErrors.length ? "此 AI 建议不可采用：\n" + u.aiErrors.join("\n") : "";
}
function renderList() {
  const units = filtered(), pages = Math.ceil(units.length / pageSize);
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  $("list-count").textContent = "当前筛选 · " + units.length.toLocaleString() + " 条";
  const visible = units.slice(state.page * pageSize, (state.page + 1) * pageSize);
  $("list").replaceChildren(...visible.map(u => {
    const button = document.createElement("button"); button.className = "entry" + (u.id === state.selected ? " selected" : "");
    const top = document.createElement("span"); top.className = "entry-top"; top.textContent = u.sheet + " · " + u.cell;
    const source = document.createElement("span"); source.className = "entry-source"; source.textContent = u.source || u.key;
    const note = document.createElement("span"); note.className = "entry-note" + (u.errors.length ? " bad" : u.untranslated ? " empty" : "");
    note.textContent = u.errors[0] || (u.untranslated ? "未翻译" : "已填写 · 校验通过");
    button.append(top, source, note); button.title = u.key + "\n" + u.source + "\n" + u.errors.join("\n");
    button.onclick = () => select(u, true); button.disabled = state.busy;
    return button;
  }));
  if (!visible.length) { const empty = document.createElement("div"); empty.className = "empty-state"; empty.textContent = state.model.units.length ? "没有符合筛选条件的条目" : "识别翻译表后，条目会显示在这里"; $("list").append(empty); }
  $("page").textContent = (pages ? state.page + 1 : 0) + " / " + pages;
  $("previous-page").disabled = state.busy || state.page === 0;
  $("next-page").disabled = state.busy || state.page >= pages - 1;
}
function select(unit, locate) {
  if (state.busy) return;
  state.selected = unit.id;
  renderCurrent(); renderList(); updateActions();
  if (locate) { try { host.locate(unit, state.snapshot.bookKey); } catch (error) { message(error.message, "error"); } }
}
function followSelection(redraw = true) {
  if (!state.snapshot || state.busy || state.writing) return;
  try {
    host.assertBook(state.snapshot.bookKey);
    const selection = host.selection();
    const unit = selection && selectedUnit(state.model.units, selection.sheet, selection.row, selection.column);
    state.selected = unit?.id ?? null;
    if (redraw) { renderCurrent(); renderList(); updateActions(); }
  } catch { /* 工作簿切换由激活事件处理；写入前仍再次核对。 */ }
}
async function scan(full = true) {
  if (state.busy) { state.fullRefresh ||= full; return; }
  busy(true);
  const dirty = [...state.dirty]; state.dirty.clear(); state.fullRefresh = false;
  try {
    if (full || !state.snapshot) {
      const oldBook = state.snapshot?.bookKey;
      state.snapshot = await host.snapshot(value => message(value));
      if (oldBook !== state.snapshot.bookKey) {
        state.journal = state.journals.get(state.snapshot.bookKey) ?? [];
        state.journalBook = state.snapshot.bookKey;
        state.language = "";
        state.selected = null;
      }
    } else {
      const bookKey = state.snapshot.bookKey;
      host.assertBook(bookKey);
      for (const name of dirty) {
        const index = state.snapshot.sheets.findIndex(s => s.name === name);
        if (index < 0) { state.fullRefresh = true; continue; }
        message("更新检查 · " + name);
        state.snapshot.sheets[index] = await host.readSheet(host.sheet(name, bookKey), bookKey);
      }
    }
    updateLanguages(discoverLanguages(state.snapshot.sheets, state.profiles));
    rebuild();
    if (!$("language").options.length || $("language").options.length === 1) $("mapping-box").open = true;
    if (!state.language) message("请选择目标语言；若没有可选项，请确认打开的是现有 LanguagePatch 翻译表。", "error");
    else message("检查完成 · " + state.model.units.length + " 条；内容仅在本机处理。", "success");
  } catch (error) {
    state.snapshot = null; state.model = { units: [], diagnostics: [] }; state.selected = null;
    render(); message(error.message || String(error), "error");
  } finally {
    busy(false); followSelection();
    if (state.fullRefresh || state.dirty.size) schedule();
  }
}
function schedule(full = false) {
  state.fullRefresh ||= full;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { if (!state.busy) scan(state.fullRefresh || !state.snapshot); }, 280);
}
function nextIssue() {
  if (state.busy || !state.snapshot) return;
  const scope = filterUnits(state.model.units, { sheet: $("sheet").value, query: $("search").value });
  const index = scope.findIndex(u => u.id === state.selected);
  for (let offset = 1; offset <= scope.length; offset++) {
    const unit = scope[(index + offset + scope.length) % scope.length];
    if (unit.untranslated || unit.errors.length) { select(unit, true); return; }
  }
  message("当前工作表和搜索范围内没有未翻译或校验问题条目。", "success");
}
async function adopt(batch = false) {
  if (state.busy || !state.snapshot) return;
  const reviewed = batch ? filtered().filter(u => isBlank(u.target) && !adoptionProblem(u)) : [current()].filter(Boolean);
  if (!reviewed.length) return message("没有可采用的合格 AI 建议。", "error");
  const problem = !batch && adoptionProblem(reviewed[0]);
  if (problem) return message(problem, "error");
  const bookKey = state.snapshot.bookKey;
  busy(true); state.writing = true;
  let result, failure = "";
  try {
    host.assertBook(bookKey);
    const fresh = await host.snapshot(value => message("采用前重新核对 · " + value));
    state.snapshot = fresh;
    const freshModel = parseWorkbook(fresh.sheets, state.language, state.profiles);
    result = await applySuggestions(host, bookKey, reviewed, freshModel.units, {
      onlyEmpty: batch,
      confirm: plan => window.confirm(batch
        ? "将采用当前筛选内 " + plan.length + " 条合格 AI 建议，仅填充空白新译文。\n原文、旧译文和 AI 列不会改变。是否继续？"
        : "将替换 " + plan[0].unit.sheet + "!" + plan[0].unit.cell + " 的新译文。\n可以用助手中的专用按钮撤销本次采用。是否继续？"),
    });
    if (result.changes.length) {
      state.journal = result.changes; state.journalBook = bookKey;
      state.journals.set(bookKey, result.changes);
    }
    failure = result.error;
  } catch (error) { failure = error.message || String(error); }
  finally {
    state.writing = false; busy(false);
    await scan(true);
  }
  if (failure) message((result?.changes.length ? "已采用 " + result.changes.length + " 条，其余停止，可撤销已采用项。" : "未采用。") + failure, "error");
  else if (result?.cancelled) message("已取消采用。");
  else message("已采用 " + (result?.changes.length ?? 0) + " 条 AI 建议。请使用 WPS 保存或另存。", "success");
}
async function undo() {
  if (state.busy || !state.journal.length) return;
  busy(true); state.writing = true;
  let result, failure;
  try {
    result = await undoSuggestions(host, state.journalBook, state.journal); state.journal = result.remaining;
    state.journals.set(state.journalBook, result.remaining);
  }
  catch (error) { failure = error.message; }
  finally { state.writing = false; busy(false); await scan(true); }
  if (failure) message(failure, "error");
  else message("已撤销 " + result.restored + " 条。" + (result.remaining.length ? result.remaining.length + " 条因后续修改或表结构变化未撤销：" + result.errors[0] : ""), result.remaining.length ? "error" : "success");
}

$("scan").onclick = () => scan(true);
$("language").onchange = () => { state.language = $("language").value; state.selected = null; state.page = 0; rebuild(); };
for (const id of ["sheet", "filter", "search"]) $(id).addEventListener(id === "search" ? "input" : "change", () => { state.page = 0; renderList(); updateActions(); });
$("previous-page").onclick = () => { state.page--; renderList(); };
$("next-page").onclick = () => { state.page++; renderList(); };
$("locate").onclick = () => { const unit = current(); if (unit) select(unit, true); };
$("next").onclick = nextIssue;
$("adopt").onclick = () => adopt(false);
$("batch").onclick = () => adopt(true);
$("undo").onclick = undo;

const mapping = setupMapping({ state, getStorage: () => window.localStorage, message, changed: () => {
  if (!state.snapshot) return;
  state.journal = []; state.journals.delete(state.snapshot.bookKey);
  state.page = 0; state.selected = null;
  updateLanguages(discoverLanguages(state.snapshot.sheets, state.profiles));
  rebuild();
} });

const listeners = [];
function listen(event, callback) {
  try { host.app.ApiEvent.AddApiEventListener(event, callback); listeners.push(event); }
  catch { message("部分自动检查事件不可用，请在修改后点击“识别并检查全表”。", "error"); }
}
function activation() {
  if (state.writing) return;
  try { if (state.snapshot?.bookKey !== host.bookKey()) schedule(true); }
  catch { state.snapshot = null; state.model = { units: [], diagnostics: [] }; state.selected = null; render(); }
}
if (host.app) {
  listen("SheetSelectionChange", () => { activation(); followSelection(); });
  listen("SheetChange", sheet => {
    if (state.writing) return;
    try {
      if (!state.snapshot || host.bookKey() !== state.snapshot.bookKey) return schedule(true);
      if (sheet?.Parent && host.bookKey(sheet.Parent) !== state.snapshot.bookKey) return;
      if (sheet?.Name) state.dirty.add(String(sheet.Name)); else state.fullRefresh = true;
      schedule();
    } catch { schedule(true); }
  });
  for (const event of ["WorkbookActivate", "WorkbookOpen", "NewWorkbook"]) listen(event, activation);
  for (const event of ["WorkbookNewSheet", "SheetBeforeDelete"]) listen(event, () => schedule(true));
  listen("SheetActivate", () => { activation(); followSelection(); });
  window.addEventListener("beforeunload", () => {
    clearTimeout(state.timer);
    for (const event of listeners) { try { host.app.ApiEvent.RemoveApiEventListener(event); } catch { /* WPS 会自动释放页面事件。 */ } }
  });
}
async function command(value) {
  let data;
  try { data = JSON.parse(value); } catch { return; }
  if (!data?.id || state.lastCommand === data.id) return;
  state.lastCommand = data.id;
  try { host.app.PluginStorage.setItem(commandKey, ""); } catch { /* 避免页面重载时重复执行旧命令。 */ }
  if (state.busy) return;
  if (!state.snapshot || data.action === "scan") await scan(true);
  if (data.action === "next") nextIssue();
  if (data.action === "adopt") await adopt(false);
}
if (typeof BroadcastChannel !== "undefined") {
  const channel = new BroadcastChannel("WpsTranslationAssistant");
  channel.onmessage = event => command(event.data);
}
if (host.app) {
  let pending = "";
  try { pending = host.app.PluginStorage.getItem(commandKey); } catch { /* 没有待处理命令。 */ }
  if (pending) command(pending); else scan(true);
} else message("请在 Windows WPS 表格中通过“翻译助手 → 打开助手”使用此页面。", "error");
render();
