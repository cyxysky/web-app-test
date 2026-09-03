import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';

export const codeSandboxCapabilitySettings = [
  { key: 'AGENT_CODE_SANDBOX_ENABLED', label: '代码沙箱', description: '启用本地受限代码执行。', section: 'runtime', group: '代码沙箱', defaultValue: 'false', control: 'boolean', applyMode: 'runtime' },
  { key: 'AGENT_CODE_SANDBOX_TIMEOUT_MS', label: '执行超时', description: '最长执行时间（毫秒）。', section: 'runtime', group: '代码沙箱', defaultValue: '30000', control: 'number', applyMode: 'runtime', min: 1000, max: 300000, step: 1000 },
  { key: 'AGENT_CODE_SANDBOX_MAX_OUTPUT_CHARS', label: '输出上限', description: '标准输出与标准错误的合计字符上限。', section: 'runtime', group: '代码沙箱', defaultValue: '30000', control: 'number', applyMode: 'runtime', min: 1000, max: 200000, step: 1000 },
] as const satisfies readonly CapabilitySettingDefinition[];
