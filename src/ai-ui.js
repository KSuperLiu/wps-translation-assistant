import { AI_PROVIDERS, AI_SETTINGS_KEY, loadAISettings, storedAISettings, providerFor, normalizeAIBaseURL } from "./ai-config.js";
import { sameReviewedUnit } from "./model.js";
import { validateText } from "./validation.js";

// 正常翻译和检查不加载 AI SDK，首次主动请求时再加载。
const listAIModels = async (...args) => (await import("./ai-client.js")).listAIModels(...args);
const generateAITranslation = async (...args) => (await import("./ai-client.js")).generateAITranslation(...args);

export function sameAIContext(a, b) {
  return !!a?.unit && !!b?.unit && a.bookKey === b.bookKey && a.draft === b.draft && sameReviewedUnit(a.unit, b.unit);
}
export function setupOnlineAI({ document = globalThis.document, getStorage, getContext, loadDraft,
  confirm = message => globalThis.confirm(message), listModels = listAIModels, generate = generateAITranslation }) {
  const $ = id => document.getElementById(id);
  let settings;
  try { settings = loadAISettings(getStorage()); } catch { settings = storedAISettings(); }
  let result = null, request = null, counter = 0, availableModels = [];
  for (const provider of AI_PROVIDERS) {
    const option = document.createElement("option"); option.value = provider.id; option.textContent = provider.name; $("ai-provider").append(option);
  }
  $("ai-provider").value = settings.provider; $("ai-base-url").value = settings.baseURL;
  $("ai-model").value = settings.model;
  $("ai-key").value = settings.apiKey;
  const config = () => ({ provider: $("ai-provider").value, baseURL: $("ai-base-url").value,
    model: $("ai-model").value, apiKey: $("ai-key").value });
  function renderModelPicker() {
    const select = $("ai-model-select"), currentModel = $("ai-model").value;
    select.replaceChildren();
    const add = (value, label) => {
      const option = document.createElement("option"); option.value = value; option.textContent = label; select.append(option);
    };
    add("", availableModels.length ? "请选择模型" : "请先读取模型列表");
    for (const model of availableModels) add("model:" + model, model);
    if (currentModel && !availableModels.includes(currentModel)) add("model:" + currentModel, currentModel);
    add("manual", "手动输入模型名称…");
    select.value = currentModel ? "model:" + currentModel : "";
    $("ai-model-manual").hidden = true;
  }
  function resetModelPicker() { availableModels = []; renderModelPicker(); }
  function status(text) { $("online-ai-status").textContent = text; $("ai-connection-status").textContent = text; }
  function clearResult() { result = null; $("online-ai-result-box").hidden = true; $("online-ai-result").textContent = ""; $("online-ai-errors").textContent = ""; }
  function cancel(text = "已取消 AI 请求。") {
    counter++; request?.controller.abort(); request = null; status(text); refresh();
  }
  function refresh() {
    const context = getContext();
    if (request?.context && !sameAIContext(request.context, context)) cancel("条目或草稿已变化，已取消本次生成。");
    if (result && !sameAIContext(result.context, context)) { clearResult(); status("条目或草稿已变化，请重新生成建议。"); }
    const unavailable = !context?.unit || context.busy || !context.unit.source?.trim();
    $("online-ai-generate").disabled = unavailable || !!request;
    $("online-ai-load").disabled = !result || !!request || unavailable;
    $("ai-models").disabled = !!request;
    $("online-ai-cancel").hidden = !request;
    $("ai-settings-cancel").hidden = !request;
    $("online-ai-generate").textContent = request?.context ? "正在生成…" : "生成当前条目译文";
    if (result) $("online-ai-errors").textContent = validateText(context.unit.source, result.text, context.unit.validationOptions).map(e => e.message || e).join("；");
  }
  function persist() {
    settings = storedAISettings(config());
    // 不保存误粘贴到 URL 的凭据或查询参数；输入框仍保留原值供用户修改。
    try { settings.baseURL = normalizeAIBaseURL(settings.baseURL, settings.provider); } catch { settings.baseURL = ""; }
    try { getStorage().setItem(AI_SETTINGS_KEY, JSON.stringify(settings)); $("ai-settings-status").textContent = "地址、模型和 Key 已保存在本机，下次打开自动恢复。"; }
    catch { $("ai-settings-status").textContent = "本机存储不可用，配置仅在本次窗格会话生效。"; }
  }
  function changed() {
    if (request) cancel("配置已变化，已取消 AI 请求。"); else status("");
    clearResult(); persist(); refresh();
  }
  $("ai-provider").onchange = () => {
    $("ai-base-url").value = providerFor($("ai-provider").value).baseURL;
    $("ai-key").value = ""; $("ai-model").value = "";
    resetModelPicker(); changed();
  };
  for (const id of ["ai-base-url", "ai-key", "ai-model"]) $(id).oninput = () => {
    // 目的地址改变时清掉凭据，避免把上一个服务的 Key 发送给新地址。
    if (id === "ai-base-url") { $("ai-key").value = ""; resetModelPicker(); }
    if (id === "ai-key") resetModelPicker();
    changed();
  };
  $("ai-model-select").onchange = () => {
    const value = $("ai-model-select").value;
    $("ai-model-manual").hidden = value !== "manual";
    if (value !== "manual") $("ai-model").value = value.startsWith("model:") ? value.slice(6) : "";
    changed();
  };
  $("ai-clear-key").onclick = () => { $("ai-key").value = ""; resetModelPicker(); changed(); status("已清除保存的 Key。"); };
  $("online-ai-cancel").onclick = () => cancel();
  $("ai-settings-cancel").onclick = () => cancel();
  async function run(type) {
    if (request) return;
    const context = getContext();
    if (type === "generate" && (!context?.unit || context.busy || !context.unit.source?.trim())) return;
    const id = ++counter, controller = new AbortController();
    request = { controller, context: type === "generate" ? context : null };
    if (type === "generate") clearResult();
    status(type === "models" ? "正在读取模型列表…" : "正在生成当前条目译文，请等待…"); refresh();
    try {
      if (type === "models") {
        const models = await listModels(config(), { signal: controller.signal });
        if (id !== counter) return;
        availableModels = models;
        status(models.length ? "已读取 " + models.length + " 个模型，请从下拉框选择。" : "服务未返回可用模型，可选择“手动输入模型名称…”填写。");
        if (models.length === 1 && !$("ai-model").value.trim()) { $("ai-model").value = models[0]; persist(); }
        renderModelPicker();
      } else {
        // 只传原文和目标语言，不发送整个工作簿、路径、Key、旧译或草稿。
        const text = await generate(config(), { source: context.unit.source, language: context.unit.language }, { signal: controller.signal });
        if (id !== counter) return;
        if (!sameAIContext(context, getContext())) { status("条目或草稿已变化，请重新生成建议。"); return; }
        result = { context, text };
        $("online-ai-result").textContent = text; $("online-ai-result-box").hidden = false;
        status("建议已生成，请核对含义和格式，再载入草稿。");
      }
    } catch (error) { if (id === counter) status(error.message); }
    finally { if (id === counter) { request = null; refresh(); } }
  }
  $("ai-models").onclick = () => run("models");
  $("online-ai-generate").onclick = () => run("generate");
  $("online-ai-load").onclick = () => {
    const context = getContext();
    if (!result || context?.busy || !sameAIContext(result.context, context)) return refresh();
    if (context.draft && context.draft !== result.text && !confirm("用生成的 AI 建议替换当前草稿？表格译文将在点击写入后才修改。")) return;
    const text = result.text; clearResult(); loadDraft(text); status("AI 建议已载入草稿，请核对后写入。"); refresh();
  };
  renderModelPicker(); refresh();
  return { refresh, dispose: () => { counter++; request?.controller.abort(); } };
}
