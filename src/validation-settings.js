const storageKey = "WpsTranslationAssistant.validationSettings.v1";
export function loadValidationSettings(storage) {
  try {
    const saved = JSON.parse(storage.getItem(storageKey) || "null");
    return { checkNewlines: saved?.checkNewlines !== false };
  } catch { return { checkNewlines: true }; }
}

export function setupValidationSettings({ getStorage, changed, document = globalThis.document }) {
  let value = { checkNewlines: true };
  try { value = loadValidationSettings(getStorage()); } catch { /* 存储不可用时默认开启。 */ }
  const control = document.getElementById("check-newlines"), status = document.getElementById("validation-settings-status");
  control.checked = value.checkNewlines;
  control.onchange = async () => {
    value = { checkNewlines: control.checked };
    control.disabled = true;
    let saved = false;
    try { getStorage().setItem(storageKey, JSON.stringify(value)); saved = true; } catch { /* 本次会话仍生效。 */ }
    status.hidden = false;
    const description = (value.checkNewlines ? "已开启换行标记检查。" : "已关闭换行标记检查。")
      + (saved ? "设置已保存在本机。" : "无法保存设置，仅在本次窗格会话生效。");
    status.textContent = description + "正在更新检查结果…";
    try {
      await changed(value);
      status.textContent = description + "检查结果已更新。";
    } catch {
      status.textContent = description + "检查结果未能更新，请重新识别工作簿。";
    } finally { control.disabled = false; }
  };
  return { get value() { return value; } };
}
