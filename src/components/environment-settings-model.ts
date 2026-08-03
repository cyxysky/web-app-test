import type { SettingsTab } from '@/config/settings';

export const environmentSettingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'skills', label: 'Skills 管理' },
  { id: 'general', label: '通用设置' },
  { id: 'model', label: '模型配置' },
  { id: 'browser', label: '浏览器与截图' },
  { id: 'runtime', label: '运行控制' },
  { id: 'memory', label: '个性化记忆' },
  { id: 'accounts', label: '登录账号' },
  { id: 'debug', label: '调试与高级' },
];

const administratorOnlySettingsTabs = new Set<SettingsTab>(['model', 'browser', 'runtime', 'debug']);

export function isAdministratorOnlySettingsTab(tab: SettingsTab) {
  return administratorOnlySettingsTabs.has(tab);
}

export function environmentSettingsTabsForUser(userId?: string, defaultUserId = '0') {
  if ((userId || '').trim() === defaultUserId.trim()) return environmentSettingsTabs;
  return environmentSettingsTabs.filter((tab) => !administratorOnlySettingsTabs.has(tab.id));
}
