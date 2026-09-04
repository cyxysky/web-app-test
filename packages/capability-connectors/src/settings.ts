import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';
export const connectorsCapabilitySettings = [
  { key: 'AGENT_CONNECTOR_TIMEOUT_MS', label: '连接器超时', description: '外部操作的最长持续时间（毫秒）。', section: 'debug', group: '连接器（高级）', defaultValue: '30000', control: 'number', applyMode: 'runtime', min: 1000, max: 300000, step: 1000 },
  { key: 'AGENT_CONNECTOR_MAX_RESULT_CHARS', label: '连接器结果上限', description: '返回给模型的序列化结果最大字符数。', section: 'debug', group: '连接器（高级）', defaultValue: '50000', control: 'number', applyMode: 'runtime', min: 1000, max: 500000, step: 1000 },
] as const satisfies readonly CapabilitySettingDefinition[];
