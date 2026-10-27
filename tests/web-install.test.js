import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { product, compareVersions, readManifest, readLocalConfig, installationState, deploymentConfig, verifyPackage, changeInstallation } from '../website/install-model.js';

const base = 'https://example.test/wps/';
const bytes = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 1, 2]);
const raw = { name: product, addonType: 'et', online: 'false', version: '1.2.0', package: 'packages/test.7z', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
const manifest = readManifest(raw, base);
const own = (version = '1.1.0') => ({ name: product, addonType: 'et', online: 'false', version, url: 'https://old.test/plugin.7z' });
const result = entries => ({ status: 0, response: JSON.stringify(entries) });
const operations = overrides => ({ manifest, entry: own(), remove: false, confirmed: true, isRunning: async () => false,
  verify: async () => {}, deploy: async () => ({ status: 0, response: 'OK' }), ...overrides });

test('网页发布仅接受同站点目录中的离线资源', () => {
  assert.equal(manifest.url, base + 'packages/test.7z');
  for (const change of [{ package: 'https://elsewhere.test/x.7z' }, { package: '../outside.7z' }, { package: 'x.exe' }, { package: 'x.7z?latest=1' }, { sha256: 'wrong' }, { name: 'Other' }, { version: 'latest' }, { size: -1 }, { online: 'true' }]) assert.throws(() => readManifest({ ...raw, ...change }, base));
});
test('版本使用数字比较并拒绝未知格式', () => {
  assert.equal(compareVersions('1.10.0', '1.2.0'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.throws(() => compareVersions('unknown', '1.2.0'));
});
test('只识别本翻译助手的表格入口，同名文字与其他插件不受影响', () => {
  assert.deepEqual(readLocalConfig(result([{ name: 'Other', addonType: 'et' }, { ...own(), addonType: 'wps' }, own()])), own());
  assert.equal(readLocalConfig(result(null)), null);
  assert.equal(readLocalConfig(result([{ ...own(), enable: 'false' }])), null);
  assert.throws(() => readLocalConfig(result([own(), own()])), /多个/);
  assert.throws(() => readLocalConfig({ status: 0, response: 'not-json' }));
  assert.throws(() => readLocalConfig({ status: 2, message: 'failed' }));
});
test('区分初装、旧版更新、同版重装、新版保护和开发版迁移', () => {
  assert.equal(installationState(null, manifest).kind, 'absent');
  assert.equal(installationState(own(), manifest).kind, 'outdated');
  assert.equal(installationState(own('1.2.0'), manifest).kind, 'current');
  assert.equal(installationState(own('2.0.0'), manifest).canInstall, false);
  assert.equal(installationState({ ...own(), online: 'true', version: '' }, manifest).kind, 'development');
});
test('识别 EXE 容器并阻止网页混装或残留 Windows 卸载项', async () => {
  for (const url of ['WpsTranslationAssistant_1.0.0', 'C:/data/WpsTranslationAssistant_1.0.0']) {
    const entry = { ...own('1.0.0'), url };
    assert.equal(installationState(entry, manifest).kind, 'native');
    await assert.rejects(changeInstallation(operations({ entry })), /不允许/);
    await assert.rejects(changeInstallation(operations({ entry, remove: true })), /不允许/);
  }
});
test('资源校验通过后才调用 WPS，升级没有先卸载旧版本', async () => {
  const calls = [];
  await changeInstallation(operations({ verify: async () => calls.push('verify'), deploy: async (method, config) => {
    calls.push(method); assert.deepEqual(config, deploymentConfig(manifest)); return { status: 0, response: 'OK' };
  } }));
  assert.deepEqual(calls, ['verify', 'enable']);
});
test('未确认关闭、WPS 运行、校验失败或降级均不会调用安装接口', async () => {
  let writes = 0;
  for (const override of [{ confirmed: false }, { isRunning: async () => true }, { verify: async () => { throw new Error('bad hash'); } }, { entry: own('2.0.0') }]) {
    await assert.rejects(changeInstallation(operations({ ...override, deploy: async () => { writes++; } })));
  }
  assert.equal(writes, 0);
});
test('卸载仅停用当前本插件，不调用 disableall 或下载资源', async () => {
  const calls = [];
  await changeInstallation(operations({ remove: true, verify: async () => { throw new Error('卸载不该下载'); }, deploy: async (method, config) => {
    calls.push(method); assert.equal(config.name, product); assert.equal(config.url, own().url); return { status: 0, response: 'OK' };
  } }));
  assert.deepEqual(calls, ['disable']);
});
test('WPS 错误或未知回执不能报告安装成功', async () => {
  for (const answer of [{ status: 1, response: 'OK' }, { status: 0, response: 'Failed' }, null]) await assert.rejects(changeInstallation(operations({ deploy: async () => answer })));
});
test('检查 7z 文件头、长度与 SHA-256，拦截坏包与失败下载', async () => {
  const fetcher = data => async () => new Response(data);
  await verifyPackage(manifest, fetcher(bytes), webcrypto.subtle);
  await assert.rejects(verifyPackage(manifest, fetcher(Buffer.alloc(bytes.length)), webcrypto.subtle), /格式/);
  const changed = Buffer.from(bytes); changed[7] = 3;
  await assert.rejects(verifyPackage(manifest, fetcher(changed), webcrypto.subtle), /校验失败/);
  await assert.rejects(verifyPackage(manifest, async () => new Response('', { status: 404 }), webcrypto.subtle), /404/);
});
