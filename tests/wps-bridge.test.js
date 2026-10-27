import test from 'node:test';
import assert from 'node:assert/strict';
import { createWpsBridge } from '../website/wps-bridge.js';

test('本机连接只访问 WPS HTTP 回环接口，不携带凭据或忽略证书', async () => {
  const calls = [];
  const bridge = createWpsBridge(async (url, options) => {
    calls.push([url, options]);
    return new Response(url.endsWith('/version') ? '1.0.3' : url.endsWith('/isRunning') ? 'Client is not running.' : '[]');
  });
  await bridge.connect(); assert.deepEqual(await bridge.getAllConfig(), { status: 0, response: '[]' });
  assert.equal(await bridge.isRunning(), false);
  assert.deepEqual(calls.map(([url]) => url), ['http://127.0.0.1:58890/version', 'http://127.0.0.1:58890/publishlist', 'http://127.0.0.1:58890/isRunning']);
  for (const [, options] of calls) { assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); }
});
test('安装与卸载遵循 WPS base64 JSON 协议并只投递本插件', async () => {
  let sent;
  const bridge = createWpsBridge(async (url, options) => { sent = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(options.body), c => c.charCodeAt(0)))); return new Response('OK'); });
  const config = { name: 'WpsTranslationAssistant', addonType: 'et', online: 'false', version: '1.2.0', url: 'https://example.test/test.7z' };
  await bridge.deploy('enable', config); assert.equal(sent.cmd, 'enable'); assert.equal(sent.url, config.url);
  await bridge.deploy('disable', config); assert.equal(sent.cmd, 'disable'); assert.equal(sent.name, config.name);
  await assert.rejects(bridge.deploy('disableall', config));
  await assert.rejects(bridge.deploy('disable', { ...config, name: 'Other' }));
});
test('未知进程状态不能默认为已关闭，未确认的写操作保留 pending 提示', async () => {
  await assert.rejects(createWpsBridge(async () => new Response('unknown')).isRunning());
  await assert.rejects(createWpsBridge(async () => new Response('unknown')).connect());
  await assert.rejects(createWpsBridge(async () => { throw new Error('network'); }).deploy('enable', { name: 'WpsTranslationAssistant', addonType: 'et' }), error => error.pending === true);
});
