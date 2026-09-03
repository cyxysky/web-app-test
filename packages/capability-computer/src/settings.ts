import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk'; export const computerCapabilitySettings = [
  { key: 'AGENT_COMPUTER_ENABLED', label: '计算机控制', description: '启用桌面观察与控制；Windows 会自动启动内置驱动。', section: 'runtime', group: '计算机', defaultValue: 'false', control: 'boolean', applyMode: 'runtime' },
  { key: 'AGENT_COMPUTER_TIMEOUT_MS', label: '计算机操作超时', description: '单次桌面操作的最长时间。', section: 'runtime', group: '计算机', defaultValue: '30000', control: 'number', applyMode: 'runtime', min: 1000, max: 300000, step: 1000 },
  { key: 'AGENT_COMPUTER_ENDPOINT', label: '计算机驱动端点', description: '留空时由能力包自动启动内置 Windows 驱动；仅外部驱动部署需要覆盖。', section: 'runtime', group: '计算机', defaultValue: '', control: 'text', applyMode: 'startup', hidden: true },
  { key: 'AGENT_COMPUTER_AUTHORIZATION', label: '计算机驱动授权', description: '内置驱动自动生成进程内授权；仅外部驱动部署需要覆盖。', section: 'runtime', group: '计算机', defaultValue: '', control: 'secret', applyMode: 'startup', secret: true, hidden: true },
] as const satisfies readonly CapabilitySettingDefinition[];
