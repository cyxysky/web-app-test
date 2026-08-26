import type { SettingsTab } from '@/config/settings';

export const environmentSettingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '通用设置' },
  { id: 'model', label: '模型配置' },
  { id: 'browser', label: '浏览器与截图' },
  { id: 'sensitive-data', label: '敏感数据过滤' },
  { id: 'runtime', label: '运行控制' },
  { id: 'debug', label: '调试与高级' },
];

const administratorOnlySettingsTabs = new Set<SettingsTab>(['model', 'browser', 'sensitive-data', 'runtime', 'debug']);

export function isAdministratorOnlySettingsTab(tab: SettingsTab) {
  return administratorOnlySettingsTabs.has(tab);
}

export function environmentSettingsTabsForUser(userId?: string, defaultUserId = '1') {
  if ((userId || '').trim() === defaultUserId.trim()) return environmentSettingsTabs;
  return environmentSettingsTabs.filter((tab) => !administratorOnlySettingsTabs.has(tab.id));
}
