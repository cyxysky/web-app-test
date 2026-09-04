import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';
export const communicationCapabilitySettings = [
  { key: 'AGENT_COMMUNICATION_ALLOW_SEND', label: '允许对外发送', description: '允许将已确认的草稿发送到配置渠道。', section: 'runtime', group: '通信', defaultValue: 'false', control: 'boolean', applyMode: 'runtime' },
  { key: 'AGENT_COMMUNICATION_TIMEOUT_MS', label: '通信超时', description: '单次对外发送请求的最长持续时间。', section: 'debug', group: '通信（高级）', defaultValue: '30000', control: 'number', applyMode: 'runtime', min: 1000, max: 300000, step: 1000 },
] as const satisfies readonly CapabilitySettingDefinition[];
