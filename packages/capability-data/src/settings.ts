import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';
export const dataCapabilitySettings = [
  { key: 'AGENT_DATA_SOURCES_JSON', label: '数据源', description: '结构化数据源定义的 JSON 数组；SQLite 使用 database 路径，PostgreSQL 使用仅引用环境变量名的 urlEnv。', section: 'runtime', group: '数据', defaultValue: '[]', control: 'textarea', applyMode: 'runtime' },
  { key: 'AGENT_DATA_MAX_ROWS', label: '数据行数上限', description: '单次查询返回的最大行数。', section: 'runtime', group: '数据', defaultValue: '500', control: 'number', applyMode: 'runtime', min: 1, max: 10000, step: 1 },
  { key: 'AGENT_DATA_ALLOW_WRITES', label: '允许数据写入', description: '经宿主确认后允许执行非只读语句。', section: 'runtime', group: '数据', defaultValue: 'false', control: 'boolean', applyMode: 'runtime' },
] as const satisfies readonly CapabilitySettingDefinition[];
