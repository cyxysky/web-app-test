import type { CapabilitySkill } from '@webpilot/capability-sdk';

/** Complete model-facing operating manual for the File Capability workflow. */
export const fileArtifactRuntimeSkillId = 'system-file-artifact-runtime';

export const fileArtifactRuntimeSkillSummary = [
  '<system_skill>',
  `<id>${fileArtifactRuntimeSkillId}</id>`,
  '<title>File Artifact Runtime</title>',

  '<description>Required built-in operating manual for the unified file tool. Read this Skill before the first file call. readSource + documentId reads generation code; readContent + artifactId/attachmentId reads file data; visualRead reads page images.</description>',
  '<required>true</required>',
  '</system_skill>',
].join('\n');

export const fileArtifactRuntimeSkillContent = `# File Artifact Runtime

This Skill is authoritative for the unified file artifact workflow and is supplied by the file package. The consuming Agent is responsible for loading it and deciding when the file tool becomes available.

Content selection: readContent accepts sheet plus range (A1:D20) for spreadsheets, contentPages for PDF text pages, or an exact unique DOCX section heading. These select content before character offset/limit pagination. pages remains for visual previews. Reuse artifact IDs from browser downloads directly.

## Required sequence

1. Explicitly call skill action=read with skillId=${fileArtifactRuntimeSkillId}.
2. Wait for that Skill read to succeed. Do not emit a file call in the same model step.
3. Continue the workflow below. The Agent host must reject a file call emitted before the successful read without executing it.

Every file action uses this same Skill. Do not read a second visual-only Skill. If the Skill read fails, use the complete error and requiredSkillId to restore the missing Skill registration. If a file operation fails, first classify the latest error using the rules below; failureCategory names the failed operation, not its cause. Do not assume every failure requires a source edit. Keep the same documentId or artifactId; never create a replacement document merely to escape a failed step.

The base file actions are list, readSource, readContent, download, convert, plan, generate, edit, render, jsApi, and unoApi. When the host initializes file with visual input enabled, the same tool additionally exposes visualIndex, visualRead, and visualReport.

## Host tool boundary and result shape

\`file\` is one model tool. It is not a JavaScript global and must not be called inside browser action=code. Independent download calls are the exception to ordinary stateful sequencing: emit all known independent image/file downloads together in one model response so the runtime executes them concurrently. Draft reads, edits, generation, rendering, and browser mutations remain ordered.

\`\`\`ts
type FileToolResult = {
  ok: boolean;
  actual: string; // plain text or JSON text; inspect the complete value
  failureCategory?: string;
  requiredSkillId?: string;
  referenceImagePath?: string;
  referenceImagePaths?: string[];
};

declare function file(input: FileInput): Promise<FileToolResult>;
\`\`\`

Do not guess returned identities. Copy \`documentId\`, \`artifactId\`, screenshot ids, and the requested next action exactly from the latest successful result. For edit, copy the latest readSource result's \`patchBaseDigest\` into \`baseDigest\`; other source and render digests remain informational runtime metadata.

## Choose the object before choosing the action

| Need | Action and identity | What it returns / changes |
| --- | --- | --- |
| Find/resume authored work | list | Draft documentIds and workflow state; no file contents |
| Read/edit generation code | readSource + documentId | Exact program window + patchBaseDigest; no page images |
| Inspect Excel cells / Word text / PDF text | readContent + artifactId OR attachmentId | Parsed file content; no generation source |
| See rendered page layout | visualIndex then visualRead + artifactId | Indexed page images, not code or editable objects |
| Fix a visible defect | readSource → edit → render | Changes the same draft, then publishes its validated result |
| Import an existing Office file for editing | plan(operation=modify, sourceAttachmentId) | An editing workspace; later program opens the mounted original |
| Fetch an existing asset | download + HTTP(S) URL or page-relative URL path + fileType | Saved asset and exact artifactId/asset name; not an OS file reader |
| Export an existing Office file to PDF | convert + sourceArtifactId | PDF artifact; no source editing |
| Author a new file | plan → generate → render | Plan chooses engine; generate validates code; render publishes |
| Look up supported syntax/features | unoApi OR jsApi + documentId | Documentation, not execution; follow plan's engine |
| Record visual evidence | visualReport + artifactId | QA records only; no automatic layout repair |

Identity rules are strict: documentId is a stable draft id; artifactId identifies finished binary bytes; attachmentId identifies an upload; screenshotId identifies a printed/rendered page. A worksheet name, elementId, file name, downloadUrl, asset name, and sourceFileName are NOT substitutes for any of these. Never put a generated .xlsx artifactId into readSource. Never put documentId into readContent.

The reason field is explanation only: saying "read Python source" cannot turn readContent into source reading. Legacy action=read is accepted for old clients only; new calls must say readSource or readContent. If IDs or parameters are mixed, correct the call from the error rather than repeating it with a different reason.

When recovering after context compression, read the conversation registry's sourceRead entry or call list. Preserve only the current documentId, targeted source-unit path, diagnostic and next action; do not reload the whole draft or every screenshot.

## Failure diagnosis, freshness, and bounded recovery

- readSource/list reads saved state; it does NOT execute or revalidate source. Check validationEvidence (checkedAt, sourceDigest, workerDigest, scope, stage, freshness). Stale or unversioned historical diagnostics cannot establish a present runtime blocker. When resuming after a fix, perform one fresh render with the same documentId before reusing an old failure conclusion. A missing worker fingerprint alone is not a reason to repeat a fresh execution.
- Diagnose the failing expression, not merely the outer function name or NoneType. In target.getPropertySetInfo().hasPropertyByName(...), NoneType.hasPropertyByName means getPropertySetInfo() returned None. It does NOT mean target or _new_document() returned None and does NOT demonstrate bridge startup failure. UNO_STYLE_PROPERTY_INFO_MISSING and UNO_WORKER_INTERNAL_ERROR identify worker bugs; UNO_BRIDGE_STARTUP identifies explicit connection/startup failure; UNO_BRIDGE_DISPOSED identifies disconnection. Do not interchange them.
- sourceRepairRequired=false means this particular runtime error is not repaired by editing the draft; it does NOT prove the remaining source correct. Signature checks do not prove execution, layout, export, or QA. A source-unit pass is not whole-document validation. After an early blocker is repaired, later independent source defects may surface.
- Follow retryable and retryAfter. After bounded bridge retries are exhausted, stop unchanged calls. Retry only after a relevant runtime/source change or confirmed recovery, not after changing reason, adding comments, reading APIs, or merely waiting. Never turn "retry once" into a multi-call loop. Restarting a process or switching the planned renderer requires user authorization and evidence that it addresses this cause.
- validationFailureCount counts failed validations in the repair sequence, possibly across different errors and source revisions. It is NOT a count of bridge startup failures, identical failures, or retry attempts. Do not cite it as proof of a process-level outage.
- For PYTHON_INDEX_OUT_OF_RANGE, compare collection length with data and loop bounds. stack(n) allocates n cells; grid(columns, rows) allocates columns*rows cells. Allocate enough cells and reflow their contents. Never silently truncate items, reuse duplicate boxes, or suppress the exception.
- Preserve requested features when repairing argument errors. slide.animate exists: pass the returned PresentationShape (or an index/name/text selector dictionary), not a bare elementId string. Master and custom-show slide indices are ONE-based; use deck.masters() and slide index 1 for the first slide. table.set_cell instead uses ZERO-based (column, row), and table.merge uses existing A1 addresses. A merge of populated cells changes content and can increase row height; reserve an empty notes row for a merge demonstration. A bad selector does not mean the feature is unsupported. Do not remove animation, master assignments, shows, or business data merely to make validation pass.
- A blocked report must distinguish observations from inference: cite the latest relevant execution, diagnostic code/stage and source revision, and state which checks remain unperformed. Never claim "the source is correct", "all features work", or "restarting the bridge will fix it" when execution stopped before those claims could be checked.

## file API signatures

\`\`\`ts
type DocumentType = "word" | "spreadsheet" | "presentation";
type SemanticBlock = {
  id?: string;
  type: "page" | "sheet" | "text" | "heading" | "list" | "quote" | "code" | "image" | "chart" | "table" | "card" | "columns" | "metric" | "timeline" | "divider" | "spacer" | "pageBreak";
  template?: "cover" | "section" | "content" | "two-column" | "comparison" | "kpi" | "chart" | "image" | "reference" | "report" | "worksheet";
  title?: string; subtitle?: string; text?: string; source?: string; alt?: string; caption?: string;
  items?: unknown[]; rows?: Array<Array<string | number | boolean | null>>;
  data?: unknown; children?: SemanticBlock[];
  columns?: Array<{ width?: number; blocks?: SemanticBlock[] }>;
  style?: Record<string, unknown>;
};
type SemanticDocumentSpec = {
  schemaVersion?: "1.0";
  documentType?: DocumentType;
  fileName?: string;
  document?: { title?: string; author?: string; language?: string; page?: Record<string, unknown> };
  theme?: "clean" | "executive" | "editorial" | "signal" | { version?: "1"; preset?: "clean" | "executive" | "editorial" | "signal"; colors?: Record<string, string>; fonts?: Record<string, string> };
  layout?: { enabled?: boolean; mode?: "repair" | "strict"; overflow?: "split" | "shrink" | "error"; imageFit?: "contain"; safeMargin?: number };
  blocks: SemanticBlock[];
};
type FileInput =
  | { action: "list"; reason?: string }
  | {
      action: "readSource";
      reason?: string;
      documentId: string;
      path?: string; // optional semantic unit path returned by readSource, for example pages/s30-risk-matrix or symbols/add_bg
      startLine?: number; // optional one-based source window, maximum 80 lines
      endLine?: number; // optional inclusive source-window end
      includeDiagnostics?: boolean; // saved details, not a new validation run
    }
  | {
      action: "readContent";
      reason?: string;
      attachmentId?: string;
      artifactId?: string; // provide exactly one of attachmentId or artifactId
      includeVisuals?: boolean; // defaults false: no automatic page screenshots
      offset?: number; // zero-based text character offset
      limit?: number; // text characters, default 8000, maximum 40000; NOT code lines
      pages?: number[]; // one-based, at most six per call
    }
  | {
      action: "download";
      reason?: string;
      urlOrPath?: string;
      url?: string;
      path?: string;
      fileType: string; // extension without a dot: png, pdf, docx, xlsx, pptx, ...
      fileName?: string;
    }
  | {
      action: "convert";
      reason?: string;
      sourceArtifactId: string;
      fileName?: string;
    }
  | {
      action: "plan";
      reason?: string;
      documentId: string; // 1-96 ASCII letters, numbers, dot, underscore, or hyphen
      fileName: string;
      documentType: DocumentType;
      operation?: "create" | "modify"; // defaults to create
      intent?: string;
      design?: {
        mode: "template" | "bespoke";
        audience?: string;
        objective?: string;
        reference?: string; // actual user-supplied reference, not an invented source
        directions?: Array<{ id: string; concept: string; composition: string; typography: string; imagery: string }>;
        selectedDirection?: string;
        selectionReason?: string;
        rhythm?: string;
        preserve?: string[];
        avoid?: string[];
      };
      sourceAttachmentId?: string; // required when operation is modify
    }
  | {
      action: "unoApi";
      reason?: string;
      documentId: string;
      documentType?: DocumentType; // inferred from the planned documentId when omitted
      query?: string; // exact module id; module responses are complete, not paginated
    }
  | {
      action: "jsApi";
      reason?: string;
      documentId: string;
      documentType?: DocumentType;
    }
  | {
      action: "generate";
      reason?: string;
      documentId: string;
      program?: string;
      spec?: SemanticDocumentSpec;
      replaceExisting?: boolean; // exceptional last resort; never an ordinary repair
      baseDigest?: string; // required with replaceExisting
      render?: boolean; // legacy; publishing always requires action=render
    }
  | {
      action: "edit";
      reason?: string;
      documentId: string;
      path?: string;
      baseDigest: string;
      patch?: string; // exactly one of patch or replacements
      replacements?: Array<{ oldText: string; newText: string }>;
      render?: boolean; // legacy; publishing always requires action=render
    }
  | {
      action: "render";
      reason?: string;
      documentId: string;
    };
\`\`\`

Action requirements:

- \`list\`: no identity fields. Use it before starting or resuming authored Office/PDF work.
- \`readSource\`: requires documentId. Returns one exact Python/JavaScript program window, patchBaseDigest, line coordinates, validation status and diagnostic counts; no screenshots, workflow replay or full warning list. Read one returned path or at most 80 source lines with startLine/endLine. If programOmitted=true, select one diagnostic-focused unit/window, not every unit. Only set includeDiagnostics=true when saved validation details are missing from context; this does not rerun validation. Do not request diagnostics again for every source window.
- \`readContent\`: requires exactly one artifactId or attachmentId. Returns file text/data, NOT the code that generated it. offset/limit count characters (zero-based offset; default 8000, maximum 40000). includeVisuals defaults to false; only request it explicitly for a needed preview. For full page QA use visualIndex/visualRead instead.
- \`download\`: provide a real source in \`urlOrPath\`, \`url\`, or \`path\`, plus \`fileType\` without a dot. When two or more independent URLs are already known, emit their separate file calls in the same model response; the runtime batches them concurrently, coalesces duplicates, limits same-origin pressure, and performs only short bounded 429 retries. For Wikimedia, copy the exact thumbnail URL returned by Commons \`imageinfo/thumburl\`; never invent or rewrite its \`Npx-\` size segment. Never add a manual sleep or a fixed 30-second wait; after a persistent 429, switch to a different source or origin.
- \`convert\`: sourceArtifactId identifies an existing Office file; The bundled converter currently supports PDF output only: omit fileName or use a .pdf name; do not request arbitrary Office-to-Office conversions. Conversion creates a file, not an editable code draft. It is not the repair path for an authored document.
- \`plan\`: \`documentId\`, \`fileName\`, and \`documentType\` are required. The extension must match the document type (Word: doc/docx/odt; spreadsheet: xls/xlsx/ods; presentation: ppt/pptx/odp; PDF is valid for each). If plan fails, correct and retry with the same documentId. \`operation\` defaults to \`"create"\`; \`sourceAttachmentId\` is required for \`operation: "modify"\`.
- \`unoApi\` and \`jsApi\`: normally call after plan and only for its returned generation mode, always with the same \`documentId\`. An early UNO catalog lookup is also accepted when both \`documentId\` and \`documentType\` are supplied; it is read-only and returns \`boundToPlannedDraft=false\` plus \`nextAction=plan\`, so plan that same ID before generate. For UNO, omit \`query\` once to receive the module index, then query only the modules the draft uses (for example \`presentation.shape\` or \`presentation.professional\`). Every module response contains all exact installed signatures, accepted schemas, and registered examples for that module. Copy those examples instead of guessing. Repeated planned-module queries are cached. Raw UNO reflection is not exposed.
- \`generate\`: create the initial source with exactly one of \`spec\` or \`program\`. Prefer \`spec\` only when plan returns \`semanticGeneration.recommended=true\` and fixed geometry fits the content. \`available=true\` alone does not recommend a template. Use \`program\` for bespoke design, advanced freeform requirements, JavaScript-planned work, or existing-file modification; it has the same validation/render safety gates. If the result already contains a saved source and \`patchBaseDigest\`, normally use \`edit\` for repairs or revisions instead of starting over. Do not regenerate unchanged source to publish or preview it. A complete replacement requires \`replaceExisting=true\` plus the current \`baseDigest\`. Program generation must preserve the required entrypoint and save/close lifecycle.
- \`edit\`: prefer exact \`replacements\` for small changes, or submit one Codex-format \`patch\`; never both. Patch grammar: one \`*** Begin Patch\` / \`*** End Patch\` envelope, \`*** Update File: draft.py\`, and \`@@\` hunks. Context/deletion/addition markers are one space / \`-\` / \`+\`, separate from ALL source indentation. draft.py is the staging alias for Python and JavaScript, not a filesystem path. All targets must match uniquely on the same pre-edit snapshot. The entire call is atomic: any conflict saves NOTHING, including otherwise valid hunks. Correct the failed targets and resubmit the complete related batch; blocked hunks were not applied. A successful source edit can still fail validation; inspect saved/validation separately. No automatic stale-version rebase or fuzzy matching.
- In an edit hunk, replacing a line always means \`-old line\` followed by \`+new line\`. A space-prefixed old line is unchanged context, so writing \` old line\` followed only by \`+new line\` inserts a duplicate; never use that form for replacement. Every hunk must contain a real \`+\` or \`-\` change; a context-only hunk is rejected before matching. Copy indentation from the exact unnumbered read result for both \`-\` and \`+\` lines.
- \`render\`: publishes the current validated source. After render succeeds, inspect or deliver that artifact instead of rewriting it without a concrete reason. If the user request, validation result, or visual review identifies a real change, readSource and edit the same documentId, then render the updated source.

## Content-led design, not a fixed visual costume

Quality words such as world-class, Swiss, restrained, cinematic, premium, or editorial are ambitions, not a page template. Do not translate them automatically into blue/amber colors, a dark cover, an English eyebrow, an accent rule, and repeated equal-width cards. A different palette alone is not a different design direction.

For ordinary quick files, use the semantic fast path. For explicit original/high-design requests, record \`design.mode="bespoke"\` in the initial plan, before writing source:

- Include audience and objective. Describe what the reader must understand or decide, not merely the topic.
- Compare 2–3 short directions with distinct concept, composition, typography, and imagery strategies. Select one by id and explain why it fits the content. If the user supplied a binding reference, one direction plus that actual reference is enough; preserve its instructed structure. Do not require another approval unless the user requested a design choice or essential information is missing.
- Record rhythm (how density, focus and scale change across the ordered content), preserve (required content/features, brand, type-size minima, editability), and avoid (task-specific stale motifs). Keep each field concise; do not write a second document into the brief. Complete bespoke briefs require audience, objective, directions, selectedDirection, selectionReason and rhythm. Template mode needs only mode.
- Use a custom program for deliberate geometry. The initial design brief is saved, survives plan recovery, and is returned on an unbounded readSource; do not reread it during every local edit. Re-planning an authored draft does not replace its original brief or source.

Keep type/color roles and alignment logic coherent, not identical page shells. Give each page a takeaway and choose its composition from the evidence: a single decisive chart may dominate a page; comparisons can share structure; an image may be full-bleed only when it adds meaning. Repetition is useful for comparable content and must not be banned or randomized by a layout quota. Do not force dark/light alternation, a fixed number of styles, decorative English text, or unrelated imagery. Support words, tables and data with native editable objects; do not replace the entire page with an image.

For substantial new work, resolve up to three representative compositions (opening, densest evidence, conclusion) before extending the system. Inspect these first in the first valid render. If existing feature validation requires complete content, author the complete source once and then inspect the representatives first; do not delete requirements or repeatedly attempt an invalid partial prototype. Small documents and narrow edits need no extra prototype. Reuse the same draft; never produce several complete decks just to choose a style. After a representative defect is fixed, inspect remaining pages and reuse only runtime-confirmed unchanged evidence.

For charts, design around the question and data roles, not an API showcase: compare compatible units, label meaningful series/points, reserve space for actual title/axis/legend text, and remove redundant chrome without deleting meaning. A theme must govern chart typography and colors as well as surrounding text. Word uses content flow, headings, sidebars and figure relationships; Excel separates inputs/calculations/outputs and uses number formats and restrained emphasis. Do not decorate reports and spreadsheets as slide decks. Explicit all-feature demonstrations still retain every requested feature, preferably in a clearly organized appendix when appropriate.

Repairs preserve the selected direction and user requirements. Reflow the affected composition before shrinking text; never meet a visual check by silently lowering required font sizes, deleting features, flattening editable content, or reverting the entire document to a default template. A saved brief is an intention, not proof of design quality.

## Semantic create fast path

Use this path only when the latest plan returns \`semanticGeneration.available=true\`. It deliberately owns layout geometry, so do not put absolute \`x\`/\`y\` coordinates into semantic blocks.

- Presentation pages use \`type="page"\` with templates \`cover\`, \`section\`, \`content\`, \`two-column\`, \`comparison\`, \`kpi\`, \`chart\`, \`image\`, or \`reference\`. Put content in \`children\`. Chart data is \`{ categories: string[], series: [{ name, values }], chartType? }\`.
- Writer may use ordinary flow blocks directly or group them in \`page\` blocks. Native flow handles pagination; semantic headings, text, lists, tables, images, cards, timelines, and page breaks remain editable.
- Calc uses \`type="sheet"\`, \`name\`, and \`children\`. Tables receive frozen/filterable headers, content-based column widths, wrapping, print area, repeat rows, and portrait/landscape selection. Chart blocks create native charts from their semantic series.
- Theme presets are versioned under schema v1: \`clean\` (default), \`executive\`, \`editorial\`, and \`signal\`. They are starting tokens, not mandatory visual identities. Override colors, fonts and typography for a justified content-led direction even without user-supplied brand tokens; respect actual brand constraints and installed font support. Semantic geometry remains template-owned: choose program authoring when changing tokens cannot express the intended composition.
- Layout defaults are \`enabled=true\`, \`mode="repair"\`, \`overflow="split"\`, and \`imageFit="contain"\`. The compiler assigns missing IDs, clamps unreadable type, repairs low contrast, splits long slide text/lists/tables, repeats table headers, and reflows dense slides. Review returned \`semantic.diagnostics\`; errors stop before Office execution and repaired warnings explain deterministic changes.
- Each image needs the exact downloaded workspace asset name in \`source\`; add \`alt\` or \`caption\` when it conveys meaning. Never invent an asset name.

Example:

\`\`\`json
{
  "action": "generate",
  "documentId": "quarterly-review",
  "spec": {
    "schemaVersion": "1.0",
    "theme": "executive",
    "blocks": [
      { "id": "cover", "type": "page", "template": "cover", "title": "Quarterly review", "subtitle": "Decisions and outlook" },
      { "id": "summary", "type": "page", "template": "kpi", "title": "At a glance", "children": [
        { "id": "revenue", "type": "metric", "title": "Revenue", "text": "$4.2M" },
        { "id": "growth", "type": "metric", "title": "Growth", "text": "+18%" }
      ] }
    ]
  }
}
\`\`\`


## JavaScript presentation visualization choices

For JavaScript presentation drafts that use PptxGenJS:

- Prefer \`slide.addChart()\` for standard column charts, horizontal bar charts, and doughnut charts, and use it for every other standard chart family supported by PptxGenJS, including area, bubble, line, pie, radar, scatter, and supported combinations. In PptxGenJS, use the bar chart type with \`barDir: "col"\` for columns and \`barDir: "bar"\` for horizontal bars. Never hand-draw a supported chart from lines, shapes, or text.
- Prefer \`slide.addTable()\` for standard tables.
- Use \`slide.addShape()\` to construct KPI progress bars, mini charts, and special infographics whose appearance cannot be represented adequately by a native chart or table.
- Do not replace a standard native chart or table with manually positioned shapes merely for styling. A shape-based replacement is appropriate only when the requested visual is intentionally infographic-like or visual QA proves that the native object cannot produce the required result.

## UNO-backed high-level Office authoring

UNO remains the internal Office engine, but authored source uses only the returned facade and versioned feature recipes. Never import \`uno\`, reference \`com.sun.star\`, inspect private facade fields, or create raw services. JavaScript drafts continue to use \`job.PptxGenJS\`, \`job.docx\`, and \`job.ExcelJS\` directly with their existing validation flow.

- Create the requested document with \`job.writer(elementId)\`, \`job.presentation(elementId)\`, or \`job.spreadsheet(elementId)\`. Use \`deck.slide(...)\` for Impress and \`workbook.sheet(...)\` for Calc; never retain or manipulate a raw UNO page, sheet, cell, cursor, controller, enum, struct, or component.
- Every generated document, slide, paragraph, list, table, chart, image, worksheet, range, cell, and feature call must have a stable \`elementId\`. Element IDs may use Unicode (including Chinese), must fit 1-128 characters, and child IDs passed to a slide facade are automatically scoped and whitespace-normalized under that parent. Prefer role/index IDs instead of deriving identifiers from visible labels. A reusable helper may therefore reuse role IDs such as \`background\` on different slides.
- Calc setters for the same cell/range, cell formatting, row height or column width may reuse the same ID when updating the exact same target. Their source mapping follows the latest setter. A reused ID for a different target or a newly created object is still a collision. Non-blocking ID warnings alone do not require another read/edit/render cycle.
- The queried \`unoApi\` modules are authoritative for the APIs they cover. Query every module the draft uses. If a module marks a capability \`preserve-only\` or \`unsupported\`, do not invent a raw UNO fallback. Preserve-only features may survive an existing-file edit but may not be created or materially rewritten.
- Exact presentation capability names in the plan are a semantic contract. Query \`presentation.shape\` and use its complete specialized-shape example for \`RectangleShape\`, \`EllipseShape\`, \`CustomShape\`, \`CaptionShape\`, \`ConnectorShape\`, \`LineShape\`, \`MeasureShape\`, \`TextShape\`, and \`GraphicObject\`; each explicitly requested item must have its own non-zero generated \`featureCounts\` key. A lookalike, visual-QA claim, or reopened generic shape count cannot substitute for the named capability.
- \`shape_type='caption'\` and \`shape_type='measure'\` invoke the real native UNO services and automatically pair them with one named editable export fallback because LibreOffice drops raw CaptionShape and MeasureShape during PPTX export. Use the one facade call shown by \`presentation.shape\`; never add a second manual lookalike or claim the exporter preserves the raw service.
- For Impress, create \`slide = deck.slide(id, layout=..., title=...)\`. Named slots are useful when they fit; \`layout='blank'\` also supports custom content/data pages, not just covers. Use \`slide.add_text/image/table/chart/card/timeline\` with allocated slots or boxes. Passing \`title\` fills a title slot; do not add another title over it. Supply \`title_style\` when the design or requested minimum differs from the default title size. Never emulate a connector arrowhead with a separate \`triangle\` shape: making the triangle box touch the target does not put its top-center apex on the line endpoint, so the visible arrow tip lands above or beside the target. Use \`slide.connect(..., end_arrow=True)\`; when complete endpoint boxes are already allocated, add the connector before the node shapes, otherwise create the child IDs first and pass those IDs. Headers, footers and accent rules are optional. When needed, \`slide.add_header(...)\` and \`slide.add_footer(...)\` stay inside layout-reserved margins; never draw a manual rule through the title or body slots. Use \`slide.grid(...)\` and \`slide.stack(...)\` for freeform composition. They return one flat row-major list (never nested rows) of mapping cells with \`x/y/width/height\`, PptxGenJS-compatible \`w/h\` aliases, and a unit marker. Iterate that list directly and pass \`box=cell\`; never flatten/extend it or tuple-index a cell. \`deck.content_box/grid/stack\` return the same unit-tagged rectangles. Use \`add_card\` or \`add_timeline\` only when those components fit the content; native tables/charts and allocated cells avoid fragile hand-layering. Omit text-box height or set \`auto_height=True\` when subsequent elements are allocated from a stack rather than hand-positioned.
- New Impress decks use the fixed wide-screen canvas \`13.333 x 7.5\` inches, whose horizontal center is \`6.6665\`. Never compose a blank slide against a \`10 x 7.5\` canvas. \`align='CENTER'\` centers text only inside its own box; it does not center that box on the slide. Prefer named slots or \`slide.grid/stack\` without an explicit box. For intentional freeform geometry, derive the region from \`deck.bounds()\` / \`deck.content_box()\` or center an inch box with \`x = (13.333 - width) / 2\`.
- Presentation text rejects \`letter_spacing\`, \`tracking\`, \`margin\`, \`autofit\`, and \`word_wrap\`. Use only the installed \`presentation.text\` vocabulary; replace those guesses with \`padding\`, \`line_spacing\`, \`min_font_size\`, explicit box geometry, or \`auto_height\`.
- \`slide.add_chart\` creates a native OLE2 chart, not a vector-shape chart; never claim otherwise in the delivery report. Its background is transparent by default. Give Cartesian charts with titles/axis titles/legends enough height, and for pie/donut choose either legend + percent-only labels or category labels without a legend. Reopen validation rejects any OLE2 chart that collapses to a non-positive size.
- Chart families have different data roles. Read the current presentation.chart module: scatter series use numeric x/y arrays, bubble adds positive sizes, and stock uses open/high/low/close arrays satisfying low <= open/close <= high. Scatter/bubble may pass categories=[]; labels are not numeric X coordinates. Do not flatten point tuples, turn roles into unrelated series, or remove required roles to pass validation. CHART_DATA_ROLE_INVALID is a source data-contract error, not a bridge failure.
- Visual repairs must preserve numeric data. Never move X/Y points or selectively reduce bubble sizes to clear axes. Use x_axis_min/x_axis_max/y_axis_min/y_axis_max for axis padding and allocate a larger plotting region; disclose unavoidable sample overlap. Labels and axis bounds are presentation, whereas values and relative bubble sizes are evidence.
- Preserve chart meaning as well as numeric arrays: do not stack independent indices merely to expose an occluded area series. Use a suitable series order, supported transparency, or separate native charts with comparable axes. For horizontal bars, verify the exported physical value/category axis titles, not only their parameter names. Axis padding alone does not fix labels drawn at an internal zero crossing; inspect their actual positions.
- For Writer, keep body content in native flow with \`document.add_title/heading/paragraph/bullets/numbered_list/table/inline_image/page_break\`; page style and header/footer configuration use returned versioned recipes.
- For Calc, create \`sheet = workbook.sheet(id, name)\` and use A1-based \`sheet.set_cell/set_range/add_table/format/merge/freeze/column_width/row_height\`. Do not obtain raw sheets, cells, ranges, draw pages, or controllers.
- Impress text, images, tables, and charts participate in bounds and collision validation. Repair the returned leaf \`elementIds\`; do not hide defects by shrinking body text below 16pt.
- Deterministic format, structure, feature-count, reopen, render, and visual-QA gates all apply to the same current source. A successful reopen does not by itself prove pagination or slide layout.

## Proven UNO suite decisions

A verified reference run delivered an 18-slide Impress deck, a 12-page Writer report, and a seven-sheet Calc workbook through this same UNO -> LibreOffice pipeline with zero reported presentation overlap or out-of-bounds defects. Treat these as proven engineering decisions, not mandatory page counts or a content template:

- Finish one document through validation, render, and complete visual QA before starting the next format. A failed PPT draft is not a reason to begin Writer or Calc work.
- In Impress, choose named layouts/slots when they fit the content. For bespoke composition use \`deck.slide(id, layout='blank')\` with explicit grid/stack/boxes, deliberate text hierarchy and safe bounds; the content title need not occupy the default slot on every page. Page furniture is optional, not a requirement. Never make a shared text helper silently increase box height because later elements will not reflow.
- Each \`unoApi\` module includes installed-facade examples for all of its registered cases. Copy the exact signature and closest example; do not copy worker internals or raw UNO from an old output file.
- Use native editable chart helpers for standard chart families and vector shapes only for intentional infographics.
- Keep Writer body content in normal flow. Use native TextSection/TextColumns for columns and give floating frames or images explicit anchors only when the requested design needs them.
- Keep Calc chart anchors inside each sheet's print area and validate that the complete source range, title row, and last category are included.
- A layout diagnostic identifies a leaf element or a primary collision source. Repair that concrete call site first. Change a shared helper only when the intended change is valid for every caller and the whole dependent layout is deliberately reflowed.
- Keep long artifacts compact and data-driven through high-level facade calls and content arrays. Prefer focused Codex-format patches for local defects; use the guarded generate replacement when the draft genuinely needs a complete architectural rewrite.
- Generate/edit performs structural UNO validation without attaching page screenshots to every repair call. A patch scoped by \`path\` to one page or sheet is validated as that exact source unit; final render still performs full-document validation. Use the returned validation state and diagnostics to choose the next operation. Render creates indexed previews but does not attach the whole document to the model; only bounded \`file action=visualRead\` batches add page-image context.
- The runtime may retry a disposed/startup-failed bridge once with an isolated LibreOffice profile. When bounded recovery is exhausted, preserve the source and stop unchanged render calls until runtime recovery is confirmed. Do not classify arbitrary NoneType errors as bridge failures or conclude that the unexecuted source is valid.

## file call examples

List and resume an existing workspace:

\`\`\`js
file({
  action: "list",
  reason: "查找当前对话中已有的文档工作区"
})
\`\`\`

\`\`\`js
file({
  action: "readSource",
  documentId: "quarterly-review",
  reason: "读取当前源文件、诊断信息和工作流检查点"
})
\`\`\`

Plan a new presentation, then read the mode-specific API and generate. These are three separate model-tool steps:

\`\`\`js
file({
  action: "plan",
  documentId: "quarterly-review",
  fileName: "季度复盘.pptx",
  documentType: "presentation",
  operation: "create",
  intent: "创建一份包含经营摘要、指标趋势、问题和下季度计划的季度复盘演示文稿",
  reason: "建立稳定的演示文稿工作区"
})
\`\`\`

\`\`\`js
file({
  action: "unoApi",
  documentId: "quarterly-review",
  documentType: "presentation",
  query: "presentation.shape",
  reason: "读取形状模块的精确签名、参数结构与全部示例"
})
\`\`\`

\`\`\`js
file({
  action: "generate",
  documentId: "quarterly-review",
  program: "def create_document(job):\\n    deck = job.presentation('quarterly-review')\\n    title = 'Old title'\\n    slide = deck.slide('cover', title=title)\\n    deck.save()\\n    deck.close()",
  reason: "提交唯一一次初始可运行源文件"
})
\`\`\`

Make a focused patch from the exact unnumbered \`program\` and \`patchBaseDigest\` returned by the latest \`readSource\` result:

\`\`\`js
file({
  action: "edit",
  documentId: "quarterly-review",
  baseDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  patch: "*** Begin Patch\\n*** Update File: draft.py\\n@@\\n     deck = job.presentation('quarterly-review')\\n-    title = 'Old title'\\n+    title = 'New title'\\n     slide = deck.slide('cover')\\n*** End Patch",
  render: false,
  reason: "修正第八页指标区域的排版和内容"
})
\`\`\`

Render the exact validated source:

\`\`\`js
file({
  action: "render",
  documentId: "quarterly-review",
  reason: "验证并发布当前源码"
})
\`\`\`

Modify an existing attachment without recreating it:

\`\`\`js
file({
  action: "plan",
  documentId: "contract-update",
  fileName: "合同修订版.docx",
  documentType: "word",
  operation: "modify",
  sourceAttachmentId: "attachment-id-from-conversation-metadata",
  intent: "保留其余格式，只更新付款日期和联系人",
  reason: "在原附件组件基础上建立修改工作区"
})
\`\`\`

Download or convert an existing artifact:

\`\`\`js
file({
  action: "download",
  urlOrPath: "https://example.com/report.pdf",
  fileType: "pdf",
  fileName: "report.pdf",
  reason: "把页面引用的 PDF 交付为当前会话 Artifact"
})
\`\`\`

\`\`\`js
file({
  action: "convert",
  sourceArtifactId: "exact-office-artifact-id",
  fileName: "季度复盘.pdf",
  reason: "把已生成的 Office Artifact 转换为 PDF"
})
\`\`\`

## Visual file actions and examples

\`visualIndex\`, \`visualRead\`, and \`visualReport\` exist on \`file\` only when the host initializes the capability with visual input enabled and supplies page-image reading.

\`\`\`ts
type FileVisualInput =
  | {
      action: "visualIndex";
      reason?: string;
      artifactId: string;
      offset?: number;
      limit?: number;
    }
  | {
      action: "visualRead";
      reason?: string;
      artifactId: string;
      screenshotIds: string[]; // one to eight exact ids from index
    }
  | {
      action: "visualReport";
      reason?: string;
      artifactId: string;
      reviews: Array<{
        screenshotId: string;
        status: "passed" | "failed";
        observation: string; // concrete page-specific visible evidence, never a generic pass statement
        checks: {
          overlap: "passed" | "failed";
          clipping: "passed" | "failed";
          alignment: "passed" | "failed";
          spacing: "passed" | "failed";
          typography: "passed" | "failed";
          contrast: "passed" | "failed";
          visualHierarchy: "passed" | "failed";
          chartTableLegibility: "passed" | "failed" | "not-applicable";
          imageQuality: "passed" | "failed" | "not-applicable";
        };
        issues?: Array<{
          type: string;
          description: string;
          region?: string;
          severity?: "error" | "warning";
        }>;
      }>;
      // May include every already-read page in one call (up to 100 reviews).
      deckReview?: {
        status: "passed" | "failed";
        observation: string; // comparison across the complete rendered artifact
        checks: {
          templateConsistency: "passed" | "failed";
          typographyConsistency: "passed" | "failed";
          colorConsistency: "passed" | "failed";
          spacingRhythm: "passed" | "failed";
          componentConsistency: "passed" | "failed";
          designIntent?: "passed" | "failed"; // required for design.mode=bespoke
          compositionRhythm?: "passed" | "failed"; // required for design.mode=bespoke
        };
        issues?: Array<{
          type: string;
          description: string;
          region?: string;
          severity?: "error" | "warning";
        }>;
      }; // required for final completion after all pages are reviewed
    };
\`\`\`

\`\`\`js
file({
  action: "visualIndex",
  artifactId: "exact-latest-artifact-id",
  offset: 0,
  limit: 100,
  reason: "列出当前 Artifact 的全部页面截图"
})
\`\`\`

\`\`\`js
file({
  action: "visualRead",
  artifactId: "exact-latest-artifact-id",
  screenshotIds: ["screenshot-0001", "screenshot-0002"],
  reason: "读取并实际检查前两页"
})
\`\`\`

\`\`\`js
file({
  action: "visualReport",
  artifactId: "exact-latest-artifact-id",
  reviews: [
    {
      screenshotId: "screenshot-0001",
      status: "passed",
      observation: "标题、正文和图形层级清楚，页边距与组件间距均衡，当前预览尺寸下文字可读。",
      checks: {
        overlap: "passed", clipping: "passed", alignment: "passed", spacing: "passed",
        typography: "passed", contrast: "passed", visualHierarchy: "passed",
        chartTableLegibility: "not-applicable", imageQuality: "passed"
      }
    },
    {
      screenshotId: "screenshot-0002",
      status: "failed",
      observation: "右侧图表图例越过内容安全区并被页面边缘裁切，图例最后一项无法完整阅读。",
      checks: {
        overlap: "passed", clipping: "failed", alignment: "passed", spacing: "passed",
        typography: "passed", contrast: "passed", visualHierarchy: "passed",
        chartTableLegibility: "failed", imageQuality: "not-applicable"
      },
      issues: [{
        type: "clipping",
        description: "右侧图表图例被页面边界裁切",
        region: "right chart legend",
        severity: "error"
      }]
    }
  ],
  deckReview: {
    status: "failed",
    observation: "对比完整文档后，第二页的内容安全区与其他页面不一致，破坏了跨页边距和组件节奏。",
    checks: {
      templateConsistency: "passed", typographyConsistency: "passed",
      colorConsistency: "passed", spacingRhythm: "failed", componentConsistency: "passed"
    },
    issues: [{ type: "spacing-consistency", description: "第二页右侧安全边距与其余页面不一致。" }]
  },
  reason: "提交已查看页面的逐页结论和全稿一致性结论"
})
\`\`\`

## Recommended workflow

1. Call file action=list before starting or resuming Office/PDF authoring, and reuse an existing documentId when it represents the requested work.
2. Call action=plan for that documentId, including a compact bespoke design brief for original/high-design work. For an existing attachment, use operation=modify with the exact sourceAttachmentId; for a new file, use operation=create. Prefer one complete initial plan; do not repeatedly plan after authoring.
3. Follow designGuidance and semanticGeneration.recommended, not available alone. For conventional files with recommended=true and suitable fixed geometry, go directly to action=generate with spec; for bespoke work use program, calling action=unoApi only for an UNO plan or action=jsApi only for a JavaScript plan and only for modules actually needed.
4. Call action=generate with exactly one of spec or program to create the initial editable source. A failed generate may still return a saved source and patchBaseDigest, so inspect the result before choosing the next action.
5. When a usable source already exists, prefer action=edit on that same documentId for repairs and revisions. If no source checkpoint was created, correct the input and retry generate. Use guarded replacement only when bounded edits cannot coherently implement the requested change, after understanding the current structure and obtaining its exact patchBaseDigest. Never reconstruct a large source through consecutive reads just to replace it.
6. Call action=render only after the current source passes validation and the complete requested content is present; render publishes that exact source.
7. After render, inspect the latest artifact when visual QA is available. Do not rewrite it speculatively. If the user request, validator, or visual inspection reveals a concrete issue, read and edit the same documentId and render again; otherwise return the artifact in finalResponse.

Use action=readSource whenever the exact current source, patchBaseDigest, workflow checkpoint, or validation diagnostics are needed. Use action=download for an existing URL/path and action=convert to convert an existing Office artifact identified by sourceArtifactId. For web research, browser action=code may locate and verify a direct asset URL, but it must not fetch or save that asset locally; pass the direct URL to file action=download, then use the exact returned artifact name in Office source. Use readContent to inspect downloaded image artifacts when authoritative pixel dimensions or aspect ratio are needed.

## Identity and current source

- documentId is the stable workspace identity. Reuse it across plan, API lookup, generate, readSource, edit, and render.
- Each documentId owns exactly one current editable source. There is no source history or restore operation; the latest readSource's patchBaseDigest is only an optimistic-concurrency guard for edit.
- action=edit always targets that one current source. Initial action=generate creates it atomically; the guarded replaceExisting form replaces that same buffer without creating a second document identity.
- Digests in results are runtime checksums for validation, cache, render currency, and QA. For every edit, copy the latest readSource's patchBaseDigest as baseDigest; do not use older source or render digests.

Do not mix ids from different documents or formats. Different documentIds and output formats may coexist in one run.

## UNO and JavaScript modes

The plan result selects the mode; do not choose a different branch afterward.

download accepts HTTP(S) URLs and page-relative URL paths, not Windows drive paths, UNC paths or file: URLs. Existing local files must already be uploaded or host-bound attachments; use their exact workspace asset names. A sourcePageUrl cannot turn a local path into a downloadable asset. If jsApi reports generator=uno, use its returned unoApi nextCall; do not switch engines or retry jsApi.

- Semantic: when semanticGeneration.recommended=true and template geometry fits the request, action=generate with spec compiles to the planned UNO facade and requires no unoApi lookup. available=true only means the engine can accept specs. Bespoke design uses program; both paths retain the normal validation, edit, render, and visual-QA workflow.
- UNO: read the unoApi module index before authoring, then query each module actually used by the draft. Reuse that module's apiReference, valueSchemas, examples, support matrix, and versioned capabilities. Module results are exhaustive for their registered examples and intentionally omit unrelated APIs. Raw UNO reflection is unavailable.
- Facade element IDs must resolve to non-empty unique stable strings at runtime. Deterministic loop expressions such as \`"slide-" + str(i)\` are allowed. Child IDs passed to slide and sheet facades are automatically scoped under their parent.
- Presentation uses \`deck.slide(...)\`; Writer uses flow methods on \`document\`; Calc uses \`workbook.sheet(...)\` with A1 addresses. Use only signatures returned by the corresponding queried module. A missing feature is unavailable for authored creation unless a module explicitly marks it supported.
- Assets resolve by exact names from the conversation workspace through facade image calls; the worker embeds them into the saved Office package.
- JavaScript: read jsApi for the planned document and use only its cookbook and supported libraries. Keep shared initialization/helpers/final output outside optional units.
- PDF is supported in both modes. JavaScript mode authors the matching Office intermediate and converts that exact result locally.

## Editing and recovery

readSource.lineCount is the total source/unit size, not the returned amount. program contains only sourceLineRange and returnedLineCount; if requestedRangeTruncated=true, use nextRead only when those additional lines are needed. Do not reread the same window or assemble a whole draft for a small fix. Broken optional source-unit markers do not destroy the source: omit path and read/edit a bounded global window to repair the markers.

Keep common styling in a few small helpers and keep page-specific content in independent functions or paired source units. Reuse helpers without turning every page into the same composition. Change a helper and its affected callers atomically; avoid repeated copies of large coordinate/style blocks that multiply repair sites.

action=edit accepts exact replacements OR one Codex apply_patch document, with documentId, the current patchBaseDigest as baseDigest, and optional source-unit path. Patch grammar uses \`*** Begin Patch\`, \`*** Update File: draft.py\`, \`@@\`, \`*** End Patch\`; never emit numeric hunk counts. Every hunk needs literal \`-old\` or \`+new\` lines; replacement needs both in the SAME hunk. Matching is unique and exact, including whitespace and punctuation; duplicate targets are rejected rather than choosing the first. Every hunk is located against the original snapshot, never text produced by another hunk in this call. Changed ranges must not overlap, though unchanged context may be shared. A malformed, ambiguous, overlapping, missing-target or stale-version edit saves nothing. patchHunks.failed identifies conflicts; patchHunks.blocked identifies otherwise valid changes withheld by atomicity. Correct the conflicts and retain the blocked changes in the resubmitted batch. Use a new read only when source/version/context is missing, not to repair patch-marker formatting.

For example, replace \`    title = "Old"\` with \`    title = "New"\` using the two change lines \`-    title = "Old"\` and \`+    title = "New"\`. Do not write the old line with a leading space and then add the new line; that is a valid insertion, not a replacement.

Prefer action=edit with replacements for small changes and Python indentation repairs: [{oldText: "   title = 'Old'", newText: "    title = 'New'"}]. Supply documentId and current baseDigest; omit patch. These are literal source strings with no diff prefixes or line numbers. oldText must match exactly once; include surrounding code if repeated. For insertion include the existing anchor in newText; for deletion use newText="". Every pair matches the same original snapshot and the entire batch commits together. A missing oldText is NOT success just because newText exists elsewhere. Only an identical latest request with a saved receipt whose resulting digest equals the current source is acknowledged as EDIT_REPLAY_CONFIRMED without another write or validation.

For Python syntax diagnostics, replace each smallest syntactically complete block. Repair the syntax issues whose exact source is present in this window; combine independent replacements only when their contexts are available. Read and repair distant windows separately. Never reconstruct indentation from diagnostic line numbers or prose: copy it from readSource.program. If using patch, the +/- marker is separate from ALL source indentation; never express old/new code as two context-only @@ blocks. A malformed patch saves nothing. Never add comments or whitespace just to defeat a no-change result. saved=true means the buffer is retained, NOT that validation passed; validation=failed requires a real repair before rendering.

Put related repairs, especially a helper signature and all affected callers, in one atomic call using non-overlapping hunks/replacements. Include unchanged context to identify each location uniquely. An optional \`@@ exact_source_line\` anchor must itself be unique and preserve indentation; Python def/class anchors are confined to that declaration's block. Prefer source-unit path for page-specific repairs. Insertions should include an unchanged anchor in the hunk; a context-free insertion means append at EOF. Validation may fail AFTER all edits are saved; then repair the saved candidate using its returned patchBaseDigest, without replaying applied changes. Conversely a target conflict saves none. Blocking errors and visible defects require focused edits; warnings alone do not justify rewriting. Final delivery still requires full validation and render.

Source units are optional navigation aids, not a source-size rule and never a validation requirement. For focused repairs, presentation page units use authored IDs such as \`pages/s30-risk-matrix\`; reusable Python helpers use symbol paths such as \`symbols/add_bg\` or \`symbols/section_divider\`. Runtime-created pages are repaired through their helper symbol. Writer page breaks and Calc worksheets are indexed semantically. Nonstandard builders may use @webpilot-unit/@webpilot-endunit markers. Large unscoped reads may return the unit index and bounded-read guidance to control payload size. Scoped reads return exact unnumbered program text and sourceLineRange.coordinateSpace. sourceDigest/sourceUnitDigest may describe a selected unit, but patchBaseDigest ALWAYS guards the complete current draft. Copy patchBaseDigest into edit.baseDigest; never substitute another digest.

Large-draft repair is a bounded workflow: read one diagnostic-focused source unit/window and edit it. Do not reconstruct a large draft through consecutive reads. Exception: a signature change and its callers may require several small, targeted windows; read only those locations, confirm the same patchBaseDigest across them, and submit their related changes in one atomic call. Independent distant repairs can proceed one window at a time. After a saved edit, reuse the returned patchBaseDigest and still-exact source when possible; read again only for missing/stale context.

## Rendering and visual QA

Bespoke deckReview also requires contentConsistency and sourceTraceability: recompute chart/callout arithmetic and name actual source rows/periods in observation. In non-factual creative work, explain that there are no external factual claims rather than inventing citations. These are model-reviewed content checks, not automatic proof that a source is true.

For native presentation charts, use this file capability and query presentation.chart@2; a separate chart-rendering capability is not needed for editable Office charts. Reuse valueSchemas rather than guessing property names. Defaults suppress dense point labels, unwanted titles and stock/radar markers; enable labels only when they remain legible. title=None means no internal title, even for one series. Use font_name/font_color, grid_color/gridlines, line_width and series_transparency to integrate charts with the page. Filled radar defaults to partial transparency; do not label every vertex. Scatter/bubble x_axis_scale/y_axis_scale='log10' requires strictly positive data and bounds and must be disclosed visibly. Do not transform source values, hide outliers or imply causality to fit a layout. x/y axis titles and bounds refer to physical horizontal/vertical axes, including horizontal bars. Use separated, clearly labeled panels for incompatible measures; do not stack unrelated indices. Native-chart attribute checks and full-file rendering complement visual QA, not replace it.

Before authoring a factual analytical deck, assemble one verified metric dataset: value, unit, period, accounting/adjustment basis and actual accessed source URL/table. Derive chart arrays, callouts, totals, shares and growth from this same dataset instead of retyping independent literals. A successful source read does not verify every later claim attributed to it: audit each material claim against the exact table, especially quarter vs year and market platform vs reporting segment. Failed fetches, PDF bytes, remembered prices and “suggest cross-checking” are not evidence. Preserve provenance in source comments/slide notes and readable page references. Distinguish observations, calculations and visible scenario assumptions. For OHLC, aggregate actual days inside the stated interval (first open, max high, min low, last close); keep one split basis and do not invent/drop months or extend the cutoff. Obtain missing evidence or report the limitation. Every analytical page needs evidence, explanation and a decision implication. Pixel QA is not factual verification; both are needed for completion.

For bespoke decks, compare genuinely different compositions, not palette variants. Quality adjectives are not a supplied visual reference. Shared helpers may implement text/chart tokens, but must not force every page through the same title-rule-chart-sidebar shell. If the selected brief promises real imagery, acquire and embed relevant assets before final review; empty image placeholders or shape-only replacements do not satisfy that promise. Use content-specific evidence spreads, mechanism diagrams and decision layouts. Readability and truthful content take priority over decorative sophistication.

render publishes only the current validated source. A preview produced during validation and any sampled page are diagnostics, not full QA.

Treat automaticValidation.formatChecks and generationDiagnostics.featureCounts as the authoritative structural and semantic counts for slides or sheets, native charts, formulas, embedded images, Word tables, drawing objects, and explicitly named UNO capabilities. Compare those counts and every validation issue with the user's requested coverage before final delivery. Visual QA certifies only the reviewed page layout; it does not prove semantic feature coverage. If a required capability is absent, has a zero count, is unsupported, failed validation, or was not verified, report that exact limitation and do not say the artifact or suite fully passed. Copy each final downloadUrl verbatim from its successful current-session result; never build or absolutize a URL from an Artifact ID, session ID, host name, or file name.

For a vision-capable model initialized with visual file actions, visual QA is a mandatory delivery gate:

1. Call file action=visualIndex with the exact latest Artifact ID.
2. Read every screenshot id in returned order, in bounded batches, and actually inspect every attached page image. Inspect each page in three passes: identify its visible content and intended reading order; scan the four edges and every object boundary for clipping/overlap; then judge composition, hierarchy, typography, color, chart semantics, and image treatment.
3. Call file action=visualReport with an evidence-backed passed or failed review for every page that was read. Submit small batches (normally 2–4 pages) after inspection rather than repeatedly regenerating one full-deck report. Successful batches are retained for the same artifact; a schema-rejected batch saves nothing, so correct and resend only that uncommitted batch. Every page requires a concrete, page-specific observation that names visible anchors and their locations (for example the title, chart, table, image, footer, or empty region), plus checks for overlap, clipping, alignment, spacing, typography, contrast, visual hierarchy, chart/table legibility, and image quality. A bare \`passed\`, a generic paraphrase of the rubric, an empty issue list, or a visualRead alone never proves visual quality. Inspect the actual pixels at a useful size; do not infer quality from successful rendering or the absence of validator errors.
4. Inspect aesthetic and semantic defects even when geometry is valid: tiny or inconsistent type, weak hierarchy, unbalanced whitespace, overly sparse or crowded composition, uneven component rhythm, default gray chart chrome, poor chart labeling, inconsistent margins, stretched/soft images, or an awkward visual focal point. On every chart, a reader must be able to identify what each bar, line, point, or sector represents without guessing: reject placeholder categories such as 1/2/3, generic-only names such as Values or Series 1 when meaning is not otherwise explicit, missing or unreadable legends/axis labels/data labels, and labels that do not match the visualized data. For every content image, verify that its subject is identified by nearby content or a caption and that an alt/source attribution is present where the task requires it. Failed reviews must identify the exact visible region and defect.
5. Never waive a visible defect as a compatibility boundary and then mark the page or deck passed. A known visible defect is a failed review until repaired or explicitly accepted by the user. Preserving data is not acceptance of obscured labels or unreadable charts; do not invent user acceptance. \`warning\` is an issue severity, NOT a check status: unresolved issues, including warnings, require status=failed and the corresponding failed check. On schema rejection retain the defect evidence; never remove issues, move them only into observation, or relabel failed checks to manufacture passed. Never claim a numeric requirement is satisfied when the observed or structural count is lower (for example, four images is not at least five).
6. After every page has been inspected, compare the complete ordered set as a deck/document overview and submit one deckReview covering template, typography, color, margins, spacing rhythm, density, recurring component styling, cover/section/content differentiation, chart semantics, and image treatment. templateConsistency means coherent design rules, NOT identical layouts. For a saved bespoke brief, include designIntent and compositionRhythm in checks: compare the selected direction with actual hierarchy, imagery and data expression, and explain why repetition/variation serves the content. Name at least two concrete cross-page observations by page, including any deliberate comparable-page repetition. Generic praise or renamed colors is not design evidence. Completion is impossible without this passed cross-page review; a visible failure in these checks requires status=failed and concrete issues just like other checks.
7. For a failed page, readSource on the same documentId, edit a focused code window, then render once. Use only the returned current artifactId. Follow returned QA coverage: reuse runtime-restored reviews only when the runtime confirms unchanged screenshot evidence; inspect/review all remaining pages and complete the cross-page review. Do not regenerate or reread unchanged pages merely to repeat successful work.

Automatic screenshot checks cover only render integrity (measurable dimensions and near-blank detection). They are not an aesthetic verdict and \`automaticChecks[].issues=[]\` never means that a page visually passed.

Delivery succeeds only when visualQaDigest equals renderedDigest, seenPageCount equals pageCount, every page has an evidence-backed passed review with all applicable checks passed, and the complete artifact has a passed deckReview. A non-visual model may rely only on structural rendering checks and must not claim visual inspection.

## Avoid repeated work and incorrect recovery

- A successful generate/edit validates and saves a source checkpoint; it is not yet a downloadable delivery. A successful render publishes that checkpoint. Do not submit unchanged program text again to get the same file.
- A target/format/version conflict saves no edits. A validation failure may have saved the entire edited source. Inspect editStatus/saved/patchHunks/validation first; never infer saved state from ok alone. Historical partial results may exist: follow their explicit applied/failed counts rather than replaying the whole old request.
- Wrong identity or wrong read action: use the provided sourceRead/contentRead request. Repeating the same artifactId with reason="read source" still reads file content.
- Missing source: list to locate the exact existing draft. An externally uploaded Office file has no recoverable Python generator merely because readContent can parse it; use the modification workflow when needed.
- Syntax/validation/visual defects: patch exact source; do not retry unchanged generation as a repair. Infrastructure failures: preserve source and report/retry only as indicated by the returned retryability; do not redesign the file to conceal a provider or renderer error.
- readSource is for code; readContent is for data; visualRead is for pixels. Do not perform all three by default. Reuse content and visible evidence already available; request only missing information.
- After compression, recover the draft id and failed region from the registry/QA state, not the entire source and all prior screenshots. Do not repeatedly fetch API catalogs already present.

## Failure continuation

Read the complete error, validation state, digests, and diagnostics. Preserve documentId and artifactId when continuing the same logical document. Choose the next operation from that evidence instead of mechanically repeating the failed action or starting a substitute artifact.
`;

export const fileRuntimeSkill = Object.freeze({
  id: fileArtifactRuntimeSkillId,
  title: 'File Artifact Runtime',
  summary: fileArtifactRuntimeSkillSummary,
  content: fileArtifactRuntimeSkillContent,
  required: true,
  activation: [{ toolName: 'file' }],
} satisfies CapabilitySkill);
