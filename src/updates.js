import { compareVersions, readManifest } from "../website/install-model.js";

export const updateWebsite = "https://ksuperliu.github.io/wps-translation-assistant/";
export const updateManifestUrl = updateWebsite + "latest.json";

export async function checkForUpdates(currentVersion, { fetcher = fetch, timeoutMs = 10_000 } = {}) {
  compareVersions(currentVersion, currentVersion);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(updateManifestUrl, {
      cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) throw new Error("更新网站暂不可用（HTTP " + response.status + "），请稍后重试。");
    let manifest;
    try { manifest = readManifest(await response.json(), updateWebsite); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error("更新信息格式异常，请稍后重试或打开更新网站查看。");
    }
    const compared = compareVersions(manifest.version, currentVersion);
    return { status: compared > 0 ? "available" : compared === 0 ? "current" : "ahead", currentVersion, latestVersion: manifest.version };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("检查更新超时，请检查网络后重试。");
    if (error instanceof TypeError) throw new Error("无法连接更新网站，请检查网络后重试。");
    throw error;
  } finally { clearTimeout(timer); }
}

export function openUpdateWebsite(app) {
  // 地址固定，不执行发布清单提供的任意网址或命令，也不改变当前工作簿。
  const assist = app?.OAAssist;
  if (!assist || typeof assist.ShellExecute !== "function") throw new Error("当前 WPS 无法自动打开浏览器，请使用下方网址。");
  if (assist.ShellExecute(updateWebsite) === false) throw new Error("未能打开浏览器，请使用下方网址。");
}
