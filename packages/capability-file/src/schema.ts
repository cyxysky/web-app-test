import { z } from 'zod';
import { defineCapabilityInput } from '@webpilot/capability-sdk';
import { normalizeFileToolInput } from './transport.js';
import {
  fileActions,
  fileVisualToolActions,
  type FileToolInput,
} from './types.js';

export const FILE_READ_MAX_CHARS = 40_000;

const fileToolShape = {
  reason: z.string().min(1).max(300).optional()
    .describe('Optional concise reason; it never changes file behavior.'),
  attachmentId: z.string().max(160).optional()
    .describe('Exact attachment id supplied by the host.'),
  artifactId: z.string().max(4_000).optional()
    .describe('Exact artifact id returned by a previous file operation.'),
  sourceArtifactId: z.string().max(4_000).optional()
    .describe('For convert: exact artifact id of the source Office file.'),
  documentId: z.string().max(96).optional()
    .describe('Stable host-scoped id reused for one logical document. Use 1-96 ASCII letters, numbers, dot, underscore, or hyphen.'),
  fileName: z.string().max(180).optional()
    .describe('Output file name including the target extension.'),
  fileType: z.string().regex(/^[a-z0-9]{1,10}$/).optional()
    .describe('For download: expected extension without a dot.'),
  documentType: z.enum(['word', 'spreadsheet', 'presentation']).optional()
    .describe('Required for plan. Common Office extension aliases are normalized before validation.'),
  operation: z.enum(['create', 'modify']).optional()
    .describe('For plan: create a new document or modify an attached existing Office document.'),
  sourceAttachmentId: z.string().max(160).optional()
    .describe('For operation=modify: exact attachment id of the existing Office file.'),
  intent: z.string().max(8_000).optional()
    .describe('For plan: concise description of the document to create or modify.'),
  url: z.string().max(8_000).optional(),
  path: z.string().max(8_000).optional()
    .describe('For draft read/edit: an optional semantic source-unit path returned by read; for download: a source path.'),
  startLine: z.number().int().min(1).optional()
    .describe('For draft read: optional one-based first source line.'),
  endLine: z.number().int().min(1).optional()
    .describe('For draft read: optional inclusive last source line.'),
  urlOrPath: z.string().max(8_000).optional(),
  program: z.string().optional()
    .describe('Required for initial generate. If a working source exists, prefer edit. The host runtime defines the supported program API.'),
  baseDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional()
    .describe('For edit or intentional full replacement: exact digest returned by the latest read of the same document and path.'),
  replaceExisting: z.boolean().optional()
    .describe('Exceptional generate-only full replacement after reading the complete current source; ordinary revisions should use edit.'),
  patch: z.string().max(200_000).optional()
    .describe("For edit: one Codex apply_patch document with '*** Begin Patch', '*** Update File: draft.py', changed @@ hunks, and '*** End Patch'."),
  render: z.boolean().optional(),
  includeVisuals: z.boolean().optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(FILE_READ_MAX_CHARS).optional(),
  pages: z.array(z.number().int().min(1)).max(6).optional(),
  query: z.string().max(1_000).optional()
    .describe('For an API lookup: omit to list modules, then pass an exact module id returned by that index.'),
} satisfies z.ZodRawShape;

const visualQaCheckStatusSchema = z.enum(['failed', 'not-applicable', 'passed']);
const visualQaPageChecksSchema = z.object({
  overlap: visualQaCheckStatusSchema,
  clipping: visualQaCheckStatusSchema,
  alignment: visualQaCheckStatusSchema,
  spacing: visualQaCheckStatusSchema,
  typography: visualQaCheckStatusSchema,
  contrast: visualQaCheckStatusSchema,
  visualHierarchy: visualQaCheckStatusSchema,
  chartTableLegibility: visualQaCheckStatusSchema,
  imageQuality: visualQaCheckStatusSchema,
}).strict();
const visualQaDeckChecksSchema = z.object({
  templateConsistency: z.enum(['failed', 'passed']),
  typographyConsistency: z.enum(['failed', 'passed']),
  colorConsistency: z.enum(['failed', 'passed']),
  spacingRhythm: z.enum(['failed', 'passed']),
  componentConsistency: z.enum(['failed', 'passed']),
}).strict();
const visualQaIssuesSchema = z.array(z.object({
  type: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  region: z.string().max(120).optional(),
  severity: z.enum(['error', 'warning']).optional(),
}).strict()).max(50).optional();

const fileVisualToolShape = {
  screenshotIds: z.array(z.string().min(1).max(40)).min(1).max(8).optional()
    .describe('For visualRead: one to eight exact screenshot ids returned by visualIndex.'),
  reviews: z.array(z.object({
    screenshotId: z.string().min(1).max(40),
    status: z.enum(['failed', 'passed']),
    observation: z.string().trim().min(20).max(1_000)
      .describe('Concrete page-specific pixel evidence covering composition and readability.'),
    checks: visualQaPageChecksSchema,
    issues: visualQaIssuesSchema,
  }).strict()).min(1).max(100).optional()
    .describe('For visualReport: evidence-backed conclusions for pages already read from this artifact.'),
  deckReview: z.object({
    status: z.enum(['failed', 'passed']),
    observation: z.string().trim().min(30).max(2_000)
      .describe('Concrete cross-page comparison of the complete rendered artifact.'),
    checks: visualQaDeckChecksSchema,
    issues: visualQaIssuesSchema,
  }).strict().optional()
    .describe('Complete-document consistency review submitted after every page has been read and reviewed.'),
} satisfies z.ZodRawShape;

function validateVisualInput(input: FileToolInput, context: z.RefinementCtx) {
  if (fileVisualToolActions.some((action) => action === input.action) && !input.artifactId?.trim()) {
    context.addIssue({ code: 'custom', message: `${input.action} requires artifactId.`, path: ['artifactId'] });
  }
  if (input.action === 'visualRead' && !input.screenshotIds?.length) {
    context.addIssue({ code: 'custom', message: 'visualRead requires screenshotIds.', path: ['screenshotIds'] });
  }
  if (input.action === 'visualReport' && !input.reviews?.length) {
    context.addIssue({ code: 'custom', message: 'visualReport requires reviews.', path: ['reviews'] });
  }
  for (const [index, review] of (input.reviews || []).entries()) {
    const failedChecks = Object.entries(review.checks)
      .filter(([, status]) => status === 'failed')
      .map(([name]) => name);
    const invalidNotApplicable = Object.entries(review.checks)
      .filter(([name, status]) => (
        status === 'not-applicable'
        && name !== 'chartTableLegibility'
        && name !== 'imageQuality'
      ))
      .map(([name]) => name);
    if (invalidNotApplicable.length) {
      context.addIssue({
        code: 'custom',
        message: `Only chartTableLegibility and imageQuality may be not-applicable; invalid: ${invalidNotApplicable.join(', ')}.`,
        path: ['reviews', index, 'checks'],
      });
    }
    if (review.status === 'passed' && failedChecks.length) {
      context.addIssue({ code: 'custom', message: `A passed review cannot contain failed checks: ${failedChecks.join(', ')}.`, path: ['reviews', index, 'status'] });
    }
    if (review.status === 'failed' && !failedChecks.length) {
      context.addIssue({ code: 'custom', message: 'A failed review requires at least one failed check.', path: ['reviews', index, 'checks'] });
    }
    if (review.status === 'passed' && review.issues?.length) {
      context.addIssue({ code: 'custom', message: 'A passed review cannot contain issues.', path: ['reviews', index, 'issues'] });
    }
    if (review.status === 'failed' && !review.issues?.length) {
      context.addIssue({ code: 'custom', message: 'A failed review requires issue details.', path: ['reviews', index, 'issues'] });
    }
  }
  if (!input.deckReview) return;
  const failedChecks = Object.entries(input.deckReview.checks)
    .filter(([, status]) => status === 'failed')
    .map(([name]) => name);
  if (input.deckReview.status === 'passed' && failedChecks.length) {
    context.addIssue({ code: 'custom', message: `A passed deckReview cannot contain failed checks: ${failedChecks.join(', ')}.`, path: ['deckReview', 'status'] });
  }
  if (input.deckReview.status === 'failed' && !failedChecks.length) {
    context.addIssue({ code: 'custom', message: 'A failed deckReview requires at least one failed check.', path: ['deckReview', 'checks'] });
  }
  if (input.deckReview.status === 'passed' && input.deckReview.issues?.length) {
    context.addIssue({ code: 'custom', message: 'A passed deckReview cannot contain issues.', path: ['deckReview', 'issues'] });
  }
  if (input.deckReview.status === 'failed' && !input.deckReview.issues?.length) {
    context.addIssue({ code: 'custom', message: 'A failed deckReview requires issue details.', path: ['deckReview', 'issues'] });
  }
}

function createFileToolSchema(visualInputAvailable: boolean) {
  const action = visualInputAvailable
    ? z.enum([...fileActions, ...fileVisualToolActions]).optional()
      .describe('Exactly one file action, including visualIndex, visualRead, and visualReport for rendered-page inspection.')
    : z.enum(fileActions).optional()
      .describe('Exactly one action: list, read, download, convert, plan, generate, edit, unoApi, jsApi, or render.');
  const schema = z.object({
    action,
    ...fileToolShape,
    ...(visualInputAvailable ? fileVisualToolShape : {}),
  }).passthrough().superRefine((input, context) => {
    if (visualInputAvailable) validateVisualInput(input as FileToolInput, context);
  });
  return z.preprocess(normalizeFileToolInput, schema);
}

export function createFileToolInput(visualInputAvailable: boolean) {
  const schema = createFileToolSchema(visualInputAvailable);
  return defineCapabilityInput<FileToolInput>(
    z.toJSONSchema(schema) as Record<string, unknown>,
    (value) => schema.parse(value) as FileToolInput,
  );
}

export const fileToolInput = createFileToolInput(false);
