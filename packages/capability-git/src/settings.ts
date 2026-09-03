import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';
export const gitCapabilitySettings = [
  { key: 'AGENT_GIT_ALLOW_WRITES', label: '允许 Git 写入', description: '允许执行已确认的补丁应用和提交。', section: 'runtime', group: 'Git', defaultValue: 'false', control: 'boolean', applyMode: 'runtime' },
  { key: 'AGENT_GIT_TIMEOUT_MS', label: 'Git 超时', description: '单条 Git 命令的最长持续时间。', section: 'runtime', group: 'Git', defaultValue: '60000', control: 'number', applyMode: 'runtime', min: 1000, max: 300000, step: 1000 },
  { key: 'AGENT_GIT_MAX_OUTPUT_CHARS', label: 'Git 输出上限', description: '返回给模型的最大命令输出字符数。', section: 'runtime', group: 'Git', defaultValue: '50000', control: 'number', applyMode: 'runtime', min: 1000, max: 500000, step: 1000 },
  { key: 'AGENT_GIT_REPOSITORY', label: 'Git 仓库', description: '暴露给 Git 能力的仓库根目录；留空时使用应用工作目录。', section: 'runtime', group: 'Git', defaultValue: '', control: 'text', applyMode: 'startup', picker: 'directory' },
] as const satisfies readonly CapabilitySettingDefinition[];
