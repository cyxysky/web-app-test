import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';
export const dataCapabilitySettings = [
  { key: 'AGENT_DATA_MAX_ROWS', label: '数据行数上限', description: '单次查询返回的最大行数。', section: 'debug', group: '数据（高级）', defaultValue: '500', control: 'number', applyMode: 'runtime', min: 1, max: 10000, step: 1 },
  { key: 'AGENT_DATA_ALLOW_WRITES', label: '允许数据写入', description: '经宿主确认后允许执行非只读语句。', section: 'runtime', group: '数据', defaultValue: 'false', control: 'boolean', applyMode: 'runtime' },
] as const satisfies readonly CapabilitySettingDefinition[];
