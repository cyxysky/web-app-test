import { z } from 'zod';

export const browserMouseToolDescription = 'Unified mouse tool. Prefer a fresh snapshot uid for semantic targets. Use x_thousandth/y_thousandth only against the latest viewport screenshot. UID actions automatically reveal offscreen targets. action=scroll may omit a target to scroll the page; drag uses toUid or toX/toY.';

export const browserMouseToolShape = {
  action: z.enum(['click', 'move', 'drag', 'scroll', 'scrollIntoView']),
  uid: z.string().optional().describe('Fresh uid from the latest takeSnapshot result.'),
  x_thousandth: z.number().int().min(1).max(999).optional().describe('Horizontal position in the latest viewport screenshot, from 1 to 999.'),
  y_thousandth: z.number().int().min(1).max(999).optional().describe('Vertical position in the latest viewport screenshot, from 1 to 999.'),
  toUid: z.string().optional().describe('Drag destination uid.'),
  toX_thousandth: z.number().int().min(1).max(999).optional().describe('Drag destination horizontal screenshot coordinate.'),
  toY_thousandth: z.number().int().min(1).max(999).optional().describe('Drag destination vertical screenshot coordinate.'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  deltaX: z.number().optional().describe('Horizontal wheel delta for action=scroll.'),
  deltaY: z.number().optional().describe('Vertical wheel delta for action=scroll.'),
} satisfies z.ZodRawShape;

export const browserKeyboardToolDescription = 'Unified keyboard tool. action=type can focus a fresh uid or latest viewport screenshot coordinate before entering text. When the runtime provides a credential reference, use credentialRef instead of putting the secret in text. action=press sends one key; action=shortcut sends a key combination. Never use keyboard letters, ArrowUp/ArrowDown, or Enter to choose an option from a native HTML <select>; use selectOption with the select UID and an exact value or full label.';

export const browserKeyboardToolShape = {
  action: z.enum(['type', 'press', 'shortcut']),
  uid: z.string().optional().describe('Fresh uid to focus before keyboard input.'),
  x_thousandth: z.number().int().min(1).max(999).optional().describe('Horizontal position in the latest viewport screenshot, from 1 to 999.'),
  y_thousandth: z.number().int().min(1).max(999).optional().describe('Vertical position in the latest viewport screenshot, from 1 to 999.'),
  text: z.string().optional(),
  credentialRef: z.string().min(1).max(200).optional().describe('Opaque runtime credential reference. For secret input use this instead of text; the model never receives the underlying value.'),
  key: z.string().optional(),
  keys: z.array(z.string().min(1)).max(6).optional(),
  replace: z.boolean().optional().describe('For action=type, replace existing content unless false.'),
  followByEnter: z.boolean().optional(),
} satisfies z.ZodRawShape;

export const browserSelectOptionToolDescription = 'Select one option from a native HTML <select>. Use the select uid from takeSnapshot plus an exact option value or visible label shown in that select\'s options attribute. This does not open the platform dropdown.';

export const browserSelectOptionToolShape = {
  uid: z.string().min(1).describe('Fresh uid of the native select from takeSnapshot.'),
  value: z.string().min(1).optional().describe('Exact option value shown in the select options attribute. Preferred when present.'),
  label: z.string().min(1).optional().describe('Exact visible option label shown in the select options attribute.'),
} satisfies z.ZodRawShape;
