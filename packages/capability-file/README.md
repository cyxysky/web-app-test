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
- DOCX structure inspection and DOCX/XLSX/PPTX generation;
- Office source analysis, artifact validation, rendering validation, preview
  generation, attachment reading, and bounded worker-based text extraction.

The legacy anchor-based DOCX fill helper is package-internal. It is not part of
the package exports and is not exposed as a `file` action.

The default converter runs local LibreOffice. Hosts may instead inject a remote
conversion function, so consumers are not tied to WebPilot, AI SDK, or a local
Office installation.

Use the package directly with any agent framework, or register it with
`@webpilot/capability-sdk` and adapt the resolved tools to the framework used by
the application.

Import only the layer an application needs:

```ts
import { createFileCapability } from '@webpilot/capability-file';
import { createNodeFileDownloader } from '@webpilot/capability-file/node/download';
import { readFileAttachment } from '@webpilot/capability-file/node/read';
import { generateUnoProgramDocument } from '@webpilot/capability-file/node/office';
import { createNodeFileWorkspace } from '@webpilot/capability-file/node/workspace';
```

For a ready-to-register Node provider:

```ts
import { createNodeFileCapability } from '@webpilot/capability-file/node';

const provider = createNodeFileCapability({
  workspace: { artifactsRoot: './artifacts' },
  visualInputAvailable: false,
});
```

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
