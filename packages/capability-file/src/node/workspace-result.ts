import { type UnoDraftPatchHunkFailure } from './workspace-source-editor.js';
import { isUnoWorkerInternalError } from './office/uno.js';
import { type OfficeProgramDiagnostic } from './office/program-analysis.js';
import type { OfficeDocumentDraft, OfficeDocumentKind } from '../office/types.js';
import { officeDesignGuidance } from '../design-guidance.js';

export type ArtifactToolPayload = {
  documentType?: OfficeDocumentKind;
  sourceFileName?: string;
  sourceDocument?: OfficeDocumentDraft['sourceDocument'];
  semanticGeneration?: ReturnType<typeof semanticGenerationPlan>;
  design?: OfficeDocumentDraft['design'];
  designGuidance?: ReturnType<typeof officeDesignGuidance>;
  workflow?: OfficeDocumentDraft['workflow'];
  reused?: boolean;
  instruction?: string;
  artifactId?: string;
  kind?: string;
  fileName?: string;
  path?: string;
  url?: string;
  downloadUrl?: string;
  bytes?: number;
  sourceUrl?: string;
  documentId?: string;
  generator?: string;
  operation?: string;
  sourceCharacters?: number;
  cacheHit?: boolean;
  changed?: boolean;
  code?: string;
  expectedBaseDigest?: string;
  suppliedBaseDigest?: string;
  patchBaseDigest?: string;
  sourceDigest?: string;
  sourceUnitPath?: string;
  validation?: string;
  validationStatus?: string;
  validationFailureCount?: number;
  saved?: boolean;
  editStatus?: string;
  patchHunks?: {
    applied: number;
    alreadyApplied?: number;
    failed: UnoDraftPatchHunkFailure[];
    blocked?: number[];
    total: number;
  };
  nextAction?: Record<string, unknown>;
  sourceRepairRequired?: boolean;
  sourceValidity?: string;
  retryable?: boolean;
  retryAfter?: string;
  validationEvidence?: OfficeDocumentDraft['validationEvidence'];
  message?: string;
  error?: string;
  recoverySuggestion?: string;
  repairHints?: string[];
  diagnostics?: Array<{
    code?: string;
    column?: number;
    elementId?: string;
    elementIds?: string[];
    line?: number;
    locator?: Record<string, unknown>;
    message?: string;
    page?: number;
    repairHint?: string;
    severity?: string;
    shapes?: number[];
    sourceExcerpt?: string;
    target?: string;
  }>;
  automaticValidation?: {
    formatChecks?: unknown;
    issues?: Array<{ code?: string; message?: string; severity?: string }>;
    passed?: boolean;
  };
  visualVerification?: {
    gateStatus?: string;
    imageCount?: number;
    pageCount?: number;
    renderedPages?: number[];
    status?: string;
  };
};

export function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/[[\]\\]/g, '\\$&');
}

export function semanticGenerationPlan(
  operation: 'create' | 'modify',
  generator: OfficeDocumentDraft['generator'],
  design: ReturnType<typeof officeDesignGuidance>,
) {
  const available = operation === 'create' && generator === 'uno';
  const recommended = available && design.mode === 'template';
  return {
    available,
    schemaVersion: '1.0',
    defaultTheme: 'clean',
    defaultLayout: { enabled: true, mode: 'repair', overflow: 'split', imageFit: 'contain' },
    recommended,
    ...(available ? {
      nextAction: recommended ? 'generate' : 'unoApi',
      input: recommended ? 'spec' : 'program',
      note: recommended
        ? 'Semantic generation skips API-catalog authoring; theme tokens may be customized. Fixed geometry is a convenience for conventional files, not a requirement for original design.'
        : 'Bespoke design should use a custom program so the compiler does not replace composition with fixed templates. Query only the API modules needed for the selected direction.',
    } : {
      reason: operation === 'modify'
        ? 'Existing files preserve their original layout through the raw UNO editing workflow.'
        : 'This workspace is configured for JavaScript program authoring.',
    }),
  };
}

export function compactAutomaticValidation(payload: ArtifactToolPayload) {
  const validation = payload.automaticValidation;
  if (!validation) return '';
  const issues = Array.isArray(validation.issues)
    ? validation.issues.slice(0, 12).map((issue) => {
        const identity = [issue.severity, issue.code].filter(Boolean).join(':') || 'issue';
        const message = String(issue.message || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        return message ? `${identity}=${message}` : identity;
      })
    : [];
  return [
    `Automatic validation passed=${validation.passed === true}`,
    validation.formatChecks === undefined ? '' : `formatChecks=${JSON.stringify(validation.formatChecks)}`,
    `issues=${issues.length ? issues.join(' | ') : 'none'}`,
  ].filter(Boolean).join('; ');
}

export function compactVisualVerification(payload: ArtifactToolPayload) {
  const verification = payload.visualVerification;
  if (!verification) return '';
  return [
    `Visual QA=${verification.gateStatus || verification.status || 'unknown'}`,
    typeof verification.pageCount === 'number' ? `pageCount=${verification.pageCount}` : '',
    typeof verification.imageCount === 'number' ? `imageCount=${verification.imageCount}` : '',
    Array.isArray(verification.renderedPages) ? `renderedPages=${verification.renderedPages.join(',')}` : '',
  ].filter(Boolean).join('; ');
}

export function compactOfficeFailure(payload: ArtifactToolPayload) {
  type Diagnostic = NonNullable<ArtifactToolPayload['diagnostics']>[number];
  const groupedDiagnostics = new Map<string, {
    affectedCount: number;
    diagnostic: Diagnostic;
    elementIds: Set<string>;
  }>();
  for (const diagnostic of payload.diagnostics || []) {
    const key = diagnostic.line
      ? JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.line, diagnostic.column])
      : JSON.stringify([
        diagnostic.severity, diagnostic.code, diagnostic.page, diagnostic.target,
        String(diagnostic.message || '').replace(/Affected runtime elements.*$/i, '').trim(),
      ]);
    const existing = groupedDiagnostics.get(key);
    const elementIds = [
      ...(diagnostic.elementIds || []),
      ...(diagnostic.elementId ? [diagnostic.elementId] : []),
    ];
    if (existing) {
      existing.affectedCount += 1;
      elementIds.forEach((elementId) => existing.elementIds.add(elementId));
    } else {
      groupedDiagnostics.set(key, {
        affectedCount: 1,
        diagnostic,
        elementIds: new Set(elementIds),
      });
    }
  }
  const diagnostics = Array.from(groupedDiagnostics.values())
    .map(({ affectedCount, diagnostic, elementIds }) => {
      const location = diagnostic.line
          ? `@${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}`
          : diagnostic.page ? `@page-${diagnostic.page}`
            : diagnostic.target ? `@${diagnostic.target}` : '';
        const identity = [diagnostic.severity, diagnostic.code].filter(Boolean).join(':') || 'issue';
        const rawMessage = String(diagnostic.message || '');
        const terminalMessage = diagnostic.code === 'UNO_RUNTIME_ERROR' || rawMessage.startsWith('Traceback (most recent call last):')
          ? rawMessage.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || rawMessage
          : rawMessage;
        const message = terminalMessage
          .replace(/Affected runtime elements.*$/i, '')
          .replace(/\s+/g, ' ').trim().slice(0, 260);
        const visibleElementIds = Array.from(elementIds).slice(0, 8);
        const elements = visibleElementIds.length
          ? `[elements=${visibleElementIds.join(',')}${elementIds.size > visibleElementIds.length ? `,+${elementIds.size - visibleElementIds.length}` : ''}]`
          : '';
        const affected = affectedCount > 1 ? `[affected=${affectedCount}]` : '';
        const sourceExcerpt = String(diagnostic.sourceExcerpt || '').trim();
        const source = sourceExcerpt
          ? ` [source=${sourceExcerpt.replace(/\s*\n\s*/g, ' ↵ ').slice(0, 700)}]`
          : '';
        return `${identity}${location}${affected}${elements}${message ? `=${message}` : ''}${source}`;
      });
  const rawError = String(payload.error || 'validation failed');
  const error = rawError.includes('__WEBPILOT_LAYOUT_DIAGNOSTICS__')
    ? `${payload.diagnostics?.length || 0} structured layout diagnostics returned by validation.`
    : (rawError.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || rawError)
      .replace(/\s+/g, ' ').trim().slice(0, 500);
  const repairHints = Array.isArray(payload.repairHints)
    ? payload.repairHints.slice(0, 6).map((hint) => String(hint).replace(/\s+/g, ' ').trim().slice(0, 360)).filter(Boolean)
    : [];
  return [
    `error=${error}`,
    payload.validationFailureCount ? `validationFailureCount=${payload.validationFailureCount} (repair sequence; mixed causes, not bridge retries)` : '',
    diagnostics.length ? `diagnostics=${diagnostics.join(' | ')}` : '',
    repairHints.length ? `repairHints=${repairHints.join(' | ')}` : '',
    payload.recoverySuggestion ? `recovery=${String(payload.recoverySuggestion).replace(/\s+/g, ' ').trim().slice(0, 500)}` : '',
  ].filter(Boolean).join('; ');
}

export function officeValidationRepairHints(
  diagnostics: Array<Partial<OfficeProgramDiagnostic> & { target?: string }> = [],
  errorText = '',
) {
  const codes = new Set(diagnostics.map((diagnostic) => String(diagnostic.code || '')).filter(Boolean));
  const combinedError = [errorText, ...diagnostics.map((diagnostic) => diagnostic.message || '')].join('\n');
  if (codes.has('UNO_WORKER_INTERNAL_ERROR') || codes.has('UNO_STYLE_PROPERTY_INFO_MISSING') || isUnoWorkerInternalError(combinedError)) {
    return ['The renderer failed internally; preserve the current source. Do not edit the draft, query unoApi, or repeat the same render. Report the runtime error and retry only after the renderer is fixed.'];
  }
  const hints: string[] = [];
  if (codes.has('OFFICE_ARTIFACT_REOPEN_FAILED')) {
    hints.push('The file was saved but LibreOffice could not reopen it. A prior DisposedException does not prove a startup failure. Inspect the exported package, relationships and export compatibility; preserve the draft and do not guess source edits or repeatedly restart. Native editability and render validity remain unverified for this output.');
  }
  if (diagnostics.length > 1) {
    hints.push(`The preflight returned ${diagnostics.length} diagnostics. Put every independent, non-overlapping repair into one Codex-format patch with separate @@ hunks; separate only repairs whose context or dependencies conflict.`);
  }
  if (codes.has('PYTHON_SYNTAX')) {
    hints.push('Read every reported syntax block, then patch each smallest complete Python block. Copy context and indentation byte-for-byte from read; the patcher never adds or removes indentation implicitly. Do not replace the complete source for local syntax errors.');
  }
  if (codes.has('PYTHON_UNDEFINED_NAME')) {
    hints.push('Define the reported name before first use or replace it with the intended existing variable. Repair the exact sourceExcerpt; do not use numbered batch replacement for a local name error.');
  }
  if (codes.has('PYTHON_INDEX_OUT_OF_RANGE')) {
    hints.push('This is a source indexing error, not a UNO bridge startup failure. Compare the data length, loop bounds, and allocated grid/stack cell count. stack(n) returns n cells; grid(columns, rows) returns columns*rows cells. Fix the allocation and dependent geometry together; do not truncate data or suppress the exception.');
  }
  if (codes.has('PRESENTATION_TABLE_CELL_OUT_OF_RANGE')) {
    hints.push('table.set_cell uses zero-based (column, row), while table.merge uses existing A1 addresses. Check both dimensions and preserve the intended data; merging populated cells is a real data/layout change, not a no-op demo.');
  }
  if (codes.has('PRESENTATION_ANIMATION_TARGET_INVALID')) {
    hints.push('animate is supported. Pass the shape object returned by add_shape/select_shape, or an exact selector dictionary; do not pass a bare elementId and do not delete the requested animation.');
  }
  if (codes.has('PRESENTATION_MASTER_SELECTOR_INVALID') || codes.has('PRESENTATION_CUSTOM_SHOW_INDEX_INVALID')) {
    hints.push('Master and custom-show slide indices are one-based, unlike table cell coordinates. Use deck.masters() for exact master selectors and [1] for the first slide in a show. Correct indices without deleting these supported features.');
  }
  if (codes.has('UNO_PYTHON_IMPORT_UNSUPPORTED')) {
    hints.push('Remove the raw UNO import and replace the affected block with a method copied from the corresponding queried facade module. Never substitute enums, structs, constants, or service calls.');
  }
  if (codes.has('MODEL_RAW_UNO_FORBIDDEN')) {
    hints.push('Raw UNO is worker-owned. Keep the current document facade and replace only the reported raw block with a supported call from the already-loaded manifest; preserve-only/unsupported features must not be recreated.');
  }
  if (codes.has('DRAFT_ENTRYPOINT_CALLED_DIRECTLY')) {
    hints.push('Delete the direct create_document(...) call. The LibreOffice worker invokes create_document(job) with the real job object; the draft must only define that function.');
  }
  if (codes.has('PRESENTATION_GEOMETRY_INVALID')) {
    hints.push('Move the reported element into a named slide slot, or repair only its explicit semantic box. Prefer deck.slide(...).add_* with slot=... over hand-calculated coordinates.');
  }
  if (codes.has('PRESENTATION_TEXT_OVERFLOW')) {
    hints.push('Increase the reported text box, shorten its copy, or redesign that local block. Use deck.text_height()/estimate_text_box() or add_text_box/card/footer so pt text is converted to 1/100 mm geometry safely. Do not auto-grow a shared helper without reflowing its dependent layout.');
  }
  if (codes.has('PRESENTATION_TEXT_BOX_TOO_SHORT')) {
    hints.push('The source mixes point font sizes with an undersized 1/100 mm geometry box. Replace the hand-sized height with deck.text_height()/estimate_text_box(), or use add_text_box/card/footer; keep min_font_size readable.');
  }
  if (codes.has('PRESENTATION_OVERLAP')) {
    hints.push('The layout preflight returned the complete overlap set. Repair every independent pair in one patch by reallocating real space: move/resize image and text boxes together, or use a content-specific composition. Do not merely add allow_overlap, relabel content as background/decoration, fade imagery into an unrequested watermark, or shrink important copy to bypass checks. Intentional overlays must belong to the design brief and remain visibly legible in actual QA.');
  }
  if (codes.has('FACADE_METHOD_ON_RAW_UNO_DOCUMENT')) {
    hints.push('Replace the raw document receiver with job.presentation/job.writer/job.spreadsheet and keep every operation on its returned slide, flow-document, or A1 worksheet facade.');
  }
  if (codes.has('FACADE_COMPONENT_ACCESS_UNSUPPORTED')) {
    hints.push('Do not inspect facade internals. Query the corresponding unoApi module and use its installed signatures and examples.');
  }
  if (codes.has('ELEMENT_ID_AUTO_DISAMBIGUATED')) {
    hints.push('The artifact was kept valid by deterministic runtime ID disambiguation. On the next relevant edit, update the shared helper namespace once instead of renaming only the last reported object or rewriting the complete source.');
  }
  if (codes.has('UNO_BRIDGE_DISPOSED')) {
    hints.push('The runtime already retried once with a fresh isolated LibreOffice profile. The disposed LibreOffice process prevented validation from completing and does not by itself identify a source defect.');
  }
  if (codes.has('UNO_BRIDGE_STARTUP')) {
    hints.push('LibreOffice failed before the document source could run. Validation did not produce evidence of a source defect.');
  }
  if (codes.has('RAW_CONNECTOR_SHAPE_UNSTABLE')) {
    hints.push('Replace only the reported raw connector with slide.connect(elementId, sourceBox, targetBox, ...). Keep the existing named slide layout and child IDs.');
  }
  if (codes.has('HELPER_CALL_SIGNATURE_MISMATCH')) {
    hints.push('The local helper definition and its callers disagree. Read the helper symbol and update its signature plus every affected call together; this is not a UNO facade API error.');
  }
  if (codes.has('HELPER_OVERLAP_DEFAULT_ENABLED')) {
    hints.push('Default reusable layout helpers to allow_overlap=False. Pass True only at explicit background, container, or decorative call sites so content overlap remains detectable.');
  }
  if (codes.has('UNO_API_METHOD_UNKNOWN') || codes.has('UNO_API_SIGNATURE_MISMATCH') || codes.has('UNO_API_ARGUMENT_INVALID')) {
    hints.push('The AST preflight rejected a guessed facade method, signature, or nested value. Query the module named by the diagnostic and copy its installed signature and complete registered examples before editing every affected call site together.');
  }
  if (codes.has('UNO_REQUIRED_CAPABILITY_MISSING')) {
    hints.push('Query presentation.shape and copy its specialized-shape example. Add each missing real facade capability with a unique elementId; do not infer semantic coverage from a lookalike, from visual QA, or from another shape type. Revalidate until every explicitly requested capability has a non-zero generated featureCounts entry.');
  }
  if (codes.has('PPTX_ELEMENT_ID_MISSING')) {
    hints.push('A serialized slide object lacks its stable element marker. Recreate only that object through the PresentationSlide facade; raw objects and expert tagging are not model-facing.');
  }
  if (codes.has('PPTX_OBJECT_OUT_OF_BOUNDS')) {
    hints.push('Repair only the reported elementId geometry using deck.bounds(); keep x/y non-negative and x+width/y+height inside those bounds with a small edge margin. Full-slide backgrounds must use bounds["width"] and bounds["height"].');
  }
  if (codes.has('RUNTIME_TEXT_OUT_OF_BOUNDS')) {
    hints.push('Move or resize only the reported text element inside deck.bounds(). The stable facade now keeps text boxes at their requested size, so do not compensate with guessed page dimensions.');
  }
  if (codes.has('RUNTIME_TEXT_OVERLAP')) {
    hints.push('Repair every independent reported text-overlap pair in one patch. Separate or resize only those local blocks; do not change a shared layout helper unless every caller is intentionally reflowed.');
  }
  if (codes.has('RUNTIME_IMAGE_OVERLAP')) {
    hints.push('Move or resize every independently reported image-overlap pair in one patch. If a collage is intentional, compose it as one image asset before placing it.');
  }
  if (codes.has('ELEMENT_MAPPING_NOT_EMBEDDED')) {
    hints.push('The registered element ID was not written onto the serialized artifact object. Tag the actual saved object rather than a wrapper, page collection, or temporary value.');
  }
  if (codes.has('EXPERT_ELEMENTS_NOT_TAGGED')) {
    hints.push('Expert mode is not model-facing. Replace the raw block with a returned facade call or versioned feature recipe.');
  }
  if (/unexpected keyword argument/i.test(errorText) && !/create_document\.<locals>\.[A-Za-z_][A-Za-z0-9_]*\(\)/i.test(errorText)) {
    hints.push('The facade rejected a guessed keyword. Query that facade module and copy its exact installed signature and example.');
  }
  if (/create_document\.<locals>\.([A-Za-z_][A-Za-z0-9_]*)\(\).*unexpected keyword argument/i.test(errorText)) {
    hints.push('A locally defined helper rejected the keyword. Update that helper signature and all of its callers together; querying unoApi will not change a user-defined Python function.');
  }
  if (/Direct job\.(?:new_document|open_document)\(\) is expert-only/i.test(errorText)) {
    hints.push('Use the matching job.writer/job.presentation/job.spreadsheet facade. For existing files, pass source_name directly to that facade; never open a raw document.');
  }
  const missingName = combinedError.match(/NameError:\s*name ['"]([^'"]+)['"] is not defined/i)?.[1];
  if (missingName) {
    hints.push(`Python name ${missingName} is undefined. Read the reported line and replace it with an existing declared identifier or define it before first use; do not batch numbered replacements.`);
  }
  const missingAsset = combinedError.match(/FileNotFoundError:\s*Asset ['"]([^'"]+)['"] is not in this conversation workspace\.\s*Available assets:\s*([^\n]+)/i);
  if (missingAsset) {
    hints.push(`Asset ${missingAsset[1]} is unavailable. Use one exact available asset name: ${missingAsset[2].trim()}. Unique case/download-prefix differences are resolved automatically.`);
  }
  if (/Presentation geometry (?:requires non-negative position and positive size|exceeds slide bounds)/i.test(combinedError)) {
    hints.push('Presentation objects require x/y >= 0, width/height > 0, and their far edge inside deck.bounds(). To remove an object, delete its call instead of replacing it with a zero-size placeholder.');
  }
  return hints;
}

export function formatFileArtifactResult(toolName: string, actual?: string) {
  if (toolName !== 'file') return undefined;
  try {
    const payload = JSON.parse(actual || '{}') as ArtifactToolPayload;
    // Edit receipts and conflicts are a protocol, not a prose success summary.
    // Keep historical partial results readable too; never hide their failed hunks.
    if (payload.editStatus || payload.patchHunks || payload.kind === 'uno-draft-patch-conflict' || payload.kind === 'uno-draft-patch-no-changes') {
      return JSON.stringify({
        kind: payload.kind, code: payload.code, documentId: payload.documentId,
        editStatus: payload.editStatus, changed: payload.changed, saved: payload.saved,
        sourceUnitPath: payload.sourceUnitPath, patchBaseDigest: payload.patchBaseDigest,
        expectedBaseDigest: payload.expectedBaseDigest, suppliedBaseDigest: payload.suppliedBaseDigest,
        patchHunks: payload.patchHunks, validation: payload.validation || payload.validationStatus,
        validationEvidence: payload.validationEvidence, sourceRepairRequired: payload.sourceRepairRequired,
        sourceValidity: payload.sourceValidity, retryable: payload.retryable, retryAfter: payload.retryAfter,
        diagnostics: payload.diagnostics, repairHints: payload.repairHints,
        // Diagnostics already contain the actionable errors. Repeating the
        // same exception as error + workflow.error can exceed the realtime
        // limit, break its JSON and hide the saved/validation distinction.
        // The original full result remains in the trace/detail endpoint.
        workflow: payload.workflow ? { ...payload.workflow, error: undefined } : undefined,
        message: payload.message, error: payload.diagnostics?.length ? undefined : payload.error,
        recoverySuggestion: payload.recoverySuggestion,
        nextAction: payload.nextAction,
      });
    }
    if (payload.kind === 'document-plan') {
      const assets = Array.isArray((payload as Record<string, unknown>).availableAssets)
        ? ((payload as Record<string, unknown>).availableAssets as Array<Record<string, unknown>>)
          .map((asset) => typeof asset.assetName === 'string' ? asset.assetName : '')
          .filter(Boolean)
        : [];
      // Routing and design decisions must survive the model-facing compaction.
      // Do not turn this back into an identity-only string or include the draft source.
      return JSON.stringify({
        kind: payload.kind, documentId: payload.documentId, fileName: payload.fileName,
        documentType: payload.documentType, operation: payload.operation || 'create',
        generator: payload.generator || 'uno', sourceCharacters: payload.sourceCharacters || 0,
        sourceFileName: payload.sourceFileName, sourceDocument: payload.sourceDocument,
        semanticGeneration: payload.semanticGeneration, design: payload.design,
        designGuidance: payload.designGuidance, workflow: payload.workflow,
        reused: payload.reused, instruction: payload.instruction, availableAssets: assets,
      });
    }
    if (payload.kind === 'uno-program' || payload.kind === 'office-program') {
      return `Office source updated: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; generator=${payload.generator || 'uno'}; sourceCharacters=${payload.sourceCharacters || 0}`;
    }
    if (payload.kind === 'uno-draft-validation') {
      if (payload.validation === 'failed' || payload.validationStatus === 'failed') {
        return `Office source validation failed: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; workingSourceSaved=${payload.saved === true}; ${compactOfficeFailure(payload)}`;
      }
      return [
        `Office source validated: ${payload.fileName || 'artifact'}; Document ID: ${payload.documentId}; sourceCharacters=${payload.sourceCharacters || 0}; cacheHit=${payload.cacheHit === true}`,
        compactAutomaticValidation(payload),
      ].filter(Boolean).join('; ');
    }
    if (payload.kind === 'office-source-unit-validation' && payload.validation === 'failed') {
      return `Office source-unit validation failed: Document ID: ${payload.documentId}; workingSourceSaved=${payload.saved === true}; ${compactOfficeFailure(payload)}`;
    }
    if (payload.kind === 'office-source-unit-validation' && payload.validation === 'passed') {
      return [
        `Office source unit validated: Document ID: ${payload.documentId}; sourceUnitPath=${String((payload as Record<string, unknown>).sourceUnitPath || '')}`,
        compactAutomaticValidation(payload),
      ].filter(Boolean).join('; ');
    }
    if (payload.kind !== 'download' && payload.kind !== 'generated') return undefined;
    const label = payload.kind === 'download'
      ? 'File downloaded'
      : 'File generated';
    const fileName = payload.fileName || 'artifact';
    const target = payload.downloadUrl || payload.url || payload.path || '';
    const targetLine = target
      ? `Download: [${escapeMarkdownLinkLabel(fileName)}](${target})`
      : `Path: ${payload.path || fileName}`;
    return [
      `${label}: ${fileName}`,
      payload.artifactId ? `Artifact ID: ${payload.artifactId}` : '',
      targetLine,
      payload.url && payload.url !== target ? `Open: ${payload.url}` : '',
      typeof payload.bytes === 'number' ? `size=${payload.bytes} bytes` : '',
      payload.kind === 'download' && /\.(?:png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(fileName)
        ? `Asset identity is NOT verified by its filename or a successful download. Before placing it, call readContent with artifactId=${payload.artifactId}, includeVisuals=true, and inspect the pixels. Verify subject/brand and aspect ratio; never label a generic or unrelated image as the requested product.`
        : payload.kind === 'download' && /\.pdf$/i.test(fileName)
          ? `Document text has not been read. Use readContent with artifactId=${payload.artifactId} for extracted evidence; do not decode PDF bytes as source text.`
          : '',
      compactAutomaticValidation(payload),
      compactVisualVerification(payload),
    ].filter(Boolean).join('; ');
  } catch {
    return actual;
  }
}
