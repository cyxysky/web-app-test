import type { ModelProvider } from '@/server/ai/schemas/runtime.schema';

export type SettingsTab = 'general' | 'model' | 'browser' | 'runtime' | 'skills' | 'memory' | 'accounts' | 'dom-test' | 'debug';

export type ModelProviderDefinition = {
  value: ModelProvider;
  label: string;
  defaultModel: string;
  defaultModels?: string[];
  keyLabel: string;
  baseUrlLabel?: string;
  defaultBaseURL?: string;
  localAuth?: boolean;
};

export type ModelSettingsLike = {
  defaultModel?: string;
  model?: string;
  models?: string[];
};

export type RuntimeEnvDefinition = {
  key: string;
  label: string;
  description: string;
  tab: Exclude<SettingsTab, 'general' | 'model' | 'skills' | 'memory' | 'accounts' | 'dom-test'>;
  defaultValue: string;
  control: 'boolean' | 'number' | 'select' | 'text' | 'secret' | 'textarea';
  options?: Array<{ label: string; value: string }>;
  picker?: 'directory';
  secret?: boolean;
};

export const modelProviderDefinitions: ModelProviderDefinition[] = [
  { value: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.5', keyLabel: 'OpenAI 访问密钥', baseUrlLabel: 'OpenAI 服务地址' },
  { value: 'openrouter', label: 'OpenRouter', defaultModel: 'qwen/qwen3.6-27b', keyLabel: 'OpenRouter 访问密钥' },
  { value: 'ollama', label: 'Ollama', defaultModel: 'llama3.1', keyLabel: 'Ollama 访问密钥（可选）', baseUrlLabel: 'Ollama 服务地址', defaultBaseURL: 'http://localhost:11434/v1' },
  { value: 'llama-cpp', label: 'llama.cpp', defaultModel: 'local-model', keyLabel: 'llama.cpp 访问密钥（可选）', baseUrlLabel: 'llama.cpp 服务地址', defaultBaseURL: 'http://localhost:8080/v1' },
  {
    value: 'lmstudio',
    label: 'LM Studio',
    defaultModel: 'qwen3-vl-2b-instruct',
    keyLabel: 'LM Studio 访问密钥（可选）',
    baseUrlLabel: 'LM Studio 服务地址',
    defaultBaseURL: 'http://localhost:1234/v1',
  },
  { value: 'google', label: 'Google Gemini API', defaultModel: 'gemini-3-flash-preview', keyLabel: 'Google 访问密钥' },
  { value: 'codex', label: 'Codex CLI', defaultModel: 'gpt-5.5', keyLabel: 'Codex CLI 使用本地登录，无需 Key', localAuth: true },
  { value: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet-4-5', keyLabel: 'Anthropic 访问密钥', baseUrlLabel: 'Anthropic 服务地址' },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    keyLabel: 'DeepSeek 访问密钥',
    baseUrlLabel: 'DeepSeek 服务地址',
    defaultBaseURL: 'https://api.deepseek.com',
  },
  {
    value: 'azure-openai',
    label: 'Azure OpenAI',
    defaultModel: 'gpt-5.5',
    keyLabel: 'Azure OpenAI 访问密钥',
    baseUrlLabel: 'Azure OpenAI 服务地址',
    defaultBaseURL: 'http://mirrors.shterm.com:8801/openai',
  },
  { value: 'groq', label: 'Groq', defaultModel: 'llama-3.3-70b-versatile', keyLabel: 'Groq 访问密钥', baseUrlLabel: 'Groq 服务地址' },
  { value: 'xai', label: 'xAI', defaultModel: 'grok-4', keyLabel: 'xAI 访问密钥', baseUrlLabel: 'xAI 服务地址' },
  { value: 'mistral', label: 'Mistral AI', defaultModel: 'mistral-large-latest', keyLabel: 'Mistral 访问密钥', baseUrlLabel: 'Mistral 服务地址' },
  { value: 'alibaba', label: 'Alibaba Cloud', defaultModel: 'qwen-plus', keyLabel: 'Alibaba 访问密钥', baseUrlLabel: 'Alibaba 服务地址' },
  { value: 'ai-gateway', label: 'Vercel AI Gateway', defaultModel: 'openai/gpt-5.5', keyLabel: 'AI Gateway 访问密钥', baseUrlLabel: 'AI Gateway 服务地址' },
  { value: 'google-vertex', label: 'Google Vertex AI', defaultModel: 'gemini-2.5-flash', keyLabel: 'Google Vertex 访问密钥', baseUrlLabel: 'Google Vertex 服务地址' },
  { value: 'perplexity', label: 'Perplexity', defaultModel: 'sonar', keyLabel: 'Perplexity 访问密钥', baseUrlLabel: 'Perplexity 服务地址' },
  { value: 'cohere', label: 'Cohere', defaultModel: 'command-a-03-2025', keyLabel: 'Cohere 访问密钥', baseUrlLabel: 'Cohere 服务地址' },
  { value: 'togetherai', label: 'Together.ai', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyLabel: 'Together.ai 访问密钥', baseUrlLabel: 'Together.ai 服务地址' },
  { value: 'fireworks', label: 'Fireworks AI', defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct', keyLabel: 'Fireworks 访问密钥', baseUrlLabel: 'Fireworks 服务地址' },
  { value: 'deepinfra', label: 'DeepInfra', defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct', keyLabel: 'DeepInfra 访问密钥', baseUrlLabel: 'DeepInfra 服务地址' },
  { value: 'cerebras', label: 'Cerebras', defaultModel: 'llama3.1-8b', keyLabel: 'Cerebras 访问密钥', baseUrlLabel: 'Cerebras 服务地址' },
  { value: 'huggingface', label: 'Hugging Face', defaultModel: 'meta-llama/Llama-3.1-8B-Instruct', keyLabel: 'Hugging Face 访问密钥', baseUrlLabel: 'Hugging Face 服务地址' },
  { value: 'bedrock', label: 'Amazon Bedrock', defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0', keyLabel: 'AWS Bedrock Bearer Token（可选）', baseUrlLabel: 'AWS 区域', defaultBaseURL: 'us-east-1' },
  { value: 'vercel', label: 'Vercel v0', defaultModel: 'v0-1.5-md', keyLabel: 'Vercel 访问密钥', baseUrlLabel: 'Vercel 服务地址' },
];

export const modelProviderValues = modelProviderDefinitions.map((item) => item.value);

export const defaultModelByProvider = modelProviderDefinitions.reduce((acc, item) => {
  acc[item.value] = item.defaultModel;
  return acc;
}, {} as Record<ModelProvider, string>);

export function modelProviderDefinition(provider: ModelProvider) {
  return modelProviderDefinitions.find((item) => item.value === provider) || modelProviderDefinitions[0];
}

export function uniqueModelIds(values: Array<string | undefined | null>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const model = String(value || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  return result;
}

export function modelListForProvider(definition: ModelProviderDefinition, settings?: ModelSettingsLike) {
  const models = uniqueModelIds([
    ...(settings?.models || []),
    settings?.defaultModel,
    settings?.model,
    ...(definition.defaultModels || []),
    definition.defaultModel,
  ]);
  return models.length ? models : [definition.defaultModel];
}

export function defaultModelForProvider(definition: ModelProviderDefinition, settings?: ModelSettingsLike) {
  const models = modelListForProvider(definition, settings);
  const requested = String(settings?.defaultModel || settings?.model || definition.defaultModel).trim();
  return requested && models.includes(requested) ? requested : models[0];
}

const boolOptions = [
  { label: '开启', value: 'true' },
  { label: '关闭', value: 'false' },
];

export const runtimeEnvDefinitions: RuntimeEnvDefinition[] = [
  { key: 'ELECTRON_EMBEDDED_BROWSER', label: '嵌入式 Electron 浏览器', description: '在桌面端对话模式中使用 Electron 原生浏览器视图；开启后对话页会切换为中间浏览器、右侧对话布局。', tab: 'browser', defaultValue: 'false', control: 'boolean', options: boolOptions },
  { key: 'AI_BROWSER_MODE', label: '浏览器控制模式', description: '代码模式让 Agent 执行受限 Playwright 代码；DOM 模式通过结构化 inspect/interact 工具操作页面。新会话使用保存后的模式。', tab: 'browser', defaultValue: 'code', control: 'select', options: [{ label: '代码模式', value: 'code' }, { label: 'DOM 模式', value: 'dom' }] },
  { key: 'BROWSER_CDP_ENDPOINT', label: '现有浏览器 CDP 地址', description: '连接已开启远程调试的 Chrome/Edge，例如 http://127.0.0.1:9222；可复用登录态。留空则启动新浏览器。', tab: 'browser', defaultValue: '', control: 'text' },
  { key: 'BROWSER_USER_DATA_DIR', label: '浏览器用户数据目录', description: '未配置 CDP 时使用指定 profile 启动持久浏览器，适合保存登录态。留空使用临时上下文。', tab: 'browser', defaultValue: '', control: 'text' },
  { key: 'BROWSER_CHANNEL', label: '浏览器通道', description: '可选 chrome、msedge 等本机浏览器通道；留空使用 Playwright Chromium。', tab: 'browser', defaultValue: '', control: 'text' },
  { key: 'HEADLESS_BROWSER', label: '无头浏览器', description: '是否隐藏浏览器窗口运行。', tab: 'browser', defaultValue: 'false', control: 'boolean', options: boolOptions },
  { key: 'BROWSER_FULLSCREEN', label: '浏览器全屏', description: '启动浏览器时是否尽量使用全屏窗口。', tab: 'browser', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'BROWSER_VIEWPORT_MODE', label: '视口模式', description: '自动时跟随真实浏览器窗口；固定时使用下方视口宽高。', tab: 'browser', defaultValue: 'auto', control: 'select', options: [{ label: '自动跟随窗口', value: 'auto' }, { label: '固定宽高', value: 'fixed' }] },
  { key: 'BROWSER_VIEWPORT_WIDTH', label: '视口宽度', description: '固定模式下的浏览器视口宽度；留空则自动跟随窗口。', tab: 'browser', defaultValue: '', control: 'number' },
  { key: 'BROWSER_VIEWPORT_HEIGHT', label: '视口高度', description: '固定模式下的浏览器视口高度；留空则自动跟随窗口。', tab: 'browser', defaultValue: '', control: 'number' },
  { key: 'BROWSER_SLOW_MO_MS', label: '浏览器动作延迟', description: 'Playwright 每个动作的慢速延迟，单位毫秒。生产运行建议为 0。', tab: 'browser', defaultValue: '0', control: 'number' },
  { key: 'BROWSER_ACTION_SETTLE_MS', label: '动作后等待', description: '每次动作后额外等待页面稳定的时间。', tab: 'browser', defaultValue: '0', control: 'number' },
  { key: 'BROWSER_NAVIGATION_DOM_QUIET_MS', label: '导航后 DOM 静默窗口', description: '导航提交后 DOM 连续保持不变达到该时长即生成语义快照，单位毫秒；0 表示关闭。', tab: 'browser', defaultValue: '250', control: 'number' },
  { key: 'BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS', label: '导航后 DOM 稳定上限', description: '等待导航后 DOM 稳定的最长时间，达到上限后继续生成当前快照，单位毫秒；0 表示关闭。', tab: 'browser', defaultValue: '1000', control: 'number' },
  { key: 'BROWSER_POPUP_WAIT_MS', label: '弹窗等待时间', description: '点击后等待新标签页或弹窗出现的时间。生产运行建议为 0。', tab: 'browser', defaultValue: '0', control: 'number' },
  { key: 'BROWSER_IGNORE_HTTPS_ERRORS', label: '忽略 HTTPS 错误', description: '测试环境证书异常时允许继续打开页面。', tab: 'browser', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'BROWSER_HTTP_REQUEST_HISTORY_LIMIT', label: 'HTTP 请求历史上限', description: '每个标签页保留多少条 HTTP 请求记录，供 AI 诊断接口和资源加载问题。', tab: 'browser', defaultValue: '400', control: 'number' },
  { key: 'AI_HTTP_REQUEST_TOOL_LIMIT', label: 'HTTP 请求工具返回条数', description: 'AI 调用 getHttpRequests 时最多返回当前标签页最近多少条请求。', tab: 'browser', defaultValue: '80', control: 'number' },
  { key: 'SCREENSHOT_STABILIZE_MS', label: '截图前稳定等待', description: '截图前等待页面稳定的时间。', tab: 'browser', defaultValue: '1000', control: 'number' },
  { key: 'SCREENSHOT_TIMEOUT_MS', label: '截图超时', description: 'Playwright 截图等待上限，单位毫秒；默认 15000。', tab: 'browser', defaultValue: '15000', control: 'number' },
  { key: 'BROWSER_CHAT_DOM_SCREENSHOTS', label: 'DOM 模式保存截图', description: '对话 DOM 模式是否保存步骤截图；关闭时不会因截图超时阻塞执行。', tab: 'browser', defaultValue: 'false', control: 'boolean', options: boolOptions },
  { key: 'AI_SCREENSHOT_MAX_KB', label: 'AI 截图压缩上限', description: '发送给 AI 的截图大小上限，留空表示不压缩。', tab: 'browser', defaultValue: '', control: 'number' },
  { key: 'SEND_SCREENSHOT_TO_AI', label: '强制发送截图', description: '覆盖模型能力判断，留空表示自动判断。', tab: 'browser', defaultValue: '', control: 'select', options: [{ label: '自动', value: '' }, ...boolOptions] },

  { key: 'AI_CUSTOM_SYSTEM_PROMPT', label: '附加系统规则', description: '追加到内置 Agent Loop 运行提示词末尾的用户规则；不会替换、覆盖或削弱原有提示词。', tab: 'runtime', defaultValue: '', control: 'textarea' },
  { key: 'MANUAL_VERIFICATION_TIMEOUT_MS', label: '人工验证等待时间', description: '验证码或登录验证的最长等待时间。', tab: 'runtime', defaultValue: '180000', control: 'number' },
  { key: 'AI_REQUEST_TIMEOUT_MS', label: 'AI 请求超时', description: '单次模型请求最长等待时间。', tab: 'runtime', defaultValue: '30000', control: 'number' },
  { key: 'AI_AGENT_LOOP_TIMEOUT_MS', label: 'Agent Loop 请求超时', description: '带工具循环的单个用户请求最长等待时间；留空时默认 120000。', tab: 'runtime', defaultValue: '120000', control: 'number' },
  { key: 'AI_SUBAGENT_LOOP_TIMEOUT_MS', label: '子 Agent 执行超时', description: '单个并行子 Agent 的完整工具循环最长时间；默认 600000 毫秒，不限制工具回合数。', tab: 'runtime', defaultValue: '600000', control: 'number' },
  { key: 'AI_SUBAGENT_CONCURRENCY', label: '子 Agent 全局并发数', description: '整个服务同时运行的子 Agent 上限；超过上限的任务排队，避免浏览器和模型请求瞬时占满资源。', tab: 'runtime', defaultValue: '3', control: 'number' },
  { key: 'AI_SUBAGENT_RESULT_MAX_CHARS', label: '子 Agent 总结建议长度', description: '写入子 Agent 提示词的建议最大字符数；只引导模型控制篇幅，后端不会截断实际结果。', tab: 'runtime', defaultValue: '40000', control: 'number' },
  { key: 'AI_RUNTIME_REQUEST_RETRY_ATTEMPTS', label: 'AI 请求连续失败上限', description: 'Agent Loop 中上游连接或请求级错误连续失败达到该次数后停止；成功一次会清零。', tab: 'runtime', defaultValue: '3', control: 'number' },
  { key: 'BROWSER_CHAT_KEEP_BROWSER_OPEN_AFTER_TURN', label: '对话完成保留浏览器', description: '浏览器对话每轮完成后是否保留浏览器，便于同一用户后续对话复用。', tab: 'runtime', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'BROWSER_CHAT_SLOW_MO_MS', label: '对话浏览器动作延迟', description: '浏览器对话覆盖全局慢速延迟；默认 0，避免工具调用被人为减速。', tab: 'runtime', defaultValue: '0', control: 'number' },
  { key: 'BROWSER_CHAT_POPUP_WAIT_MS', label: '对话点击弹窗等待', description: '浏览器对话点击后的同步弹窗等待；默认 0，弹窗仍会由页面监听异步接管。', tab: 'runtime', defaultValue: '0', control: 'number' },
  { key: 'BROWSER_CHAT_ACTION_FRAME_LIMIT', label: '对话动作 Frame 上限', description: '每次对话工具动作后参与交互校验与 DOM 增量采集的 frame 数量；较小值可避免多 iframe 页面拖慢点击。', tab: 'runtime', defaultValue: '24', control: 'number' },
  { key: 'BROWSER_CHAT_SHOW_REASONING', label: '对话展示思维链', description: '是否在对话模式中展示模型返回的推理内容；关闭后仍会保留工具调用与最终回复。', tab: 'runtime', defaultValue: 'false', control: 'boolean', options: boolOptions },
  { key: 'BROWSER_CHAT_LOG_LIMIT', label: '对话日志保留上限', description: '每个浏览器对话最多保留多少条执行日志；前端日志弹窗使用虚拟滚动。', tab: 'runtime', defaultValue: '2000', control: 'number' },
  { key: 'AI_PERSONAL_MEMORY_ENABLED', label: '个性化记忆召回', description: '是否在浏览器对话提示词中召回简洁的用户记忆和域名记忆。', tab: 'runtime', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'AI_PERSONAL_MEMORY_EXTRACT_ENABLED', label: '个性化记忆提炼', description: '每轮浏览器对话完成后，是否提炼可长期复用的别名、偏好、工作流和域名事实。', tab: 'runtime', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'AI_PERSONAL_MEMORY_PROMPT_LIMIT', label: '个性化记忆注入上限', description: '单轮浏览器对话最多注入多少条个性化记忆。', tab: 'runtime', defaultValue: '6', control: 'number' },
  { key: 'AI_PERSONAL_MEMORY_EXTRACTION_TIMEOUT_MS', label: '个性化记忆提炼超时', description: '对话结束后，记忆提炼模型请求允许的最长时间，单位毫秒。', tab: 'runtime', defaultValue: '30000', control: 'number' },
  { key: 'AI_CONTEXT_WINDOW_TOKENS', label: '上下文窗口大小', description: '估算模型上下文窗口大小。', tab: 'runtime', defaultValue: '256000', control: 'number' },
  { key: 'AI_CONTEXT_COMPRESSION_THRESHOLD', label: '上下文压缩阈值', description: '超过上下文窗口多少比例后压缩历史。', tab: 'runtime', defaultValue: '0.7', control: 'number' },
  { key: 'AI_AGENT_LOOP_SUMMARY_INPUT_MAX_CHARS', label: '压缩摘要输入上限', description: 'Agent Loop 生成续接摘要时保留的历史字符上限；会优先保留上一摘要和最新工具结果。', tab: 'runtime', defaultValue: '120000', control: 'number' },
  { key: 'AI_AGENT_LOOP_SUMMARY_OUTPUT_MAX_CHARS', label: '压缩摘要输出上限', description: 'Agent Loop 续接摘要允许的最大字符数。', tab: 'runtime', defaultValue: '24000', control: 'number' },
  { key: 'AI_IMAGE_CONTEXT_ESTIMATE_TOKENS', label: '单张图片估算 Token', description: '估算每张截图占用的上下文 token。', tab: 'runtime', defaultValue: '1200', control: 'number' },
  { key: 'AI_VISUAL_HISTORY_LIMIT', label: '视觉历史上限', description: 'Visual Context Manager 保留多少张历史图。', tab: 'runtime', defaultValue: '6', control: 'number' },
  { key: 'AI_VISUAL_COMPRESSED_HISTORY_LIMIT', label: '压缩后历史图上限', description: '上下文压缩后保留多少张历史图。', tab: 'runtime', defaultValue: '2', control: 'number' },
  { key: 'AI_VISUAL_COMPRESSED_PINNED_LIMIT', label: '压缩后证据图上限', description: '上下文压缩后保留多少张固定证据图。', tab: 'runtime', defaultValue: '2', control: 'number' },
  { key: 'AI_PROMPT_SCREENSHOT_REFERENCE_LIMIT', label: '历史截图引用上限', description: '可供 AI 选择引用的历史截图数量。', tab: 'runtime', defaultValue: '8', control: 'number' },

  { key: 'AI_COMPLETION_VERIFY', label: '完成结果二次校验', description: 'AI 声明完成后是否再做一次完成校验。', tab: 'debug', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'PLAYWRIGHT_TRACE', label: 'Playwright Trace', description: '是否保存 Playwright trace。', tab: 'debug', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'CODEX_PATH', label: 'Codex CLI 路径', description: '自定义 Codex CLI 可执行文件路径。', tab: 'debug', defaultValue: '', control: 'text' },
  { key: 'CODEX_CWD', label: 'Codex 工作目录', description: 'Codex CLI 默认工作目录。', tab: 'debug', defaultValue: '', control: 'text' },
  { key: 'CODEX_APPROVAL_MODE', label: 'Codex 审批模式', description: 'Codex CLI 的审批策略。', tab: 'debug', defaultValue: 'on-failure', control: 'select', options: [{ label: '失败时询问', value: 'on-failure' }, { label: '每次询问', value: 'on-request' }, { label: '永不询问', value: 'never' }, { label: '不受信任时询问', value: 'untrusted' }] },
  { key: 'CODEX_SANDBOX_MODE', label: 'Codex 沙箱模式', description: 'Codex CLI 的文件系统沙箱模式。', tab: 'debug', defaultValue: 'workspace-write', control: 'select', options: [{ label: '工作区可写', value: 'workspace-write' }, { label: '只读', value: 'read-only' }, { label: '完全访问', value: 'danger-full-access' }] },
  { key: 'CODEX_REASONING_EFFORT', label: 'Codex 推理强度', description: 'Codex CLI 的推理强度。', tab: 'debug', defaultValue: 'medium', control: 'select', options: [{ label: '无', value: 'none' }, { label: '极低', value: 'minimal' }, { label: '低', value: 'low' }, { label: '中', value: 'medium' }, { label: '高', value: 'high' }, { label: '极高', value: 'xhigh' }] },
  { key: 'CODEX_VERBOSE', label: 'Codex 详细日志', description: '是否输出更详细的 Codex 日志。', tab: 'debug', defaultValue: 'false', control: 'boolean', options: boolOptions },
  { key: 'CODEX_SKIP_GIT_REPO_CHECK', label: '跳过 Git 仓库检查', description: 'Codex CLI 是否跳过 Git 仓库检查。', tab: 'debug', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'CODEX_ALLOW_NPX', label: '允许 Codex 使用 npx', description: 'Codex CLI 是否允许 npx。', tab: 'debug', defaultValue: 'false', control: 'boolean', options: boolOptions },
];

export const runtimeEnvKeys = runtimeEnvDefinitions.map((item) => item.key);

export function runtimeEnvDefinition(key: string) {
  return runtimeEnvDefinitions.find((item) => item.key === key);
}
