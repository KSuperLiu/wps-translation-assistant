import { text } from "./validation.js";

export const normalizeHeader = value => text(value).normalize("NFKC").replace(/\uFEFF/g, "").trim().replace(/\s+/g, " ").toLowerCase();
const compact = value => normalizeHeader(value).replace(/[\s_.-]/g, "");
const aliases = new Map(Object.entries({
  jp: "JA", kr: "KO", cn: "ZH", tw: "ZH-HANT", ptbr: "PT-BR", ptpt: "PT-PT",
  中文: "ZH", 简体中文: "ZH-HANS", 简体: "ZH-HANS", 简中: "ZH-HANS", 繁體中文: "ZH-HANT", 繁体中文: "ZH-HANT", 繁中: "ZH-HANT",
  英语: "EN", 英文: "EN", 日语: "JA", 日文: "JA", 日本語: "JA", 韩语: "KO", 韩文: "KO", 한국어: "KO",
  法语: "FR", 德语: "DE", 西班牙语: "ES", 葡萄牙语: "PT", 巴西葡萄牙语: "PT-BR", 俄语: "RU", ไทย: "TH", 泰语: "TH",
  tiếngviệt: "VI", 越南语: "VI", bahasaindonesia: "ID", 印尼语: "ID", filipino: "FIL",
  english: "EN", japanese: "JA", korean: "KO", french: "FR", german: "DE", spanish: "ES", portuguese: "PT", russian: "RU",
}));
let namesReady = false;
function loadLanguageNames() {
  if (namesReady) return;
  namesReady = true;
  // 从运行时语言数据生成英文/中文语言名，不必为每个新语种增加分支。
  if (typeof Intl.DisplayNames !== "function") return;
  for (const locale of ["en", "zh-CN"]) {
    const names = new Intl.DisplayNames([locale], { type: "language", fallback: "none" });
    for (let a = 97; a <= 122; a++) for (let b = 97; b <= 122; b++) {
      const code = String.fromCharCode(a, b);
      const name = names.of(code);
      if (name) {
        aliases.set(compact(name), code.toUpperCase());
        if (locale === "en") {
          try {
            const native = new Intl.DisplayNames([code], { type: "language", fallback: "none" }).of(code);
            if (native) aliases.set(compact(native), code.toUpperCase());
          } catch { /* 缺少该语种的原生名称时仍支持标准代码。 */ }
        }
      }
    }
  }
}

export function canonicalLanguage(value) {
  let name = normalizeHeader(value);
  if (!name) return "";
  if (/^(default|translation)$/.test(name)) return name === "default" ? "Default" : "Translation";
  if (aliases.has(compact(name))) return aliases.get(compact(name));
  // 语言名后附代码，例如 Korean (ko)、葡萄牙语(pt_BR)。
  const annotated = /^(.*?)\s*\(([a-z]{2,3}(?:[-_][a-z0-9]{2,8})*)\)$/.exec(name);
  if (annotated) return canonicalLanguage(annotated[2]);
  name = name.replace(/_/g, "-");
  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(name) && !/^(old|new|key|src|ref|ai)$/.test(name)) {
    try { return Intl.getCanonicalLocales(name)[0].toUpperCase(); }
    catch { return ""; }
  }
  loadLanguageNames();
  return aliases.get(compact(name)) || "";
}

export function headerRole(value) {
  let label = normalizeHeader(value), old = false, ai = false, reference = false;
  // 限定为独立单词/分隔符，避免把 Thai 等语言名里的 ai 当成 AI。
  const remove = (regex, role) => { if (regex.test(label)) { role(); label = label.replace(regex, " ").trim(); } };
  remove(/(?:^|[\s_().-])(?:old|previous)(?=$|[\s_().-])|旧译文|旧翻译|旧版|旧/g, () => { old = true; });
  remove(/(?:^|[\s_().-])ai(?=$|[\s_().-])|ai建议|ai译文|ai翻译|机器翻译/gi, () => { ai = true; });
  remove(/(?:^|[\s_().-])(?:reference|ref)(?=$|[\s_().-])|参考译文|参考语种|参考/g, () => { reference = true; });
  label = label.replace(/(?:^|[\s_().-])(?:new|current)(?=$|[\s_().-])|目标语言|目标语种|目标译文|新译文|新翻译/g, " ")
    .replace(/^[\s_().-]+|[\s_().-]+$/g, "").trim();
  const token = compact(label);
  if (["languagekey", "key", "id", "文本key", "语言key", "键"].includes(token) && !old && !ai) return { role: "key", language: token === "id" ? "ID" : "" };
  if (["sourcetext", "source", "原文", "源文", "源文本", "中文原文"].includes(token)) return { role: old ? "old-source" : "source", language: "" };
  if (["weight", "权重", "notes", "note", "备注", "说明", "字段解释", "标记字段"].includes(token)) return { role: "other", language: "" };
  let language = canonicalLanguage(label);
  // 标准语法本身会接受 URL、SKU 等未知三字母组合，自动发现不能只靠正则。
  if (language && !["Default", "Translation"].includes(language) && typeof Intl.DisplayNames === "function") {
    try {
      const known = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(language.split("-")[0].toLowerCase());
      if (!known) language = "";
    } catch { language = ""; }
  }
  if (ai) return { role: "ai", language };
  if (reference) return { role: "reference", language };
  if (language) return { role: old ? "old" : "current", language };
  return { role: "other", language: "" };
}
