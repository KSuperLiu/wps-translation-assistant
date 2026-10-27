import { readLocalConfig, installationState, changeInstallation } from './install-model.js';

export function primaryAction(state, manifest) {
  if (state.busy) return { label: { detecting: '正在检测 WPS…', connecting: '正在打开 WPS…', waiting: '等待 WPS 关闭…', verifying: '正在校验资源…', installing: '正在安装…', removing: '正在卸载…' }[state.phase] || '正在处理…', disabled: true };
  if (state.uncertain) return { label: '等待确认操作结果', disabled: true };
  if (!state.connected) return { label: '安装 / 更新到 WPS', disabled: false };
  const local = installationState(state.entry, manifest);
  if (local.kind === 'current') return { label: '已是最新版本', disabled: true };
  if (local.kind === 'newer') return { label: '本机版本更新，无需操作', disabled: true };
  if (local.kind === 'native') return { label: '请先卸载旧安装器版本', disabled: true };
  return { label: local.kind === 'outdated' ? '更新到 v' + manifest.version : '安装到 WPS', disabled: false };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true });
  });
}

export function createInstallerController({ manifest, bridge, verify, startService, notify = () => {}, confirmRemove = () => true, delay = sleep, closeAttempts = 40 }) {
  const state = { phase: 'ready', busy: false, connected: false, entry: null, needsService: false, uncertain: false, message: '', tone: '' };
  let active, pending;
  const emit = patch => { Object.assign(state, patch); notify({ ...state }); };
  const assertActive = signal => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  async function readState() {
    const next = readLocalConfig(await bridge.getAllConfig());
    installationState(next, manifest);
    state.entry = next; state.connected = true; state.needsService = false;
  }
  function readyMessage() {
    const local = installationState(state.entry, manifest);
    return local.kind === 'native' ? '检测到旧版 EXE 安装入口，请先按下方说明卸载一次。'
      : local.kind === 'current' ? '已安装 v' + state.entry.version + '，可以直接在 WPS 中使用。'
      : local.kind === 'newer' ? '本机已安装 v' + state.entry.version + '，将保留此版本。'
      : local.kind === 'outdated' ? '本机 v' + state.entry.version + '，新版已准备好。'
      : '准备好了，点击下方按钮即可安装。';
  }
  async function detect() {
    if (state.busy) return;
    emit({ busy: true, phase: 'detecting', message: '正在自动检测本机 WPS…', tone: '' });
    let serviceConnected = false;
    try {
      await bridge.connect({ timeoutMs: 1500 }); serviceConnected = true; await readState();
      if (pending) {
        const complete = pending.remove ? !state.entry : state.entry?.version === manifest.version && state.entry?.url === manifest.url;
        if (!complete) { emit({ uncertain: true, message: '操作结果仍待确认，请稍后重新检测。', tone: 'error' }); return; }
        pending = null;
      }
      emit({ phase: 'ready', uncertain: false, message: readyMessage(), tone: 'success' });
    } catch (error) {
      emit({ phase: 'offline', connected: false, needsService: !serviceConnected, message: state.uncertain ? '操作结果尚未确认，请等待后重新检测。' : serviceConnected ? error.message : '点击下方按钮，将自动连接 WPS 并完成安装或更新。', tone: state.uncertain || serviceConnected ? 'error' : '' });
    } finally { emit({ busy: false }); }
  }
  async function connectForAction(signal) {
    let started = false;
    if (state.needsService) { startService(); started = true; }
    for (let attempt = 0; attempt < 8; attempt++) {
      assertActive(signal);
      try { await bridge.connect({ timeoutMs: 1200 }); }
      catch (error) {
        assertActive(signal);
        if (!started) { startService(); started = true; }
        await delay(600, signal);
        continue;
      }
      await readState(); assertActive(signal); return;
    }
    state.connected = false; state.needsService = true;
    throw new Error('还没有连上 WPS。请允许浏览器打开 WPS / 访问本机服务，再点一次。');
  }
  async function operate({ remove = false, repair = false } = {}) {
    if (state.busy || state.uncertain) return;
    if (remove && !confirmRemove()) return;
    active = new AbortController(); const signal = active.signal;
    emit({ busy: true, phase: 'connecting', message: '正在连接 WPS，请留意浏览器的打开 WPS 提示。', tone: '' });
    let acknowledged = false;
    try {
      await connectForAction(signal);
      const local = installationState(state.entry, manifest);
      if ((!remove && (local.kind === 'newer' || (local.kind === 'current' && !repair))) || (remove && !state.entry)) {
        emit({ phase: 'ready', message: remove ? '插件已经卸载。' : readyMessage(), tone: 'success' }); return;
      }
      if (local.kind === 'native') throw new Error(readyMessage());
      let running = await bridge.isRunning();
      for (let attempt = 0; running && attempt < closeAttempts; attempt++) {
        emit({ phase: 'waiting', message: '请保存并关闭 WPS 文档。检测到退出后会自动继续。', tone: '' });
        await delay(1500, signal); assertActive(signal);
        running = await bridge.isRunning();
      }
      if (running) throw new Error('还没有检测到 WPS 退出。保存并关闭文档后，再点一次即可。');
      await readState(); assertActive(signal);
      const fresh = installationState(state.entry, manifest);
      if (remove && !state.entry) { emit({ phase: 'ready', message: '插件已经卸载。', tone: 'success' }); return; }
      if (!remove && !repair && fresh.kind === 'current') { emit({ phase: 'ready', message: readyMessage(), tone: 'success' }); return; }
      await changeInstallation({ manifest, entry: state.entry, remove, confirmed: true, isRunning: () => bridge.isRunning(),
        verify: async value => { emit({ phase: 'verifying', message: '正在校验插件资源…' }); await verify(value); assertActive(signal); },
        deploy: async (method, config) => {
          assertActive(signal);
          emit({ phase: remove ? 'removing' : 'installing', message: remove ? '正在卸载翻译助手…' : '正在安装翻译助手…' });
          for (let attempt = 0; attempt < 8; attempt++) {
            assertActive(signal);
            try {
              const result = await bridge.deploy(method, config);
              acknowledged = result?.status === 0 && (result.response === 'OK' || result.response === '');
              return result;
            } catch (error) {
              // 只重试 WPS 明确表示“尚未执行”的服务不可用回执，不重试超时或未知结果。
              if (!error.needsService) throw error;
              if (attempt === 7) throw new Error('WPS 安装服务仍未就绪，请重新打开 WPS 后再试。旧版本没有被预先卸载。');
              emit({ phase: 'connecting', message: '正在唤醒 WPS 安装服务，请留意浏览器提示…' });
              if (attempt === 0) startService();
              await delay(700, signal); assertActive(signal);
              if (await bridge.isRunning()) throw new Error('请保存并关闭 WPS 后，再点一次继续。');
              await readState();
              const now = installationState(state.entry, manifest);
              if ((remove && !state.entry) || (!remove && !repair && now.kind === 'current')) return { status: 0, response: 'OK' };
              if (!(remove ? now.canRemove : now.canInstall)) throw new Error('本机安装状态已变化，请重新检测后操作。');
              emit({ phase: remove ? 'removing' : 'installing', message: remove ? '正在卸载翻译助手…' : '正在安装翻译助手…' });
            }
          }
        },
      });
      await readState();
      if (remove ? state.entry != null : state.entry?.version !== manifest.version || state.entry?.url !== manifest.url) throw new Error('本机状态尚未与预期一致。');
      emit({ phase: 'ready', message: remove ? '已卸载。重新打开 WPS 后生效。' : '设置好了！重新打开 WPS，点击“翻译助手 → 打开助手”。', tone: 'success' });
    } catch (error) {
      if (error.pending || acknowledged) {
        pending = { remove }; emit({ phase: 'uncertain', uncertain: true, message: '操作结果尚未确认，请稍后在“更多选项”中重新检测，勿重复提交。', tone: 'error' });
      } else emit({ phase: 'ready', message: signal.aborted ? '已取消，可以稍后再操作。' : error.message, tone: signal.aborted ? '' : 'error' });
    } finally { active = null; emit({ busy: false }); }
  }
  return { detect, install: () => operate(), repair: () => operate({ repair: true }), remove: () => operate({ remove: true }),
    cancelWait: () => { if (state.phase === 'waiting') active?.abort(); }, getState: () => ({ ...state }) };
}
