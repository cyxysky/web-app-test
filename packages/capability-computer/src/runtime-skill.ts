import type { CapabilitySkill } from '@webpilot/capability-sdk';

export const computerRuntimeSkillId = 'system-computer-runtime';

export const computerRuntimeSkill = Object.freeze({
  id: computerRuntimeSkillId,
  title: 'Computer Runtime',
  summary: `<system_skill id="${computerRuntimeSkillId}">Observe the current desktop before every dependent input action, use the returned current-screenshot pixel dimensions and coordinates directly, and verify the resulting state.</system_skill>`,
  content: `# Computer Runtime

- Use observe before acting. It already captures and attaches one fresh screenshot, so do not request a second capture without an intervening state change.
- Every successful observe returns the exact captured image width and height in physical pixels.
- Inspect the returned elements before choosing coordinates. Prefer an exact named UIA or desktop-accessibility element, then exact OCR text, then a visually confirmed button-candidate.
- OCR text is approximate recognition, not authoritative application text. Use it only when its location and the screenshot agree, and do not quote an unverified OCR string as the resulting UI state.
- Click a matching returned element with elementId. The runtime resolves its center in the latest screenshot pixel grid; do not copy or recalculate its coordinates.
- Never substitute an unrelated element id when the requested target is absent. Its returned name, text, role, and active window must be consistent with the intended action.
- If the requested application is not the active window, switch to it first and observe again. Do not click an element belonging to the currently active unrelated application as a way to focus the target.
- Element ids belong only to the latest successful observe and become invalid after any state-changing action.
- Every click x/y uses direct pixel coordinates in that exact latest screenshot. There is no normalized 0-1000 conversion.
- For x: 0 is the screenshot's left edge and width - 1 is its right edge. For y: 0 is the top edge and height - 1 is the bottom edge.
- The attached screenshot bytes preserve the returned pixel dimensions. Derive the point directly in that full-resolution pixel grid.
- The runtime rejects a click outside the latest screenshot bounds and returns the executed pixel point for audit.
- A successful click result proves only that input was injected. Observe afterward and verify the requested UI state before claiming success.
- When opening a named desktop or Start-menu application, use computer action=launch with its exact visible name. Do not click an icon or manually operate Windows Search unless launch reports that no unambiguous shortcut exists.
- After launch, observe once and verify the foreground application or visible window before reporting success.
- For a request that only asks to open an application, a clearly visible matching application window proves success. Do not continue into login or application use unless the user requested it.
- Identify an icon from a clearly readable label, not from color or logo resemblance. If the post-click observation shows a different application or file, switch methods instead of guessing another coordinate from the same image.
- Use the smallest input action and observe again after every state change.
- Once a post-action observation visibly proves the requested target state, stop and report success instead of repeating equivalent observations.
- Common Windows key names include WIN or SUPER, CTRL, ALT, SHIFT, ENTER, ESC, TAB, and arrow keys.
- Never type secrets unless the host provides a protected fill primitive.
- If a locked Windows secure desktop prevents capture, retry once, then ask the host to unlock it; never attempt to bypass authentication.
- External, destructive, privacy-sensitive, or costly actions require host approval and direct verification.`,
  required: true,
  activation: [{
    toolName: 'computer',
    actions: ['observe', 'launch', 'click', 'type', 'key', 'scroll', 'wait'],
  }],
} satisfies CapabilitySkill);
