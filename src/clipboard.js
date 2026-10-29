// WPS 本地加载项可能没有 Clipboard API，保留浏览器复制命令作为兼容路径。
export async function copyText(text, { navigator = globalThis.navigator, document = globalThis.document } = {}) {
  if (typeof text !== "string" || !text.length) throw new Error("没有可复制的 Key。");
  try {
    if (typeof navigator?.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* 权限受限时尝试本地加载项的复制命令。 */ }
  const active = document?.activeElement;
  let input;
  try {
    input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.cssText = "position:fixed;left:-9999px;top:0;min-height:0;opacity:0";
    document.body.append(input);
    input.focus({ preventScroll: true });
    input.select();
    if (!document.execCommand("copy")) throw new Error("复制命令未成功。");
  } catch {
    throw new Error("未能复制，请选中 Key 后按 Ctrl+C。");
  } finally {
    input?.remove();
    try { active?.focus({ preventScroll: true }); } catch { /* 不影响复制结果。 */ }
  }
}
