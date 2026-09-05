import type { SettingsTab } from '@/config/settings';

export type EnvironmentSettingsTab = {
  id: SettingsTab;
  label: string;
  description: string;
};

export type EnvironmentSettingsTabGroup = {
  id: 'interface' | 'ai' | 'tools' | 'system';
  label: string;
  tabs: SettingsTab[];
};

export const environmentSettingsTabs: EnvironmentSettingsTab[] = [
  { id: 'general', label: '外观与偏好', description: '语言、品牌和界面主题' },
  { id: 'model', label: '模型与供应商', description: '模型、密钥和服务地址' },
  { id: 'runtime', label: 'Agent 运行', description: '推理、上下文和并发策略' },
  { id: 'browser', label: '浏览器', description: '实例、预览和浏览器 Agent' },
  { id: 'capabilities', label: '工具能力', description: '代码、文件、Git 和桌面工具' },
  { id: 'integrations', label: '连接与数据', description: '连接器、通信、数据和研究' },
  { id: 'sensitive-data', label: '安全与隐私', description: '敏感数据过滤、检测和评测' },
  { id: 'debug', label: '系统与高级', description: '调试、追踪和 CLI 参数' },
];

export const environmentSettingsTabGroups: EnvironmentSettingsTabGroup[] = [
  { id: 'interface', label: '界面', tabs: ['general'] },
  { id: 'ai', label: 'AI 与运行', tabs: ['model', 'runtime'] },
  { id: 'tools', label: '工具与连接', tabs: ['browser', 'capabilities', 'integrations'] },
  { id: 'system', label: '安全与系统', tabs: ['sensitive-data', 'debug'] },
];

const administratorOnlySettingsTabs = new Set<SettingsTab>([
  'model',
  'runtime',
  'browser',
  'capabilities',
  'integrations',
  'sensitive-data',
  'debug',
]);

export function environmentSettingsTab(tab: SettingsTab) {
  return environmentSettingsTabs.find((item) => item.id === tab);
}

export function isAdministratorOnlySettingsTab(tab: SettingsTab) {
  return administratorOnlySettingsTabs.has(tab);
}

export function environmentSettingsTabsForUser(userId?: string, defaultUserId = '1') {
  if ((userId || '').trim() === defaultUserId.trim()) return environmentSettingsTabs;
  return environmentSettingsTabs.filter((tab) => !administratorOnlySettingsTabs.has(tab.id));
}
