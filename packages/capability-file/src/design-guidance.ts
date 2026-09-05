import { z } from 'zod';
import type { OfficeDesignBrief, OfficeDocumentDraft, OfficeVisualQaDeckChecks } from './office/types.js';

const sentence = z.string().trim().min(1).max(320);

/** Shared validation for model tools and direct workspace callers. Keep this brief, not a second draft. */
export const officeDesignBriefSchema = z.object({
  mode: z.enum(['template', 'bespoke']),
  audience: sentence.optional(),
  objective: sentence.optional(),
  reference: z.string().trim().min(1).max(500).describe('A concrete user-supplied deck, image, URL or named visual reference that fixes composition. Quality adjectives such as world-class, Swiss precision, restrained or cinematic are NOT a reference; compare 2-3 distinct directions instead.').optional(),
  directions: z.array(z.object({
    id: z.string().trim().min(1).max(40),
    concept: sentence,
    composition: sentence,
    typography: sentence,
    imagery: sentence,
  }).strict()).min(1).max(3).optional(),
  selectedDirection: z.string().trim().min(1).max(40).optional(),
  selectionReason: sentence.optional(),
  rhythm: sentence.optional(),
  preserve: z.array(sentence).max(8).optional(),
  avoid: z.array(sentence).max(8).optional(),
}).strict().superRefine((brief, context) => {
  const ids = (brief.directions || []).map((direction) => direction.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['directions'], message: 'Design direction IDs must be unique.' });
  if (brief.selectedDirection && !ids.includes(brief.selectedDirection)) {
    context.addIssue({ code: 'custom', path: ['selectedDirection'], message: 'selectedDirection must identify one of directions, not a theme preset.' });
  }
  if (brief.mode !== 'bespoke') return;
  for (const key of ['audience', 'objective', 'directions', 'selectedDirection', 'selectionReason', 'rhythm'] as const) {
    if (!brief[key]) context.addIssue({ code: 'custom', path: [key], message: `Bespoke design requires ${key}. Record concrete content-led decisions, not quality adjectives.` });
  }
  if (!brief.reference && ids.length < 2) {
    context.addIssue({ code: 'custom', path: ['directions'], message: 'Compare 2–3 directions with different composition/type/image strategies, or provide the user-supplied reference that already fixes the direction. Do not render several full decks.' });
  }
});

type DesignContext = Pick<OfficeDocumentDraft, 'design' | 'intent' | 'operation' | 'documentType'>;

export function officeDesignGuidance(draft: DesignContext) {
  // Intent only recommends a path. Never block a legacy task or override an explicit mode by keyword.
  const bespokeRequested = /世界级.{0,24}(?:设计|视觉|排版|审美)|(?:瑞士|编辑)排版|电影级视觉|脸谱化|(?:独特|定制|原创).{0,12}(?:设计|视觉|排版)|world[ -]?class.{0,24}(?:design|visual|typography)|bespoke|art direction/i.test(draft.intent || '');
  const mode = draft.design?.mode || (bespokeRequested ? 'bespoke' : 'template');
  const selected = draft.design?.directions?.find((item) => item.id === draft.design?.selectedDirection);
  return {
    mode,
    briefRecorded: Boolean(draft.design),
    selectedDirection: selected?.id,
    concept: selected?.concept,
    authoring: draft.operation === 'modify' || mode === 'bespoke' ? 'program' : 'spec-when-available',
    instruction: draft.operation === 'modify'
      ? 'Preserve the existing document, content and native objects unless the user requests redesign. Apply any design brief only within the requested changes.'
      : mode === 'bespoke'
        ? 'Use a content-led custom program, not the default semantic template. Record a compact design brief in the initial plan. Keep typography/color roles coherent, but choose composition by each page’s purpose; named slots are optional and blank/grid/stack composition is supported. Do not repeat a title/subtitle/rule/card shell or randomize layouts just for variety.'
        : 'Use semantic templates for fast conventional documents when available. Presets are starting tokens, not mandatory brand styles; custom colors, fonts and type scales are allowed within readability constraints.',
    representativeReview: mode === 'bespoke'
      ? 'For substantial new work, resolve up to three representative compositions (opening, densest evidence, conclusion) before expanding. Inspect these first in the first valid render. If required-feature validation needs the complete document, author it once before rendering; do not omit requirements to force a partial prototype. Small tasks need no extra prototype. Reuse the same draft and existing evidence, never generate several full alternatives. Final QA covers every page.'
      : undefined,
    authoringEfficiency: 'Use small shared typography/chart helpers and independently editable page sections. Reuse design tokens, not a repeated page shell. For data pages choose readable axes, selective labels, native series colors and honest units before decoration; avoid charts whose scale compresses relevant samples or whose markers/labels conceal each other.',
    contentStandard: 'For analytical presentations, each substantive page needs evidence, explanation and a decision implication. Keep one verified metric dataset with exact source URL/table/period/unit/basis; derive chart arrays, callout totals, shares and growth from it instead of independently retyping numbers. Reading a source does not verify every later claim attributed to it. Cross-check every material assertion against its actual source table before delivery, especially quarter vs year, market platform vs reporting segment, and assumptions vs disclosed figures. Do not invent prices, timelines or radar scores to fill required chart families. Match chart type to the question; meaningful methods appendices may cover remaining families.',
    referenceStandard: 'Words like world-class, Swiss, restrained and cinematic specify ambitions, not an existing visual reference. Do not use them as a reference to bypass comparing directions. Compare composition, typography and actual imagery strategies, not just palette changes. When the user asks for real imagery, plan and acquire relevant assets instead of silently replacing them with decorative shapes or declaring all imagery unnecessary.',
    requiredDeckChecks: draft.design?.mode === 'bespoke' ? ['designIntent', 'compositionRhythm', 'contentConsistency', 'sourceTraceability'] : [],
  };
}

export function missingDesignReviewChecks(design: OfficeDesignBrief | undefined, checks: OfficeVisualQaDeckChecks | undefined) {
  if (design?.mode !== 'bespoke') return [];
  return (['designIntent', 'compositionRhythm', 'contentConsistency', 'sourceTraceability'] as const).filter((key) => checks?.[key] !== 'passed' && checks?.[key] !== 'failed');
}
