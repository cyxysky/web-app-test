import type {
  CapabilityExecutionContext,
  CapabilityResult,
  CapabilityRunContext,
} from '@webpilot/capability-sdk';
import {
  createFileCapability,
  type FileArtifactOperationResult,
  type FileAttachmentBinding,
  type FileCapabilityRuntimeOperations,
  type FileReadInput,
  type FileToolInput,
  type FileVisualToolInput,
} from '../index.js';
import {
  createNodeFileWorkspace,
  type FileGenerationProgress,
  type NodeFileWorkspaceHost,
} from './workspace.js';

type ContextValue<T> = T | ((context: CapabilityRunContext) => T | Promise<T>);

export type NodeFileCapabilityOptions = {
  workspace: ContextValue<NodeFileWorkspaceHost>;
  visualInputAvailable: boolean;
  attachmentBindings?: ContextValue<readonly FileAttachmentBinding[] | undefined>;
  sourcePageUrl?: ContextValue<string | undefined>;
  includeVisualVerification?: boolean;
  readFile?: (
    input: FileReadInput,
    context: CapabilityExecutionContext,
    runContext: CapabilityRunContext,
  ) => Promise<FileArtifactOperationResult>;
  readFileVisuals?: (
    input: FileVisualToolInput,
    context: CapabilityExecutionContext,
    runContext: CapabilityRunContext,
  ) => Promise<FileArtifactOperationResult>;
};

async function resolveContextValue<T>(value: ContextValue<T>, context: CapabilityRunContext) {
  return typeof value === 'function'
    ? (value as (context: CapabilityRunContext) => T | Promise<T>)(context)
    : value;
}

function parsedOperationData(actual: string): unknown {
  try {
    return JSON.parse(actual) as unknown;
  } catch {
    return actual;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function fileOperationToCapabilityResult(
  result: FileArtifactOperationResult,
): CapabilityResult {
  const parsed = parsedOperationData(result.actual);
  const imagePaths = result.referenceImagePaths?.filter(Boolean) || [];
  const parsedRecord = record(parsed);
  const data = imagePaths.length
    ? parsedRecord
      ? { ...parsedRecord, referenceImagePaths: imagePaths }
      : { actual: parsed, referenceImagePaths: imagePaths }
    : parsed;
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: 'file-operation-failed',
        message: result.actual,
        details: data,
      },
    };
  }

  const payload = record(data);
  const artifactId = typeof payload?.artifactId === 'string' ? payload.artifactId : undefined;
  const downloadUrl = typeof payload?.downloadUrl === 'string' ? payload.downloadUrl : undefined;
  const mediaType = typeof payload?.mimeType === 'string' ? payload.mimeType : undefined;
  const content = [
    ...(artifactId ? [{
      type: 'artifact' as const,
      artifactId,
      ...(downloadUrl ? { downloadUrl } : {}),
      ...(mediaType ? { mediaType } : {}),
    }] : []),
    ...imagePaths.map((imagePath) => ({
      type: 'image' as const,
      artifactId: imagePath,
    })),
  ];
  return {
    ok: true,
    summary: result.actual,
    data,
    content: content.length ? content : undefined,
  };
}

function unavailable(message: string): CapabilityResult {
  return { ok: false, error: { code: 'file-action-unavailable', message } };
}

function progressReporter(context: CapabilityExecutionContext) {
  return async (event: FileGenerationProgress) => context.reportProgress?.(event);
}

export async function createNodeFileOperations(
  options: NodeFileCapabilityOptions,
  runContext: CapabilityRunContext,
): Promise<FileCapabilityRuntimeOperations> {
  const [workspaceHost, configuredBindings, sourcePageUrl] = await Promise.all([
    resolveContextValue(options.workspace, runContext),
    options.attachmentBindings
      ? resolveContextValue(options.attachmentBindings, runContext)
      : undefined,
    options.sourcePageUrl
      ? resolveContextValue(options.sourcePageUrl, runContext)
      : undefined,
  ]);
  const workspace = createNodeFileWorkspace(workspaceHost);
  const attachmentBindings = configuredBindings ? [...configuredBindings] : undefined;
  const runId = runContext.runId;
  const includeVisualVerification = options.includeVisualVerification === true;

  const file: FileCapabilityRuntimeOperations['file'] = {
    list: async () => fileOperationToCapabilityResult(
      await workspace.listOfficeDrafts({ runId }),
    ),
    read: async (input, context) => {
      if (input.documentId) {
        return fileOperationToCapabilityResult(await workspace.readUnoDraft({
          runId,
          documentId: input.documentId,
          path: input.path,
          startLine: input.startLine,
          endLine: input.endLine,
        }));
      }
      if (!options.readFile) {
        return unavailable('Reading external attachments requires a host-provided readFile adapter.');
      }
      return fileOperationToCapabilityResult(await options.readFile(input, context, runContext));
    },
    download: async (input: FileToolInput, context) => fileOperationToCapabilityResult(
      await workspace.downloadFileArtifact({
        runId,
        url: input.url,
        path: input.path,
        urlOrPath: input.urlOrPath,
        fileName: input.fileName,
        fileType: input.fileType,
        sourcePageUrl,
      }, { abortSignal: context.abortSignal }),
    ),
    convert: async (input: FileToolInput, context) => fileOperationToCapabilityResult(
      await workspace.convertFileArtifact({
        runId,
        sourceArtifactId: input.sourceArtifactId,
        fileName: input.fileName,
        includeVisualVerification,
      }, { abortSignal: context.abortSignal }),
    ),
    plan: async (input: FileToolInput) => fileOperationToCapabilityResult(
      await workspace.planFileArtifact({
        runId,
        documentId: input.documentId,
        fileName: input.fileName,
        documentType: input.documentType,
        operation: input.operation,
        intent: input.intent,
        sourceAttachmentId: input.sourceAttachmentId,
        attachmentBindings,
      }),
    ),
    unoApi: async (input: FileToolInput) => fileOperationToCapabilityResult(
      await workspace.getUnoApi({
        runId,
        documentId: input.documentId,
        documentType: input.documentType,
        query: input.query,
        offset: input.offset,
        limit: input.limit,
      }),
    ),
    jsApi: async (input: FileToolInput) => fileOperationToCapabilityResult(
      await workspace.getOfficeJsApi({
        runId,
        documentId: input.documentId,
        documentType: input.documentType,
      }),
    ),
    generate: async (input: FileToolInput, context) => fileOperationToCapabilityResult(
      await workspace.generateUnoFileArtifact({
        runId,
        documentId: input.documentId,
        program: input.program,
        replaceExisting: input.replaceExisting,
        baseDigest: input.baseDigest,
        render: input.render,
        includeVisualVerification,
        attachmentBindings,
        abortSignal: context.abortSignal,
        onProgress: progressReporter(context),
      }),
    ),
    edit: async (input: FileToolInput, context) => fileOperationToCapabilityResult(
      await workspace.editUnoFileArtifact({
        runId,
        documentId: input.documentId,
        path: input.path,
        program: input.program,
        patch: input.patch,
        baseDigest: input.baseDigest,
        render: input.render,
        includeVisualVerification,
        attachmentBindings,
        abortSignal: context.abortSignal,
        onProgress: progressReporter(context),
      }),
    ),
    render: async (input: FileToolInput, context) => fileOperationToCapabilityResult(
      await workspace.renderFileArtifact({
        runId,
        documentId: input.documentId,
        includeVisualVerification,
        attachmentBindings,
        abortSignal: context.abortSignal,
        onProgress: progressReporter(context),
      }),
    ),
  };

  const visual = options.visualInputAvailable && options.readFileVisuals ? {
    index: executeVisual,
    read: executeVisual,
    report: executeVisual,
  } satisfies NonNullable<FileCapabilityRuntimeOperations['visual']> : undefined;

  async function executeVisual(input: FileVisualToolInput, context: CapabilityExecutionContext) {
    const current = await workspace.verifyCurrentUnoRenderedArtifact({
      runId,
      artifactId: input.artifactId,
    });
    if (!current.ok) return fileOperationToCapabilityResult(current);
    const visualResult = await options.readFileVisuals!(input, context, runContext);
    return fileOperationToCapabilityResult(await workspace.recordOfficeVisualQaProgress({
      runId,
      artifactId: input.artifactId,
      action: input.action,
      result: visualResult,
    }));
  }

  return {
    file,
    visual,
    health: () => workspace.health(),
    dispose: () => workspace.dispose(),
  };
}

export function createNodeFileCapability(options: NodeFileCapabilityOptions) {
  return createFileCapability({
    visualInputAvailable: options.visualInputAvailable,
    createOperations: (context) => createNodeFileOperations(options, context),
  });
}
