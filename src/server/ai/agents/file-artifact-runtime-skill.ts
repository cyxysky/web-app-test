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

Do not guess a returned id or digest. Copy \`documentId\`, \`artifactId\`, \`sourceDigest\`, \`renderedDigest\`, screenshot ids, revisions, and the requested next action exactly from the latest successful result.

## file API signatures

\`\`\`ts
type DocumentType = "word" | "spreadsheet" | "presentation";
type ApiTarget = "all" | "document" | "page" | "text" | "cursor" | "sheet" | "cell" | "shape" | "table" | "table-column" | "table-row" | "chart" | "chart-data";

type FileInput =
  | { action: "list"; reason?: string }
  | {
      action: "read";
      reason?: string;
      documentId: string;
      path?: string; // optional @webpilot-unit path, for example pages/slide-008
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
      target?: ApiTarget; // inferred from query; otherwise defaults to "document"
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
      baseDigest?: string;
      edits?: FileLineEdit[];
      patch?: string;
      restoreRevision?: number;
      render?: boolean;
    }
  | {
      action: "render";
      reason?: string;
      documentId: string;
    };

type FileLineEdit =
  | { kind: "replaceRange"; startLine: number; endLine: number; newText: string }
  | { kind: "deleteRange"; startLine: number; endLine: number }
  | { kind: "insertBefore" | "insertAfter"; line: number; newText: string }
  | { kind: "replaceText"; oldText: string; occurrence?: number; newText: string } // occurrence is a one-based match index, never a replacement count
  | { kind: "replaceAll"; oldText: string; newText: string };
\`\`\`

Action requirements:

- \`list\`: no identity fields. Use it before starting or resuming authored Office/PDF work.
- \`read\`: with \`documentId\`, reads the current draft source/checkpoint; otherwise provide exactly one of \`attachmentId\` or \`artifactId\` to read an external/current artifact.
- \`download\`: provide a real source in \`urlOrPath\`, \`url\`, or \`path\`, plus \`fileType\` without a dot.
- \`convert\`: \`sourceArtifactId\` is the exact Artifact ID of the source Office file.
- \`plan\`: \`documentId\`, \`fileName\`, and \`documentType\` are required. \`operation\` defaults to \`"create"\`; \`sourceAttachmentId\` is required for \`operation: "modify"\`.
- \`unoApi\` and \`jsApi\`: call only after plan and only for its returned generation mode, always with the same \`documentId\`. \`unoApi\` infers \`documentType\` from that plan and always returns the complete reflection catalog; use \`query\` only to filter that catalog.
- \`generate\`: call exactly once for a planned document. It creates the single editable source buffer even when validation fails.
- \`edit\`: after generation, including a failed initial validation, repair the same saved source with structured \`edits\`, one unified \`patch\`, or \`restoreRevision\`. Do not combine these mutation forms and do not send a whole-program replacement.
- \`render\`: publishes only the current source after that exact source passes validation.

## JavaScript presentation visualization choices

For JavaScript presentation drafts that use PptxGenJS:

- Prefer \`slide.addChart()\` for standard column charts, horizontal bar charts, and doughnut charts. In PptxGenJS, use the bar chart type with \`barDir: "col"\` for columns, \`barDir: "bar"\` for horizontal bars, and the doughnut chart type for rings.
- Prefer \`slide.addTable()\` for standard tables.
- Use \`slide.addShape()\` to construct KPI progress bars, mini charts, and special infographics whose appearance cannot be represented adequately by a native chart or table.
- Do not replace a standard native chart or table with manually positioned shapes merely for styling. A shape-based replacement is appropriate only when the requested visual is intentionally infographic-like or visual QA proves that the native object cannot produce the required result.

## UNO Writer authoring model

UNO Writer keeps the complete LibreOffice API available. Do not tell the user that an Office feature is unavailable merely because the high-level facade does not expose it.

The stable facade, element mapping, expert-mode audit, high-risk static checks, and format-specific deterministic checks in this section apply only to UNO drafts. JavaScript drafts continue to use \`job.PptxGenJS\`, \`job.docx\`, and \`job.ExcelJS\` directly with their existing validation flow.

- For new documents, use \`job.writer(elementId)\`, \`job.presentation(elementId)\`, or \`job.spreadsheet(elementId)\` by default. The stable facade covers ordinary flow content and bounded page, slide, and cell layout.
- Every generated page, paragraph, heading, list, table, chart, image, shape, worksheet, range, and cell must have a stable \`elementId\`. Reuse the same ID when repairing that logical element.
- If the stable facade cannot express a required Office feature, declare \`expert = job.expert("concrete reason")\`. Use the raw UNO handles exposed by that expert object and call \`expert.tag(target, elementId, kind, locator)\` for each raw UNO object.
- Expert mode preserves full Office capability, but it is explicit and auditable. Direct \`layout.raw\`, \`job.new_document()\`, and untagged raw UNO objects are rejected before execution.
- Keep ordinary text, tables, and images in flow layout unless the requested appearance genuinely needs floating placement. When using a floating frame, shape, image, or embedded chart, assign its anchor, wrapping, size, and position deliberately and inspect every affected rendered page.
- For Impress, read `deck.bounds()` once and compose ordinary content with `deck.content_box()`, `deck.grid()`, and `deck.stack()`. Do not hand-calculate a dense page of unrelated absolute coordinates when a facade layout can allocate non-overlapping cells.
- Impress text and images participate in collision validation automatically. `add_shape` is decorative by default; use `layout_role="content", allow_overlap=False` for semantic bars, chart marks, table cells, and diagram nodes. Use `layout_role="background"` or `"container"` and `allow_overlap=True` only for deliberate underlays.
- Treat every `text_overlap`, `image_overlap`, or `content_overlap` diagnostic as a blocking layout defect. Repair only the listed `elementIds` using the returned intersection and overlap ratio; do not hide the defect by shrinking body text below 16pt.
- Output validation may report floating objects, positioned text frames, or exact-height table rows as visual-review risks. These warnings preserve advanced authoring freedom; they are not permission to skip visual QA. Fix unintended clipping or overlap in the same source, while retaining intentional freeform composition.
- Deterministic validation runs before visual QA: format-specific package checks followed by LibreOffice render-and-reopen verification. Microsoft Office is not launched or required by this pipeline.
- Never use a successful reopen or a structurally valid package as proof that pagination is visually correct. Complete the current-artifact page review only after all deterministic gates have passed.

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
  reason: "读取当前源文件、修订号、digest 和工作流检查点"
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
  target: "shape",
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
  baseDigest: "exact-64-character-source-digest",
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

Restore a known committed revision after a bad direction:

\`\`\`js
file({
  action: "edit",
  documentId: "quarterly-review",
  restoreRevision: 3,
  render: false,
  reason: "把修订版 3 恢复为新的当前修订版"
})
\`\`\`

Render the exact validated source:

\`\`\`js
file({
  action: "render",
  documentId: "quarterly-review",
  reason: "验证并发布当前提交版本"
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
        issues?: Array<{
          type: string;
          description: string;
          region?: string;
          severity?: "error" | "warning";
        }>;
      }>;
    };
\`\`\`

\`\`\`js
fileVisual({
  action: "index",
  artifactId: "exact-latest-artifact-id",
  offset: 0,
  limit: 100,
  reason: "列出当前版本的全部页面截图"
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
    { screenshotId: "screenshot-0001", status: "passed" },
    {
      screenshotId: "screenshot-0002",
      status: "failed",
      issues: [{
        type: "clipping",
        description: "右侧图表图例被页面边界裁切",
        region: "right chart legend",
        severity: "error"
      }]
    }
  ],
  reason: "提交已查看页面的逐页结论"
})
\`\`\`

## Workflow state machine

1. Call file action=list before starting or resuming Office/PDF authoring, and reuse an existing documentId when it represents the requested work.
2. Call action=plan once for that documentId. For an existing attachment, use operation=modify with the exact sourceAttachmentId; for a new file, use operation=create.
3. Follow the generationMode returned by plan. Call action=unoApi only for an UNO plan or action=jsApi only for a JavaScript plan, always with the planned documentId.
4. Call action=generate exactly once to create the single editable source buffer. The source is saved even when validation fails.
5. Use action=edit for every later source change or validation repair. Once source exists, never call generate again.
6. Call action=render only after the current source passes validation; render publishes that exact source.
7. When visual QA is available, use fileVisual index -> read -> report against the exact latest Artifact ID until every page explicitly passes.

Use action=read whenever the current source, fresh line numbers, workflow checkpoint, validation diagnostics, revisions, or digests are needed. Use action=download for an existing URL/path and action=convert to convert an existing Office artifact identified by sourceArtifactId. Read downloaded image artifacts when authoritative pixel dimensions or aspect ratio are needed.

## Identity, revisions, and digests

- documentId is the stable workspace identity. Reuse it across plan, API lookup, generate, read, edit, and render.
- revision identifies a source version that passed validation. Failed source remains in the same editable buffer without creating a revision.
- sourceDigest identifies the exact current source bytes.
- validatedSourceDigest identifies the source that passed the complete validation pipeline. render is allowed only when it equals sourceDigest.
- renderedDigest identifies the source used for the current published artifact.
- visualQaDigest identifies the renderedDigest whose pages all received explicit passing reviews. Any source change invalidates prior full visual-QA state.

Do not mix ids from different documents or formats. Different documentIds and output formats may coexist in one run.

## UNO and JavaScript modes

The plan result selects the mode; do not choose a different branch afterward.

- UNO: read unoApi for the planned document. Geometry uses 1/100 mm while CharHeight uses points. In Impress, set Position/Size, add the shape to the page, write String/Text, then apply formatting. Never create scrollable text controls.
- Facade element IDs must resolve to non-empty unique stable strings at runtime. Deterministic loop expressions such as \`"slide-" + str(i)\` are allowed. Local helper functions that happen to be named \`add_text\` or \`add_shape\` are not facade calls. Raw UNO objects still require \`expert.tag(...)\` on the exact serialized object.
- The presentation facade directly supports \`deck.bounds()\`, \`deck.add_text(..., font_size, color, bold, italic, align, font_name)\`, and \`deck.add_shape(..., service, fill, line, line_width, fill_transparency)\`. \`deck.add_text\` keeps the exact requested box size; leave a small edge margin and resize the box or shorten copy if text does not fit. Use \`deck.bounds()\` for every full-slide/background or edge-aligned object. Copy the exact signatures returned by unoApi; do not guess other style keywords.
- JavaScript: read jsApi for the planned document and use only its cookbook and supported libraries. Keep shared initialization/helpers/final output outside optional units.
- PDF is supported in both modes. JavaScript mode authors the matching Office intermediate and converts that exact result locally.

## Editing and recovery

action=edit accepts replaceRange, insertBefore, insertAfter, deleteRange, exact replaceText/replaceAll, a unified patch, or restoreRevision. Do not send an unversioned complete program replacement through edit, and do not replace most of the source with one replaceRange. For replaceText, omit occurrence when oldText is unique; otherwise occurrence is the one-based index of the intended match, not the number of replacements. To replace every exact match, send one replaceAll edit instead of a list of numbered replaceText edits.

Every edit updates the one saved working source and validates it. Success creates a validated revision. Failure keeps the exact edited source plus diagnostics and requires another edit; it never restores an older source automatically. Use action=read when fresh line numbers or exact current text are needed. Rendering and final delivery remain blocked while validationStatus is failed.

Large scripts may optionally wrap self-contained page or section bodies in @webpilot-unit markers and use path-scoped read/edit. Unit edits validate an isolated candidate, while final render still validates the complete document. Near-complete replaceRange edits are blocked; repair a focused region, use replaceAll for repeated exact text, or edit one marked unit.

## Rendering and visual QA

render publishes only the current validated source. A preview produced during validation and any sampled page are diagnostics, not full QA.

Treat automaticValidation.formatChecks as the authoritative structural counts for slides or sheets, native charts, formulas, embedded images, Word tables, and drawing objects. Compare those counts and every validation issue with the user's requested coverage before final delivery. Visual QA certifies only the reviewed page layout; it does not prove semantic feature coverage. If a required capability is absent, has a zero count, is unsupported, failed validation, or was not verified, report that exact limitation and do not say the artifact or suite fully passed. Copy each final downloadUrl verbatim from its successful current-session result; never build or absolutize a URL from an Artifact ID, session ID, host name, or file name.

For a vision-capable model, fileVisual is a mandatory delivery gate:

1. Call index with the exact latest Artifact ID.
2. Read every screenshot id in returned order, in bounded batches, and actually inspect every attached page image.
3. Call report with an explicit passed or failed review for every page that was read. A read alone never passes QA.
4. Failed reviews must identify concrete issues such as clipping, overlap, unreadable contrast, empty/off-canvas content, distorted images, broken tables/charts, or inconsistent alignment.
5. Fix the current document with focused edits, render a new artifact, and restart complete QA using only the new Artifact ID.

Delivery succeeds only when visualQaDigest equals renderedDigest, seenPageCount equals pageCount, and every page has an explicit passed review. A non-visual model may rely only on structural rendering checks and must not claim visual inspection.

## Failure continuation

Read the complete error and requiredNextAction. Preserve documentId, revision, sourceDigest, renderedDigest, artifactId, and the last successful source as applicable. Retry the required operation with corrected parameters or a focused edit. Continue the original document workflow rather than starting a substitute artifact.
`;
