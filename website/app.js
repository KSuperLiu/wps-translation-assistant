import { readManifest, readLocalConfig, installationState, verifyPackage, changeInstallation } from './install-model.js';
import { createWpsBridge } from './wps-bridge.js';

const $ = id => document.getElementById(id);
const bridge = createWpsBridge();
let manifest, entry = null, connected = false, busy = false;
function message(text, type = '') { $('message').textContent = text; $('message').dataset.type = type; }
function render() {
  const state = manifest && connected ? installationState(entry, manifest) : null;
  $('connect').disabled = busy || !manifest;
  $('connect').textContent = connected ? '重新检查本机状态' : '连接本机 WPS';
  $('install').disabled = busy || !state?.canInstall || !$('closed').checked;
  $('install').textContent = state?.label || '安装翻译助手';
  $('remove').disabled = busy || !state?.canRemove || !$('closed').checked;
  $('migration').hidden = state?.kind !== 'native';
  $('local').textContent = connected ? entry ? state.kind === 'native' ? '旧版 Windows 安装器版本' : state.kind === 'development' ? '开发版 / 在线版' : '已安装 v' + entry.version : '未安装' : '尚未连接';
}
async function readState() {
  connected = false;
  const next = readLocalConfig(await bridge.getAllConfig());
  // 先验证版本/来源，再允许界面启用安装按钮。
  installationState(next, manifest); entry = next; connected = true;
}
$('connect').onclick = async () => {
  busy = true; render(); message('正在连接本机 WPS；请留意浏览器的打开 WPS / 本机连接提示。');
  try {
    await bridge.connect(); await readState();
    const state = installationState(entry, manifest);
    message(state.kind === 'native' ? '已检测到旧版安装器入口，请按下方说明先卸载，再重新连接。'
      : state.kind === 'newer' ? '本机版本高于网站版本，将保留本机版本。'
      : '连接成功。保存并关闭 WPS 文档后，即可安装、更新或卸载。', 'success');
  } catch (error) { connected = false; message(error.message, 'error'); }
  finally { busy = false; render(); }
};
async function operate(remove) {
  if (busy) return;
  if (remove && !window.confirm('确定从 WPS 卸载 / 停用翻译助手？翻译工作簿不会被修改，其他插件不受影响。')) return;
  busy = true; render(); message(remove ? '正在核对本机状态并卸载…' : '正在核对版本、校验资源并安装，请稍候…');
  let pending = false;
  try {
    await readState(); // 不使用页面打开时的旧配置执行安装或卸载。
    await changeInstallation({ manifest, entry, remove, confirmed: $('closed').checked, isRunning: () => bridge.isRunning(),
      verify: verifyPackage, deploy: (method, config) => bridge.deploy(method, config) });
    await readState();
    if (remove ? entry != null : entry?.version !== manifest.version) throw new Error('WPS 已响应，但本机配置尚未与预期一致。请等待后重新检查状态。');
    message(remove ? 'WPS 已确认卸载 / 停用。重新打开 WPS 后，翻译助手选项卡将消失。'
      : 'WPS 已确认安装配置。重新打开 WPS 表格，点击“翻译助手 → 打开助手”。', 'success');
    $('closed').checked = false;
  } catch (error) { pending = !!error.pending; message(error.message, 'error'); }
  finally { busy = pending; render(); }
}
$('closed').onchange = render;
$('install').onclick = () => operate(false);
$('remove').onclick = () => operate(true);

try {
  const response = await fetch('./latest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('发布版本读取失败，请稍后刷新页面。');
  manifest = readManifest(await response.json(), new URL('./', location.href));
  $('latest').textContent = '最新 v' + manifest.version; render();
} catch (error) { $('latest').textContent = '版本暂不可用'; message(error.message, 'error'); }
