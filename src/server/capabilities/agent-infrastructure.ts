import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import ffmpegStaticPath from 'ffmpeg-static';
import type { CapabilityProvider, CapabilityRunContext } from '@webpilot/capability-sdk';
import { createCodeSandboxCapability } from '@webpilot/capability-code-sandbox';
import { createNodeProcessCodeSandbox } from '@webpilot/capability-code-sandbox/node';
import { createHttpCodeSandboxExecutor } from '@webpilot/capability-code-sandbox/remote';
import { createResearchCapability } from '@webpilot/capability-research';
import { createNodeResearchOperations } from '@webpilot/capability-research/node';
import type { ResearchSource } from '@webpilot/capability-research';
import { createNodeConnectorsCapability } from '@webpilot/capability-connectors/node';
import type { AgentConnector } from '@webpilot/capability-connectors';
import { createNodeKnowledgeCapability } from '@webpilot/capability-knowledge/node';
import { createDataCapability, createDataSourceRegistry, type AgentDataSource } from '@webpilot/capability-data';
import { createMediaCapability, type MediaOperations } from '@webpilot/capability-media';
import { createFfmpegMediaOperations } from '@webpilot/capability-media/node';
import { createNodeCommunicationCapability } from '@webpilot/capability-communication/node';
import type { CommunicationChannel } from '@webpilot/capability-communication';
import { createNodeGitCapability } from '@webpilot/capability-git/node';
import { createNodeComputerCapability } from '@webpilot/capability-computer/node';
import { createNodeWorkflowCapability } from '@webpilot/capability-workflow/node';
import type { BrowserCodeAttachmentBinding } from '@webpilot/capability-browser/node';
import { artifactApiUrl } from '@/lib/artifacts';
import { artifactPath, artifactsRoot, codeSandboxRoot } from '@/server/storage/paths';
import { resolveExternalIntegrations } from '@/server/integrations/external-integration-vault';
import {
  createExternalCommunicationChannel,
  createExternalDataSource,
  createExternalIntegrationConnector,
  createExternalResearchSearch,
} from '@/server/integrations/external-integration-drivers';

function safeSegment(value: unknown, fallback: string) {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 160) || fallback;
}

function createAgentCodeSandboxCapability(): CapabilityProvider {
  return createCodeSandboxCapability({
    createExecutor(context) {
      const backend = context.configuration.AGENT_CODE_SANDBOX_BACKEND === 'local' ? 'local' : 'remote';
      if (backend === 'remote') {
        return createHttpCodeSandboxExecutor({
          url: String(context.configuration.AGENT_CODE_SANDBOX_RUNNER_URL || '').trim(),
          token: String(context.configuration.AGENT_CODE_SANDBOX_RUNNER_TOKEN || '').trim() || undefined,
        });
      }
      return createNodeProcessCodeSandbox({
        workspaceDirectory: codeSandboxRoot('agent-infrastructure', 'code', safeSegment(context.userId, 'shared'), safeSegment(context.runId, 'run'), randomUUID()),
        maxConcurrent: Number(context.configuration.AGENT_CODE_SANDBOX_MAX_CONCURRENCY) || 2,
      });
    },
  });
}

async function configuredConnectors(context: CapabilityRunContext): Promise<AgentConnector[]> {
  const timeoutMs = Number(context.configuration.AGENT_CONNECTOR_TIMEOUT_MS) || 30_000;
  return (await resolveExternalIntegrations('connector'))
    .map((record) => createExternalIntegrationConnector(record, timeoutMs));
}

async function configuredCommunicationChannels(context: CapabilityRunContext): Promise<CommunicationChannel[]> {
  const timeoutMs = Number(context.configuration.AGENT_COMMUNICATION_TIMEOUT_MS) || 30_000;
  return (await resolveExternalIntegrations('communication'))
    .map((record) => createExternalCommunicationChannel(record, timeoutMs));
}

async function configuredResearchSearch(context: CapabilityRunContext) {
  const timeoutMs = Number(context.configuration.AGENT_RESEARCH_TIMEOUT_MS) || 20_000;
  const searches = (await resolveExternalIntegrations('research'))
    .map((record) => createExternalResearchSearch(record, timeoutMs));
  if (!searches.length) return undefined;
  return async (
    input: { query: string; limit: number; domains?: string[]; recencyDays?: number },
    execution: { invocationId: string; abortSignal?: AbortSignal },
  ): Promise<ResearchSource[]> => {
    const settled = await Promise.allSettled(searches.map((search) => search(input, execution)));
    const successful = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    if (!successful.length && settled.every((result) => result.status === 'rejected')) {
      throw new AggregateError(
        settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
        '所有研究搜索服务均请求失败。',
      );
    }
    const unique = new Map(successful.map((source) => [source.url, source]));
    return [...unique.values()].slice(0, input.limit);
  };
}

async function configuredDataSources(): Promise<AgentDataSource[]> {
  const sources: AgentDataSource[] = [];
  try {
    for (const record of await resolveExternalIntegrations('data')) {
      sources.push(await createExternalDataSource(record, 15_000));
    }
    return sources;
  } catch (error) {
    await Promise.allSettled(sources.map((source) => source.dispose?.()));
    throw error;
  }
}

function mediaOperations(input: { context: CapabilityRunContext; attachments: readonly BrowserCodeAttachmentBinding[] }): MediaOperations {
  const byRef = new Map(input.attachments.map((attachment) => [attachment.ref, attachment.path]));
  const root = artifactsRoot();
  const resolveSource = async (sourceRef: string) => {
    const attachment = byRef.get(sourceRef);
    if (attachment) return attachment;
    let pathname = sourceRef;
    try { pathname = new URL(sourceRef, 'http://webpilot.local').pathname; } catch { /* validate the raw path below */ }
    const marker = '/api/artifacts/';
    const markerIndex = pathname.indexOf(marker);
    if (markerIndex < 0) throw new Error('Media sourceRef must be a registered attachment id or Artifact URL.');
    const relative = pathname.slice(markerIndex + marker.length).split('/').map(decodeURIComponent);
    const resolved = path.resolve(root, ...relative);
    const relativeCheck = path.relative(root, resolved);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) throw new Error('Media artifact reference escapes the artifact root.');
    return resolved;
  };
  if (!ffmpegStaticPath) {
    return { inspect: async () => { throw new Error('FFmpeg runtime is unavailable.'); }, health: async () => ({ status: 'needs-runtime', message: 'FFmpeg runtime is unavailable.' }) };
  }
  return createFfmpegMediaOperations({
    ffmpegPath: ffmpegStaticPath,
    timeoutMs: Number(input.context.configuration.AGENT_MEDIA_TIMEOUT_MS) || 120_000,
    resolveSource,
    async publishArtifact(filePath) {
      const extension = path.extname(filePath).toLowerCase() || '.bin';
      const directory = artifactPath(safeSegment(input.context.runId, 'shared'), 'media');
      await mkdir(directory, { recursive: true });
      const artifactId = `media_${randomUUID()}${extension}`;
      const destination = path.join(directory, artifactId);
      await copyFile(filePath, destination);
      return { artifactId, mediaType: extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.png' ? 'image/png' : undefined, downloadUrl: artifactApiUrl(destination, { artifactsRoot: root }) };
    },
  });
}

export function createAgentInfrastructureProviders(input: {
  attachmentBindings?: readonly BrowserCodeAttachmentBinding[];
} = {}): CapabilityProvider[] {
  return [
    createAgentCodeSandboxCapability(),
    createResearchCapability({ createOperations: async (context) => createNodeResearchOperations({ search: await configuredResearchSearch(context), timeoutMs: Number(context.configuration.AGENT_RESEARCH_TIMEOUT_MS) || 20_000 }) }),
    createNodeConnectorsCapability({ connectors: configuredConnectors }),
    createNodeKnowledgeCapability({ directory: (context) => artifactPath('agent-infrastructure', 'knowledge', safeSegment(context.userId, 'shared')) }),
    createDataCapability({ createRegistry: async () => createDataSourceRegistry(await configuredDataSources()) }),
    createMediaCapability({ createOperations: (context) => mediaOperations({ context, attachments: input.attachmentBindings || [] }) }),
    createNodeCommunicationCapability({ channels: configuredCommunicationChannels, draftDirectory: (context) => artifactPath('agent-infrastructure', 'communication', safeSegment(context.userId, 'shared')) }),
    createNodeGitCapability({ repository: (context) => String(context.configuration.AGENT_GIT_REPOSITORY || '').trim() || process.cwd() }),
    createNodeComputerCapability({
      screenshotDirectory: (context) => artifactPath(
        safeSegment(context.runId, 'shared'),
        'computer',
      ),
    }),
    createNodeWorkflowCapability({ directory: (context) => artifactPath('agent-infrastructure', 'workflows', safeSegment(context.userId, 'shared')) }),
  ];
}

export const agentInfrastructureToolNames = Object.freeze([
  'codeSandbox',
  'research',
  'connectors',
  'knowledge',
  'data',
  'media',
  'communication',
  'git',
  'computer',
  'workflow',
] as const);
