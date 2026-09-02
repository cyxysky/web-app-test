import {
  defineCapabilityTool,
  type CapabilityExecutionContext,
  type CapabilityInstruction,
  type CapabilityManifest,
  type CapabilityProvider,
  type CapabilityResult,
  type CapabilityRunContext,
  type CapabilityToolSet,
} from '@webpilot/capability-sdk';
import { createFileToolInput } from './schema.js';
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
};

export const fileRuntimeInstruction: CapabilityInstruction = {
  id: 'com.webpilot.file/runtime',
  title: 'File artifact workflow',
  content: [
    'Use stable document ids for logical documents.',
    'Read an existing draft before editing it and preserve the latest digest expected by the host.',
    'Treat artifact and screenshot ids as opaque host-issued values; never invent them.',
    'When visual inspection is available, index and read exact rendered pages before reporting visual QA.',
  ].join('\n'),
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
  if (!isFileAction(input.action)) {
    return {
      ok: false,
      error: {
        code: 'invalid-file-action',
        message: 'file requires one action: list | read | download | convert | plan | generate | edit | unoApi | jsApi | render.',
      },
    };
  }
  const handler = operations[input.action] as ((
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
    return await handler(input as FileToolInput & { action: FileAction }, context);
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
      description: visualInputAvailable
        ? 'List, read, download, convert, plan, generate, edit, inspect APIs for, render, and visually inspect file artifacts in a stable document workspace.'
        : 'List, read, download, convert, plan, generate, edit, inspect APIs for, or render file artifacts in a stable document workspace.',
      input: createFileToolInput(visualInputAvailable),
      inputExamples: [
        { action: 'list', reason: 'List current file drafts' },
        { action: 'read', reason: 'Read the current document source', documentId: 'travel-guide' },
        {
          action: 'plan',
          reason: 'Plan a presentation',
          documentId: 'travel-guide',
          fileName: 'travel-guide.pptx',
          documentType: 'presentation',
          operation: 'create',
          intent: 'Create a concise travel guide presentation.',
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
        runtimeInstructionId: fileRuntimeInstruction.id,
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
  instruction?: CapabilityInstruction | false;
}): CapabilityProvider {
  return {
    manifest: fileCapabilityManifest,
    async createRuntime(context) {
      const operations = await options.createOperations(context);
      return {
        tools: createFileTools(operations, {
          visualInputAvailable: options.visualInputAvailable,
        }),
        instructions: options.instruction === false
          ? []
          : [options.instruction || fileRuntimeInstruction],
        health: operations.health || (() => Promise.resolve({ status: 'healthy' })),
        dispose: operations.dispose || (() => Promise.resolve()),
      };
    },
  };
}
