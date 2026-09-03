import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';

// Chart storage, renderer and ECharts version are host resources rather than
// user-editable values. Exporting the empty definition keeps package discovery
// uniform and lets a future chart adapter add settings without host changes.
export const chartCapabilitySettings = [] as const satisfies readonly CapabilitySettingDefinition[];

