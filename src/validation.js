// 对齐 LocalizationWorkbench/Services/ProtectedTextService.cs。
// 保留工作台的片段语法与自闭合标签集合；本插件允许译文新增字面量 \\n。
const selfClosing = new Set(["br", "sprite", "space", "quad", "page", "nobr"]);

export function extractTokens(text) {
  return String(text ?? "").match(/\{[^{}\r\n]+\}|%(?:\d+\$)?[sdifuxX]|<\/?[A-Za-z][^<>\r\n]*?>|\\n/g) ?? [];
}

export function validateText(source, target) {
  const expected = extractTokens(source);
  const actual = extractTokens(target);
  const counts = new Map();
  actual.forEach(t => counts.set(t, (counts.get(t) ?? 0) + 1));
  const missing = [];
  for (const token of expected) {
    if ((counts.get(token) ?? 0) > 0) counts.set(token, counts.get(token) - 1);
    else missing.push(token);
  }
  const extra = [];
  counts.forEach((count, token) => {
    if (token === "\\n") return; // 译文可按排版需要增加换行，不作为多余片段。
    for (let i = 0; i < count; i++) extra.push(token);
  });
  const errors = [];
  for (const [tokens, direction, prefix] of [[missing, "少", "缺少受保护片段："], [extra, "多", "新增或修改了受保护片段："]]) {
    const newlineCount = tokens.filter(token => token === "\\n").length;
    if (newlineCount) errors.push("译文比原文" + direction + "了 " + newlineCount + " 个换行标记 \\n（反斜杠 + n，不是单元格实际换行）");
    const others = tokens.filter(token => token !== "\\n");
    if (others.length) errors.push(prefix + others.join(" "));
  }
  const stack = [];
  for (const token of actual.filter(t => t.startsWith("<"))) {
    const name = /^<\/?\s*([A-Za-z][A-Za-z0-9]*)/.exec(token)?.[1]?.toLowerCase();
    if (!name || token.endsWith("/>") || selfClosing.has(name)) continue;
    if (!token.startsWith("</")) stack.push(name);
    else if (stack.at(-1) === name) stack.pop();
    else errors.push("富文本标签闭合顺序错误：" + token);
  }
  while (stack.length) errors.push("富文本标签未闭合：<" + stack.pop() + ">");
  return errors;
}

export function text(value) { return value == null ? "" : String(value); }
export function isBlank(value) { return text(value).trim() === ""; }
