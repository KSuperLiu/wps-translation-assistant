const storageKey = "WpsTranslationAssistant.pane";
const commandKey = "WpsTranslationAssistant.command";
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("WpsTranslationAssistant") : null;

window.OnTranslationLoad = () => true;
window.OnTranslationGetImage = function (control) {
  const images = {
    TranslationOpen: "images/assistant.svg",
    TranslationScan: "images/check.svg",
    TranslationNext: "images/next-issue.svg",
    TranslationAdopt: "images/ai-adopt.svg",
  };
  return images[control.Id] || "images/assistant.svg";
};
window.OnTranslationAction = function (control) {
  try {
    const app = window.Application;
    if (!app?.ActiveWorkbook) return window.alert("请先打开翻译工作簿。");
    let pane;
    const id = app.PluginStorage.getItem(storageKey);
    if (id) { try { pane = app.GetTaskPane(id); } catch { /* 重新创建失效窗格。 */ } }
    if (!pane) {
      const url = new URL("pane.html", window.location.href);
      pane = app.CreateTaskPane(url.href);
      app.PluginStorage.setItem(storageKey, pane.ID);
      try { pane.DockPosition = 2; pane.Width = 440; } catch { /* 使用 WPS 默认尺寸。 */ }
    }
    pane.Visible = true;
    const action = { TranslationScan: "scan", TranslationNext: "next", TranslationAdopt: "adopt" }[control.Id] || "open";
    const command = JSON.stringify({ action, id: Date.now() + ":" + Math.random() });
    app.PluginStorage.setItem(commandKey, command);
    channel?.postMessage(command);
    return true;
  } catch (error) {
    window.alert("无法打开翻译助手：" + (error.message || error));
    return false;
  }
};
