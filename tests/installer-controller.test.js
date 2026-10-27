import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstallerController, primaryAction } from '../website/installer-controller.js';

const manifest = { name: 'WpsTranslationAssistant', addonType: 'et', online: 'false', version: '1.2.2', url: 'https://example.test/plugin.7z' };
const entry = (version = '1.2.1') => ({ ...manifest, version });
function fixture(options = {}) {
  const data = { entry: options.entry ?? null, running: false, launches: 0, verifies: 0, writes: [], views: [] };
  const bridge = {
    connect: async () => {}, getAllConfig: async () => ({ status: 0, response: JSON.stringify(data.entry ? [data.entry] : []) }),
    isRunning: async () => data.running,
    deploy: async (method, config) => { data.writes.push(method); data.entry = method === 'disable' ? null : { ...config }; return { status: 0, response: 'OK' }; },
    ...options.bridge,
  };
  const controller = createInstallerController({ manifest, bridge, verify: async () => { data.verifies++; },
    startService: () => { data.launches++; }, notify: state => data.views.push(state), delay: async () => {}, ...options.controller });
  return { data, bridge, controller };
}

test('自动检测只读取状态，不自动调起 WPS、下载或安装', async () => {
  const { data, controller } = fixture(); await controller.detect();
  assert.equal(controller.getState().connected, true);
  assert.equal(primaryAction(controller.getState(), manifest).label, '安装到 WPS');
  assert.equal(data.launches, 0); assert.equal(data.verifies, 0); assert.deepEqual(data.writes, []);
});
test('主按钮区分安装、更新、最新版本与降级保护', async () => {
  for (const [local, label, disabled] of [[null, '安装到 WPS', false], [entry(), '更新到 v1.2.2', false], [entry('1.2.2'), '已是最新版本', true], [entry('2.0.0'), '本机版本更新，无需操作', true]]) {
    const { controller } = fixture({ entry: local }); await controller.detect();
    assert.deepEqual(primaryAction(controller.getState(), manifest), { label, disabled });
  }
});
test('一次点击完成连接、校验、安装和状态确认，无需勾选框', async () => {
  const { controller, data } = fixture(); await controller.detect(); await controller.install();
  assert.deepEqual(data.writes, ['enable']); assert.equal(data.verifies, 1);
  assert.equal(controller.getState().entry.version, '1.2.2');
  assert.match(controller.getState().message, /设置好了/);
});
test('WPS 服务未启动时，检测不调起，用户点击后自动调起并重试连接', async () => {
  let ready = false;
  const { controller, data } = fixture({ bridge: { connect: async () => { if (!ready) throw new Error('offline'); } }, controller: { delay: async () => { ready = true; } } });
  await controller.detect(); assert.equal(data.launches, 0);
  await controller.install(); assert.equal(data.launches, 1); assert.deepEqual(data.writes, ['enable']);
});
test('WPS 正在编辑时等待退出，再自动继续；不会在运行时写配置', async () => {
  const { controller, data } = fixture({ controller: { delay: async () => { assert.deepEqual(data.writes, []); data.running = false; } } });
  data.running = true; await controller.install();
  assert.ok(data.views.some(state => state.phase === 'waiting')); assert.deepEqual(data.writes, ['enable']);
});
test('取消等待后不会延迟安装，之后可以重新点击', async () => {
  let controller, data;
  ({ controller, data } = fixture({ controller: { delay: async () => { controller.cancelWait(); } } }));
  data.running = true; await controller.install();
  assert.deepEqual(data.writes, []); assert.match(controller.getState().message, /已取消/);
  data.running = false; await controller.install(); assert.deepEqual(data.writes, ['enable']);
});
test('等待超时后停止，不会强制安装', async () => {
  const { controller, data } = fixture({ controller: { closeAttempts: 2 } });
  data.running = true; await controller.install();
  assert.deepEqual(data.writes, []); assert.match(controller.getState().message, /还没有检测到 WPS 退出/);
});
test('正在处理时重复点击不会再提交', async () => {
  let release;
  const { controller, data } = fixture({ bridge: { connect: () => new Promise(resolve => { release = resolve; }) } });
  const operation = controller.install(); await controller.install(); release(); await operation;
  assert.deepEqual(data.writes, ['enable']);
});
test('本机已是最新时不重复安装，重新安装需要独立操作', async () => {
  const { controller, data } = fixture({ entry: entry('1.2.2') });
  await controller.install(); assert.deepEqual(data.writes, []);
  await controller.repair(); assert.deepEqual(data.writes, ['enable']);
});
test('未知配置与旧 EXE 容器不会被自动覆盖', async () => {
  const native = fixture({ entry: { ...entry('1.0.0'), url: 'WpsTranslationAssistant_1.0.0' } });
  await native.controller.install(); assert.deepEqual(native.data.writes, []); assert.match(native.controller.getState().message, /EXE/);
  const broken = fixture({ bridge: { getAllConfig: async () => ({ status: 0, response: '<broken>' }) } });
  await broken.controller.install(); assert.deepEqual(broken.data.writes, []); assert.match(broken.controller.getState().message, /解析/); assert.equal(broken.data.launches, 0);
});
test('核对时已被其他操作更新的条目不会再次提交', async () => {
  const { controller, data } = fixture({ entry: entry(), controller: { delay: async () => { data.running = false; data.entry = entry('1.2.2'); } } });
  data.running = true; await controller.install(); assert.deepEqual(data.writes, []);
});
test('资源校验失败不会安装，失败后可以重试', async () => {
  const { controller, data } = fixture({ controller: { verify: async () => { throw new Error('校验失败'); } } });
  await controller.install(); assert.deepEqual(data.writes, []); assert.match(controller.getState().message, /校验失败/);
  assert.equal(controller.getState().uncertain, false);
});
test('卸载独立确认且只停用自身，取消确认不做任何操作', async () => {
  const first = fixture({ entry: entry(), controller: { confirmRemove: () => false } });
  await first.controller.remove(); assert.deepEqual(first.data.writes, []); assert.equal(first.data.verifies, 0);
  const second = fixture({ entry: entry() }); await second.controller.remove();
  assert.deepEqual(second.data.writes, ['disable']); assert.equal(second.data.verifies, 0);
});
test('写入超时锁住重复提交；只读复查确认结果后才解除', async () => {
  const { controller, data } = fixture({ bridge: { deploy: async () => { throw Object.assign(new Error('pending'), { pending: true }); } } });
  await controller.install(); assert.equal(controller.getState().uncertain, true);
  await controller.detect(); assert.equal(controller.getState().uncertain, true);
  data.entry = entry('1.2.2'); await controller.detect(); assert.equal(controller.getState().uncertain, false);
});

test('状态服务正常但安装子服务休眠时，自动唤醒后继续，超时回执不重复提交', async () => {
  let attempts = 0;
  const { controller, data } = fixture({ bridge: { deploy: async (method, config) => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('sleeping'), { needsService: true });
    data.writes.push(method); data.entry = config; return { status: 0, response: 'OK' };
  } } });
  await controller.install();
  assert.equal(attempts, 2); assert.equal(data.launches, 1); assert.deepEqual(data.writes, ['enable']);
  let unknownCalls = 0;
  const unknown = fixture({ bridge: { deploy: async () => { unknownCalls++; throw Object.assign(new Error('unknown'), { pending: true }); } } });
  await unknown.controller.install(); assert.equal(unknownCalls, 1); assert.equal(unknown.data.launches, 0);
});
