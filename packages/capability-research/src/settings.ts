import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';
export const researchCapabilitySettings = [
  { key: 'AGENT_RESEARCH_MAX_CONTENT_CHARS', label: '研究内容上限', description: '单次抓取返回的最大正文字符数。', section: 'runtime', group: '研究', defaultValue: '30000', control: 'number', applyMode: 'runtime', min: 1000, max: 200000, step: 1000 },
  { key: 'AGENT_RESEARCH_TIMEOUT_MS', label: '研究请求超时', description: '研究请求的最长持续时间（毫秒）。', section: 'runtime', group: '研究', defaultValue: '20000', control: 'number', applyMode: 'runtime', min: 1000, max: 120000, step: 1000 },
  { key: 'AGENT_RESEARCH_SEARCH_ENDPOINT', label: '研究搜索端点', description: '可选的 JSON 搜索服务端点。', section: 'runtime', group: '研究', defaultValue: '', control: 'text', applyMode: 'startup' },
  { key: 'AGENT_RESEARCH_SEARCH_AUTHORIZATION', label: '研究服务授权', description: '仅向已配置的搜索服务发送此授权请求头。', section: 'runtime', group: '研究', defaultValue: '', control: 'secret', applyMode: 'startup', secret: true },
] as const satisfies readonly CapabilitySettingDefinition[];
