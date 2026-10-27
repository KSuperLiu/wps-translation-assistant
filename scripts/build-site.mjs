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
  let html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  for (const file of ['app.js', 'style.css']) html = html.replace('./' + file, './' + file + '?v=' + hash(fs.readFileSync(path.join(output, file))).slice(0, 12));
  fs.writeFileSync(path.join(output, 'index.html'), html);
  fs.copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'));
  fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(output, '.nojekyll'), '');
  fs.writeFileSync(path.join(output, 'publish.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./"><title>WPS 翻译助手</title><a href="./">前往安装与更新页面</a>');
  fs.writeFileSync(path.join(output, '更新说明.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"><title>更新说明 · WPS 翻译助手</title><main class="shell" style="display:block;padding-top:40px"><a href="./">← 返回安装页面</a><h1>v' + pkg.version + '</h1><p>插件侧栏显示当前版本，新增“检查更新”；发现新版后可直接打开更新网站。检查仅在点击时联网，不上传表格内容。</p><p>保留通用语种与表结构识别、占位符/TMP 标签校验、问题定位、填写进度、表内 AI 建议采用及撤销。</p><p>旧 Windows EXE 版请先在系统应用列表卸载一次，之后统一通过此网站管理。网页升级使用 WPS 标准版本目录；识别设置受本机浏览器存储和 WPS 缓存策略影响。</p><p>更多版本记录请查看 <a href="https://github.com/KSuperLiu/wps-translation-assistant">项目 README</a>。</p></main></html>');
  console.log('网站资源已生成：' + output);
  console.log('插件包：' + manifest.package + ' (' + manifest.size + ' bytes) SHA-256: ' + manifest.sha256);
} finally {
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('wps-web-release-')) fs.rmSync(resolved, { recursive: true, force: true });
}
