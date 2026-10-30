export const AI_SETTINGS_KEY = "WpsTranslationAssistant.aiSettings.v1";
export const AI_PROVIDERS = [
  { id: "litellm", name: "LiteLLM 网关", baseURL: "", kind: "compatible" },
  { id: "openrouter", name: "OpenRouter 统一网关", baseURL: "https://openrouter.ai/api/v1", kind: "compatible" },
  { id: "openai", name: "OpenAI 官方", baseURL: "https://api.openai.com/v1", kind: "compatible" },
  { id: "anthropic", name: "Anthropic 官方", baseURL: "https://api.anthropic.com/v1", kind: "anthropic" },
  { id: "google", name: "Google Gemini 官方", baseURL: "https://generativelanguage.googleapis.com/v1beta", kind: "google" },
  { id: "deepseek", name: "DeepSeek 官方", baseURL: "https://api.deepseek.com/v1", kind: "compatible" },
  { id: "qwen", name: "通义千问 · 北京", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", kind: "compatible" },
  { id: "qwen-intl", name: "通义千问 · 新加坡", baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", kind: "compatible" },
  { id: "compatible", name: "其他 OpenAI 兼容服务", baseURL: "", kind: "compatible" },
];
export const providerFor = id => AI_PROVIDERS.find(p => p.id === id) || AI_PROVIDERS[0];
export function publicAISettings(value = {}) {
  const provider = providerFor(value.provider);
  return { provider: provider.id, baseURL: typeof value.baseURL === "string" ? value.baseURL : provider.baseURL,
    model: typeof value.model === "string" ? value.model.slice(0, 256) : "" };
}
export function loadAISettings(storage) {
  try { return publicAISettings(JSON.parse(storage.getItem(AI_SETTINGS_KEY)) || {}); }
  catch { return publicAISettings(); }
}
export function normalizeAIBaseURL(value, provider = "compatible") {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error("请填写完整的 AI 服务地址，例如 https://ai.example.com/v1。"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("AI 服务地址需使用 HTTPS；本机服务可用 HTTP。");
  if (url.username || url.password || url.search || url.hash) throw new Error("服务地址不能包含账号、Key、查询参数或 # 片段。");
  let pathname = url.pathname.replace(/\/+$/, "");
  if (/\/(chat\/completions|messages|models|responses)$/.test(pathname)) throw new Error("请填写 API 基础地址，不要包含 chat/completions、messages、models 或 responses。");
  if (provider === "litellm" && !pathname.endsWith("/v1")) pathname += "/v1";
  url.pathname = pathname;
  return url.href.replace(/\/$/, "");
}
export function resolveAIConnection(value, requireModel = false) {
  const config = publicAISettings(value), provider = providerFor(config.provider);
  const baseURL = normalizeAIBaseURL(config.baseURL, config.provider);
  const apiKey = String(value.apiKey || "").trim();
  if (!apiKey) throw new Error("请粘贴 AI Key / LiteLLM 虚拟 Key。");
  if (/[\r\n]/.test(apiKey)) throw new Error("Key 不能包含换行。");
  if (requireModel && !config.model.trim()) throw new Error("请读取模型列表后选择模型，或输入服务提供的模型名称。");
  return { ...config, model: config.model.trim(), kind: provider.kind, apiKey,
    baseURL, headers: {} };
}
