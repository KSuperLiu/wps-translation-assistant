import { text } from "./validation.js";
import { address } from "./model.js";

export const pause = () => new Promise(resolve => setTimeout(resolve, 0));

// WPS 版本间可能返回零基或一基二维数组；按已知矩形尺寸识别，不丢首行/首列。
export function normalizeMatrix(raw, rows, columns) {
  if (rows === 1 && columns === 1 && !Array.isArray(raw)) return [[text(raw)]];
  if (!Array.isArray(raw)) throw new Error("当前 WPS 未返回可识别的单元格数组，请升级 WPS 后重试。");
  let source = raw;
  if (rows === 1 && !Array.isArray(raw[0]) && !Array.isArray(raw[1])) source = [raw];
  const rowOffset = source.length === rows + 1 ? 1 : 0;
  if (source.length !== rows + rowOffset) throw new Error("WPS 返回的单元格行数与读取范围不一致。");
  return Array.from({ length: rows }, (_, r) => {
    let line = source[r + rowOffset];
    if (!Array.isArray(line) && columns === 1) return [text(line)];
    if (!Array.isArray(line)) throw new Error("WPS 返回的单元格数组结构不一致。");
    const colOffset = line.length === columns + 1 ? 1 : 0;
    if (line.length !== columns + colOffset) throw new Error("WPS 返回的单元格列数与读取范围不一致。");
    return Array.from({ length: columns }, (_, c) => text(line[c + colOffset]));
  });
}

export class WpsHost {
  constructor(app) { this.app = app; }
  activeBook() {
    const book = this.app?.ActiveWorkbook;
    if (!book) throw new Error("请先在 WPS 表格中打开 LanguagePatch 翻译工作簿。");
    return book;
  }
  bookKey(book = this.activeBook()) { return text(book.FullName || book.Name); }
  assertBook(expected) {
    if (this.bookKey() !== expected) throw new Error("当前工作簿已切换，请重新识别后操作。");
  }
  sheet(name, bookKey) {
    this.assertBook(bookKey);
    return this.activeBook().Worksheets.Item(name);
  }
  async readSheet(sheet, bookKey, onProgress = () => {}) {
    const name = text(sheet.Name);
    try {
      const used = sheet.UsedRange;
      const rows = Number(used.Row) + Number(used.Rows.Count) - 1;
      const columns = Number(used.Column) + Number(used.Columns.Count) - 1;
      if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) throw new Error("无法读取有效区域。");
      if (rows > 50000 || columns > 512 || rows * columns > 1500000) {
        throw new Error("有效区域过大（" + rows + " 行 × " + columns + " 列），请清理空白区域格式后重新识别。");
      }
      const values = [];
      // 小块读取，留出界面响应时间；每块之后检查工作簿是否仍相同。
      for (let start = 1; start <= rows; start += 400) {
        this.assertBook(bookKey);
        const end = Math.min(rows, start + 399);
        const raw = sheet.Range("A" + start + ":" + address(end, columns)).Value2;
        values.push(...normalizeMatrix(raw, end - start + 1, columns));
        onProgress(name, end, rows);
        await pause();
      }
      this.assertBook(bookKey);
      return { name, rows, columns, values };
    } catch (error) {
      this.assertBook(bookKey);
      return { name, rows: 0, columns: 0, values: [], error: error.message || String(error) };
    }
  }
  async snapshot(onProgress = () => {}) {
    const book = this.activeBook(), bookKey = this.bookKey(book);
    const count = Number(book.Worksheets.Count), sheets = [];
    for (let i = 1; i <= count; i++) {
      this.assertBook(bookKey);
      const sheet = book.Worksheets.Item(i);
      onProgress("识别 " + i + "/" + count + " · " + sheet.Name);
      sheets.push(await this.readSheet(sheet, bookKey));
    }
    this.assertBook(bookKey);
    return { bookKey, name: text(book.Name), sheets };
  }
  selection() {
    const sheet = this.app.ActiveSheet, range = this.app.Selection;
    return sheet && range ? { sheet: text(sheet.Name), row: Number(range.Row), column: Number(range.Column) } : null;
  }
  locate(unit, bookKey) {
    const sheet = this.sheet(unit.sheet, bookKey);
    for (const guard of unit.guards) {
      if (text(sheet.Range(guard.cell).Value2) !== guard.value) throw new Error("条目位置或表结构已变化，请重新检查后定位。");
    }
    if (!sheet.Visible) throw new Error("目标工作表已隐藏，请先在 WPS 中取消隐藏。");
    sheet.Activate();
    sheet.Range(unit.cell).Select();
  }
  verifyUnit(unit, bookKey, expectedTarget, expectedAI = unit.ai) {
    const sheet = this.sheet(unit.sheet, bookKey);
    for (const guard of unit.guards) {
      if (text(sheet.Range(guard.cell).Value2) !== guard.value) throw new Error("表结构、Key 或原文已变化，请重新识别后操作。");
    }
    if (expectedAI !== null && unit.aiCell && text(sheet.Range(unit.aiCell).Value2) !== expectedAI) throw new Error("AI 建议已变化，请重新检查后操作。");
    const range = sheet.Range(unit.cell);
    if (text(range.Value2) !== expectedTarget) throw new Error("译文已变化，本次操作未覆盖你的新内容。");
    if (range.HasFormula) throw new Error("目标单元格含公式，已跳过：" + unit.sheet + "!" + unit.cell);
    if (range.MergeCells) throw new Error("目标单元格已合并，已跳过：" + unit.sheet + "!" + unit.cell);
    if (sheet.ProtectContents && range.Locked) throw new Error("目标单元格受保护，无法写入：" + unit.sheet + "!" + unit.cell);
    return range;
  }
  writeText(unit, bookKey, expectedTarget, value, expectedAI = unit.ai) {
    const range = this.verifyUnit(unit, bookKey, expectedTarget, expectedAI);
    const oldFormat = range.NumberFormat;
    const oldValue = range.Value2;
    let wrote = false;
    try {
      if (typeof value === "string") range.NumberFormat = "@";
      range.Value2 = value;
      wrote = true;
      if (range.HasFormula || text(range.Value2) !== text(value)) throw new Error("写入结果未通过文本核对。");
    } catch (error) {
      if (wrote) range.Value2 = oldValue;
      throw error;
    } finally {
      // 格式恢复失败不能把已写入的操作伪装为完全失败，否则会丢失撤销记录。
      try { range.NumberFormat = oldFormat; } catch { /* 内容仍可由专用撤销恢复。 */ }
    }
  }
}
