import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk'; export const workflowCapabilitySettings = [
  { key: 'AGENT_WORKFLOW_MAX_STEPS', label: '工作流步骤上限', description: '单个工作流允许的最大步骤数；仅用于保护运行时，普通任务无需修改。', section: 'debug', group: '工作流程（高级）', defaultValue: '100', control: 'number', applyMode: 'runtime', min: 1, max: 1000, step: 1 },
] as const satisfies readonly CapabilitySettingDefinition[];
