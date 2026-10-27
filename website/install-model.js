export const product = 'WpsTranslationAssistant';

export function compareVersions(a, b) {
  const parse = value => {
    if (!/^\d+\.\d+\.\d+$/.test(value || '')) throw new Error('无法确认插件版本，请先检查本机安装来源。');
    return value.split('.').map(Number);
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export function readManifest(value, baseUrl) {
  if (value?.name !== product || value.addonType !== 'et' || value.online !== 'false') throw new Error('发布配置不属于翻译助手离线加载项。');
  compareVersions(value.version, value.version);
  const base = new URL(baseUrl), url = new URL(value.package, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || !url.pathname.endsWith('.7z') || url.search || url.hash
      || !/^[a-f0-9]{64}$/i.test(value.sha256 || '') || !Number.isInteger(value.size) || value.size < 1 || value.size > 20_000_000) throw new Error('插件资源配置无效，请联系发布者。');
  return { ...value, url: url.href };
}

export function readLocalConfig(result) {
  if (result?.status !== 0) throw new Error(result?.message || result?.msg || '未能连接 WPS，请确认已安装 WPS 并允许本机连接。');
  let entries;
  try { entries = typeof result.response === 'string' ? JSON.parse(result.response || 'null') : result.response; }
  catch { throw new Error('WPS 返回的加载项配置无法解析，未进行安装或卸载。'); }
  if (entries == null) entries = [];
  if (!Array.isArray(entries)) throw new Error('WPS 返回的加载项配置格式异常。');
  const own = entries.filter(entry => entry?.name === product && (entry.addonType || entry.type) === 'et' && entry.enable !== 'false' && entry.enable !== false);
  if (own.length > 1) throw new Error('检测到多个翻译助手入口，请先在原安装入口清理重复配置。');
  return own[0] || null;
}

export function installationState(entry, manifest) {
  if (!entry) return { kind: 'absent', label: '安装翻译助手', canInstall: true, canRemove: false };
  const offline = entry.online === 'false' || entry.online === false || (entry.online == null && entry.version);
  if (offline && entry.version === '1.0.0' && /(?:^|[\\/])WpsTranslationAssistant_1\.0\.0[\\/]?$/.test(entry.url || '')) {
    return { kind: 'native', label: '请先移除旧安装器版本', canInstall: false, canRemove: false };
  }
  if (!offline) return { kind: 'development', label: '切换为网页安装版', canInstall: true, canRemove: true };
  const compared = compareVersions(entry.version, manifest.version);
  if (compared > 0) return { kind: 'newer', label: '本机版本更新', canInstall: false, canRemove: true };
  return { kind: compared === 0 ? 'current' : 'outdated', label: compared === 0 ? '重新安装当前版本' : '更新翻译助手', canInstall: true, canRemove: true };
}

export function deploymentConfig(manifest) {
  return { name: product, addonType: 'et', online: 'false', version: manifest.version, url: manifest.url };
}

export async function verifyPackage(manifest, fetcher = fetch, subtle = crypto.subtle) {
  const response = await fetcher(manifest.url, { cache: 'no-store' });
  if (!response.ok) throw new Error('插件资源下载失败：HTTP ' + response.status);
  const bytes = await response.arrayBuffer(), header = new Uint8Array(bytes, 0, Math.min(6, bytes.byteLength));
  if (bytes.byteLength !== manifest.size || [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c].some((value, i) => header[i] !== value)) throw new Error('插件包大小或格式校验失败，未调用安装。');
  const hash = Array.from(new Uint8Array(await subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== manifest.sha256.toLowerCase()) throw new Error('插件资源校验失败，未调用安装。请稍后刷新页面重试。');
}

export function checkDeploymentResult(result) {
  if (result?.status !== 0 || (result.response !== 'OK' && result.response !== '')) throw new Error(result?.message || result?.msg || 'WPS 未确认操作成功，请检查状态后再操作。');
}

export async function changeInstallation({ manifest, entry, remove, confirmed, isRunning, verify, deploy }) {
  if (!confirmed) throw new Error('请先保存并关闭 WPS 文档，勾选下方确认项。');
  const state = installationState(entry, manifest);
  if (!(remove ? state.canRemove : state.canInstall)) throw new Error('当前安装来源或版本不允许此操作，请按页面提示处理。');
  if (await isRunning()) throw new Error('WPS 表格仍在运行，请保存工作并正常退出后重试。');
  if (!remove) await verify(manifest);
  // 升级直接交给 WPS enable，不先卸载旧版；仅传入本插件，不遍历处理其他加载项。
  const config = remove ? { ...entry, name: product, addonType: 'et' } : deploymentConfig(manifest);
  checkDeploymentResult(await deploy(remove ? 'disable' : 'enable', config));
}
