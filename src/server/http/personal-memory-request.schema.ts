import { z } from 'zod';

export const personalMemoryRequestSchema = z.object({
  id: z.string().trim().max(120).optional(),
  scope: z.enum(['global', 'domain']).default('global'),
  domain: z.string().trim().max(1_000).default(''),
  type: z.enum(['alias', 'preference', 'workflow', 'domain_fact']).default('preference'),
  key: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().max(80)).max(20).default([]),
  value: z.string().trim().min(1).max(260),
  confidence: z.number().min(0).max(1).default(1),
  sourceUrl: z.string().trim().max(2_000).optional(),
  status: z.enum(['active', 'disabled']).default('active'),
  shared: z.boolean().optional(),
  recall: z.enum(['always', 'relevant']).optional(),
}).strict();

export const personalMemoryPatchSchema = z.object({
  scope: z.enum(['global', 'domain']).optional(),
  domain: z.string().trim().max(1_000).optional(),
  type: z.enum(['alias', 'preference', 'workflow', 'domain_fact']).optional(),
  key: z.string().trim().min(1).max(120).optional(),
  aliases: z.array(z.string().trim().max(80)).max(20).optional(),
  value: z.string().trim().min(1).max(260).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceUrl: z.string().trim().max(2_000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  shared: z.boolean().optional(),
  recall: z.enum(['always', 'relevant']).optional(),
}).strict();
