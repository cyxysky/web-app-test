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

\`file\` and \`fileVisual\` are model tools. They are not JavaScript globals and must not be called inside browserCode. Independent download calls are the exception to ordinary stateful sequencing: emit all known independent image/file downloads together in one model response so the runtime executes them concurrently. Draft reads, edits, generation, rendering, and browser mutations remain ordered.

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

Do not guess returned identities. Copy \`documentId\`, \`artifactId\`, screenshot ids, and the requested next action exactly from the latest successful result. For edit, copy the latest read result's \`patchBaseDigest\` into \`baseDigest\`; other source and render digests remain informational runtime metadata.

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
      replaceExisting?: boolean; // exceptional last resort; never an ordinary repair
      baseDigest?: string; // required with replaceExisting
      render?: boolean;
    }
  | {
      action: "edit";
      reason?: string;
      documentId: string;
      path?: string;
      baseDigest: string;
      patch: string;
      render?: boolean;
    }
  | {
      action: "render";
      reason?: string;
      documentId: string;
    };
\`\`\`

Action requirements:

- \`list\`: no identity fields. Use it before starting or resuming authored Office/PDF work.
- \`read\`: with \`documentId\`, reads the current draft checkpoint. For a large source, read one returned source-unit \`path\` or a bounded \`startLine\`/\`endLine\` window; otherwise provide exactly one of \`attachmentId\` or \`artifactId\` to read an external/current artifact.
- \`download\`: provide a real source in \`urlOrPath\`, \`url\`, or \`path\`, plus \`fileType\` without a dot. When two or more independent URLs are already known, emit their separate file calls in the same model response; the runtime batches them concurrently, coalesces duplicates, limits same-origin pressure, and performs only short bounded 429 retries. For Wikimedia, copy the exact thumbnail URL returned by Commons \`imageinfo/thumburl\`; never invent or rewrite its \`Npx-\` size segment. Never add a manual sleep or a fixed 30-second wait; after a persistent 429, switch to a different source or origin.
- \`convert\`: \`sourceArtifactId\` is the exact Artifact ID of the source Office file.
- \`plan\`: \`documentId\`, \`fileName\`, and \`documentType\` are required. \`operation\` defaults to \`"create"\`; \`sourceAttachmentId\` is required for \`operation: "modify"\`.
- \`unoApi\` and \`jsApi\`: normally call after plan and only for its returned generation mode, always with the same \`documentId\`. An early UNO catalog lookup is also accepted when both \`documentId\` and \`documentType\` are supplied; it is read-only and returns \`boundToPlannedDraft=false\` plus \`nextAction=plan\`, so plan that same ID before generate. For UNO, omit \`query\` once to receive the module index, then query only the modules the draft uses (for example \`presentation.shape\` or \`presentation.professional\`). Every module response contains all exact installed signatures, accepted schemas, and registered examples for that module. Copy those examples instead of guessing. Repeated planned-module queries are cached. Raw UNO reflection is not exposed.
- \`generate\`: create the initial source only. Once a documentId has a working source, \`edit\` is the mandatory first choice for every repair, validation failure, layout correction, content revision, and patch retry. A guarded complete replacement is an exceptional last resort only when the required change genuinely cannot be expressed as bounded patches without rebuilding most of the program. Never replace merely because a patch had invalid syntax, stale context, a matching conflict, or many diagnostics; read the current source and repair the patch instead. If replacement is truly unavoidable, read the complete current draft first, then pass \`replaceExisting=true\` and its exact \`patchBaseDigest\` as \`baseDigest\`. Initial generation and exceptional replacement must both preserve exactly one top-level synchronous \`def create_document(job):\`; keep every facade call inside it, and finish with exactly one \`facade.save()\` followed by exactly one \`facade.close()\`.
- \`edit\`: apply one Codex-format patch in \`patch\` to the exact source identified by \`baseDigest\`. Use exactly one \`*** Begin Patch\` / \`*** End Patch\` envelope containing \`*** Update File: draft.py\` and one or more \`@@\` hunks; every unchanged line starts with one space, every deletion with \`-\`, and every addition with \`+\`. Never wrap each hunk in another Begin/End pair, invent a separate \`replace\` field, or write unified-diff line-number headers. Put independent repairs in separate \`@@\` hunks of one call. Each hunk is atomic and independent: successful hunks are saved even if another hunk has stale context; then read the new source/digest and retry only the reported conflicts.
- In an edit hunk, replacing a line always means \`-old line\` followed by \`+new line\`. A space-prefixed old line is unchanged context, so writing \` old line\` followed only by \`+new line\` inserts a duplicate; never use that form for replacement. Every hunk must contain a real \`+\` or \`-\` change; a context-only hunk is rejected before matching. Copy indentation from the exact unnumbered read result for both \`-\` and \`+\` lines.
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
- Every generated document, slide, paragraph, list, table, chart, image, worksheet, range, cell, and feature call must have a stable \`elementId\`. Element IDs may use Unicode (including Chinese), must fit 1-128 characters, and child IDs passed to a slide facade are automatically scoped and whitespace-normalized under that parent. Prefer role/index IDs instead of deriving identifiers from visible labels. A reusable helper may therefore reuse role IDs such as \`background\` on different slides.
- The queried \`unoApi\` modules are authoritative for the APIs they cover. Query every module the draft uses. If a module marks a capability \`preserve-only\` or \`unsupported\`, do not invent a raw UNO fallback. Preserve-only features may survive an existing-file edit but may not be created or materially rewritten.
- Exact presentation capability names in the plan are a semantic contract. Query \`presentation.shape\` and use its complete specialized-shape example for \`RectangleShape\`, \`EllipseShape\`, \`CustomShape\`, \`CaptionShape\`, \`ConnectorShape\`, \`LineShape\`, \`MeasureShape\`, \`TextShape\`, and \`GraphicObject\`; each explicitly requested item must have its own non-zero generated \`featureCounts\` key. A lookalike, fileVisual claim, or reopened generic shape count cannot substitute for the named capability.
- \`shape_type='caption'\` and \`shape_type='measure'\` invoke the real native UNO services and automatically pair them with one named editable export fallback because LibreOffice drops raw CaptionShape and MeasureShape during PPTX export. Use the one facade call shown by \`presentation.shape\`; never add a second manual lookalike or claim the exporter preserves the raw service.
- For Impress, create \`slide = deck.slide(id, layout=..., title=...)\` and place content through named slots with \`slide.add_text/image/table/chart/card/timeline\`. Passing \`title\` fills the layout's title slot; do not add another title over it. Use \`layout='blank'\` for a fully custom cover or section composition. Never emulate a connector arrowhead with a separate \`triangle\` shape: making the triangle box touch the target does not put its top-center apex on the line endpoint, so the visible arrow tip lands above or beside the target. Use \`slide.connect(..., end_arrow=True)\`; when complete endpoint boxes are already allocated, add the connector before the node shapes, otherwise create the child IDs first and pass those IDs. Use \`slide.add_header(...)\` and \`slide.add_footer(...)\` for repeated chrome; both stay inside layout-reserved margins, so never draw a manual rule through the title or body slots. Use \`slide.grid(...)\` and \`slide.stack(...)\` for freeform composition. They return one flat row-major list (never nested rows) of mapping cells with \`x/y/width/height\`, PptxGenJS-compatible \`w/h\` aliases, and a unit marker. Iterate that list directly and pass \`box=cell\`; never flatten/extend it or tuple-index a cell. \`deck.content_box/grid/stack\` return the same unit-tagged rectangles. Prefer \`add_card\`, \`add_timeline\`, native tables/charts, and allocated cells over hand-layering a rectangle plus several independently sized text boxes. Omit text-box height or set \`auto_height=True\` when subsequent elements are allocated from a stack rather than hand-positioned.
- New Impress decks use the fixed wide-screen canvas \`13.333 x 7.5\` inches, whose horizontal center is \`6.6665\`. Never compose a blank slide against a \`10 x 7.5\` canvas. \`align='CENTER'\` centers text only inside its own box; it does not center that box on the slide. Prefer named slots or \`slide.grid/stack\` without an explicit box. For intentional freeform geometry, derive the region from \`deck.bounds()\` / \`deck.content_box()\` or center an inch box with \`x = (13.333 - width) / 2\`.
- Presentation text rejects \`letter_spacing\`, \`tracking\`, \`margin\`, \`autofit\`, and \`word_wrap\`. Use only the installed \`presentation.text\` vocabulary; replace those guesses with \`padding\`, \`line_spacing\`, \`min_font_size\`, explicit box geometry, or \`auto_height\`.
- \`slide.add_chart\` creates a native OLE2 chart, not a vector-shape chart; never claim otherwise in the delivery report. Its background is transparent by default. Give Cartesian charts with titles/axis titles/legends enough height, and for pie/donut choose either legend + percent-only labels or category labels without a legend. Reopen validation rejects any OLE2 chart that collapses to a non-positive size.
- For Writer, keep body content in native flow with \`document.add_title/heading/paragraph/bullets/numbered_list/table/inline_image/page_break\`; page style and header/footer configuration use returned versioned recipes.
- For Calc, create \`sheet = workbook.sheet(id, name)\` and use A1-based \`sheet.set_cell/set_range/add_table/format/merge/freeze/column_width/row_height\`. Do not obtain raw sheets, cells, ranges, draw pages, or controllers.
- Impress text, images, tables, and charts participate in bounds and collision validation. Repair the returned leaf \`elementIds\`; do not hide defects by shrinking body text below 16pt.
- Deterministic format, structure, feature-count, reopen, render, and visual-QA gates all apply to the same current source. A successful reopen does not by itself prove pagination or slide layout.

## Proven UNO suite decisions

A verified reference run delivered an 18-slide Impress deck, a 12-page Writer report, and a seven-sheet Calc workbook through this same UNO -> LibreOffice pipeline with zero reported presentation overlap or out-of-bounds defects. Treat these as proven engineering decisions, not mandatory page counts or a content template:

- Finish one document through validation, render, and complete visual QA before starting the next format. A failed PPT draft is not a reason to begin Writer or Calc work.
- In Impress, allocate every page through \`deck.slide(...)\` named layouts and slots. Use semantic boxes only for intentional freeform composition, and never make a shared text helper silently increase box height because later elements will not reflow.
- Each \`unoApi\` module includes installed-facade examples for all of its registered cases. Copy the exact signature and closest example; do not copy worker internals or raw UNO from an old output file.
- Use native editable chart helpers for standard chart families and vector shapes only for intentional infographics.
- Keep Writer body content in normal flow. Use native TextSection/TextColumns for columns and give floating frames or images explicit anchors only when the requested design needs them.
- Keep Calc chart anchors inside each sheet's print area and validate that the complete source range, title row, and last category are included.
- A layout diagnostic identifies a leaf element or a primary collision source. Repair that concrete call site first. Change a shared helper only when the intended change is valid for every caller and the whole dependent layout is deliberately reflowed.
- Keep long artifacts compact and data-driven through high-level facade calls and content arrays. Prefer focused Codex-format patches for local defects; use the guarded generate replacement when the draft genuinely needs a complete architectural rewrite.
- Generate/edit performs structural UNO validation without attaching page screenshots to every repair call. A patch scoped by \`path\` to one page or sheet is validated as that exact source unit; final render still performs mandatory full-document validation. Once the requested content and feature counts are complete and validation passes with \`requiredNextAction=render\`, call render immediately. Render creates the indexed previews but does not attach the whole document to the model; only bounded \`fileVisual read\` batches add page-image context.
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
  query: "presentation.shape",
  reason: "读取形状模块的精确签名、参数结构与全部示例"
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

Make a focused patch from the exact unnumbered \`program\` and \`patchBaseDigest\` returned by the latest \`read\` result:

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
      screenshotIds: string[]; // one to eight exact ids from index
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
5. When a source already exists, use action=edit first and continue editing that same source until it validates. \`requiredNextAction=edit\` is binding. Failed drafts remain editable; a malformed or conflicting patch must be corrected and retried as edit, never converted into generate. Use guarded replacement only as a last resort when bounded patches cannot coherently implement a near-total program rebuild, after reading the complete current source and its exact patchBaseDigest.
6. Call action=render only after the current source passes validation; render publishes that exact source.
7. When visual QA is available, use fileVisual index -> read -> report against the exact latest Artifact ID until every page has an evidence-backed pass and the complete artifact has a passed deckReview.

Use action=read whenever the exact current source, patchBaseDigest, workflow checkpoint, or validation diagnostics are needed. Use action=download for an existing URL/path and action=convert to convert an existing Office artifact identified by sourceArtifactId. For web research, browserCode may locate and verify a direct asset URL, but it must not fetch or save that asset locally; pass the direct URL to file action=download, then use the exact returned artifact name in Office source. Read downloaded image artifacts when authoritative pixel dimensions or aspect ratio are needed.

## Identity and current source

- documentId is the stable workspace identity. Reuse it across plan, API lookup, generate, read, edit, and render.
- Each documentId owns exactly one current editable source. There is no source history or restore operation; the latest read's patchBaseDigest is only an optimistic-concurrency guard for edit.
- action=edit always targets that one current source. Initial action=generate creates it atomically; the guarded replaceExisting form replaces that same buffer without creating a second document identity.
- Digests in results are runtime checksums for validation, cache, render currency, and QA. For every edit, copy the latest read's patchBaseDigest as baseDigest; do not use older source or render digests.

Do not mix ids from different documents or formats. Different documentIds and output formats may coexist in one run.

## UNO and JavaScript modes

The plan result selects the mode; do not choose a different branch afterward.

- UNO: read the unoApi module index before authoring, then query each module actually used by the draft. Reuse that module's apiReference, valueSchemas, examples, support matrix, and versioned capabilities. Module results are exhaustive for their registered examples and intentionally omit unrelated APIs. Raw UNO reflection is unavailable.
- Facade element IDs must resolve to non-empty unique stable strings at runtime. Deterministic loop expressions such as \`"slide-" + str(i)\` are allowed. Child IDs passed to slide and sheet facades are automatically scoped under their parent.
- Presentation uses \`deck.slide(...)\`; Writer uses flow methods on \`document\`; Calc uses \`workbook.sheet(...)\` with A1 addresses. Use only signatures returned by the corresponding queried module. A missing feature is unavailable for authored creation unless a module explicitly marks it supported.
- Assets resolve by exact names from the conversation workspace through facade image calls; the worker embeds them into the saved Office package.
- JavaScript: read jsApi for the planned document and use only its cookbook and supported libraries. Keep shared initialization/helpers/final output outside optional units.
- PDF is supported in both modes. JavaScript mode authors the matching Office intermediate and converts that exact result locally.

## Editing and recovery

action=edit accepts one Codex apply_patch document plus the exact baseDigest returned as patchBaseDigest by the latest read of the same documentId and optional path. Use only \`*** Begin Patch\`, \`*** Update File: draft.py\`, one or more \`@@\` hunks, and \`*** End Patch\`; never calculate or emit hunk line counts. Immediately before the tool call, verify every hunk contains a literal \`-old\` or \`+new\` line; a replacement contains both. Never submit a block made only of unchanged context. The parser follows Codex matching order: exact, trailing-whitespace-insensitive, trimmed, then Unicode-punctuation-normalized. Unchanged context lines always retain the current source's original whitespace and indentation, even after a fuzzy match; added lines are inserted exactly as written. A malformed patch, context-only hunk, or stale whole-draft digest fails before editing. Within a valid patch, each real-change \`@@\` hunk is applied independently: matching hunks are saved, non-matching hunks are reported by index, and the next retry must start from a new read and digest. If documentId is accidentally omitted, the runtime recovers it only when baseDigest uniquely identifies one editable draft; still copy documentId explicitly from read.

For example, replace \`    title = "Old"\` with \`    title = "New"\` using the two change lines \`-    title = "Old"\` and \`+    title = "New"\`. Do not write the old line with a leading space and then add the new line; that is a valid insertion, not a replacement.

For Python syntax diagnostics, patch each smallest syntactically complete block. Repair every independent syntax issue returned by AST preflight in one patch whenever the contexts do not overlap. Never reconstruct indentation from diagnostic line numbers or prose: copy it from read.program.

Put every independent repair into separate non-overlapping \`@@\` hunks of the same patch. Include at least two unchanged context lines around small changes when possible; repeated code requires enough context to identify one location. An optional \`@@ function_or_section\` anchor advances matching to that source line without using numeric coordinates. Successful hunks and a validation-failed candidate are saved, so every follow-up patch must start from a new read and patchBaseDigest. A diagnostic with a line, sourceExcerpt, source unit, helper, or elementId must be repaired with edit. Rendering and final delivery remain blocked until the current source validates and renders.

Source units are optional navigation aids, not a source-size rule and never a validation requirement. For focused repairs, presentation page units use authored IDs such as \`pages/s30-risk-matrix\`; reusable Python helpers use symbol paths such as \`symbols/add_bg\` or \`symbols/section_divider\`. Runtime-created pages are repaired through their helper symbol. Writer page breaks and Calc worksheets are indexed semantically. Nonstandard builders may use @webpilot-unit/@webpilot-endunit markers. Large unscoped reads may return the unit index and bounded-read guidance to control payload size. Scoped reads return exact unnumbered source for that unit and a digest scoped to the same path; reuse both path and patchBaseDigest in edit.

## Rendering and visual QA

render publishes only the current validated source. A preview produced during validation and any sampled page are diagnostics, not full QA.

Treat automaticValidation.formatChecks and generationDiagnostics.featureCounts as the authoritative structural and semantic counts for slides or sheets, native charts, formulas, embedded images, Word tables, drawing objects, and explicitly named UNO capabilities. Compare those counts and every validation issue with the user's requested coverage before final delivery. Visual QA certifies only the reviewed page layout; it does not prove semantic feature coverage. If a required capability is absent, has a zero count, is unsupported, failed validation, or was not verified, report that exact limitation and do not say the artifact or suite fully passed. Copy each final downloadUrl verbatim from its successful current-session result; never build or absolutize a URL from an Artifact ID, session ID, host name, or file name.

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
