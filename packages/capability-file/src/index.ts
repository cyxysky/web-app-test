import {
  createCapabilityRuntime,
  defineCapabilityTool,
  type CapabilityExecutionContext,
  type CapabilityManifest,
  type CapabilityProvider,
  type CapabilityResult,
  type CapabilityRunContext,
  type CapabilityToolSet,
} from '@webpilot/capability-sdk';
import { fileCapabilitySettings } from './settings.js';
import { fileRuntimeSkill } from './runtime-skill.js';
import { createFileToolInput } from './schema.js';
import { fileActionInputIssues } from './action-guidance.js';
import { normalizeFileToolInput } from './transport.js';
import {
  fileActions,
  fileVisualActions,
  fileVisualToolActions,
  type FileAction,
  type FileCapabilityOperations,
  type FileCapabilityRuntimeOperations,
  type FileToolInput,
  type FileVisualAction,
  type FileVisualCapabilityOperations,
  type FileVisualToolAction,
  type FileVisualToolInput,
} from './types.js';

export * from './formats.js';
export * from './office/types.js';
export * from './runtime-skill.js';
export * from './settings.js';
export * from './schema.js';
export * from './transport.js';
export * from './types.js';

export const fileCapabilityToolNames = Object.freeze({
  file: 'file',
} as const);

export const fileCapabilityManifest: CapabilityManifest = {
  schemaVersion: 1,
  id: 'com.webpilot.file',
  name: 'File artifacts',
  version: '0.1.0',
  description: 'Portable file artifact schemas and action routing with host-injected engines and stores.',
  permissions: ['files:read', 'files:write'],
  runtimeRequirements: {
    operations: 'A host must inject implementations for the file actions it enables.',
    nodeAdapter: {
      entrypoint: '@webpilot/capability-file/node',
      node: '>=22.16',
      libreoffice: 'Required only when using the default local Office converter.',
      python: 'Required when using the included UNO authoring runtime.',
    },
  },
  configuration: { settings: fileCapabilitySettings },
  skills: [fileRuntimeSkill],
};

function isFileAction(value: string | undefined): value is FileAction {
  return fileActions.some((action) => action === value);
}

function isFileVisualAction(value: string): value is FileVisualAction {
  return fileVisualActions.some((action) => action === value);
}

function isFileVisualToolAction(value: string | undefined): value is FileVisualToolAction {
  return fileVisualToolActions.some((action) => action === value);
}

const visualActionMap: Record<FileVisualToolAction, FileVisualAction> = {
  visualIndex: 'index',
  visualRead: 'read',
  visualReport: 'report',
};

function executionFailure(toolName: string, error: unknown): CapabilityResult {
  return {
    ok: false,
    error: {
      code: `${toolName}-execution-failed`,
      message: `${toolName} execution failed: ${error instanceof Error ? error.message : String(error)}`,
    },
  };
}

export async function executeFileAction(
  operations: FileCapabilityOperations,
  input: FileToolInput,
  context: CapabilityExecutionContext,
): Promise<CapabilityResult> {
  input = normalizeFileToolInput(input) as FileToolInput;
  if (!isFileAction(input.action)) {
    return {
      ok: false,
      error: {
        code: 'invalid-file-action',
        message: 'file requires one action: list | readSource | readContent | download | convert | plan | generate | edit | unoApi | jsApi | render.',
      },
    };
  }
  const issues = fileActionInputIssues(input);
  if (issues.length) {
    return { ok: false, error: { code: 'file-action-input-mismatch', message: issues.map((issue) => `${issue.field}: ${issue.message}`).join('\n'), details: issues } };
  }
  // Text reads never attach page previews unless explicitly requested.
  if (input.action === 'readContent') input = { ...input, includeVisuals: input.includeVisuals === true };
  const readAlias = (input.action === 'readSource' || input.action === 'readContent') && !operations[input.action];
  const handler = (readAlias ? operations.read : operations[input.action as FileAction]) as ((
    actionInput: FileToolInput & { action: FileAction },
    executionContext: CapabilityExecutionContext,
  ) => Promise<CapabilityResult>) | undefined;
  if (!handler) {
    return {
      ok: false,
      error: {
        code: 'file-action-unavailable',
        message: `file action=${input.action} is unavailable in this runtime.`,
      },
    };
  }
  try {
    return await handler({ ...input, action: readAlias ? 'read' : input.action } as FileToolInput & { action: FileAction }, context);
  } catch (error) {
    return executionFailure('file', error);
  }
}

async function executeFileVisualAction(
  operations: FileVisualCapabilityOperations,
  input: FileVisualToolInput,
  context: CapabilityExecutionContext,
): Promise<CapabilityResult> {
  if (!isFileVisualAction(input.action)) {
    return {
      ok: false,
      error: {
        code: 'invalid-file-visual-action',
        message: 'file requires action=visualIndex|visualRead|visualReport for visual inspection.',
      },
    };
  }
  const handler = operations[input.action] as ((
    actionInput: FileVisualToolInput & { action: FileVisualAction },
    executionContext: CapabilityExecutionContext,
  ) => Promise<CapabilityResult>) | undefined;
  if (!handler) {
    return {
      ok: false,
      error: {
        code: 'file-visual-action-unavailable',
        message: `file action=visual${input.action[0].toUpperCase()}${input.action.slice(1)} is unavailable in this runtime.`,
      },
    };
  }
  try {
    return await handler(input, context);
  } catch (error) {
    return executionFailure('file', error);
  }
}

export function createFileTools(
  operations: FileCapabilityRuntimeOperations,
  options: { visualInputAvailable: boolean },
): CapabilityToolSet {
  const visualInputAvailable = options.visualInputAvailable && Boolean(operations.visual);
  const tools: Record<string, ReturnType<typeof defineCapabilityTool>> = {
    [fileCapabilityToolNames.file]: defineCapabilityTool<FileToolInput, unknown>({
      name: fileCapabilityToolNames.file,
      description: (visualInputAvailable
        ? 'File workflow: readSource(documentId) reads editable Python/JavaScript; readContent(artifactId OR attachmentId) reads file text/data, NOT source. To repair layout: readSource → edit → render → visualIndex/visualRead → visualReport. list discovers drafts; plan selects engine; generate creates source; download fetches assets; convert changes file format; unoApi/jsApi describe the planned engine. Never substitute IDs or infer behavior from reason.'
        : 'File workflow: readSource(documentId) reads editable Python/JavaScript; readContent(artifactId OR attachmentId) reads file text/data, NOT source. To repair: readSource → edit → render. list discovers drafts; plan selects engine; generate creates source; download fetches assets; convert changes file format; unoApi/jsApi describe the planned engine. No visual inspection is available; do not claim visual QA.')
        + ' Design: original/high-design work starts with plan.design (bespoke audience, objective, distinct directions, selection and rhythm), then custom program composition. For fast conventional files, follow semanticGeneration.recommended, not available alone. Consistent visual rules do not mean identical page layouts.'
        + ' Edit is atomic: prefer exact replacements, uniquely matched on one pre-edit snapshot; any conflict saves nothing. Preserve indentation; never rely on fuzzy matching. After saved=true, inspect validation separately and use the returned patchBaseDigest. Only an identical request confirmed by a saved edit receipt is deduplicated. unoApi exact module IDs return only that module.'
        + ' Recovery: readSource/list return saved diagnostics, not a new execution. Check validationEvidence freshness. Do not infer bridge failure from NoneType or source correctness from a runtime blocker. Respect retryable/retryAfter; no unchanged retry loops.',
      input: createFileToolInput(visualInputAvailable),
      inputExamples: [
        { action: 'list', reason: 'List current file drafts' },
        { action: 'readSource', reason: 'Locate code to patch, without reading the PPTX or attaching screenshots', documentId: 'travel-guide', startLine: 1, endLine: 80 },
        { action: 'readContent', reason: 'Inspect finished-file text/data, not the generator source', artifactId: 'exact-artifact-id-from-render', offset: 0, limit: 2000 },
        {
          action: 'plan',
          reason: 'Plan a presentation',
          documentId: 'travel-guide',
          fileName: 'travel-guide.pptx',
          documentType: 'presentation',
          operation: 'create',
          intent: 'Create a concise travel guide presentation.',
        },
        {
          action: 'generate',
          reason: 'Create the planned presentation with semantic templates',
          documentId: 'travel-guide',
          spec: {
            schemaVersion: '1.0',
            theme: 'clean',
            blocks: [
              { id: 'cover', type: 'page', template: 'cover', title: 'Travel guide', subtitle: 'A concise itinerary' },
            ],
          },
        },
        { action: 'render', reason: 'Render the current document', documentId: 'travel-guide' },
        ...(visualInputAvailable ? [
          { action: 'visualIndex', artifactId: 'host-artifact-id', offset: 0, limit: 100 },
          { action: 'visualRead', artifactId: 'host-artifact-id', screenshotIds: ['screenshot-0001'] },
        ] : []),
      ],
      policy: {
        concurrency: 'serial',
        concurrencyGroup: 'file-artifacts',
        permissions: fileCapabilityManifest.permissions,
      },
      execute: (input, context) => {
        if (!isFileVisualToolAction(input.action)) {
          return executeFileAction(operations.file, input, context);
        }
        if (!visualInputAvailable || !operations.visual) {
          return Promise.resolve({
            ok: false,
            error: {
              code: 'file-visual-action-unavailable',
              message: `file action=${input.action} is unavailable because this runtime has no visual input support.`,
            },
          });
        }
        return executeFileVisualAction(operations.visual, {
          reason: input.reason,
          action: visualActionMap[input.action],
          artifactId: input.artifactId || '',
          screenshotIds: input.screenshotIds,
          reviews: input.reviews,
          deckReview: input.deckReview,
          offset: input.offset,
          limit: input.limit,
        }, context);
      },
    }),
  };
  return Object.freeze(tools);
}

export function createFileCapability(options: {
  visualInputAvailable: boolean;
  createOperations(
    context: CapabilityRunContext,
  ): FileCapabilityRuntimeOperations | Promise<FileCapabilityRuntimeOperations>;
}): CapabilityProvider {
  return {
    manifest: fileCapabilityManifest,
    async createRuntime(context) {
      const operations = await options.createOperations(context);
      return createCapabilityRuntime({
        tools: createFileTools(operations, {
          visualInputAvailable: options.visualInputAvailable,
        }),
        health: operations.health,
        dispose: operations.dispose,
      });
    },
  };
}
