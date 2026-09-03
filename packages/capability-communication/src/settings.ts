import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';
export const communicationCapabilitySettings = [
  { key: 'AGENT_COMMUNICATION_ALLOW_SEND', label: '允许对外发送', description: '允许将已确认的草稿发送到配置渠道。', section: 'runtime', group: '通信', defaultValue: 'false', control: 'boolean', applyMode: 'runtime' },
  { key: 'AGENT_COMMUNICATION_TIMEOUT_MS', label: '通信超时', description: '单次对外发送请求的最长持续时间。', section: 'runtime', group: '通信', defaultValue: '30000', control: 'number', applyMode: 'runtime', min: 1000, max: 300000, step: 1000 },
  { key: 'AGENT_COMMUNICATION_WEBHOOKS_JSON', label: '通信 Webhook', description: 'Webhook 渠道定义的 JSON 数组；授权值必须引用环境变量。', section: 'runtime', group: '通信', defaultValue: '[]', control: 'textarea', applyMode: 'runtime' },
] as const satisfies readonly CapabilitySettingDefinition[];
