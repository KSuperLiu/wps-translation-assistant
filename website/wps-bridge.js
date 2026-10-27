// 与 wpsjs 发布页相同的 WPS RelayHttpServer 本机接口。
// HTTP 回环服务由 WPS 自带，不启动本项目服务器，不绕过 TLS 证书验证。
export function createWpsBridge(fetcher = fetch) {
  const origin = 'http://127.0.0.1:58890';
  async function request(endpoint, body, mutation = false, timeoutMs = 8_000) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), mutation ? 90_000 : timeoutMs);
    try {
      const response = await fetcher(origin + endpoint, { method: 'POST', body,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, credentials: 'omit', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('WPS 本机服务返回 HTTP ' + response.status);
      return await response.text();
    } catch (cause) {
      const error = new Error(mutation ? '操作结果尚未确认。请等待后刷新页面检查状态，勿重复提交。'
        : '未能连接 WPS 本机服务。请先点击“打开 WPS 连接服务”，再重新连接；若浏览器询问本机连接权限，请按组织规定处理。', { cause });
      error.pending = mutation; throw error;
    } finally { clearTimeout(timer); }
  }
  return {
    async connect({ timeoutMs = 8_000 } = {}) {
      const version = (await request('/version', '{}', false, timeoutMs)).trim();
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('WPS 本机服务版本无法确认，请升级 WPS 后重试。');
    },
    async getAllConfig() { return { status: 0, response: await request('/publishlist', '{}') }; },
    async isRunning() {
      const response = await request('/isRunning', JSON.stringify({ app: 'et' }));
      if (!['Client is running.', 'Client is not running.'].includes(response)) throw new Error('无法确认 WPS 表格是否已退出，请检查本机文档窗口。');
      return response === 'Client is running.';
    },
    async deploy(method, config) {
      if (!['enable', 'disable'].includes(method) || config.name !== 'WpsTranslationAssistant' || config.addonType !== 'et') throw new Error('拒绝管理其他插件或禁用全部加载项。');
      const data = JSON.stringify({ cmd: method, name: config.name, addonType: 'et', online: config.online,
        url: config.url, version: config.version, time: Date.now() });
      const body = btoa(Array.from(new TextEncoder().encode(data), byte => String.fromCharCode(byte)).join(''));
      return { status: 0, response: await request('/deployaddons/runParams', body, true) };
    },
  };
}
