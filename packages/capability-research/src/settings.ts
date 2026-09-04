import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';
export const researchCapabilitySettings = [
  { key: 'AGENT_RESEARCH_MAX_CONTENT_CHARS', label: '研究内容上限', description: '单次抓取返回的最大正文字符数。', section: 'debug', group: '研究（高级）', defaultValue: '30000', control: 'number', applyMode: 'runtime', min: 1000, max: 200000, step: 1000 },
  { key: 'AGENT_RESEARCH_TIMEOUT_MS', label: '研究请求超时', description: '研究请求的最长持续时间（毫秒）。', section: 'debug', group: '研究（高级）', defaultValue: '20000', control: 'number', applyMode: 'runtime', min: 1000, max: 120000, step: 1000 },
] as const satisfies readonly CapabilitySettingDefinition[];
