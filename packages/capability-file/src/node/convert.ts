import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { raceWithAbort, type CapabilityHealth } from '@webpilot/capability-sdk';
import type { FileArtifactOperationResult } from '../types.js';
import {
  createNodeArtifactPayload,
  nodeArtifactRelativePath,
  sanitizeNodeArtifactFileName,
  sha256NodeFile,
  uniqueNodeArtifactPath,
  type NodeArtifactPayload,
  type NodeArtifactUrlResolver,
} from './artifacts.js';
import {
  convertOfficeFile,
  resolveLibreOfficeExecutable,
  type LibreOfficeRuntimeOptions,
  type OfficeFileConversionInput,
} from './libreoffice.js';

const convertibleOfficeExtensions = new Set([
  '.doc', '.docx', '.odt',
  '.xls', '.xlsx', '.ods',
  '.ppt', '.pptx', '.odp',
]);

export type NodeFileConvertInput = {
  runId?: string;
  sourceArtifactId?: string;
  fileName?: string | null;
  includeVisualVerification?: boolean;
};

export type NodeFileConversionPreviewInput = {
  absolutePath: string;
  cacheKey: string;
  extension: '.pdf';
  name: string;
  previewRoot: string;
  abortSignal?: AbortSignal;
};

export type NodeFileConversionPreviewResult = {
  imagePaths: string[];
  renderedPages: number[];
};

export type NodeFileConversionArtifact = NodeArtifactPayload<'generated'> & {
  sourceArtifactId: string;
  convertedFrom: string;
  convertedTo: '.pdf';
};

export type NodeFileConverterOptions = {
  artifactsRoot: string;
  artifactUrl?: NodeArtifactUrlResolver;
  conversionsDirectory?: (runId?: string) => string;
  previewsDirectory?: (runId?: string) => string;
  convertOfficeFile?: (input: OfficeFileConversionInput) => Promise<Buffer | undefined>;
  renderPreview?: (
    input: NodeFileConversionPreviewInput,
  ) => Promise<NodeFileConversionPreviewResult>;
  runtime?: LibreOfficeRuntimeOptions;
  runtimeHealth?: () => Promise<CapabilityHealth>;
  timeoutMs?: number;
};

export type NodeFileConvertExecutionOptions = {
  abortSignal?: AbortSignal;
};

export interface NodeFileConverter {
  convert(
    input: NodeFileConvertInput,
    options?: NodeFileConvertExecutionOptions,
  ): Promise<FileArtifactOperationResult>;
  health(): Promise<CapabilityHealth>;
  dispose(): Promise<void>;
}

export function createNodeFileConverter(
  options: NodeFileConverterOptions,
): NodeFileConverter {
  const artifactsRoot = path.resolve(options.artifactsRoot);
  const activeControllers = new Set<AbortController>();
  const activeConversions = new Set<Promise<FileArtifactOperationResult>>();
  const officeConverter = options.convertOfficeFile || convertOfficeFile;
  let disposed = false;

  const conversionsDirectory = (runId?: string) => path.resolve(
    options.conversionsDirectory?.(runId)
      || path.join(
        artifactsRoot,
        sanitizeNodeArtifactFileName(runId, 'adhoc'),
        'generated',
        'conversions',
      ),
  );
  const previewsDirectory = (runId?: string) => path.resolve(
    options.previewsDirectory?.(runId)
      || path.join(
        artifactsRoot,
        sanitizeNodeArtifactFileName(runId, 'adhoc'),
        'attachment-previews',
      ),
  );

  function createController(externalSignal?: AbortSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(
      externalSignal?.reason instanceof Error
        ? externalSignal.reason
        : new Error('Office conversion aborted.'),
    );
    if (externalSignal?.aborted) onAbort();
    else externalSignal?.addEventListener('abort', onAbort, { once: true });
    activeControllers.add(controller);
    return {
      controller,
      dispose() {
        externalSignal?.removeEventListener('abort', onAbort);
        activeControllers.delete(controller);
      },
    };
  }

  async function convertUnlocked(
    input: NodeFileConvertInput,
    signal: AbortSignal,
  ): Promise<FileArtifactOperationResult> {
    try {
      signal.throwIfAborted();
      const sourceArtifactId = String(input.sourceArtifactId || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .trim();
      if (!sourceArtifactId) {
        return {
          ok: false,
          actual: 'file action=convert requires sourceArtifactId from a prior artifact result.',
        };
      }
      const sourcePath = path.resolve(artifactsRoot, sourceArtifactId);
      nodeArtifactRelativePath(
        artifactsRoot,
        sourcePath,
        'file action=convert sourceArtifactId must resolve inside the artifact workspace.',
      );
      const sourceMetadata = await stat(sourcePath);
      if (!sourceMetadata.isFile()) {
        return {
          ok: false,
          actual: 'file action=convert sourceArtifactId does not identify a file.',
        };
      }
      const sourceExtension = path.extname(sourcePath).toLowerCase();
      if (!convertibleOfficeExtensions.has(sourceExtension)) {
        return {
          ok: false,
          actual: `file action=convert supports Office source files only; received ${sourceExtension || 'no extension'}.`,
        };
      }
      const requestedName = sanitizeNodeArtifactFileName(
        input.fileName,
        `${path.basename(sourcePath, sourceExtension)}.pdf`,
      );
      if (path.extname(requestedName).toLowerCase() !== '.pdf') {
        return {
          ok: false,
          actual: 'file action=convert currently requires a .pdf fileName.',
        };
      }
      const converted = await officeConverter({
        absolutePath: sourcePath,
        sourceExtension,
        targetExtension: '.pdf',
        abortSignal: signal,
        runtime: options.runtime,
        timeoutMs: options.timeoutMs,
      });
      signal.throwIfAborted();
      if (!converted?.length) throw new Error('LibreOffice did not return converted PDF bytes.');

      const directory = conversionsDirectory(input.runId);
      nodeArtifactRelativePath(
        artifactsRoot,
        directory,
        'Conversions directory must stay inside the configured artifact root.',
      );
      await mkdir(directory, { recursive: true });
      const target = await uniqueNodeArtifactPath(directory, requestedName);
      await writeFile(target.filePath, converted, { flag: 'wx' });
      const artifact = createNodeArtifactPayload({
        artifactsRoot,
        artifactUrl: options.artifactUrl,
      }, {
        filePath: target.filePath,
        fileName: target.fileName,
        bytes: converted.length,
        kind: 'generated',
      });

      let visualVerification: NodeFileConversionPreviewResult | undefined;
      if (input.includeVisualVerification && options.renderPreview) {
        const previewRoot = previewsDirectory(input.runId);
        nodeArtifactRelativePath(
          artifactsRoot,
          previewRoot,
          'Preview directory must stay inside the configured artifact root.',
        );
        visualVerification = await raceWithAbort(options.renderPreview({
          absolutePath: target.filePath,
          cacheKey: `${await sha256NodeFile(target.filePath)}:conversion`,
          extension: '.pdf',
          name: target.fileName,
          previewRoot,
          abortSignal: signal,
        }), signal);
      }

      const payload: NodeFileConversionArtifact & { qualityGate: unknown } = {
        ...artifact,
        sourceArtifactId,
        convertedFrom: sourceExtension,
        convertedTo: '.pdf',
        qualityGate: visualVerification ? {
          structural: true,
          visual: {
            previewPages: visualVerification.renderedPages,
            modelReviewRequired: true,
          },
        } : {
          structural: true,
          visual: { status: 'not-performed' },
        },
      };
      return {
        ok: true,
        actual: JSON.stringify(payload),
        referenceImagePaths: visualVerification?.imagePaths.length
          ? visualVerification.imagePaths
          : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        actual: `Office conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function convert(
    input: NodeFileConvertInput,
    execution: NodeFileConvertExecutionOptions = {},
  ) {
    if (disposed) {
      return {
        ok: false,
        actual: 'Office conversion failed: file converter has been disposed.',
      };
    }
    const controlled = createController(execution.abortSignal);
    const pending = convertUnlocked(input, controlled.controller.signal);
    activeConversions.add(pending);
    try {
      return await pending;
    } finally {
      controlled.dispose();
      activeConversions.delete(pending);
    }
  }

  return {
    convert,
    async health() {
      if (disposed) {
        return { status: 'unhealthy', message: 'File converter has been disposed.' };
      }
      if (options.runtimeHealth) return options.runtimeHealth();
      if (options.convertOfficeFile) {
        return {
          status: 'healthy',
          details: { converter: 'injected' },
        };
      }
      const libreOffice = await resolveLibreOfficeExecutable(options.runtime);
      return libreOffice ? {
        status: 'healthy',
        details: { converter: 'libreoffice', libreOffice },
      } : {
        status: 'needs-runtime',
        message: 'LibreOffice is required for Office conversion.',
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of activeControllers) {
        controller.abort(new Error('File converter disposed.'));
      }
      await Promise.allSettled(activeConversions);
      activeControllers.clear();
      activeConversions.clear();
    },
  };
}
