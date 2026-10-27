import { readManifest, installationState, verifyPackage } from './install-model.js';
import { createWpsBridge } from './wps-bridge.js';
import { createInstallerController, primaryAction } from './installer-controller.js';

const $ = id => document.getElementById(id);
let manifest, controller;
function render(state) {
  const local = state.connected ? installationState(state.entry, manifest) : null;
  const primary = primaryAction(state, manifest);
  $('primary').textContent = primary.label; $('primary').disabled = primary.disabled;
  $('message').textContent = state.message; $('message').dataset.type = state.tone;
  $('local').textContent = state.connected ? state.entry ? local.kind === 'native' ? '旧版安装器' : local.kind === 'development' ? '开发版' : '已安装 v' + state.entry.version : '尚未安装' : '自动连接本机 WPS';
  $('migration').hidden = local?.kind !== 'native';
  $('cancel').hidden = state.phase !== 'waiting';
  $('refresh').disabled = state.busy;
  $('repair').disabled = state.busy || state.uncertain || local?.kind !== 'current';
  $('remove').disabled = state.busy || state.uncertain || !local?.canRemove;
}
try {
  const response = await fetch('./latest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('版本信息暂不可用，请刷新页面重试。');
  manifest = readManifest(await response.json(), new URL('./', location.href));
  $('latest').textContent = '最新 v' + manifest.version;
  controller = createInstallerController({ manifest, bridge: createWpsBridge(), verify: verifyPackage,
    startService: () => { window.location.href = 'ksoWPSCloudSvr://start=RelayHttpServer'; },
    notify: render, confirmRemove: () => window.confirm('确定卸载 WPS 翻译助手？翻译工作簿和其他插件不受影响。') });
  $('primary').onclick = controller.install;
  $('cancel').onclick = controller.cancelWait;
  $('refresh').onclick = controller.detect;
  $('repair').onclick = controller.repair;
  $('remove').onclick = controller.remove;
  await controller.detect();
} catch (error) {
  $('message').textContent = error.message; $('message').dataset.type = 'error';
  $('primary').textContent = '请刷新页面重试'; $('primary').disabled = false;
  $('primary').onclick = () => window.location.reload();
}