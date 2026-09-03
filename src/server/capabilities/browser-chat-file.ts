import {
  createFileCapability,
  createFileTools,
  type FileCapabilityRuntimeOperations,
  type FileAttachmentBinding,
  type FileReadInput,
  type FileToolInput,
  type FileVisualToolInput,
} from '@webpilot/capability-file';
import type { CapabilityExecutionContext } from '@webpilot/capability-sdk';
import {
  resolveLibreOfficeExecutable,
  resolveLibreOfficePythonExecutable,
  resolveUnoProgramWorker,
} from '@webpilot/capability-file/node';
import type { BrowserActionResult } from '@webpilot/capability-browser/node';
import { normalizeFileReadLimit as normalizeBrowserChatFileReadLimit } from '@webpilot/capability-file/node';
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
  return browserActionResultToCapabilityResult({ ok: false, actual: message });
}

function createBrowserChatFileOperations(
  runId: string,
  options: BrowserChatFileCapabilityOptions,
): FileCapabilityRuntimeOperations {
  const workspace = createWebPilotFileWorkspace();
  const file = {
    list: async () => browserActionResultToCapabilityResult(
      await workspace.listOfficeDrafts({ runId }),
    ),
    read: async (input: FileToolInput) => {
      if (input.documentId) {
        return browserActionResultToCapabilityResult(await workspace.readUnoDraft({
          documentId: input.documentId,
          path: input.path,
          startLine: input.startLine,
          endLine: input.endLine,
          runId,
        }));
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
    download: async (input: FileToolInput, context: CapabilityExecutionContext) => browserActionResultToCapabilityResult(
      await workspace.downloadFileArtifact({
        ...input,
        runId,
        sourcePageUrl: options.currentPageUrl?.(),
      }, { abortSignal: context.abortSignal }),
    ),
    convert: async (input: FileToolInput, context: CapabilityExecutionContext) => browserActionResultToCapabilityResult(
      await workspace.convertFileArtifact({
        runId,
        sourceArtifactId: input.sourceArtifactId,
        fileName: input.fileName,
        includeVisualVerification: options.visualInputAvailable,
      }, { abortSignal: context.abortSignal }),
    ),
    plan: async (input: FileToolInput) => browserActionResultToCapabilityResult(
      await workspace.planFileArtifact({
        ...input,
        runId,
        attachmentBindings: options.attachmentBindings,
      }),
    ),
    unoApi: async (input: FileToolInput) => browserActionResultToCapabilityResult(
      await workspace.getUnoApi({ ...input, runId }),
    ),
    jsApi: async (input: FileToolInput) => browserActionResultToCapabilityResult(
      await workspace.getOfficeJsApi({ ...input, runId }),
    ),
    generate: async (input: FileToolInput, context: CapabilityExecutionContext) => (
      browserActionResultToCapabilityResult(await workspace.generateUnoFileArtifact({
        ...input,
        abortSignal: context.abortSignal,
        onProgress: progressReporter(context),
        runId,
        attachmentBindings: options.attachmentBindings,
        includeVisualVerification: false,
      }))
    ),
    edit: async (input: FileToolInput, context: CapabilityExecutionContext) => (
      browserActionResultToCapabilityResult(await workspace.editUnoFileArtifact({
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
      }))
    ),
    render: async (input: FileToolInput, context: CapabilityExecutionContext) => (
      browserActionResultToCapabilityResult(await workspace.renderFileArtifact({
        ...input,
        abortSignal: context.abortSignal,
        onProgress: progressReporter(context),
        runId,
        attachmentBindings: options.attachmentBindings,
        includeVisualVerification: options.visualInputAvailable,
      }))
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
    if (!version.ok) return browserActionResultToCapabilityResult(version);
    const result = await options.readFileVisuals?.(input)
      || { ok: false, actual: 'File visual actions are unavailable in this runtime.' };
    return browserActionResultToCapabilityResult(await workspace.recordOfficeVisualQaProgress({
      runId,
      artifactId: input.artifactId,
      action: input.action,
      result,
    }));
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
    createOperations: (context) => createBrowserChatFileOperations(context.runId, options),
  });
}

export async function executeBrowserChatFile(input: {
  runId: string;
  params: unknown;
  options: BrowserChatFileCapabilityOptions;
  abortSignal?: AbortSignal;
  invocationId?: string;
}) {
  const operations = createBrowserChatFileOperations(input.runId, input.options);
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
