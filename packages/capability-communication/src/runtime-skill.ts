import type { CapabilitySkill } from '@webpilot/capability-sdk';
export const communicationRuntimeSkillId = 'system-communication-runtime';
export const communicationRuntimeSkill = Object.freeze({
  id: communicationRuntimeSkillId, title: 'Communication Runtime',
  summary: `<system_skill id="${communicationRuntimeSkillId}">Create an exact draft before sending any external message; inspect each channel's target and content capabilities, verify the draft, and rely on host approval for send.</system_skill>`,
  content: `# Communication Runtime\n\n- Always list channels first and respect the selected channel's targetKinds, contentFormats, and requiresExplicitTargets capabilities.\n- Always create and inspect a draft before send.\n- Preserve exact target identifiers and target kinds; never guess a user ID, group ID, email address, or audience.\n- Sending is externally visible and requires host approval even when a draft exists.\n- Do not include credentials or unrelated private information.\n- Report delivery identifiers only after the channel confirms acceptance.`,
  required: true, activation: [{ toolName: 'communication', actions: ['channels', 'draft', 'readDraft', 'send'] }],
} satisfies CapabilitySkill);
