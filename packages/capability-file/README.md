# @webpilot/capability-file

An agent-framework-neutral file artifact capability.

The package owns one public `file` contract with a dynamically configured JSON Schema,
transport normalization, validation, manifests, action dispatch, runtime skill,
Office document model, and shared file-format/MIME registry. Agent frameworks
are optional: call the exported operations directly, or expose them as tools
through `FileCapabilityOperations` and `@webpilot/capability-sdk`.

`@webpilot/capability-file/node` includes reusable filesystem-backed adapters:

- artifact path safety, metadata, URL mapping, unique naming, and hashing;
- a downloader with bounded streaming, per-origin concurrency, retry handling,
  URL caching, AbortSignal support, and lifecycle disposal;
- configurable LibreOffice discovery, UNO-compatible Python discovery, and
  cancellable Office conversion;
- an Office-to-PDF artifact converter with injected artifact URL, conversion,
  runtime-health, and preview-rendering contracts;
- JavaScript and Python/UNO Office authoring runtimes with package-owned workers;
- semantic Word, PowerPoint, and Excel templates with versioned themes, default
  layout repair, and deterministic compilation into the validated UNO pipeline;
- DOCX structure inspection and DOCX/XLSX/PPTX generation;
- Office source analysis, artifact validation, rendering validation, preview
  generation, attachment reading, and bounded worker-based text extraction.

The default converter runs local LibreOffice. Hosts may instead inject a remote
conversion function, so consumers are not tied to WebPilot, AI SDK, or a local
Office installation.

## Source, content, and visual reads

The model-facing actions deliberately use different names and identities:

| Purpose | Call |
| --- | --- |
| Find an existing draft | `file({ action: 'list' })` |
| Read generation code | `file({ action: 'readSource', documentId, startLine: 1, endLine: 80 })` |
| Read Excel cells / Word text / PDF text | `file({ action: 'readContent', artifactId, offset: 0, limit: 2000 })` |
| Read an upload's content | `file({ action: 'readContent', attachmentId })` |
| Inspect rendered pages | `visualIndex` then `visualRead`, using the current `artifactId` and returned `screenshotIds` |

`readSource` returns `program` and `patchBaseDigest`; pass that exact digest as
`edit.baseDigest`. `readContent` is not the generator source and cannot supply
code to patch. Its limits count characters, not source lines; the default is
8,000 characters, and an explicit smaller limit is honored. Page previews are
opt-in (`includeVisuals: true`), not a side effect of ordinary text reads.

Source reads return one copy of the exact code, source coordinates, the patch
digest, validation status and diagnostic counts. Use `includeDiagnostics: true`
only to retrieve missing saved validation details; it does not rerun validation.
Capability `summary` is a short label, never a second serialized copy of `data`.
Calc setters can reuse an element ID for updates to the same cell/range, format,
row height or column width. Different targets and object creation still receive
collision warnings; ordinary property updates retain the ID and latest source location.

Mixed source/content identities are rejected with corrective instructions.
`reason` never changes routing. Old `read` calls remain accepted at the transport
boundary, but normalize to `readSource` or `readContent` and are not advertised
in the model action enum. Legacy host adapters implementing only `read` remain
usable through the dispatcher. New adapters should implement the explicit actions.

Draft catalogs and render results expose `sourceRead`; published artifacts also
expose `contentRead`. Preserve these distinctions in host file registries and
context-compaction summaries. Repair workflow: `readSource → edit → render`;
do not regenerate unchanged source to reread data or previews.

Use the package directly with any agent framework, or register it with
`@webpilot/capability-sdk` and adapt the resolved tools to the framework used by
the application. The
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md)
shows the complete `mountCapabilities()` registration, tool conversion, Skill
injection, execution, result handling, and disposal flow.

Import only the layer an application needs:

```ts
import { createFileCapability } from '@webpilot/capability-file';
import { createNodeFileDownloader } from '@webpilot/capability-file/node/download';
import { readFileAttachment } from '@webpilot/capability-file/node/read';
import { generateUnoProgramDocument } from '@webpilot/capability-file/node/office';
import { createNodeFileWorkspace } from '@webpilot/capability-file/node/workspace';
```

### Safe source editing

`edit` accepts either exact `replacements` or Codex-format `patch`, with the
current `readSource.patchBaseDigest`. Both modes locate every target on the
same original source snapshot. Targets must be unique and non-overlapping;
whitespace and punctuation are never fuzzy-matched. Optional source-unit paths
scope the edit. The entire batch commits or none of it does, including related
helper/caller changes. Conflict results identify `failed` and withheld `blocked`
hunks, with `changed=false` and `saved=false`.

Stale revisions are rejected, not automatically rebased. A persisted receipt
deduplicates only the identical latest request at its exact resulting source
revision. Finding the new text elsewhere is not evidence that an edit happened.
Validation-failed source remains an editable buffer: `saved=true` does not mean
`validation=passed`. Structured model results preserve these states and the new
`patchBaseDigest`, including conflict information from historical partial edits.

UNO API lookup prioritizes exact versioned/unversioned module IDs. Unknown
versions return the module index, not unrelated search matches. Keyword searches
ignore numeric version tokens and require all terms. Catalog caching includes
the worker digest; metadata writes use the same document lock as source edits.

New Office documents can use the compact semantic path instead of authoring a
raw program. The default layout policy enforces readable type and safe margins,
uses contained images, splits long slide text/lists/tables, repeats table
headers, and configures spreadsheet widths, frozen headers, and print layout:

```ts
import { generateFileBuffer } from '@webpilot/capability-file/node/generate';

const result = await generateFileBuffer({
  schemaVersion: '1.0',
  documentType: 'presentation',
  fileName: 'review.pptx',
  document: { title: 'Quarterly review', language: 'en' },
  theme: 'executive',
  blocks: [
    { id: 'cover', type: 'page', template: 'cover', title: 'Quarterly review' },
    { id: 'summary', type: 'page', template: 'kpi', title: 'At a glance', children: [
      { id: 'revenue', type: 'metric', title: 'Revenue', text: '$4.2M' },
      { id: 'growth', type: 'metric', title: 'Growth', text: '+18%' },
    ] },
  ],
});
```

The workspace tool exposes the same path as `action=generate` with `spec` when
the preceding plan returns `semanticGeneration.available=true`. Follow
`semanticGeneration.recommended` when selecting this path: availability is not
a recommendation to use fixed geometry for original design.

### Content-led design

Initial `plan` calls may include a compact `design` brief:

- `mode: "template"`: conventional fast documents. Preset colors, fonts and
  typography are editable starting tokens, even without supplied brand assets.
- `mode: "bespoke"`: audience, objective, 2–3 directions (each with `id`,
  `concept`, `composition`, `typography`, `imagery`), `selectedDirection`,
  `selectionReason`, and `rhythm`. A binding user `reference` allows one
  direction. Optional `preserve`/`avoid` lists record constraints and unwanted
  motifs; do not duplicate the full content in the brief.

The brief is validated and saved with the draft. Plan results, including the
model-facing compact result, preserve the brief and `designGuidance`.
Bespoke work is recommended to use custom `program` authoring, with blank
slides, grids/stacks and content-led geometry rather than the semantic
compiler's fixed slots. Bounds, native object, font and render validation
remain in force. No engine switch or fixed theme is implied. High-design
intent can recommend this route for older callers, but keyword matching does
not reject existing workflows or override an explicit mode.

Resolve representative compositions before expanding, inspect them first in
the first valid render, and reuse the same draft. If feature validation needs
the full document, do not force a partial prototype through it. Final review
still covers every page. Bespoke plans additionally require
`deckReview.checks.designIntent` and `compositionRhythm`; consistency means
coherent visual rules, not identical page layouts or a quota of variations.
This records an evidence-backed model review, not an automatic aesthetic score.

Authored-workspace re-planning remains idempotent: it does not overwrite the
original brief or source. Bounded source reads do not repeat the brief;
unbounded `readSource` can recover it after context compaction. Existing-file
modification still preserves the original unless the user requests redesign.

For a ready-to-register Node provider:

```ts
import { createNodeFileCapability } from '@webpilot/capability-file/node';

const provider = createNodeFileCapability({
  workspace: { artifactsRoot: './artifacts' },
  visualInputAvailable: false,
});
```

For the optional AI SDK adapter, install `@webpilot/capability-file` and
`@webpilot/capability-adapter-ai-sdk`, then mount the provider in one call:

```ts
import { createNodeFileCapability } from '@webpilot/capability-file/node';
import { mountAISDKCapabilities } from '@webpilot/capability-adapter-ai-sdk';

const fileRuntime = await mountAISDKCapabilities({
  providers: [createNodeFileCapability({
    workspace: { artifactsRoot: './artifacts' },
    visualInputAvailable: false,
  })],
  context: { runId: crypto.randomUUID() },
  configurations: {
    'com.webpilot.file': { OFFICE_GENERATION_MODE: 'auto' },
  },
  skills: { mode: 'lazy' },
});
```

`@webpilot/capability-host` is not a dependency of the File core. The AI SDK
adapter brings it transitively for one-call mounting; direct Provider consumers
can continue to use File without the host API.

Set `visualInputAvailable` from the active model's image-input capability. When
it is false, the `file` schema omits `visualIndex`, `visualRead`,
`visualReport`, and their visual-only parameters.

The host may inject attachment readers, visual readers, URL mapping, download,
conversion, preview, and storage behavior. `@webpilot/capability-file/mcp`
exposes the same provider through stdio or Streamable HTTP; the included
`webpilot-file-mcp` executable uses `CAPABILITY_FILE_ARTIFACTS_DIR` (or
`ARTIFACTS_DIR`).

The package resolves its Office workers from the published `runtime/` directory.
Packaged hosts may instead set `CAPABILITY_FILE_RUNTIME_DIR`, and may override the
individual Python worker with `LIBREOFFICE_UNO_PROGRAM_WORKER_PATH`.
