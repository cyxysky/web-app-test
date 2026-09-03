import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';
export const knowledgeCapabilitySettings = [
  { key: 'AGENT_KNOWLEDGE_CHUNK_CHARS', label: '知识分块大小', description: '每个索引分块的大致字符数。', section: 'runtime', group: '知识库', defaultValue: '1800', control: 'number', applyMode: 'runtime', min: 400, max: 8000, step: 100 },
  { key: 'AGENT_KNOWLEDGE_SEARCH_LIMIT', label: '知识检索结果上限', description: '单次搜索返回的最大分块数。', section: 'runtime', group: '知识库', defaultValue: '8', control: 'number', applyMode: 'runtime', min: 1, max: 30, step: 1 },
] as const satisfies readonly CapabilitySettingDefinition[];
