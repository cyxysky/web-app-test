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
- \`unoApi\` and \`jsApi\`: call only after plan and only for its returned generation mode, always with the same \`documentId\`. \`unoApi\` infers \`documentType\` from that plan and returns the complete reflection catalog; use \`query\` to focus later lookups when needed.
- \`generate\`: create or atomically replace the one editable source owned by the documentId. Calling generate for an existing documentId intentionally replaces its current complete source.
- \`edit\`: apply structured \`edits\` directly to the documentId current source. Do not send a whole-program replacement or a unified patch; use generate when the complete source intentionally needs replacement.
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
- Element IDs are document-global, including objects created inside helpers. Every helper that can run more than once must accept a caller-owned \`sid\` or \`id_prefix\`; every logical role inside that helper must use a distinct suffix such as \`/dot\`, \`/dot-inner\`, and \`/description\`. Never reuse one short suffix for both a shape and its label.
- Duplicate IDs are deterministically disambiguated by the runtime and returned as warnings so one collision cannot discard an otherwise valid document. Treat that warning as source-quality debt: fix the shared helper namespace once on the next relevant edit. Do not rename only the last reported instance and do not regenerate the whole document for an ID warning.
- If the stable facade cannot express a required Office feature, declare \`expert = job.expert("concrete reason")\`. When a facade already exists, get its raw document only with \`doc = expert.component(layout)\`; never guess \`layout.component\`, \`layout._component\`, or \`getattr(layout, ...)\`. Keep only \`import uno\`: \`from com.sun.star...\` imports are unsupported, so use the exact \`uno.Enum\`, \`uno.getConstantByName\`, and \`uno.createUnoStruct\` forms returned by unoApi. Call \`expert.tag(target, elementId, kind, locator, layout_role=..., allow_overlap=...)\` for each raw UNO object. In Impress, raw \`shape\` tags default to decorative; explicitly mark semantic bars/nodes/table cells/chart marks as \`layout_role="content", allow_overlap=False\`, and deliberate cards/backgrounds as \`layout_role="container"\` or \`"background"\`, \`allow_overlap=True\`.
- Do not enter expert mode merely to demonstrate that raw UNO exists. “Full capability” means representative, reliable Office features through the stable facade; use raw services only for a concrete requested feature that the facade cannot express. Do not equate feature coverage with more pages, more source lines, or one-off low-level objects.
- Expert mode preserves full Office capability, but it is explicit and auditable. Direct \`layout.raw\`, \`job.new_document()\`, and untagged raw UNO objects are rejected before execution.
- Keep ordinary text, tables, and images in flow layout unless the requested appearance genuinely needs floating placement. When using a floating frame, shape, image, or embedded chart, assign its anchor, wrapping, size, and position deliberately and inspect every affected rendered page.
- For Impress, read \`deck.bounds()\` once. Use \`deck.mm/cm/inch/pt\` for explicit units and compose ordinary content with \`deck.content_box()\`, \`deck.grid()\`, \`deck.stack()\`, \`deck.add_text_box()\`, \`deck.add_card()\`, \`deck.add_footer()\`, and \`deck.add_connector()\`. Pass content-box margins as a named mapping \`{"left": ..., "right": ..., "top": ..., "bottom": ...}\`; do not memorize or guess tuple order. Connect grid/stack cells with \`deck.add_connector_between(element_id, page, source_box, target_box)\`; use coordinate-level \`add_connector\` only for chart axes or endpoints already derived from bounded boxes. Use \`deck.add_native_table()\`, \`deck.add_bar_chart()\`, \`deck.add_line_chart()\`, \`deck.add_donut_chart()\`, and \`deck.add_timeline()\` for those standard visuals. Use \`deck.add_image_contain()\` whenever an image must retain its aspect ratio. These are the UNO equivalent of the higher-level JavaScript presentation API; do not hand-calculate a dense page of unrelated absolute coordinates or recreate these components with raw services.
- Never infer a text-box geometry height from a point font size. Use \`deck.text_height()\` or \`deck.estimate_text_box()\`; the static preflight rejects boxes that cannot hold even \`min_font_size\` because geometry is 1/100 mm while CharHeight is pt.
- Impress text and images participate in collision validation automatically. \`add_shape\` is decorative by default; use \`layout_role="content", allow_overlap=False\` for semantic bars, chart marks, table cells, and diagram nodes. Use \`layout_role="background"\` or \`"container"\` and \`allow_overlap=True\` only for deliberate underlays.
- Treat every returned \`text_overlap\`, \`image_overlap\`, or \`content_overlap\` diagnostic as a blocking layout defect. Container/background shapes are excluded by the runtime, so do not move a correctly tagged card merely because its children occupy it. Repair only the listed content \`elementIds\` using the returned intersection and overlap ratio; do not hide the defect by shrinking body text below 16pt.
- Output validation may report floating objects, positioned text frames, or exact-height table rows as visual-review risks. These warnings preserve advanced authoring freedom; they are not permission to skip visual QA. Fix unintended clipping or overlap in the same source, while retaining intentional freeform composition.
- Deterministic validation runs before visual QA: format-specific package checks followed by LibreOffice render-and-reopen verification. Microsoft Office is not launched or required by this pipeline.
- Never use a successful reopen or a structurally valid package as proof that pagination is visually correct. Complete the current-artifact page review only after all deterministic gates have passed.

## Proven UNO suite decisions

A verified reference run delivered an 18-slide Impress deck, a 12-page Writer report, and a seven-sheet Calc workbook through this same UNO -> LibreOffice pipeline with zero reported presentation overlap or out-of-bounds defects. Treat these as proven engineering decisions, not mandatory page counts or a content template:

- Finish one document through validation, render, and complete visual QA before starting the next format. A failed PPT draft is not a reason to begin Writer or Calc work.
- In Impress, allocate the page with \`bounds\`, explicit unit helpers, \`content_box\`, \`grid\`, and \`stack\`; use measured \`add_text_box\`, \`add_card\`, and \`add_footer\` components before dropping to raw coordinates. Never make a shared text helper silently increase box height because later elements will not reflow.
- The presentation \`unoApi\` cookbook \`completeDocument\` is an executable regression blueprint distilled from the verified zero-overlap suite. Start from its \`page_base\`, grid, native-table, chart, and timeline composition patterns instead of inventing a new low-level framework. Copy exact facade signatures; do not copy private worker internals from an old output file.
- Use vector shapes for stable presentation infographics and charts. Do not use Impress OLE2 charts that reopen as zero-size objects; place genuinely editable native charts in Calc.
- Keep Writer body content in normal flow. Use native TextSection/TextColumns for columns and give floating frames or images explicit anchors only when the requested design needs them.
- Keep Calc chart anchors inside each sheet's print area and validate that the complete source range, title row, and last category are included.
- A layout diagnostic identifies a leaf element or a primary collision source. Repair that concrete call site first. Change a shared helper only when the intended change is valid for every caller and the whole dependent layout is deliberately reflowed.
- Generate the complete initial source once, but for a long deck keep code compact and data-driven: shared page chrome plus facade component calls and content arrays, not one hand-positioned coordinate program per slide. Use focused structured edits for local defects. A syntax error, undefined name, duplicate ID, geometry defect, overlap, or one failing raw helper is never grounds for complete replacement. Replace a failed source atomically only when a bounded read proves that the top-level document/facade architecture itself is incompatible; state that concrete architectural defect in the generate reason and keep the same documentId.
- Generate/edit performs structural UNO validation without attaching page screenshots to every repair call. A line-only edit wholly contained in one inferred page or sheet is automatically validated as that exact source unit even when \`path\` is omitted; final render still performs mandatory full-document validation. Once the requested content and feature counts are complete and validation passes with \`requiredNextAction=render\`, call render immediately; render and fileVisual are the only stages that should add page-image context.
- A disposed UNO bridge is retried automatically once with a fresh isolated LibreOffice profile. If it fails again at the same source line, edit only that expert/raw helper into a stable facade composition or a simpler tagged object. Never respond to bridge disposal by rewriting unrelated sections.

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

Use action=read whenever the current source, fresh line numbers, workflow checkpoint, or validation diagnostics are needed. Use action=download for an existing URL/path and action=convert to convert an existing Office artifact identified by sourceArtifactId. Read downloaded image artifacts when authoritative pixel dimensions or aspect ratio are needed.

## Identity and current source

- documentId is the stable workspace identity. Reuse it across plan, API lookup, generate, read, edit, and render.
- Each documentId owns exactly one current editable source. There is no caller-visible version handshake, source history, or restore operation.
- action=edit always targets that one current source. action=generate always replaces it atomically.
- Digests in results are runtime checksums for validation, cache, render currency, and QA. Never send one back as an edit or generate argument.

Do not mix ids from different documents or formats. Different documentIds and output formats may coexist in one run.

## UNO and JavaScript modes

The plan result selects the mode; do not choose a different branch afterward.

- UNO: read unoApi for the planned document. Geometry uses 1/100 mm while CharHeight uses points. In Impress, set Position/Size, add the shape to the page, write String/Text, then apply formatting. Never create scrollable text controls.
- Facade element IDs must resolve to non-empty unique stable strings at runtime. Deterministic loop expressions such as \`"slide-" + str(i)\` are allowed. Local helper functions that happen to be named \`add_text\` or \`add_shape\` are not facade calls. Raw UNO objects still require \`expert.tag(...)\` on the exact serialized object.
- The presentation facade directly supports \`deck.bounds()\`, \`deck.add_text(..., font_size, color, bold, italic, align, font_name)\`, and \`deck.add_shape(..., service, fill, line, line_width, fill_transparency)\`. \`deck.add_text\` keeps the exact requested box size; leave a small edge margin and resize the box or shorten copy if text does not fit. Use \`deck.bounds()\` for every full-slide/background or edge-aligned object. Copy the exact signatures returned by unoApi; do not guess other style keywords.
- Use \`deck.add_text_link(..., url="https://...")\` for external links and \`deck.add_text_link(..., target_slide_id="stable-slide-id")\` for click-to-jump text. The target is the stable ID passed to \`deck.add_slide()\`; forward slide references are supported. Do not report hyperlinking as unavailable without first querying and using this facade.
- \`deck.add_native_table()\` creates a native editable Impress TableShape. Its cell text and styling remain editable in PowerPoint/Impress; spreadsheet-style formulas are not a PowerPoint table feature and must not be described as an UNO failure.
- Stable Impress chart helpers serialize data graphics as editable vector shapes because native OLE chart round trips are not reliable. Read \`vectorChartCount\` and \`totalChartCount\` in formatChecks; \`nativeChartCount=0\` does not mean that requested visible charts are absent.
- Image facade calls resolve real files from the conversation asset workspace through \`job.asset_path()\`; LibreOffice embeds those files into the Office package. Never claim that the runtime accepts only Base64 image literals or lacks an asset-file path channel.
- JavaScript: read jsApi for the planned document and use only its cookbook and supported libraries. Keep shared initialization/helpers/final output outside optional units.
- PDF is supported in both modes. JavaScript mode authors the matching Office intermediate and converts that exact result locally.

## Editing and recovery

action=edit accepts replaceRange, insertBefore, insertAfter, deleteRange, and exact replaceText/replaceAll. Do not use a unified patch. Read the exact source unit or bounded line window and submit the smallest structured edit directly against the documentId current source. replaceRange applies newText with its supplied indentation exactly, matching mature source editors. Set preserveIndent=true only when the replacement is deliberately written relative to the replaced block; never enable it for source copied from action=read or for mixed-indent Python blocks. Line edits and replaceText/replaceAll may be mixed in one atomic call: all line edits use coordinates from the same read and merge first, then exact-text edits run in their supplied order against that candidate. Every structured edit is saved to the one current source before validation, even when syntax or validation errors remain. Overlapping context ranges are minimized and merged atomically; later edits win only on the same changed source lines. Do not send a complete program replacement through edit, and do not replace most of the source with one replaceRange; use generate when the complete source truly needs replacement. For replaceText, omit occurrence when oldText is unique; otherwise occurrence is the one-based index of the intended match, not the number of replacements. To replace every exact match, send one replaceAll edit instead of a list of numbered replaceText edits.

For a Python syntax diagnostic, edit the exact offending line or the smallest syntactically complete block. In particular, repair \`unexpected indent\` with one exact-line replaceText/replaceRange whenever possible. Do not copy unchanged adjacent lines into newText: doing so creates duplicate slide factories and duplicate element calls without helping the syntax repair. After the edit, continue from the newly saved current source even if another diagnostic remains.

Edits are cumulative: one call may fix only one of many errors, and the next call continues from that saved result. Syntax, runtime, layout, or artifact validation failures keep the exact edited source plus diagnostics and remain editable. There is no consecutive-failure lock or automatic rollback. A diagnostic with a line, sourceExcerpt, source unit, helper, or elementId must be repaired with edit; do not answer such a failure by rewriting the draft with generate. action=generate atomically replaces the current source only when a complete-draft replacement is intentionally required, not as ordinary error recovery. Use action=read only when fresh line numbers or exact current text are needed. Rendering and final delivery remain blocked while validationStatus is failed.

Sources over 300 lines require scoped reading and editing. Presentation page units use authored IDs such as \`pages/s30-risk-matrix\`; reusable Python helpers use symbol paths such as \`symbols/add_bg\` or \`symbols/section_divider\`. A legacy \`pages/slide-030\` request resolves only when one authored ID unambiguously represents slide 30. Runtime-created pages are repaired through their helper symbol, never through a guessed static call count. Writer page breaks and Calc worksheets are indexed semantically. Nonstandard builders may use @webpilot-unit/@webpilot-endunit markers. An unscoped read returns only the unit index and guidance, not the complete large program. Symbol edits validate the complete draft; page/sheet unit edits validate an isolated candidate, while final render still validates everything. Near-complete replaceRange edits are blocked; repair a focused region, use replaceAll for repeated exact text, or edit one unit.

## Rendering and visual QA

render publishes only the current validated source. A preview produced during validation and any sampled page are diagnostics, not full QA.

Treat automaticValidation.formatChecks as the authoritative structural counts for slides or sheets, native charts, formulas, embedded images, Word tables, and drawing objects. Compare those counts and every validation issue with the user's requested coverage before final delivery. Visual QA certifies only the reviewed page layout; it does not prove semantic feature coverage. If a required capability is absent, has a zero count, is unsupported, failed validation, or was not verified, report that exact limitation and do not say the artifact or suite fully passed. Copy each final downloadUrl verbatim from its successful current-session result; never build or absolutize a URL from an Artifact ID, session ID, host name, or file name.

For a vision-capable model, fileVisual is a mandatory delivery gate:

1. Call index with the exact latest Artifact ID.
2. Read every screenshot id in returned order, in bounded batches, and actually inspect every attached page image.
3. Call report with an evidence-backed passed or failed review for every page that was read. Every page requires a concrete observation plus checks for overlap, clipping, alignment, spacing, typography, contrast, visual hierarchy, chart/table legibility, and image quality. A bare \`passed\`, an empty issue list, or a read alone never proves visual quality.
4. Inspect aesthetic defects even when geometry is valid: tiny or inconsistent type, weak hierarchy, unbalanced whitespace, overly sparse or crowded composition, uneven component rhythm, poor chart labeling, inconsistent margins, stretched/soft images, or an awkward visual focal point. Failed reviews must identify the exact visible region and defect.
5. After every page has been inspected, submit one deckReview comparing template, typography, color, spacing rhythm, and component styling across the complete artifact. Completion is impossible without this passed cross-page review.
6. Fix the current document with focused edits, render a new artifact, and restart complete QA using only the new Artifact ID.

Automatic screenshot checks cover only render integrity (measurable dimensions and near-blank detection). They are not an aesthetic verdict and \`automaticChecks[].issues=[]\` never means that a page visually passed.

Delivery succeeds only when visualQaDigest equals renderedDigest, seenPageCount equals pageCount, every page has an evidence-backed passed review with all applicable checks passed, and the complete artifact has a passed deckReview. A non-visual model may rely only on structural rendering checks and must not claim visual inspection.

## Failure continuation

Read the complete error and requiredNextAction. Preserve documentId and artifactId as applicable. Retry the required operation with corrected parameters or a focused edit against the one current source. Continue the original document workflow rather than starting a substitute artifact.
`;
