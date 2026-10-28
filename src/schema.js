import { text } from "./validation.js";
import { normalizeHeader, canonicalLanguage, headerRole } from "./languages.js";

export const readCell = (sheet, row, column) => text(sheet.values[row - 1]?.[column - 1]);
const same = (a, b) => normalizeHeader(a) === normalizeHeader(b);
const unique = values => [...new Set(values)];
function metadata(value) {
  const match = /^(.*?)[_.\s-]+(i18n|il8n|languagekey|key|ai)(?:[_.\s-]+(.+))?$/i.exec(normalizeHeader(value));
  return match ? { field: match[1], kind: match[2] === "ai" ? "ai" : "key", language: canonicalLanguage(match[3] || "") } : null;
}
const sameField = (a, b) => normalizeHeader(a).replace(/[_.\s-]/g, "") === normalizeHeader(b).replace(/[_.\s-]/g, "");
const columns = sheet => Array.from({ length: sheet.columns }, (_, i) => i + 1);

function targetMappings(sheet, row, allowed, { preferPairs = false, field = "", fieldRow = 0 } = {}) {
  const roles = allowed.map(column => {
    const role = headerRole(readCell(sheet, row, column));
    return { column, ...role, role: role.role === "key" && role.language === "ID" ? "current" : role.role };
  });
  const current = roles.filter(r => r.role === "current"), old = roles.filter(r => r.role === "old");
  const pairs = current.filter(r => old.some(o => o.language === r.language));
  const candidates = preferPairs && old.length ? pairs : current;
  const issues = [], targets = [];
  for (const language of unique(candidates.map(r => r.language))) {
    const choices = candidates.filter(r => r.language === language);
    const previous = old.filter(r => r.language === language);
    if (choices.length !== 1 || previous.length > 1) { issues.push("目标语言 " + language + " 的表头重复或别名冲突，未处理此语言。"); continue; }
    const specific = roles.filter(r => r.role === "ai" && r.language === language).map(r => r.column);
    const generic = roles.filter(r => r.role === "ai" && !r.language).map(r => r.column);
    if (fieldRow) for (const column of columns(sheet)) {
      const m = metadata(readCell(sheet, fieldRow, column));
      if (m?.kind === "ai" && sameField(m.field, field)) {
        if (m.language === language) specific.push(column);
        else if (!m.language) generic.push(column);
      }
    }
    const ai = unique(specific), genericAI = unique(generic);
    const aiCol = ai.length === 1 ? ai[0] : !ai.length && unique(candidates.map(r => r.language)).length === 1 && genericAI.length === 1 ? genericAI[0] : 0;
    if (ai.length > 1 || (!aiCol && genericAI.length)) issues.push("目标语言 " + language + " 的 AI 列无法唯一对应，已停用 AI 采用。");
    targets.push({ language, targetCol: choices[0].column, oldCol: previous[0]?.column || 0, aiCol });
  }
  return { targets, issues, paired: pairs.length,
    referenceLanguages: unique(roles.filter(r => r.role === "reference" || (preferPairs && old.length && r.role === "current" && !pairs.includes(r))).map(r => r.language).filter(Boolean)) };
}

function flatLayout(sheet, row) {
  const roles = columns(sheet).map(column => ({ column, ...headerRole(readCell(sheet, row, column)) }));
  const sources = roles.filter(r => r.role === "source");
  const explicitKeys = roles.filter(r => r.role === "key" && !r.language);
  const keys = explicitKeys.length ? explicitKeys : roles.filter(r => r.role === "key");
  if (!sources.length || !keys.length || !roles.some(r => r.role === "current" || (r.language === "ID" && !keys.some(k => k.column === r.column)))) return null;
  if (sources.length !== 1 || keys.length !== 1) return { groups: [], score: 20, issues: ["原文列或 Key 列不唯一，请设置字段映射。"] };
  const mapping = targetMappings(sheet, row, columns(sheet).filter(c => c !== sources[0].column && c !== keys[0].column));
  const oldSources = roles.filter(r => r.role === "old-source");
  if (oldSources.length > 1) mapping.issues.push("旧原文列不唯一，已停用旧原文对照，请设置字段映射。");
  return { score: 30 + mapping.targets.length, issues: mapping.issues, groups: [{
    field: "Language", headerRow: row, fieldRow: 0, dataStartRow: row + 1,
    sourceCol: sources[0].column, oldSourceCol: oldSources.length === 1 ? oldSources[0].column : 0, keyCol: keys[0].column, baseKeyCol: 0,
    groupStart: 1, groupEnd: sheet.columns, ...mapping,
  }] };
}

function configLayout(sheet, row) {
  if (row < 2) return null;
  const fieldRow = row - 1;
  const meta = columns(sheet).map(column => ({ column, ...metadata(readCell(sheet, fieldRow, column)) })).filter(m => m.kind);
  const sourceColumns = columns(sheet).filter(column => {
    const field = readCell(sheet, fieldRow, column).trim();
    if (!field || metadata(field) || headerRole(field).role === "key" || /^(标记字段|字段解释)$/i.test(field)) return false;
    return headerRole(readCell(sheet, row, column)).role === "source"
      || meta.some(m => m.kind === "key" && sameField(m.field, field))
      || headerRole(readCell(sheet, row, column - 1)).role === "old-source";
  });
  if (!sourceColumns.length) return null;
  const starts = sourceColumns.map((column, i) => {
    const prior = sourceColumns[i - 1] || 0;
    const oldSources = columns(sheet).filter(c => c > prior && c < column && headerRole(readCell(sheet, row, c)).role === "old-source");
    return i === 0 ? 1 : oldSources.at(-1) || column;
  });
  const issues = [], groups = [];
  const baseKeys = columns(sheet).filter(c => headerRole(readCell(sheet, fieldRow, c)).role === "key" || same(readCell(sheet, fieldRow, c), "标记字段"));
  for (let index = 0; index < sourceColumns.length; index++) {
    const sourceCol = sourceColumns[index], field = readCell(sheet, fieldRow, sourceCol).trim();
    const groupStart = starts[index], groupEnd = (starts[index + 1] || sheet.columns + 1) - 1;
    const allowed = columns(sheet).filter(c => c >= groupStart && c <= groupEnd && c !== sourceCol && !metadata(readCell(sheet, fieldRow, c)));
    const mapping = targetMappings(sheet, row, allowed, { preferPairs: true, field, fieldRow });
    const keys = meta.filter(m => m.kind === "key" && sameField(m.field, field));
    if (keys.length > 1) { issues.push(field + "：字段映射重复，请明确完整 Key 列。"); continue; }
    const oldSources = allowed.filter(c => headerRole(readCell(sheet, row, c)).role === "old-source");
    if (oldSources.length > 1) issues.push(field + "：旧原文列不唯一，已停用旧原文对照，请设置字段映射。");
    const explicitSource = headerRole(readCell(sheet, row, sourceCol)).role === "source";
    // 非标准原文表头必须有旧原文锚点及旧/新目标配对；不猜测任意说明列。
    if (!explicitSource && (!oldSources.length || !mapping.paired || (!keys.length && !baseKeys.length))) {
      issues.push(field + "：原文表头与 Key/旧新译文关系无法唯一确定，请设置字段映射。"); continue;
    }
    if (!mapping.targets.length) { issues.push(field + "：未找到匹配的旧/新目标语言列，请设置字段映射。"); continue; }
    if (!keys.length && baseKeys.length !== 1) { issues.push(field + "：无法唯一确定 Key 或基础 Id 列，请设置字段映射。"); continue; }
    groups.push({ field, headerRow: row, fieldRow, dataStartRow: row + 1, sourceCol, keyCol: keys[0]?.column || 0,
      oldSourceCol: oldSources.length === 1 ? oldSources[0] : 0,
      baseKeyCol: baseKeys.length === 1 ? baseKeys[0] : 0, groupStart, groupEnd, ...mapping });
    issues.push(...mapping.issues.map(issue => field + "：" + issue));
  }
  return { score: groups.length * 10 + (meta.length ? 15 : 0), groups, issues };
}

export function schemaSignature(sheet, headerRow) {
  const hasFieldMetadata = headerRow > 1 && (sheet.values[headerRow - 2] || []).some(value => metadata(value));
  return JSON.stringify({ headerRow, columns: sheet.columns,
    headers: sheet.values.slice(Math.max(0, headerRow - (hasFieldMetadata ? 2 : 1)), headerRow).map(row => columns(sheet).map(c => normalizeHeader(row[c - 1]))) });
}

export function createManualProfile(sheet, entry, existing = null) {
  const e = { ...entry, language: canonicalLanguage(entry.language) };
  for (const name of ["headerRow", "dataStartRow", "sourceCol", "oldSourceCol", "targetCol", "keyCol", "oldCol", "aiCol"]) e[name] = Number(e[name] || 0);
  if (!e.language) throw new Error("请填写目标语种代码或语言名，例如 FR、pt-BR、Korean。");
  if (!Number.isInteger(e.headerRow) || e.headerRow < 1 || e.headerRow > sheet.rows) throw new Error("表头行超出工作表范围。");
  if (!Number.isInteger(e.dataStartRow) || e.dataStartRow <= e.headerRow || e.dataStartRow > sheet.rows + 1) throw new Error("数据起始行必须在表头之后。");
  const used = [e.sourceCol, e.oldSourceCol, e.targetCol, e.keyCol, e.oldCol, e.aiCol].filter(Boolean);
  if (!e.sourceCol || !e.targetCol || !e.keyCol || used.some(c => !Number.isInteger(c) || c < 1 || c > sheet.columns) || unique(used).length !== used.length) {
    throw new Error("请选择不同的 Key、原文和新译文列；旧译文及 AI 列可留空，但不能与其他角色重复。");
  }
  e.field = text(e.field).trim() || "手动映射";
  const signature = schemaSignature(sheet, e.headerRow);
  const entries = existing?.signature === signature ? existing.entries.filter(item => !(item.sourceCol === e.sourceCol && item.language === e.language)) : [];
  for (const other of entries) {
    const protectedOther = [other.sourceCol, other.oldSourceCol, other.keyCol, other.oldCol, other.aiCol].filter(Boolean);
    const protectedNew = [e.sourceCol, e.oldSourceCol, e.keyCol, e.oldCol, e.aiCol].filter(Boolean);
    if (other.targetCol === e.targetCol || protectedOther.includes(e.targetCol) || protectedNew.includes(other.targetCol)) {
      throw new Error("字段映射相互冲突：新译文列不能与其他字段的新译文、原文、Key、旧译文或 AI 列重叠。");
    }
  }
  return { signature, headerRow: e.headerRow, entries: [...entries, e] };
}

function manualGroups(sheet, profile) {
  // 存储配置仍走相同的列冲突/范围检查，不信任浏览器缓存中的任意数据。
  const validated = profile.entries.reduce((result, entry) => createManualProfile(sheet, entry, result), null);
  if (!validated || validated.entries.length !== profile.entries.length) throw new Error("缓存中的字段映射重复或为空，请重新设置。");
  return validated.entries.map(checked => {
    return { field: checked.field, headerRow: checked.headerRow, fieldRow: 0, dataStartRow: checked.dataStartRow,
      sourceCol: checked.sourceCol, oldSourceCol: checked.oldSourceCol, keyCol: checked.keyCol, baseKeyCol: 0, groupStart: checked.sourceCol, groupEnd: checked.targetCol,
      referenceLanguages: [], targets: [{ language: checked.language, targetCol: checked.targetCol, oldCol: checked.oldCol, aiCol: checked.aiCol }] };
  });
}

export function inspectWorkbook(sheets, profiles = []) {
  const groups = [], diagnostics = [];
  for (const sheet of sheets) {
    if (sheet.error) { diagnostics.push(sheet.name + "：" + sheet.error); continue; }
    if (!sheet.rows || sheet.name === "总览") continue;
    const manual = profiles.filter(p => p?.headerRow && p.signature === schemaSignature(sheet, p.headerRow));
    if (manual.length) {
      try {
        if (manual.length !== 1) throw new Error("有多个可匹配的手动配置，请在识别设置中清除后重新映射。");
        groups.push(...manualGroups(sheet, manual[0]).map(g => ({ ...g, sheet: sheet.name, manual: true })));
      } catch (error) { diagnostics.push(sheet.name + "：" + error.message); }
      continue;
    }
    const candidates = [];
    for (let row = 1; row <= Math.min(12, sheet.rows); row++) {
      const flat = flatLayout(sheet, row);
      if (flat) candidates.push(flat);
      const config = configLayout(sheet, row);
      if (config && (config.groups.length || config.issues.length)) candidates.push(config);
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) { if (sheet.rows > 1) diagnostics.push(sheet.name + "：未找到可确认的 Key、原文和目标语言关系，请展开“识别设置”映射一次。"); continue; }
    if (candidates[1]?.score === best.score && JSON.stringify(best.groups) !== JSON.stringify(candidates[1].groups)) {
      diagnostics.push(sheet.name + "：存在多个同等可信的表头结构，请设置字段映射。"); continue;
    }
    groups.push(...best.groups.map(g => ({ ...g, sheet: sheet.name, manual: false })));
    diagnostics.push(...best.issues.map(issue => sheet.name + "：" + issue));
  }
  const languages = unique(groups.flatMap(g => g.targets.map(t => t.language)));
  return { groups, languages, diagnostics };
}
