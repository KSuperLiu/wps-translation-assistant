import { inspectWorkbook, schemaSignature, createManualProfile } from "./schema.js";
import { columnName } from "./model.js";

const storageKey = "WpsTranslationAssistant.schemaProfiles.v1";
export function loadProfiles(storage) {
  try {
    const value = JSON.parse(storage.getItem(storageKey) || "[]");
    return Array.isArray(value) ? value.filter(p => typeof p?.signature === "string" && Array.isArray(p.entries)) : [];
  } catch { return []; }
}

export function setupMapping({ state, getStorage, message, changed }) {
  const $ = id => document.getElementById(id);
  const selectIds = ["key", "source", "target", "old", "ai"];
  const currentSheet = () => state.snapshot?.sheets.find(s => s.name === $("mapping-sheet").value);
  const currentProfile = () => {
    const sheet = currentSheet(), row = Number($("mapping-header").value);
    return sheet && state.profiles.find(p => p.headerRow === row && p.signature === schemaSignature(sheet, row));
  };
  const option = (value, label) => { const o = document.createElement("option"); o.value = value; o.textContent = label; return o; };
  function persist() {
    try { getStorage().setItem(storageKey, JSON.stringify(state.profiles)); return true; }
    catch { return false; }
  }
  function refreshColumns(values = {}) {
    const sheet = currentSheet();
    if (!sheet) return;
    const row = Number($("mapping-header").value);
    for (const name of selectIds) {
      const select = $("mapping-" + name), previous = values[name + "Col"] ?? select.value;
      const options = Array.from({ length: sheet.columns }, (_, i) => option(i + 1, columnName(i + 1) + " · " + (sheet.values[row - 1]?.[i] || "空表头")));
      select.replaceChildren(option(0, name === "old" || name === "ai" ? "无" : "请选择"), ...options);
      select.value = String(previous || 0);
    }
    refreshEntries();
  }
  function refreshEntries() {
    const profile = currentProfile(), sheet = currentSheet();
    const auto = sheet && inspectWorkbook([sheet]).groups;
    $("mapping-status").textContent = profile ? "已启用手动映射 · " + profile.entries.length + " 个字段；可继续添加字段。"
      : auto?.length ? "当前为自动识别 · " + auto.length + " 个字段组。" : "尚未自动识别，指定列后即可检查。";
    $("mapping-reset").disabled = !profile || state.busy;
    $("mapping-entries").replaceChildren(...(profile?.entries || []).map((entry, index) => {
      const item = document.createElement("div"); item.className = "mapping-entry";
      const label = document.createElement("span"); label.textContent = entry.field + " · " + entry.language + " · " + columnName(entry.sourceCol) + " → " + columnName(entry.targetCol);
      const remove = document.createElement("button"); remove.textContent = "移除"; remove.disabled = state.busy;
      remove.onclick = () => {
        if (state.busy) return;
        const remaining = profile.entries.filter((_, i) => i !== index);
        state.profiles = state.profiles.filter(p => p.signature !== profile.signature);
        if (remaining.length) state.profiles.push({ ...profile, entries: remaining });
        persist(); changed(); refreshEntries();
      };
      item.append(label, remove); return item;
    }));
  }
  function loadSheet() {
    const sheet = currentSheet();
    if (!sheet) return;
    const profile = state.profiles.find(p => p.signature === schemaSignature(sheet, p.headerRow));
    const auto = inspectWorkbook([sheet]).groups[0];
    const entry = profile?.entries.at(-1), target = auto?.targets.find(t => t.language === state.language) || auto?.targets[0];
    $("mapping-header").value = entry?.headerRow || auto?.headerRow || 1;
    $("mapping-data").value = entry?.dataStartRow || auto?.dataStartRow || 2;
    $("mapping-language").value = entry?.language || target?.language || state.language || "";
    $("mapping-field").value = entry?.field || auto?.field || "";
    refreshColumns(entry || { keyCol: auto?.keyCol, sourceCol: auto?.sourceCol, targetCol: target?.targetCol, oldCol: target?.oldCol, aiCol: target?.aiCol });
  }
  $("mapping-sheet").onchange = loadSheet;
  $("mapping-header").onchange = () => {
    const row = Number($("mapping-header").value);
    if (Number($("mapping-data").value) <= row) $("mapping-data").value = row + 1;
    refreshColumns();
  };
  $("mapping-save").onclick = () => {
    if (state.busy) return;
    try {
      const sheet = currentSheet();
      if (!sheet) throw new Error("请先选择已读取的工作表。");
      const entry = { headerRow: $("mapping-header").value, dataStartRow: $("mapping-data").value,
        language: $("mapping-language").value, field: $("mapping-field").value };
      for (const name of selectIds) entry[name + "Col"] = $("mapping-" + name).value;
      const profile = createManualProfile(sheet, entry, currentProfile());
      state.profiles = [...state.profiles.filter(p => p.signature !== profile.signature), profile];
      state.language = profile.entries.at(-1).language;
      const saved = persist(); changed(); refreshEntries();
      message(saved ? "映射已保存；同表头结构会自动复用，当前 Sheet 仅处理配置的字段。" : "映射已在本会话生效；当前 WPS 环境不允许持久保存配置。", saved ? "success" : "error");
    } catch (error) { message(error.message, "error"); }
  };
  $("mapping-reset").onclick = () => {
    if (state.busy) return;
    const profile = currentProfile();
    if (!profile) return;
    state.profiles = state.profiles.filter(p => p.signature !== profile.signature);
    persist(); changed(); loadSheet(); message("已恢复自动识别。");
  };
  return {
    refresh() {
      const previous = $("mapping-sheet").value;
      const sheets = (state.snapshot?.sheets || []).filter(s => !s.error && s.rows && s.name !== "总览");
      $("mapping-sheet").replaceChildren(...sheets.map(s => option(s.name, s.name)));
      if (sheets.some(s => s.name === previous)) $("mapping-sheet").value = previous;
      loadSheet();
    },
  };
}
