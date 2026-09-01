export const fileArtifactRuntimeSkillId = 'system-file-artifact-runtime';

export const fileArtifactRuntimeSkillSummary = [
  '<system_skill>',
  `<id>${fileArtifactRuntimeSkillId}</id>`,
  '<title>File Artifact Runtime</title>',
  '<description>Hidden built-in operating manual shared by file and fileVisual. Their first governed call automatically loads and returns it while continuing the operation.</description>',
  '<required>true</required>',
  '</system_skill>',
].join('\n');

export const fileArtifactRuntimeSkillContent = `# File Artifact Runtime

This hidden built-in Skill is authoritative for the file and fileVisual artifact workflow. The backend loads it once per Agent run during the first governed file or fileVisual call and returns it in loadedRuntimeSkill while continuing the original operation.

## Required sequence

1. Call file or fileVisual normally.
2. On the first governed call, inspect loadedRuntimeSkill and the original tool result returned by that same transaction.
3. Continue the workflow below. Explicit skill action=read remains supported but is not required.

Every file and fileVisual action uses this same Skill. Do not read a second visual-only Skill. If automatic loading fails, use the complete error and requiredSkillId to restore the missing Skill registration. If the original tool operation fails, use its failureCategory and complete workflow result to correct the input or workflow state. Keep the same documentId or artifactId; never create a replacement document merely to escape a failed step.

The governed file actions are list, read, download, convert, plan, generate, edit, render, jsApi, and unoApi. The governed fileVisual actions are index, read, and report.

## Host tool boundary and result shape

\`file\` and \`fileVisual\` are model tools. They are not JavaScript globals and must not be called inside browserCode. Each example below is one provider-neutral tool call in its own model step.

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
declare function fileVisual(input: FileVisualInput): Promise<FileToolResult>;
\`\`\`

Do not guess returned identities. Copy \`documentId\`, \`artifactId\`, screenshot ids, and the requested next action exactly from the latest successful result. Source digests are informational runtime metadata and are never inputs to generate or edit.

## file API signatures

\`\`\`ts
type DocumentType = "word" | "spreadsheet" | "presentation";
type FileInput =
  | { action: "list"; reason?: string }
  | {
      action: "read";
      reason?: string;
      documentId: string;
      path?: string; // optional semantic unit path returned by read, for example pages/s30-risk-matrix or symbols/add_bg
      startLine?: number; // optional one-based source window, maximum 240 lines
      endLine?: number; // optional inclusive source-window end
    }
  | {
      action: "read";
      reason?: string;
      attachmentId?: string;
      artifactId?: string; // provide exactly one of attachmentId or artifactId
      includeVisuals?: boolean;
      offset?: number;
      limit?: number;
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
      sourceAttachmentId?: string; // required when operation is modify
    }
  | {
      action: "unoApi";
      reason?: string;
      documentId: string;
      documentType?: DocumentType; // inferred from the planned documentId when omitted
      query?: string;
      offset?: number;
      limit?: number;
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
      program: string;
      render?: boolean;
    }
  | {
      action: "edit";
      reason?: string;
      documentId: string;
      path?: string;
      edits?: FileLineEdit[];
      render?: boolean;
    }
  | {
      action: "render";
      reason?: string;
      documentId: string;
    };

type FileLineEdit =
  | { kind: "replaceRange"; startLine: number; endLine: number; newText: string; preserveIndent?: boolean }
  | { kind: "deleteRange"; startLine: number; endLine: number }
  | { kind: "insertBefore" | "insertAfter"; line: number; newText: string }
  | { kind: "replaceText"; oldText: string; occurrence?: number; newText: string } // occurrence is a one-based match index, never a replacement count
  | { kind: "replaceAll"; oldText: string; newText: string };
\`\`\`

Action requirements:

- \`list\`: no identity fields. Use it before starting or resuming authored Office/PDF work.
- \`read\`: with \`documentId\`, reads the current draft checkpoint. For a large source, read one returned source-unit \`path\` or a bounded \`startLine\`/\`endLine\` window; otherwise provide exactly one of \`attachmentId\` or \`artifactId\` to read an external/current artifact.
- \`download\`: provide a real source in \`urlOrPath\`, \`url\`, or \`path\`, plus \`fileType\` without a dot.
- \`convert\`: \`sourceArtifactId\` is the exact Artifact ID of the source Office file.
- \`plan\`: \`documentId\`, \`fileName\`, and \`documentType\` are required. \`operation\` defaults to \`"create"\`; \`sourceAttachmentId\` is required for \`operation: "modify"\`.
- \`unoApi\` and \`jsApi\`: call only after plan and only for its returned generation mode, always with the same \`documentId\`. Call \`unoApi\` before authoring. It returns one complete executable Office facade cookbook: every exact public signature generated from the installed implementation, accepted value schemas, copyable feature examples, support levels, and versioned recipes. Read that response instead of guessing or issuing one query per feature. A repeated call returns the same complete cached cookbook when recovery needs it. Raw UNO reflection is not exposed.
- \`generate\`: create or atomically replace the one editable source owned by the documentId. Calling generate for an existing documentId intentionally replaces its current complete source.
- \`edit\`: apply structured \`edits\` directly to the documentId current source. Do not send a whole-program replacement or a unified patch; use generate when the complete source intentionally needs replacement.
- \`render\`: publishes only the current source after that exact source passes validation.

## JavaScript presentation visualization choices

For JavaScript presentation drafts that use PptxGenJS:

- Prefer \`slide.addChart()\` for standard column charts, horizontal bar charts, and doughnut charts, and use it for every other standard chart family supported by PptxGenJS, including area, bubble, line, pie, radar, scatter, and supported combinations. In PptxGenJS, use the bar chart type with \`barDir: "col"\` for columns and \`barDir: "bar"\` for horizontal bars. Never hand-draw a supported chart from lines, shapes, or text.
- Prefer \`slide.addTable()\` for standard tables.
- Use \`slide.addShape()\` to construct KPI progress bars, mini charts, and special infographics whose appearance cannot be represented adequately by a native chart or table.
- Do not replace a standard native chart or table with manually positioned shapes merely for styling. A shape-based replacement is appropriate only when the requested visual is intentionally infographic-like or visual QA proves that the native object cannot produce the required result.

## UNO-backed high-level Office authoring

UNO remains the internal Office engine, but authored source uses only the returned facade and versioned feature recipes. Never import \`uno\`, reference \`com.sun.star\`, inspect private facade fields, or create raw services. JavaScript drafts continue to use \`job.PptxGenJS\`, \`job.docx\`, and \`job.ExcelJS\` directly with their existing validation flow.

- Create the requested document with \`job.writer(elementId)\`, \`job.presentation(elementId)\`, or \`job.spreadsheet(elementId)\`. Use \`deck.slide(...)\` for Impress and \`workbook.sheet(...)\` for Calc; never retain or manipulate a raw UNO page, sheet, cell, cursor, controller, enum, struct, or component.
- Every generated document, slide, paragraph, list, table, chart, image, worksheet, range, cell, and feature call must have a stable \`elementId\`. Element IDs may use Unicode (including Chinese), must be 1-128 non-whitespace characters, and child IDs passed to a slide or worksheet facade are automatically scoped under that parent. A reusable helper may therefore reuse role IDs such as \`background\` on different slides.
- The single \`unoApi\` response is authoritative for the whole draft. If it marks a capability \`preserve-only\` or \`unsupported\`, do not invent a raw UNO fallback. Preserve-only features may survive an existing-file edit but may not be created or materially rewritten.
- For Impress, create \`slide = deck.slide(id, layout=..., title=...)\` and place content through named slots with \`slide.add_text/image/table/chart/card/timeline\`. Use an explicit semantic box only when a named layout cannot express the requested composition.
- For Writer, keep body content in native flow with \`document.add_title/heading/paragraph/bullets/numbered_list/table/inline_image/page_break\`; page style and header/footer configuration use returned versioned recipes.
- For Calc, create \`sheet = workbook.sheet(id, name)\` and use A1-based \`sheet.set_cell/set_range/add_table/format/merge/freeze/column_width/row_height\`. Do not obtain raw sheets, cells, ranges, draw pages, or controllers.
- Impress text, images, tables, and charts participate in bounds and collision validation. Repair the returned leaf \`elementIds\`; do not hide defects by shrinking body text below 16pt.
- Deterministic format, structure, feature-count, reopen, render, and visual-QA gates all apply to the same current source. A successful reopen does not by itself prove pagination or slide layout.

## Proven UNO suite decisions

A verified reference run delivered an 18-slide Impress deck, a 12-page Writer report, and a seven-sheet Calc workbook through this same UNO -> LibreOffice pipeline with zero reported presentation overlap or out-of-bounds defects. Treat these as proven engineering decisions, not mandatory page counts or a content template:

- Finish one document through validation, render, and complete visual QA before starting the next format. A failed PPT draft is not a reason to begin Writer or Calc work.
- In Impress, allocate every page through \`deck.slide(...)\` named layouts and slots. Use semantic boxes only for intentional freeform composition, and never make a shared text helper silently increase box height because later elements will not reflow.
- The \`unoApi\` \`completeDocument\` is an executable high-level regression blueprint. Copy exact facade signatures and versioned feature recipes; do not copy worker internals or raw UNO from an old output file.
- Use native editable chart helpers for standard chart families and vector shapes only for intentional infographics.
- Keep Writer body content in normal flow. Use native TextSection/TextColumns for columns and give floating frames or images explicit anchors only when the requested design needs them.
- Keep Calc chart anchors inside each sheet's print area and validate that the complete source range, title row, and last category are included.
- A layout diagnostic identifies a leaf element or a primary collision source. Repair that concrete call site first. Change a shared helper only when the intended change is valid for every caller and the whole dependent layout is deliberately reflowed.
- Generate the complete initial source once, but keep long artifacts compact and data-driven through high-level facade calls and content arrays. Use focused structured edits for local defects. A syntax error, undefined name, duplicate ID, geometry defect, overlap, or one failing feature call is never grounds for complete replacement.
- Generate/edit performs structural UNO validation without attaching page screenshots to every repair call. A line-only edit wholly contained in one inferred page or sheet is automatically validated as that exact source unit even when \`path\` is omitted; final render still performs mandatory full-document validation. Once the requested content and feature counts are complete and validation passes with \`requiredNextAction=render\`, call render immediately; render and fileVisual are the only stages that should add page-image context.
- A disposed UNO bridge is retried automatically once with a fresh isolated LibreOffice profile. If it fails again, preserve the source and retry the unchanged facade program; source edits cannot repair LibreOffice process startup.

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
  action: "read",
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
  query: "text image table chart positioning formatting",
  reason: "读取该 UNO 计划所需的形状与排版 API"
})
\`\`\`

\`\`\`js
file({
  action: "generate",
  documentId: "quarterly-review",
  program: "# complete runnable source returned here",
  render: false,
  reason: "提交唯一一次初始可运行源文件"
})
\`\`\`

Make a focused line edit using line numbers from the latest \`read\` result:

\`\`\`js
file({
  action: "edit",
  documentId: "quarterly-review",
  edits: [{
    kind: "replaceRange",
    startLine: 120,
    endLine: 128,
    newText: "# replacement source for this exact section"
  }],
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

## fileVisual API signatures and examples

\`fileVisual\` exists only when the selected model supports image input and the runtime supplies page-image reading.

\`\`\`ts
type FileVisualInput =
  | {
      action: "index";
      reason?: string;
      artifactId: string;
      offset?: number;
      limit?: number;
    }
  | {
      action: "read";
      reason?: string;
      artifactId: string;
      screenshotIds: string[]; // one to six exact ids from index
    }
  | {
      action: "report";
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
      deckReview?: {
        status: "passed" | "failed";
        observation: string; // comparison across the complete rendered artifact
        checks: {
          templateConsistency: "passed" | "failed";
          typographyConsistency: "passed" | "failed";
          colorConsistency: "passed" | "failed";
          spacingRhythm: "passed" | "failed";
          componentConsistency: "passed" | "failed";
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
fileVisual({
  action: "index",
  artifactId: "exact-latest-artifact-id",
  offset: 0,
  limit: 100,
  reason: "列出当前 Artifact 的全部页面截图"
})
\`\`\`

\`\`\`js
fileVisual({
  action: "read",
  artifactId: "exact-latest-artifact-id",
  screenshotIds: ["screenshot-0001", "screenshot-0002"],
  reason: "读取并实际检查前两页"
})
\`\`\`

\`\`\`js
fileVisual({
  action: "report",
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

## Workflow state machine

1. Call file action=list before starting or resuming Office/PDF authoring, and reuse an existing documentId when it represents the requested work.
2. Call action=plan once for that documentId. For an existing attachment, use operation=modify with the exact sourceAttachmentId; for a new file, use operation=create.
3. Follow the generationMode returned by plan. Call action=unoApi only for an UNO plan or action=jsApi only for a JavaScript plan, always with the planned documentId.
4. Call action=generate to create the single editable source buffer. The source is saved even when validation fails.
5. Use action=edit for focused local repairs. Failed drafts remain editable. If the architecture itself needs replacement, call action=generate on the same documentId; it replaces that id's one current source.
6. Call action=render only after the current source passes validation; render publishes that exact source.
7. When visual QA is available, use fileVisual index -> read -> report against the exact latest Artifact ID until every page has an evidence-backed pass and the complete artifact has a passed deckReview.

Use action=read whenever the current source, fresh line numbers, workflow checkpoint, or validation diagnostics are needed. Use action=download for an existing URL/path and action=convert to convert an existing Office artifact identified by sourceArtifactId. For web research, browserCode may locate and verify a direct asset URL, but it must not fetch or save that asset locally; pass the direct URL to file action=download, then use the exact returned artifact name in Office source. Read downloaded image artifacts when authoritative pixel dimensions or aspect ratio are needed.

## Identity and current source

- documentId is the stable workspace identity. Reuse it across plan, API lookup, generate, read, edit, and render.
- Each documentId owns exactly one current editable source. There is no caller-visible version handshake, source history, or restore operation.
- action=edit always targets that one current source. action=generate always replaces it atomically.
- Digests in results are runtime checksums for validation, cache, render currency, and QA. Never send one back as an edit or generate argument.

Do not mix ids from different documents or formats. Different documentIds and output formats may coexist in one run.

## UNO and JavaScript modes

The plan result selects the mode; do not choose a different branch afterward.

- UNO: read unoApi before authoring and reuse its apiReference, valueSchemas, examples, completeDocument, support matrix, and versioned capabilities. It is one complete executable cookbook, not a broad signature summary. Do not spend calls or tokens querying individual features. Raw UNO reflection is intentionally unavailable.
- Facade element IDs must resolve to non-empty unique stable strings at runtime. Deterministic loop expressions such as \`"slide-" + str(i)\` are allowed. Child IDs passed to slide and sheet facades are automatically scoped under their parent.
- Presentation uses \`deck.slide(...)\`; Writer uses flow methods on \`document\`; Calc uses \`workbook.sheet(...)\` with A1 addresses. Use only signatures returned in the one complete manifest. A missing feature is unavailable for authored creation unless the manifest explicitly marks it supported.
- Assets resolve by exact names from the conversation workspace through facade image calls; the worker embeds them into the saved Office package.
- JavaScript: read jsApi for the planned document and use only its cookbook and supported libraries. Keep shared initialization/helpers/final output outside optional units.
- PDF is supported in both modes. JavaScript mode authors the matching Office intermediate and converts that exact result locally.

## Editing and recovery

action=edit accepts replaceRange, insertBefore, insertAfter, deleteRange, and exact replaceText/replaceAll. Do not use a unified patch. Read the exact source unit or bounded line window and submit the smallest structured edit directly against the documentId current source. replaceRange applies newText with its supplied indentation exactly, matching mature source editors. Set preserveIndent=true only when the replacement is deliberately written relative to the replaced block; never enable it for source copied from action=read or for mixed-indent Python blocks. Line edits and replaceText/replaceAll may be mixed in one atomic call: all line edits use coordinates from the same read and merge first, then exact-text edits run in their supplied order against that candidate. Every structured edit is saved to the one current source before validation, even when syntax or validation errors remain. Overlapping context ranges are minimized and merged atomically; later edits win only on the same changed source lines. Do not send a complete program replacement through edit, and do not replace most of the source with one replaceRange; use generate when the complete source truly needs replacement. For replaceText, omit occurrence when oldText is unique; otherwise occurrence is the one-based index of the intended match, not the number of replacements. To replace every exact match, send one replaceAll edit instead of a list of numbered replaceText edits.

For a Python syntax diagnostic, edit the exact offending line or the smallest syntactically complete block. In particular, repair \`unexpected indent\` with one exact-line replaceText/replaceRange whenever possible. Do not copy unchanged adjacent lines into newText: doing so creates duplicate slide factories and duplicate element calls without helping the syntax repair. After the edit, continue from the newly saved current source even if another diagnostic remains.

Edits are cumulative: one call may fix only one of many errors, and the next call continues from that saved result. Syntax, runtime, layout, or artifact validation failures keep the exact edited source plus diagnostics and remain editable. There is no consecutive-failure lock or automatic rollback. A diagnostic with a line, sourceExcerpt, source unit, helper, or elementId must be repaired with edit; do not answer such a failure by rewriting the draft with generate. action=generate atomically replaces the current source only when a complete-draft replacement is intentionally required, not as ordinary error recovery. Use action=read only when fresh line numbers or exact current text are needed. Rendering and final delivery remain blocked while validationStatus is failed.

Source units are optional navigation aids, not a source-size rule and never a validation requirement. For focused repairs, presentation page units use authored IDs such as \`pages/s30-risk-matrix\`; reusable Python helpers use symbol paths such as \`symbols/add_bg\` or \`symbols/section_divider\`. Runtime-created pages are repaired through their helper symbol. Writer page breaks and Calc worksheets are indexed semantically. Nonstandard builders may use @webpilot-unit/@webpilot-endunit markers. Large unscoped reads may return the unit index and bounded-read guidance to control payload size, but the complete source remains valid. Scoped reads report global source line numbers, and scoped line edits use those same global coordinates. Near-complete replaceRange edits are blocked; repair a focused region, use replaceAll for repeated exact text, or edit one unit.

## Rendering and visual QA

render publishes only the current validated source. A preview produced during validation and any sampled page are diagnostics, not full QA.

Treat automaticValidation.formatChecks as the authoritative structural counts for slides or sheets, native charts, formulas, embedded images, Word tables, and drawing objects. Compare those counts and every validation issue with the user's requested coverage before final delivery. Visual QA certifies only the reviewed page layout; it does not prove semantic feature coverage. If a required capability is absent, has a zero count, is unsupported, failed validation, or was not verified, report that exact limitation and do not say the artifact or suite fully passed. Copy each final downloadUrl verbatim from its successful current-session result; never build or absolutize a URL from an Artifact ID, session ID, host name, or file name.

For a vision-capable model, fileVisual is a mandatory delivery gate:

1. Call index with the exact latest Artifact ID.
2. Read every screenshot id in returned order, in bounded batches, and actually inspect every attached page image. Inspect each page in three passes: identify its visible content and intended reading order; scan the four edges and every object boundary for clipping/overlap; then judge composition, hierarchy, typography, color, chart semantics, and image treatment.
3. Call report with an evidence-backed passed or failed review for every page that was read. Every page requires a concrete, page-specific observation that names visible anchors and their locations (for example the title, chart, table, image, footer, or empty region), plus checks for overlap, clipping, alignment, spacing, typography, contrast, visual hierarchy, chart/table legibility, and image quality. A bare \`passed\`, a generic paraphrase of the rubric, an empty issue list, or a read alone never proves visual quality. Inspect the actual pixels at a useful size; do not infer quality from successful rendering or the absence of validator errors.
4. Inspect aesthetic and semantic defects even when geometry is valid: tiny or inconsistent type, weak hierarchy, unbalanced whitespace, overly sparse or crowded composition, uneven component rhythm, default gray chart chrome, poor chart labeling, inconsistent margins, stretched/soft images, or an awkward visual focal point. On every chart, a reader must be able to identify what each bar, line, point, or sector represents without guessing: reject placeholder categories such as 1/2/3, generic-only names such as Values or Series 1 when meaning is not otherwise explicit, missing or unreadable legends/axis labels/data labels, and labels that do not match the visualized data. For every content image, verify that its subject is identified by nearby content or a caption and that an alt/source attribution is present where the task requires it. Failed reviews must identify the exact visible region and defect.
5. Never waive a visible defect as a compatibility boundary and then mark the page or deck passed. A known visible defect is a failed review until repaired or explicitly accepted by the user. Never claim a numeric requirement is satisfied when the observed or structural count is lower (for example, four images is not at least five).
6. After every page has been inspected, compare the complete ordered set as a deck/document overview and submit one deckReview covering template, typography, color, margins, spacing rhythm, density, recurring component styling, cover/section/content differentiation, chart semantics, and image treatment. Name at least two concrete cross-page observations. Completion is impossible without this passed cross-page review.
7. Fix the current document with focused edits, render a new artifact, and restart complete QA using only the new Artifact ID.

Automatic screenshot checks cover only render integrity (measurable dimensions and near-blank detection). They are not an aesthetic verdict and \`automaticChecks[].issues=[]\` never means that a page visually passed.

Delivery succeeds only when visualQaDigest equals renderedDigest, seenPageCount equals pageCount, every page has an evidence-backed passed review with all applicable checks passed, and the complete artifact has a passed deckReview. A non-visual model may rely only on structural rendering checks and must not claim visual inspection.

## Failure continuation

Read the complete error and requiredNextAction. Preserve documentId and artifactId as applicable. Retry the required operation with corrected parameters or a focused edit against the one current source. Continue the original document workflow rather than starting a substitute artifact.
`;
