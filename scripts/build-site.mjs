import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { compareVersions } from '../website/install-model.js';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
compareVersions(pkg.version, pkg.version);
const output = path.join(root, 'site-dist'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-web-release-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sevenZip = require('7zip-bin').path7za;
function run(args) {
  const result = spawnSync(sevenZip, args, { cwd: temp, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || '7z 打包失败');
}
try {
  // 只清理本项目固定的构建输出和本次创建的临时目录。
  if (path.dirname(output) !== root || path.basename(output) !== 'site-dist') throw new Error('构建输出路径异常');
  fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(path.join(output, 'packages'), { recursive: true });
  const folder = pkg.name + '_' + pkg.version;
  fs.cpSync(path.join(root, 'dist'), path.join(temp, folder), { recursive: true });
  const filename = pkg.name + '-' + pkg.version + '.7z', archive = path.join(output, 'packages', filename);
  run(['a', '-t7z', '-mx=9', '-mtc=off', '-mta=off', '-mtm=off', archive, folder]);
  run(['t', archive]);
  const bytes = fs.readFileSync(archive);
  const manifest = { name: pkg.name, addonType: 'et', online: 'false', version: pkg.version,
    package: 'packages/' + filename, sha256: hash(bytes), size: bytes.length };
  // 一个业务版本只对应一个资源包，避免 WPS 缓存同版旧资源却显示已更新。
  if (process.env.SITE_BASE_URL) {
    const response = await fetch(new URL('latest.json', process.env.SITE_BASE_URL), { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (response.ok) {
      const previous = await response.json(), comparison = compareVersions(pkg.version, previous.version);
      if (comparison < 0 || (comparison === 0 && manifest.sha256 !== previous.sha256)) throw new Error('线上已存在相同或更高版本的其他资源，请先递增 package.json 的版本号，再重新发布。');
    } else if (response.status !== 404) throw new Error('无法核对线上版本：HTTP ' + response.status);
  }
  fs.cpSync(path.join(root, 'website'), output, { recursive: true });
  // Pages 静态资源有浏览器缓存。界面更新独立于插件版本，以内容哈希刷新入口与其模块依赖。
  for (const script of ['installer-controller.js', 'app.js']) {
    let source = fs.readFileSync(path.join(output, script), 'utf8');
    for (const module of ['install-model.js', 'wps-bridge.js', 'installer-controller.js']) {
      if (module !== script) source = source.replace('./' + module, './' + module + '?v=' + hash(fs.readFileSync(path.join(output, module))).slice(0, 12));
    }
    fs.writeFileSync(path.join(output, script), source);
  }
  for (const page of ['index.html', 'guide.html']) {
    let html = fs.readFileSync(path.join(output, page), 'utf8').replaceAll('{{APP_VERSION}}', pkg.version);
    for (const file of ['app.js', 'style.css', 'guide.css']) html = html.replace('./' + file, './' + file + '?v=' + hash(fs.readFileSync(path.join(output, file))).slice(0, 12));
    fs.writeFileSync(path.join(output, page), html);
  }
  fs.copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'));
  fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(output, '.nojekyll'), '');
  fs.writeFileSync(path.join(output, 'publish.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./"><title>WPS 翻译助手</title><a href="./">前往安装与更新页面</a>');
  fs.writeFileSync(path.join(output, '更新说明.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"><title>更新说明 · WPS 翻译助手</title><main class="shell" style="display:block;padding-top:40px"><a href="./">← 返回安装页面</a><h1>v' + pkg.version + '</h1><p>新增在线 AI：支持 LiteLLM、统一网关和厂商官方 Key；可读取模型列表、生成当前条目译文并载入草稿。AI 配置直接粘贴 AI Key / LiteLLM 虚拟 Key，地址、模型和 Key 都保存在本机，重新打开自动恢复，可随时清除保存的 Key。配置方法见使用文档。</p><p>优化单条写入和单条 AI 采用：写入前后只读取当前工作表，并增量更新检查结果，不再反复扫描整个工作簿；仍核对位置、表头、Key、原文、AI、当前译文及同表重复 Key。首次识别、手动重新识别和交付检查仍检查全工作簿。</p><p>“下一条待处理”优先定位当前筛选范围内未填写译文的条目，没有空译文后再定位已有译文的校验问题；写入后跳转也使用相同顺序。</p><p>修复大表切换检查选项时勾选显示延迟：立即显示开关与更新状态，分批重算检查结果，不再重新识别整表；保留草稿、条目位置和撤销记录。</p><p>新增“更多 → 检查设置”中的换行标记检查开关，默认开启并记住本机选择。开启时检查新增和遗漏，关闭时忽略反斜杠加 n 的数量差异；切换立即更新译文、草稿、AI 建议和交付检查，其他检查不受影响。</p><p>重复 Key 只检查当前工作表中的完整 Key，不跨表判重；groupName、groupDesc 等不同字段后缀按不同 Key 处理。</p><p>修复已有译文仍被归为“需补译”的问题：补译分类核对当前译文，不再因缺少旧译文误判；原文变更与格式问题仍保留检查。</p><p>“条目信息”中的完整 Key 后新增“复制”按钮，一键复制完整 Key，并提示复制结果。</p><p>移除任务列表中的“AI 建议与当前译文不同”筛选项。</p><p>精简“当前条目”：工作表、单元格、字段名和完整 Key 收进默认折叠的“条目信息”，原文直接靠前显示；仍可点击“定位译文”跳转到表格。</p><p>允许原文和译文为空；支持直接采用表内 AI 建议，写入后仍需用 WPS 保存。</p><p>更多说明见 <a href="https://github.com/KSuperLiu/wps-translation-assistant">项目 README</a>。</p></main></html>');
  console.log('网站资源已生成：' + output);
  console.log('插件包：' + manifest.package + ' (' + manifest.size + ' bytes) SHA-256: ' + manifest.sha256);
} finally {
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('wps-web-release-')) fs.rmSync(resolved, { recursive: true, force: true });
}
