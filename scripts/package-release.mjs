import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const cliPath = path.resolve(path.dirname(require.resolve("wpsjs/vite_plugins")), "..");
const sevenZip = require("7zip-bin").path7za;
const output = path.join(root, "release");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "wps-translation-release-"));
fs.mkdirSync(output, { recursive: true });
const packageFile = path.join(output, pkg.name + ".7z");
try {
  const folder = pkg.name + "_" + pkg.version;
  fs.cpSync(path.join(root, "dist"), path.join(staging, folder), { recursive: true });
  // 仅重建本项目明确命名的发布包，不移除整个发布目录。
  fs.rmSync(packageFile, { force: true });
  const result = spawnSync(sevenZip, ["a", packageFile, folder], { cwd: staging, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "7z 打包失败");
  const template = fs.readFileSync(path.join(cliPath, "src/lib/res/publish.html"), "utf8");
  if (!template.includes("PUBLISH_REPLACE_STRING") || !template.includes("SERVERID_REPLEASE_STRING")) throw new Error("wpsjs 发布页面模板已变化，请检查兼容性。");
  const config = `[{name:${JSON.stringify(pkg.name)},addonType:"et",online:"false",multiUser:"false",version:${JSON.stringify(pkg.version)},url:new URL(${JSON.stringify(pkg.name + ".7z")},window.location.href).href}]`;
  fs.writeFileSync(path.join(output, "publish.html"), template
    .replace("PUBLISH_REPLACE_STRING", config).replace("SERVERID_REPLEASE_STRING", "undefined"), "utf8");
  fs.writeFileSync(path.join(output, "安装说明.txt"), [
    "WPS 翻译助手 " + pkg.version,
    "",
    "管理员部署：将此目录的所有文件放到同一个 HTTP/HTTPS 静态网站目录（公司内网也可以）。",
    "例如：https://your-company.example/translation-assistant/publish.html",
    "安装页面自动使用同目录 WpsTranslationAssistant.7z 的地址，无需手工修改域名。",
    "请配置服务器允许下载 .7z 文件，不能把压缩包请求重定向到登录页。",
    "请用浏览器验证 .7z 能正常下载。此压缩包无需由用户手工解压。",
    "",
    "翻译人员安装：",
    "1. 安装支持 JavaScript 加载项的 Windows WPS Office。",
    "2. 用浏览器访问管理员提供的 publish.html，按页面检查并安装/启用。",
    "3. 保存工作，正常关闭全部 WPS 表格窗口，再重新打开翻译表。",
    "4. 在“翻译助手”选项卡点击“打开助手”。",
    "",
    "使用者不需要 Node.js、npm 或 .NET。安装时需要访问上述网站；此插件安装后从本地运行。",
    "本版本仅本机处理表格数据，不调用 AI 模型；AI 建议来自表内已有的 AI 列。",
    "如果页面显示 WPS 不可用，请检查版本与企业策略，联系管理员处理。",
    "卸载：返回同一个发布页面，选择卸载/禁用，然后重新打开 WPS。",
    "本目录为发布资源包；开发源码另行提供。仅解压本目录并不会完成安装。",
    "",
  ].join("\r\n"), "utf8");
  console.log("发布资源已生成：" + output);
  console.log("部署整个 release 目录，再向使用者分发 publish.html 的访问地址。");
} finally {
  const resolvedStage = path.resolve(staging), intendedTemp = path.resolve(os.tmpdir()) + path.sep;
  if (resolvedStage.startsWith(intendedTemp) && path.basename(resolvedStage).startsWith("wps-translation-release-")) fs.rmSync(resolvedStage, { recursive: true, force: true });
}
