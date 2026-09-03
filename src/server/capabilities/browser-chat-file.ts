import {
  createFileCapability,
  createFileTools,
  type FileCapabilityRuntimeOperations,
  type FileAttachmentBinding,
  type FileReadInput,
  type FileToolInput,
  type FileVisualToolInput,
} from '@webpilot/capability-file';
import type { CapabilityConfiguration, CapabilityExecutionContext } from '@webpilot/capability-sdk';
import {
  fileOperationToCapabilityResult,
  normalizeFileReadLimit as normalizeBrowserChatFileReadLimit,
  resolveLibreOfficeExecutable,
  resolveLibreOfficePythonExecutable,
  resolveUnoProgramWorker,
} from '@webpilot/capability-file/node';
import type { BrowserActionResult } from '@webpilot/capability-browser/node';
import type { FileGenerationProgress } from '@webpilot/capability-file/node/workspace';
import {
  browserActionResultToCapabilityResult,
  capabilityResultToBrowserActionResult,
} from './browser-chat-result';
import { createWebPilotFileWorkspace } from './webpilot-file-workspace';

export type BrowserChatFileCapabilityOptions = {
  attachmentBindings?: FileAttachmentBinding[];
  currentPageUrl?: () => string;
  readFile?: (input: FileReadInput) => Promise<BrowserActionResult>;
  readFileVisuals?: (input: FileVisualToolInput) => Promise<BrowserActionResult>;
  visualInputAvailable: boolean;
};

function progressReporter(context: CapabilityExecutionContext) {
  return async (progress: FileGenerationProgress) => {
    await context.reportProgress?.(progress);
  };
}

function unavailable(message: string) {
  return { ok: false as const, error: { code: 'file-action-unavailable', message } };
}

function createBrowserChatFileOperations(
  runId: string,
  options: BrowserChatFileCapabilityOptions,
  configuration?: CapabilityConfiguration,
): FileCapabilityRuntimeOperations {
  const workspace = createWebPilotFileWorkspace(configuration);
  const file = {
    list: async () => fileOperationToCapabilityResult(
      await workspace.listOfficeDrafts({ runId }),
      'file-list-failed',
    ),
    read: async (input: FileToolInput) => {
      if (input.documentId) {
        return fileOperationToCapabilityResult(await workspace.readUnoDraft({
          documentId: input.documentId,
          path: input.path,
          startLine: input.startLine,
          endLine: input.endLine,
          runId,
        }), 'file-read-failed');
      }
      if (!options.readFile) return unavailable('file action=read is unavailable in this runtime.');
      const includeVisuals = options.visualInputAvailable
        && (input.includeVisuals ?? (
          input.offset === undefined
          || input.offset === 0
          || Boolean(input.pages?.length)
        ));
      return browserActionResultToCapabilityResult(await options.readFile({
        attachmentId: input.attachmentId,
        artifactId: input.artifactId,
        includeVisuals,
        limit: normalizeBrowserChatFileReadLimit(input.limit),
        offset: input.offset,
        pages: input.pages,
      }));
    },
    download: async (input: FileToolInput, context: CapabilityExecutionContext) => fileOperationToCapabilityResult(
      await workspace.downloadFileArtifact({
        ...input,
        runId,
        sourcePageUrl: options.currentPageUrl?.(),
      }, { abortSignal: context.abortSignal }),
      'file-download-failed',
    ),
    convert: async (input: FileToolInput, context: CapabilityExecutionContext) => fileOperationToCapabilityResult(
      await workspace.convertFileArtifact({
        runId,
        sourceArtifactId: input.sourceArtifactId,
        fileName: input.fileName,
        includeVisualVerification: options.visualInputAvailable,
      }, { abortSignal: context.abortSignal }),
      'file-convert-failed',
    ),
    plan: async (input: FileToolInput) => fileOperationToCapabilityResult(
      await workspace.planFileArtifact({
        ...input,
        runId,
        attachmentBindings: options.attachmentBindings,
      }),
      'file-plan-failed',
    ),
    unoApi: async (input: FileToolInput) => fileOperationToCapabilityResult(
      await workspace.getUnoApi({ ...input, runId }),
      'file-uno-api-failed',
    ),
    jsApi: async (input: FileToolInput) => fileOperationToCapabilityResult(
      await workspace.getOfficeJsApi({ ...input, runId }),
      'file-js-api-failed',
    ),
    generate: async (input: FileToolInput, context: CapabilityExecutionContext) => (
      fileOperationToCapabilityResult(await workspace.generateUnoFileArtifact({
        ...input,
        abortSignal: context.abortSignal,
        onProgress: progressReporter(context),
        runId,
        attachmentBindings: options.attachmentBindings,
        includeVisualVerification: false,
      }), 'file-generate-failed')
    ),
    edit: async (input: FileToolInput, context: CapabilityExecutionContext) => (
      fileOperationToCapabilityResult(await workspace.editUnoFileArtifact({
        documentId: input.documentId,
        path: input.path,
        program: input.program,
        baseDigest: input.baseDigest,
        patch: input.patch,
        render: input.render,
        abortSignal: context.abortSignal,
        onProgress: progressReporter(context),
        runId,
        attachmentBindings: options.attachmentBindings,
        includeVisualVerification: false,
      }), 'file-edit-failed')
    ),
    render: async (input: FileToolInput, context: CapabilityExecutionContext) => (
      fileOperationToCapabilityResult(await workspace.renderFileArtifact({
        ...input,
        abortSignal: context.abortSignal,
        onProgress: progressReporter(context),
        runId,
        attachmentBindings: options.attachmentBindings,
        includeVisualVerification: options.visualInputAvailable,
      }), 'file-render-failed')
    ),
  } satisfies FileCapabilityRuntimeOperations['file'];

  const health = async () => {
    const workspaceHealth = await workspace.health();
    if (workspaceHealth.status !== 'healthy') return workspaceHealth;
    const conversionDetails = workspaceHealth.details?.conversion;
    const libreOffice = conversionDetails && typeof conversionDetails === 'object'
      && typeof (conversionDetails as { libreOffice?: unknown }).libreOffice === 'string'
      ? (conversionDetails as { libreOffice: string }).libreOffice
      : await resolveLibreOfficeExecutable();
    if (!libreOffice) {
      return {
        status: 'needs-runtime' as const,
        message: 'LibreOffice is required for Office generation, conversion, and preview.',
      };
    }
    const python = await resolveLibreOfficePythonExecutable(libreOffice);
    if (!python) {
      return {
        status: 'needs-runtime' as const,
        message: 'A Python runtime compatible with LibreOffice UNO is required.',
      };
    }
    const unoWorker = await resolveUnoProgramWorker();
    if (!unoWorker) {
      return {
        status: 'needs-runtime' as const,
        message: 'The File Capability UNO worker is missing from the runtime.',
      };
    }
    return {
      status: 'healthy' as const,
      details: {
        libreOffice,
        python,
        unoWorker,
        workspace: workspaceHealth.details,
      },
    };
  };

  const dispose = () => workspace.dispose();

  if (!options.visualInputAvailable || !options.readFileVisuals) return { file, health, dispose };

  const executeVisual = async (input: FileVisualToolInput) => {
    const version = await workspace.verifyCurrentUnoRenderedArtifact({
      runId,
      artifactId: input.artifactId,
    });
    if (!version.ok) return fileOperationToCapabilityResult(version, 'file-visual-version-failed');
    const result = await options.readFileVisuals?.(input)
      || { ok: false, actual: 'File visual actions are unavailable in this runtime.' };
    return fileOperationToCapabilityResult(await workspace.recordOfficeVisualQaProgress({
      runId,
      artifactId: input.artifactId,
      action: input.action,
      result,
    }), 'file-visual-report-failed');
  };

  return {
    file,
    health,
    dispose,
    visual: {
      index: executeVisual,
      read: executeVisual,
      report: executeVisual,
    },
  };
}

export function createBrowserChatFileCapability(
  options: BrowserChatFileCapabilityOptions,
) {
  return createFileCapability({
    visualInputAvailable: options.visualInputAvailable,
    createOperations: (context) => createBrowserChatFileOperations(context.runId, options, context.configuration),
  });
}

export async function executeBrowserChatFile(input: {
  runId: string;
  params: unknown;
  options: BrowserChatFileCapabilityOptions;
  abortSignal?: AbortSignal;
  invocationId?: string;
  configuration?: CapabilityConfiguration;
}) {
  const operations = createBrowserChatFileOperations(input.runId, input.options, input.configuration);
  const tool = createFileTools(operations, {
    visualInputAvailable: input.options.visualInputAvailable,
  }).file;
  const parsed = tool.input.parse(input.params);
  try {
    return capabilityResultToBrowserActionResult(await tool.execute(parsed, {
      invocationId: input.invocationId || `file:${input.runId}`,
      abortSignal: input.abortSignal,
    }));
  } finally {
    await operations.dispose?.();
  }
}
