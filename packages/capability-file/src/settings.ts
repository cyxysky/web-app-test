import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';

export const fileCapabilitySettings = [
  {
    key: 'OFFICE_GENERATION_MODE',
    label: 'Office 文件生成模式',
    description: '选择 LibreOffice UNO、高层 JavaScript Office 库或自动选择。',
    section: 'runtime',
    group: '文件能力',
    defaultValue: 'uno',
    control: 'select',
    applyMode: 'runtime',
    options: [
      { label: 'LibreOffice UNO', value: 'uno' },
      { label: 'JavaScript Office 库', value: 'javascript' },
      { label: '自动选择', value: 'auto' },
    ],
  },
] as const satisfies readonly CapabilitySettingDefinition[];

