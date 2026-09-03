import type { CapabilitySkill } from '@webpilot/capability-sdk';

export const computerRuntimeSkillId = 'system-computer-runtime';

export const computerRuntimeSkill = Object.freeze({
  id: computerRuntimeSkillId,
  title: 'Computer Runtime',
  summary: `<system_skill id="${computerRuntimeSkillId}">Observe the current desktop before every dependent input action, use normalized current-screenshot coordinates, and verify the resulting state.</system_skill>`,
  content: `# Computer Runtime

- Observe or capture a fresh screenshot before acting.
- Every computer click uses a normalized 0-1000 coordinate space, independent of screenshot or display pixel size.
- For x: 0 is the screenshot's left edge and 1000 is its right edge. For y: 0 is the top edge and 1000 is the bottom edge.
- Estimate x and y as proportions of the latest screenshot. Never send raw screenshot pixels or physical display pixels.
- Example: the visual center is x=500, y=500; a point one quarter from the left and three quarters down is x=250, y=750.
- The returned display width and height are informational physical pixels; do not use them directly as click x/y.
- Use the smallest input action and observe again after every state change.
- Once a post-action observation visibly proves the requested target state, stop and report success instead of repeating equivalent observations.
- Common Windows key names include WIN or SUPER, CTRL, ALT, SHIFT, ENTER, ESC, TAB, and arrow keys.
- Never type secrets unless the host provides a protected fill primitive.
- If a locked Windows secure desktop prevents capture, retry once, then ask the host to unlock it; never attempt to bypass authentication.
- External, destructive, privacy-sensitive, or costly actions require host approval and direct verification.`,
  required: true,
  activation: [{
    toolName: 'computer',
    actions: ['observe', 'screenshot', 'click', 'type', 'key', 'scroll', 'wait'],
  }],
} satisfies CapabilitySkill);
