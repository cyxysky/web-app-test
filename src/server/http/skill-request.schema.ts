import { z } from 'zod';
import { skillResourceSchema } from '@/server/ai/schemas/runtime.schema';

export const skillRequestSchema = z.object({
  id: z.string().trim().max(200).optional(),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(4_000).default(''),
  triggerPhrases: z.array(z.string().trim().max(500)).max(100).default([]),
  content: z.object({ details: z.string().max(100_000).default(''), resources: z.array(skillResourceSchema).max(20).optional() }).strict(),
  sourceSessionId: z.string().trim().max(200).optional(),
  status: z.enum(['draft', 'ready', 'disabled']).default('ready'),
  shared: z.boolean().optional(),
}).strict();
