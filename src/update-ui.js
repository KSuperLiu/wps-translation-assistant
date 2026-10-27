import { checkForUpdates, openUpdateWebsite } from "./updates.js";

export function setupUpdateControls({ version, app, document: doc = document, check = checkForUpdates, open = openUpdateWebsite }) {
  const $ = id => doc.getElementById(id);
  const button = $("check-updates"), status = $("update-status"), site = $("open-update-site"), fallback = $("update-link-fallback");
  let checking = false;
  $("current-version").textContent = "当前版本 v" + version;
  function show(text, kind = "") { status.hidden = false; status.textContent = text; status.dataset.kind = kind; }
  button.onclick = async () => {
    if (checking) return;
    checking = true; button.disabled = true; button.textContent = "正在检查…";
    site.hidden = true; fallback.hidden = true; show("正在检查更新…");
    try {
      const result = await check(version);
      if (result.status === "available") {
        show("发现新版本 v" + result.latestVersion + "。请先保存工作，再到更新网站操作。", "available");
        site.hidden = false;
      } else if (result.status === "current") show("当前已是最新版本（v" + version + "）。", "current");
      else show("当前版本 v" + version + " 高于网站版本 v" + result.latestVersion + "，无需更新。", "current");
    } catch (error) {
      show(error.message || "检查更新失败，请稍后重试。", "error");
      site.hidden = false;
    } finally {
      checking = false; button.disabled = false; button.textContent = "检查更新";
    }
  };
  site.onclick = () => {
    try { open(app); }
    catch {
      show("未能自动打开浏览器，请点击或复制下方网址。", "error");
      fallback.hidden = false;
    }
  };
}
