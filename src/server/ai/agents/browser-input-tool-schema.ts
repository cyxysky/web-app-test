import { z } from 'zod';

export const browserInteractToolDescription = 'Unified page-interaction tool. action=click, move, drag, scroll, and scrollIntoView handle pointer input; action=type, press, and shortcut handle keyboard input; action=selectOption chooses a native HTML <select> option without opening the platform dropdown. Prefer a fresh inspect action=capture uid for semantic targets. Use x_thousandth/y_thousandth only against the latest viewport screenshot. When the runtime provides a credential reference, use credentialRef instead of putting the secret in text.';

export const browserInteractToolShape = {
  action: z.enum(['click', 'move', 'drag', 'scroll', 'scrollIntoView', 'type', 'press', 'shortcut', 'selectOption']),
  uid: z.string().optional().describe('Fresh uid from the latest inspect action=capture result.'),
  x_thousandth: z.number().int().min(1).max(999).optional().describe('Horizontal position in the latest viewport screenshot, from 1 to 999.'),
  y_thousandth: z.number().int().min(1).max(999).optional().describe('Vertical position in the latest viewport screenshot, from 1 to 999.'),
  toUid: z.string().optional().describe('Drag destination uid.'),
  toX_thousandth: z.number().int().min(1).max(999).optional().describe('Drag destination horizontal screenshot coordinate.'),
  toY_thousandth: z.number().int().min(1).max(999).optional().describe('Drag destination vertical screenshot coordinate.'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  deltaX: z.number().optional().describe('Horizontal wheel delta for action=scroll.'),
  deltaY: z.number().optional().describe('Vertical wheel delta for action=scroll.'),
  text: z.string().optional(),
  credentialRef: z.string().min(1).max(200).optional().describe('Opaque runtime credential reference. For secret input use this instead of text; the model never receives the underlying value.'),
  key: z.string().optional(),
  keys: z.array(z.string().min(1)).max(6).optional(),
  replace: z.boolean().optional().describe('For action=type, replace existing content unless false.'),
  followByEnter: z.boolean().optional(),
  value: z.string().min(1).optional().describe('Exact option value shown in the select options attribute. Preferred when present.'),
  label: z.string().min(1).optional().describe('Exact visible option label shown in the select options attribute.'),
} satisfies z.ZodRawShape;
