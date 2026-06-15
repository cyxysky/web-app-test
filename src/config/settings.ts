import type { ModelProvider } from '@/server/ai/schemas/test-case.schema';

export type SettingsTab = 'general' | 'model' | 'browser' | 'runtime' | 'debug';

export type ModelProviderDefinition = {
  value: ModelProvider;
  label: string;
  defaultModel: string;
  keyLabel: string;
  baseUrlLabel?: string;
  defaultBaseURL?: string;
  localAuth?: boolean;
};

export type RuntimeEnvDefinition = {
  key: string;
  label: string;
  description: string;
  tab: Exclude<SettingsTab, 'general' | 'model'>;
  defaultValue: string;
  control: 'boolean' | 'number' | 'select' | 'text' | 'secret';
  options?: Array<{ label: string; value: string }>;
  secret?: boolean;
};

export const modelProviderDefinitions: ModelProviderDefinition[] = [
  { value: 'openrouter', label: 'OpenRouter', defaultModel: 'qwen/qwen3.6-27b', keyLabel: 'OpenRouter API Key' },
  { value: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.5', keyLabel: 'OpenAI API Key', baseUrlLabel: 'OpenAI Base URL' },
  { value: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-v4-flash', keyLabel: 'DeepSeek API Key' },
  { value: 'google', label: 'Google Gemini API', defaultModel: 'gemini-3-flash-preview', keyLabel: 'Google API Key' },
  { value: 'gemini', label: 'Gemini CLI', defaultModel: 'gemini-3-flash-preview', keyLabel: 'Gemini CLI 使用本地登录，无需 Key', localAuth: true },
  { value: 'codex', label: 'Codex CLI', defaultModel: 'gpt-5.5', keyLabel: 'Codex CLI 使用本地登录，无需 Key', localAuth: true },
  {
    value: 'lmstudio',
    label: 'LM Studio',
    defaultModel: 'qwen3-vl-2b-instruct',
    keyLabel: 'LM Studio API Key（可选）',
    baseUrlLabel: 'LM Studio 服务地址',
    defaultBaseURL: 'http://localhost:1234/v1',
  },
  {
    value: 'azure-openai',
    label: 'Azure OpenAI',
    defaultModel: 'gpt-5.5',
    keyLabel: 'Azure OpenAI API Key',
    baseUrlLabel: 'Azure OpenAI Base URL',
    defaultBaseURL: 'http://mirrors.shterm.com:8801/openai',
  },
];

export const modelProviderValues = modelProviderDefinitions.map((item) => item.value);

export const defaultModelByProvider = modelProviderDefinitions.reduce((acc, item) => {
  acc[item.value] = item.defaultModel;
  return acc;
}, {} as Record<ModelProvider, string>);

export function modelProviderDefinition(provider: ModelProvider) {
  return modelProviderDefinitions.find((item) => item.value === provider) || modelProviderDefinitions[0];
}

const boolOptions = [
  { label: '开启', value: 'true' },
  { label: '关闭', value: 'false' },
];

export const runtimeEnvDefinitions: RuntimeEnvDefinition[] = [
  { key: 'AI_BROWSER_MODE', label: '浏览器控制模式', description: 'visual-markers 使用截图编号，dom 使用 DOM 定位。', tab: 'browser', defaultValue: 'visual-markers', control: 'select', options: [{ label: '视觉标记', value: 'visual-markers' }, { label: 'DOM 定位', value: 'dom' }] },
  { key: 'BROWSER_CDP_ENDPOINT', label: '现有浏览器 CDP 地址', description: '连接已开启远程调试的 Chrome/Edge，例如 http://127.0.0.1:9222；可复用登录态。留空则启动新浏览器。', tab: 'browser', defaultValue: '', control: 'text' },
  { key: 'BROWSER_USER_DATA_DIR', label: '浏览器用户数据目录', description: '未配置 CDP 时使用指定 profile 启动持久浏览器，适合保存登录态。留空使用临时上下文。', tab: 'browser', defaultValue: '', control: 'text' },
  { key: 'BROWSER_CHANNEL', label: '浏览器通道', description: '可选 chrome、msedge 等本机浏览器通道；留空使用 Playwright Chromium。', tab: 'browser', defaultValue: '', control: 'text' },
  { key: 'HEADLESS_BROWSER', label: '无头浏览器', description: '是否隐藏浏览器窗口运行。', tab: 'browser', defaultValue: 'false', control: 'boolean', options: boolOptions },
  { key: 'BROWSER_FULLSCREEN', label: '浏览器全屏', description: '启动浏览器时是否尽量使用全屏窗口。', tab: 'browser', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'BROWSER_VIEWPORT_WIDTH', label: '视口宽度', description: '浏览器视口宽度。', tab: 'browser', defaultValue: '1920', control: 'number' },
  { key: 'BROWSER_VIEWPORT_HEIGHT', label: '视口高度', description: '浏览器视口高度。', tab: 'browser', defaultValue: '1080', control: 'number' },
  { key: 'BROWSER_SLOW_MO_MS', label: '浏览器动作延迟', description: 'Playwright 每个动作的慢速延迟，单位毫秒。', tab: 'browser', defaultValue: '250', control: 'number' },
  { key: 'BROWSER_ACTION_SETTLE_MS', label: '动作后等待', description: '每次动作后额外等待页面稳定的时间。', tab: 'browser', defaultValue: '0', control: 'number' },
  { key: 'BROWSER_POPUP_WAIT_MS', label: '弹窗等待时间', description: '点击后等待新标签页或弹窗出现的时间。', tab: 'browser', defaultValue: '600', control: 'number' },
  { key: 'BROWSER_IGNORE_HTTPS_ERRORS', label: '忽略 HTTPS 错误', description: '测试环境证书异常时允许继续打开页面。', tab: 'browser', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'BROWSER_HTTP_REQUEST_HISTORY_LIMIT', label: 'HTTP 请求历史上限', description: '每个标签页保留多少条 HTTP 请求记录，供 AI 诊断接口和资源加载问题。', tab: 'browser', defaultValue: '400', control: 'number' },
  { key: 'AI_HTTP_REQUEST_TOOL_LIMIT', label: 'HTTP 请求工具返回条数', description: 'AI 调用 getHttpRequests 时最多返回当前标签页最近多少条请求。', tab: 'browser', defaultValue: '80', control: 'number' },
  { key: 'SCREENSHOT_ELEMENT_LABELS', label: '截图元素编号', description: '在截图上绘制可点击元素编号。', tab: 'browser', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'SCREENSHOT_SCROLL_AREA_LABELS', label: '滚动区域标记', description: '在截图上绘制可滚动区域标记。', tab: 'browser', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'SCREENSHOT_ELEMENT_LABEL_LIMIT', label: '元素编号上限', description: '单张截图最多标记多少个候选元素。', tab: 'browser', defaultValue: '160', control: 'number' },
  { key: 'SCREENSHOT_SCROLL_AREA_LABEL_LIMIT', label: '滚动区域上限', description: '单张截图最多标记多少个滚动区域。', tab: 'browser', defaultValue: '12', control: 'number' },
  { key: 'SCREENSHOT_STABILIZE_MS', label: '截图前稳定等待', description: '截图前等待页面稳定的时间。', tab: 'browser', defaultValue: '1000', control: 'number' },
  { key: 'SCREENSHOT_MAX_KB', label: '截图压缩上限', description: '发送给模型前的截图大小上限，留空表示不压缩。', tab: 'browser', defaultValue: '', control: 'number' },
  { key: 'AI_SCREENSHOT_MAX_KB', label: 'AI 截图压缩上限', description: '发送给 AI 的截图大小上限，留空表示沿用截图压缩上限。', tab: 'browser', defaultValue: '', control: 'number' },
  { key: 'VISUAL_MARKERS_IS_MARKED', label: '启用视觉标记', description: '是否在截图上叠加候选编号。', tab: 'browser', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'VISUAL_MARKER_SEPARATE_MAP', label: '单独标记图', description: '把标记图和原截图分开发给模型，运行证据链展示不带标识的原图。', tab: 'browser', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'SEND_SCREENSHOT_TO_AI', label: '强制发送截图', description: '覆盖模型能力判断，留空表示自动判断。', tab: 'browser', defaultValue: '', control: 'select', options: [{ label: '自动', value: '' }, ...boolOptions] },
  { key: 'INTERACTIVE_CANDIDATE_LIMIT', label: '交互候选上限', description: '页面上下文最多采集多少个候选元素。', tab: 'browser', defaultValue: '160', control: 'number' },
  { key: 'DOM_TREE_MAX_NODES', label: 'DOM 节点上限', description: 'DOM 模式下最多读取多少个简化节点。', tab: 'browser', defaultValue: '320', control: 'number' },
  { key: 'DOM_TREE_MAX_DEPTH', label: 'DOM 深度上限', description: 'DOM 模式下读取 DOM 树的最大深度。', tab: 'browser', defaultValue: '14', control: 'number' },

  { key: 'KEEP_BROWSER_OPEN_AFTER_RUN', label: '运行后保留浏览器', description: '运行结束后是否保持浏览器打开。', tab: 'runtime', defaultValue: 'false', control: 'boolean', options: boolOptions },
  { key: 'KEEP_BROWSER_OPEN_ON_AI_ERROR', label: 'AI 错误时保留浏览器', description: 'AI 调用异常时是否保留浏览器用于排查。', tab: 'runtime', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'AI_TEST_RUNTIME_MAX_STEPS', label: '最大运行步骤数', description: '单次测试最多允许 AI 执行多少个运行步骤。', tab: 'runtime', defaultValue: '30', control: 'number' },
  { key: 'AI_BROWSER_CHAT_MAX_STEPS', label: '对话模式浏览器步骤上限', description: '对话模式中，单轮用户消息最多允许执行多少个浏览器步骤；达到后会保存进度并暂停，发送“继续”可接着执行。', tab: 'runtime', defaultValue: '6', control: 'number' },
  { key: 'AI_AGENT_LOOP_MAX_TURNS', label: 'Agent Loop 最大轮次', description: '单个步骤内部最多允许多少轮工具调用。', tab: 'runtime', defaultValue: '6', control: 'number' },
  { key: 'RUN_WORKER_CONCURRENCY', label: '运行并发数', description: '同时执行多少个测试运行。', tab: 'runtime', defaultValue: '1', control: 'number' },
  { key: 'MANUAL_VERIFICATION_TIMEOUT_MS', label: '人工验证等待时间', description: '验证码或登录验证的最长等待时间。', tab: 'runtime', defaultValue: '180000', control: 'number' },
  { key: 'REPLAY_STEP_DELAY_MS', label: '回放步骤间隔', description: '固定流程回放时每个录制动作前的等待时间，用于模拟 AI 每轮观察和页面加载间隔。', tab: 'runtime', defaultValue: '1500', control: 'number' },
  { key: 'REPLAY_AFTER_ACTION_SETTLE_MS', label: '回放动作后额外等待', description: '回放动作执行后、截图前额外等待的时间。通常留 0，页面慢时可加大。', tab: 'runtime', defaultValue: '0', control: 'number' },
  { key: 'REPLAY_AI_REPAIR', label: '回放失败 AI 修复', description: '固定流程回放工具失败时，是否让 AI 接管当前页面自动修复操作。', tab: 'runtime', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'REPLAY_AI_REPAIR_MAX_STEPS', label: 'AI 修复重试步数', description: '回放失败后 AI 修复最多允许连续接管多少个步骤，通常 1-2 即可。', tab: 'runtime', defaultValue: '2', control: 'number' },
  { key: 'AI_TEST_REQUEST_TIMEOUT_MS', label: 'AI 请求超时', description: '单次模型请求最长等待时间。', tab: 'runtime', defaultValue: '30000', control: 'number' },
  { key: 'AI_CONTEXT_WINDOW_TOKENS', label: '上下文窗口大小', description: '估算模型上下文窗口大小。', tab: 'runtime', defaultValue: '32000', control: 'number' },
  { key: 'AI_CONTEXT_COMPRESSION_THRESHOLD', label: '上下文压缩阈值', description: '超过上下文窗口多少比例后压缩历史。', tab: 'runtime', defaultValue: '0.7', control: 'number' },
  { key: 'AI_IMAGE_CONTEXT_ESTIMATE_TOKENS', label: '单张图片估算 Token', description: '估算每张截图占用的上下文 token。', tab: 'runtime', defaultValue: '1200', control: 'number' },
  { key: 'AI_VISUAL_HISTORY_LIMIT', label: '视觉历史上限', description: 'Visual Context Manager 保留多少张历史图。', tab: 'runtime', defaultValue: '6', control: 'number' },
  { key: 'AI_VISUAL_COMPRESSED_HISTORY_LIMIT', label: '压缩后历史图上限', description: '上下文压缩后保留多少张历史图。', tab: 'runtime', defaultValue: '2', control: 'number' },
  { key: 'AI_VISUAL_COMPRESSED_PINNED_LIMIT', label: '压缩后证据图上限', description: '上下文压缩后保留多少张固定证据图。', tab: 'runtime', defaultValue: '2', control: 'number' },
  { key: 'AI_PROMPT_SCREENSHOT_REFERENCE_LIMIT', label: '历史截图引用上限', description: '可供 AI 选择引用的历史截图数量。', tab: 'runtime', defaultValue: '8', control: 'number' },

  { key: 'AI_PROMPT_INCLUDE_FULL_TIMELINE', label: '包含完整时间线', description: '是否在 prompt 中包含完整步骤时间线。', tab: 'debug', defaultValue: 'false', control: 'boolean', options: boolOptions },
  { key: 'RUN_MEMORY_TIMELINE_LIMIT', label: '运行记忆时间线长度', description: '运行记忆保留多少条时间线。', tab: 'debug', defaultValue: '10', control: 'number' },
  { key: 'RUN_MEMORY_SUMMARY_MAX_CHARS', label: '运行记忆摘要长度', description: '运行记忆摘要的最大字符数。', tab: 'debug', defaultValue: '1000', control: 'number' },
  { key: 'AI_COMPLETION_VERIFY', label: '完成结果二次校验', description: 'AI 声明完成后是否再做一次完成校验。', tab: 'debug', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'AI_TEST_DEBUG', label: '调试事件记录', description: '是否记录 AI 请求、工具调用和性能事件。', tab: 'debug', defaultValue: 'false', control: 'boolean', options: boolOptions },
  { key: 'PLAYWRIGHT_TRACE', label: 'Playwright Trace', description: '是否保存 Playwright trace。', tab: 'debug', defaultValue: 'true', control: 'boolean', options: boolOptions },
  { key: 'DATABASE_URL', label: '数据库连接', description: '数据库连接字符串。', tab: 'debug', defaultValue: '', control: 'secret', secret: true },
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
