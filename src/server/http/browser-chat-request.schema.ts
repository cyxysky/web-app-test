import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).optional();
const userId = z.union([z.string().trim().min(1).max(120), z.number().finite()]).optional();

export const browserChatAttachmentSchema = z.object({
  id: text(120),
  name: text(500),
  type: text(200),
  size: z.number().finite().nonnegative().optional(),
  path: text(4_000),
  url: text(4_000),
  kind: z.enum(['image', 'file', 'tab']).optional(),
  sourceUrl: optionalText(4_000),
}).strict();

const browserChatSettingsSchema = z.object({
  safetyMode: z.enum(['strict', 'full']).default('strict'),
  modelProvider: optionalText(120),
  model: optionalText(240),
});

export const createBrowserChatSessionRequestSchema = browserChatSettingsSchema.extend({
  targetUrl: text(4_000).default(''),
  title: optionalText(240),
  workflowMode: z.enum(['chat', 'target']).default('chat'),
  userId,
  qzUserId: userId,
}).strict();

export const sendBrowserChatMessageRequestSchema = browserChatSettingsSchema.extend({
  content: text(100_000).default(''),
  clientMessageId: optionalText(120),
  attachments: z.array(browserChatAttachmentSchema).max(100).default([]),
  skillIds: z.array(text(120)).max(100).default([]),
  userId,
  qzUserId: userId,
}).strict();

export type CreateBrowserChatSessionRequest = z.infer<typeof createBrowserChatSessionRequestSchema>;
export type SendBrowserChatMessageRequest = z.infer<typeof sendBrowserChatMessageRequestSchema>;
