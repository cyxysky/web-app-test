import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type CapabilityConfiguration } from '@webpilot/capability-sdk';
import { createNodeFileConverter, type NodeFileConverter } from './convert.js';
import { createNodeFileDownloader, type NodeFileDownloader } from './download.js';
import { type NodeArtifactUrlResolver } from './artifacts.js';
import { renderFilePreview, type FilePreviewResult } from './office/preview.js';

export type NodeFileWorkspaceHost = {
  artifactsRoot: string;
  artifactUrl?: NodeArtifactUrlResolver;
  configuration?: CapabilityConfiguration;
  converter?: NodeFileConverter;
  downloader?: NodeFileDownloader;
  officeGenerationMode?: 'auto' | 'javascript' | 'uno';
  renderPreview?: (input: Parameters<typeof renderFilePreview>[0]) => Promise<FilePreviewResult>;
};

export type ResolvedNodeFileWorkspaceHost = Required<Pick<NodeFileWorkspaceHost, 'artifactsRoot' | 'converter' | 'downloader' | 'renderPreview'>> & {
  artifactUrl: NodeArtifactUrlResolver;
  officeGenerationMode: 'auto' | 'javascript' | 'uno';
  dispose(): Promise<void>;
};

export const nodeFileWorkspaceHost = new AsyncLocalStorage<ResolvedNodeFileWorkspaceHost>();

export let defaultNodeFileWorkspaceHost: ResolvedNodeFileWorkspaceHost | undefined;

export function resolveNodeFileWorkspaceHost(options: NodeFileWorkspaceHost): ResolvedNodeFileWorkspaceHost {
  const artifactsRoot = path.resolve(options.artifactsRoot);
  const artifactUrl = options.artifactUrl || ((input) => pathToFileURL(input.absolutePath).href);
  const renderPreview = options.renderPreview || renderFilePreview;
  const downloader = options.downloader || createNodeFileDownloader({ artifactsRoot, artifactUrl });
  const converter = options.converter || createNodeFileConverter({
    artifactsRoot,
    artifactUrl,
    renderPreview: async (input) => renderPreview(input),
  });
  const configuredOfficeGenerationMode = String(
    options.officeGenerationMode || options.configuration?.OFFICE_GENERATION_MODE || 'uno',
  ).trim().toLowerCase();
  const officeGenerationMode = configuredOfficeGenerationMode === 'auto'
    || configuredOfficeGenerationMode === 'javascript'
    || configuredOfficeGenerationMode === 'uno'
    ? configuredOfficeGenerationMode
    : 'uno';
  return {
    artifactsRoot,
    artifactUrl,
    converter,
    downloader,
    officeGenerationMode,
    renderPreview,
    async dispose() {
      await Promise.all([
        options.downloader ? Promise.resolve() : downloader.dispose(),
        options.converter ? Promise.resolve() : converter.dispose(),
      ]);
    },
  };
}

export function currentNodeFileWorkspaceHost() {
  const scoped = nodeFileWorkspaceHost.getStore();
  if (scoped) return scoped;
  const artifactsRoot = path.resolve(
    process.env.CAPABILITY_FILE_ARTIFACTS_DIR
      || process.env.ARTIFACTS_DIR
      || path.join(process.cwd(), 'runtime', 'artifacts'),
  );
  if (!defaultNodeFileWorkspaceHost || defaultNodeFileWorkspaceHost.artifactsRoot !== artifactsRoot) {
    void defaultNodeFileWorkspaceHost?.dispose();
    defaultNodeFileWorkspaceHost = resolveNodeFileWorkspaceHost({ artifactsRoot });
  }
  return defaultNodeFileWorkspaceHost;
}

export async function disposeDefaultNodeFileWorkspace() {
  const host = defaultNodeFileWorkspaceHost;
  defaultNodeFileWorkspaceHost = undefined;
  await host?.dispose();
}
