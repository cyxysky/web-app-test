import type { CapabilitySkill } from '@webpilot/capability-sdk';
export const communicationRuntimeSkillId = 'system-communication-runtime';
export const communicationRuntimeSkill = Object.freeze({
  id: communicationRuntimeSkillId, title: 'Communication Runtime',
  summary: `<system_skill id="${communicationRuntimeSkillId}">Create an exact draft before sending any external message; verify recipients, content, and channel, and rely on host approval for send.</system_skill>`,
  content: `# Communication Runtime\n\n- Always create and inspect a draft before send.\n- Preserve exact recipient identifiers and never guess an address, channel, or audience.\n- Sending is externally visible and requires host approval even when a draft exists.\n- Do not include credentials or unrelated private information.\n- Report the provider message identifier only after the channel confirms delivery acceptance.`,
  required: true, activation: [{ toolName: 'communication', actions: ['channels', 'draft', 'readDraft', 'send'] }],
} satisfies CapabilitySkill);
