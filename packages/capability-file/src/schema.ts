import { z } from 'zod';
import { defineCapabilityInput } from '@webpilot/capability-sdk';
import { normalizeFileToolInput } from './transport.js';
import { fileActionInputIssues } from './action-guidance.js';
import { officeDesignBriefSchema } from './design-guidance.js';
import {
  fileModelActions,
  fileVisualToolActions,
  type FileToolInput,
} from './types.js';

export const FILE_READ_MAX_CHARS = 40_000;

const semanticCellSchema = z.union([
  z.string().max(20_000), z.number().finite(), z.boolean(), z.null(),
]);
const semanticBlockSchema: z.ZodType<Record<string, unknown>> = z.lazy(() => z.object({
  id: z.string().min(1).max(128).optional(),
  type: z.enum([
    'page', 'sheet', 'text', 'heading', 'list', 'quote', 'code', 'image', 'svg',
    'chart', 'table', 'card', 'columns', 'metric', 'timeline', 'shape', 'divider',
    'spacer', 'pageBreak',
  ]),
  template: z.enum([
    'cover', 'section', 'content', 'two-column', 'comparison', 'kpi', 'chart',
    'image', 'reference', 'report', 'worksheet',
  ]).optional(),
  title: z.string().max(2_000).optional(),
  subtitle: z.string().max(4_000).optional(),
  name: z.string().max(500).optional(),
  language: z.string().max(40).optional(),
  level: z.number().int().min(0).max(9).optional(),
  ordered: z.boolean().optional(),
  breakBefore: z.literal('page').optional(),
  fit: z.literal('contain').optional(),
  shapeType: z.string().max(80).optional(),
  chartType: z.string().max(80).optional(),
  text: z.string().max(40_000).optional(),
  markdown: z.string().max(40_000).optional(),
  source: z.string().max(500).optional(),
  alt: z.string().max(1_000).optional(),
  caption: z.string().max(2_000).optional(),
  items: z.array(z.unknown()).max(500).optional(),
  rows: z.array(z.array(semanticCellSchema).max(64)).max(5_000).optional(),
  children: z.array(semanticBlockSchema).max(240).optional(),
  columns: z.array(z.object({
    width: z.union([z.number().positive(), z.string().regex(/^\d+(?:\.\d+)?%$/)]).optional(),
    blocks: z.array(semanticBlockSchema).max(120).optional(),
  }).strict()).max(4).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  style: z.record(z.string(), z.unknown()).optional(),
}).strict());

const semanticSpecSchema = z.object({
  schemaVersion: z.literal('1.0').optional(),
  documentType: z.enum(['word', 'spreadsheet', 'presentation']).optional(),
  fileName: z.string().max(180).optional(),
  document: z.object({
    title: z.string().max(2_000).optional(),
    description: z.string().max(4_000).optional(),
    author: z.string().max(500).optional(),
    language: z.string().max(40).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    defaultStyle: z.record(z.string(), z.unknown()).optional(),
    page: z.object({
      backgroundColor: z.string().max(20).optional(),
      footer: z.string().max(2_000).optional(),
      header: z.string().max(2_000).optional(),
      height: z.number().positive().optional(),
      marginBottom: z.number().nonnegative().optional(),
      marginLeft: z.number().nonnegative().optional(),
      marginRight: z.number().nonnegative().optional(),
      marginTop: z.number().nonnegative().optional(),
      orientation: z.enum(['landscape', 'portrait']).optional(),
      showPageNumber: z.boolean().optional(),
      unit: z.enum(['cm', 'in', 'mm', 'pt', 'px']).optional(),
      width: z.number().positive().optional(),
    }).strict().optional(),
  }).strict().optional(),
  theme: z.union([
    z.enum(['clean', 'editorial', 'executive', 'signal']),
    z.object({
      version: z.literal('1').optional(),
      preset: z.enum(['clean', 'editorial', 'executive', 'signal']).optional(),
      colors: z.object({
        accent: z.string().max(20).optional(),
        background: z.string().max(20).optional(),
        border: z.string().max(20).optional(),
        muted: z.string().max(20).optional(),
        primary: z.string().max(20).optional(),
        secondary: z.string().max(20).optional(),
        surface: z.string().max(20).optional(),
        text: z.string().max(20).optional(),
      }).strict().optional(),
      fonts: z.object({
        body: z.string().max(120).optional(),
        heading: z.string().max(120).optional(),
        mono: z.string().max(120).optional(),
      }).strict().optional(),
      typography: z.object({
        body: z.number().finite().optional(),
        caption: z.number().finite().optional(),
        heading: z.number().finite().optional(),
        metric: z.number().finite().optional(),
        title: z.number().finite().optional(),
      }).strict().optional(),
    }).strict(),
  ]).optional(),
  layout: z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(['repair', 'strict']).optional(),
    overflow: z.enum(['split', 'shrink', 'error']).optional(),
    imageFit: z.literal('contain').optional(),
    safeMargin: z.number().positive().optional(),
    minPresentationBodyFontSize: z.number().positive().optional(),
    minWordBodyFontSize: z.number().positive().optional(),
    minSpreadsheetFontSize: z.number().positive().optional(),
    maxCharactersPerSlide: z.number().int().positive().optional(),
    maxContentUnitsPerSlide: z.number().positive().optional(),
    maxListItemsPerSlide: z.number().int().positive().optional(),
    maxTableRowsPerSlide: z.number().int().positive().optional(),
    maxTableColumns: z.number().int().positive().optional(),
  }).strict().optional(),
  blocks: z.array(semanticBlockSchema).min(1).max(240),
}).strict().describe(
  'Compact semantic create spec. Templates own layout geometry; layout repair/splitting is enabled by default. Use only for a newly created UNO document.',
);

const fileToolShape = {
  reason: z.string().min(1).max(300).optional()
    .describe('User-visible explanation only. Saying "read source" here does NOT select source reading; action and identity fields control behavior.'),
  attachmentId: z.string().max(160).optional()
    .describe('For readContent: exact uploaded attachment id. Not a draft id and not usable to read generation source.'),
  artifactId: z.string().max(4_000).optional()
    .describe('For readContent/visualIndex/visualRead/visualReport: exact finished-file artifact id from render/download/convert. Reading an .xlsx artifact returns spreadsheet content, NOT Python source.'),
  sourceArtifactId: z.string().max(4_000).optional()
    .describe('For convert: exact artifact id of the existing Office file to export as PDF. Does not read or modify generation source.'),
  documentId: z.string().max(96).optional()
    .describe('Draft identity for plan, readSource, generate, edit, render and API lookup. Copy from list/plan/render; never substitute artifactId, fileName, sourceFileName or a host path. New ids use 1-96 ASCII letters/numbers/dot/underscore/hyphen.'),
  fileName: z.string().max(180).optional()
    .describe('For plan/download/convert: output name with extension. A name is not an artifactId or documentId. The bundled convert currently outputs PDF only; omit the name or use .pdf.'),
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
  design: officeDesignBriefSchema.optional()
    .describe('For initial plan: template for conventional fast files; bespoke for original art direction. Bespoke records audience/objective, 2–3 distinct directions (or one grounded user reference), selectedDirection, selectionReason and page rhythm. This is not a visual pass or permission to delete requested content.'),
  url: z.string().max(8_000).optional()
    .describe('For download: verified direct file URL, not a search result, preview webpage, artifactId or source-unit path.'),
  path: z.string().max(8_000).optional()
    .describe('For readSource/edit: exact source-unit path returned by readSource, not draft.py, an Office filename or filesystem path. For download only: a real local source path.'),
  startLine: z.number().int().min(1).optional()
    .describe('For readSource only: one-based first code line; use the returned coordinateSpace when a source-unit path is selected. Maximum 80 lines per response.'),
  endLine: z.number().int().min(1).optional()
    .describe('For readSource only: inclusive last code line, at least startLine. This is not a worksheet row or PDF page number.'),
  includeDiagnostics: z.boolean().optional()
    .describe('readSource only, default false: include saved diagnostic details, NOT a new validation run. Check validationEvidence source/worker freshness before treating old errors as current blockers. Ordinary reads return counts, not full warnings.'),
  urlOrPath: z.string().max(8_000).optional()
    .describe('For download: real HTTP(S) file URL or page-relative URL path resolved against sourcePageUrl. Not an operating-system path. Local assets must be uploaded/host-bound attachments. Supply exactly one of urlOrPath/url/path.'),
  program: z.string().optional()
    .describe('For generate: executable source for advanced/program workflows. Provide program or spec, never both. If a working source exists, prefer edit.'),
  spec: semanticSpecSchema.optional()
    .describe('For generate: compact Word, spreadsheet, or presentation content using versioned themes and semantic templates. Provide spec or program, never both.'),
  baseDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional()
    .describe('For edit/guarded full replacement: copy EXACTLY readSource.patchBaseDigest from the latest read of this document. Do not use sourceDigest, sourceUnitDigest, renderedDigest or an artifact id.'),
  replaceExisting: z.boolean().optional()
    .describe('Exceptional generate-only full replacement after reading the complete current source; ordinary revisions should use edit.'),
  patch: z.string().max(200_000).optional()
    .describe("For edit, use patch OR replacements. Codex patch: Begin Patch, Update File: draft.py, @@ hunks, End Patch. Literal -old/+new markers are separate from ALL source indentation. Every target must match uniquely and exactly on the SAME pre-edit snapshot. Any conflict rejects the WHOLE call; no partial saves or automatic stale-version rebase. Prefer replacements for small fixes."),
  replacements: z.array(z.object({
    oldText: z.string().min(1).max(100_000).describe('Exact unique source substring copied from readSource.program, including ALL indentation; no diff markers or line numbers. Include surrounding code to disambiguate. Cannot be empty.'),
    newText: z.string().max(100_000).describe('Replacement source verbatim, preserving intended indentation. Empty string deletes oldText. For insertion include the old anchor in newText.'),
  }).strict()).min(1).max(50).optional()
    .refine((items) => !items || items.reduce((sum, item) => sum + item.oldText.length + item.newText.length, 0) <= 200_000, 'Replacement text exceeds 200000 characters')
    .describe('Preferred for small/indentation repairs: unique exact oldText/newText pairs on the SAME pre-edit snapshot. All pairs commit together or NONE do; combine helper and caller changes in one call. No whitespace guessing. Missing oldText is a conflict, not proof of previous success. Use documentId and latest baseDigest; inspect saved and validation separately.'),
  render: z.boolean().optional()
    .describe('Legacy generate/edit flag; use a separate action=render to publish. generate/edit create or validate source, not a deliverable download.'),
  includeVisuals: z.boolean().optional()
    .describe('For readContent only: false by default; true explicitly attaches rendered pages. Text reading is not visual QA. Prefer visualIndex + visualRead for page inspection.'),
  offset: z.number().int().min(0).optional()
    .describe('readContent: zero-based character offset. visualIndex: zero-based screenshot-list offset. Never a source line number.'),
  sheet: z.string().trim().min(1).max(200).optional().describe('readContent: exact spreadsheet worksheet name.'),
  range: z.string().trim().min(1).max(40).optional().describe('readContent: A1 cell/range, for example A1:D20; specify sheet for multi-sheet files.'),
  contentPages: z.array(z.number().int().min(1)).min(1).max(100).optional().describe('readContent: PDF text pages, one-based. Independent from visual-preview pages.'),
  section: z.string().trim().min(1).max(300).optional().describe('readContent: exact, unique DOCX heading; reads through the next heading of the same or higher level.'),
  limit: z.number().int().min(1).max(FILE_READ_MAX_CHARS).optional()
    .describe('readContent: maximum text characters (default 8000, max 40000), NOT source lines. visualIndex: maximum index entries (default 100, max 200). readSource uses startLine/endLine instead.'),
  pages: z.array(z.number().int().min(1)).max(6).optional()
    .describe('Only for readContent(includeVisuals=true): one-based rendered/printed page numbers, at most six. A worksheet may span multiple pages. visualRead instead uses screenshotIds.'),
  query: z.string().max(1_000).optional()
    .describe('For an API lookup: omit to list modules, then pass an exact module id returned by that index.'),
} satisfies z.ZodRawShape;

const visualQaCheckStatusSchema = z.enum(['failed', 'not-applicable', 'passed'])
  .describe('No warning check status. Any unresolved visible defect requires failed. Warning is only an issue severity, not permission to pass the check.');
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
  designIntent: z.enum(['failed', 'passed']).optional()
    .describe('Required for bespoke plans: rendered hierarchy, type, imagery and data expression realize the selected design direction and preserved requirements, not merely its palette.'),
  compositionRhythm: z.enum(['failed', 'passed']).optional()
    .describe('Required for bespoke plans: composition and density serve page purposes; repetition is intentional for comparable content, not a universal shell. Do not impose arbitrary layout quotas.'),
  contentConsistency: z.enum(['failed', 'passed']).optional()
    .describe('Required for bespoke plans: recompute displayed changes/shares/totals from the same data used by charts; verify titles, axes, units, dates and callouts agree across pages. Pixel inspection alone cannot pass this check. Describe concrete calculations and page numbers in observation.'),
  sourceTraceability: z.enum(['failed', 'passed']).optional()
    .describe('Required for bespoke plans: material factual values match actually accessed source rows, periods and accounting basis. Assumptions are visibly identified. A successful fetch is not verification. Describe exact source/table references in observation; missing evidence means failed.'),
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
    .describe('For visualReport: conclusions for pages actually seen via visualRead on this artifact. passed requires no failed checks and no issues; failed requires a failed check and concrete issues. Reporting does not modify source.'),
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
      context.addIssue({ code: 'custom', message: `A passed review cannot contain failed checks: ${failedChecks.join(', ')}. Set status=failed and retain the failed checks and issue details; do not relabel a defect as passed.`, path: ['reviews', index, 'status'] });
    }
    if (review.status === 'failed' && !failedChecks.length) {
      context.addIssue({ code: 'custom', message: 'A failed review requires at least one failed check. Mark the check corresponding to the documented defect as failed; keep status=failed and the issue details.', path: ['reviews', index, 'checks'] });
    }
    if (review.status === 'passed' && review.issues?.length) {
      context.addIssue({ code: 'custom', message: 'A passed review cannot contain issues. Retain the issues (including warnings), set status=failed and mark the corresponding check failed. Do not delete issues or move them only into observation to obtain passed.', path: ['reviews', index, 'issues'] });
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
    context.addIssue({ code: 'custom', message: `A passed deckReview cannot contain failed checks: ${failedChecks.join(', ')}. Set status=failed and retain the failed checks and issues.`, path: ['deckReview', 'status'] });
  }
  if (input.deckReview.status === 'failed' && !failedChecks.length) {
    context.addIssue({ code: 'custom', message: 'A failed deckReview requires at least one failed check. Mark the cross-page check corresponding to the documented defect as failed; do not change status to passed to satisfy the schema.', path: ['deckReview', 'checks'] });
  }
  if (input.deckReview.status === 'passed' && input.deckReview.issues?.length) {
    context.addIssue({ code: 'custom', message: 'A passed deckReview cannot contain issues. Retain the issues, set status=failed and mark the corresponding check failed. Do not hide defects in observation or claim user acceptance without an explicit user instruction.', path: ['deckReview', 'issues'] });
  }
  if (input.deckReview.status === 'failed' && !input.deckReview.issues?.length) {
    context.addIssue({ code: 'custom', message: 'A failed deckReview requires issue details.', path: ['deckReview', 'issues'] });
  }
}

function createFileToolSchema(visualInputAvailable: boolean) {
  const action = visualInputAvailable
    ? z.enum([...fileModelActions, ...fileVisualToolActions])
      .describe('Required. readSource + documentId = editable code; readContent + artifactId/attachmentId = file text/data; visualIndex/visualRead/visualReport = rendered-page QA. generate/edit validate source; render publishes it.')
    : z.enum(fileModelActions)
      .describe('Required. list, readSource (draft code), readContent (file text/data), download, convert, plan, generate, edit, unoApi, jsApi, render. Source and content reading use different identities.');
  const schema = z.object({
    action,
    ...fileToolShape,
    ...(visualInputAvailable ? fileVisualToolShape : {}),
  }).passthrough().superRefine((input, context) => {
    for (const issue of fileActionInputIssues(input as FileToolInput)) {
      context.addIssue({ code: 'custom', message: issue.message, path: [issue.field] });
    }
    if (input.action === 'generate') {
      const hasProgram = typeof input.program === 'string' && Boolean(input.program.trim());
      const hasSpec = Boolean(input.spec);
      if (hasProgram === hasSpec) {
        context.addIssue({
          code: 'custom',
          message: 'generate requires exactly one of program or spec.',
          path: hasProgram ? ['spec'] : ['program'],
        });
      }
    } else if (input.spec) {
      context.addIssue({ code: 'custom', message: 'spec is accepted only for action=generate.', path: ['spec'] });
    }
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
