import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import ffmpegStaticPath from 'ffmpeg-static';
import { DataSource } from 'typeorm';
import type { CapabilityProvider, CapabilityRunContext } from '@webpilot/capability-sdk';
import { createNodeCodeSandboxCapability } from '@webpilot/capability-code-sandbox/node';
import { createResearchCapability } from '@webpilot/capability-research';
import { createNodeResearchOperations } from '@webpilot/capability-research/node';
import type { ResearchSource } from '@webpilot/capability-research';
import { createMcpStreamableHttpConnector, createNodeConnectorsCapability } from '@webpilot/capability-connectors/node';
import type { AgentConnector } from '@webpilot/capability-connectors';
import { createNodeKnowledgeCapability } from '@webpilot/capability-knowledge/node';
import { createDataCapability, createDataSourceRegistry, type AgentDataSource } from '@webpilot/capability-data';
import { createTypeOrmAgentDataSource } from '@webpilot/capability-data/typeorm';
import { createMediaCapability, type MediaOperations } from '@webpilot/capability-media';
import { createFfmpegMediaOperations } from '@webpilot/capability-media/node';
import { createJsonWebhookChannel, createNodeCommunicationCapability } from '@webpilot/capability-communication/node';
import type { CommunicationChannel } from '@webpilot/capability-communication';
import { createNodeGitCapability } from '@webpilot/capability-git/node';
import { createNodeComputerCapability } from '@webpilot/capability-computer/node';
import { createNodeWorkflowCapability } from '@webpilot/capability-workflow/node';
import type { BrowserCodeAttachmentBinding } from '@webpilot/capability-browser/node';
import { artifactApiUrl } from '@/lib/artifacts';
import { artifactPath, artifactsRoot } from '@/server/storage/paths';

function safeSegment(value: unknown, fallback: string) {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 160) || fallback;
}

function jsonArray(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return [] as Record<string, unknown>[];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
  } catch {
    return [];
  }
}

function optionalAuthorization(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? { authorization: text } : undefined;
}

function researchSearch(context: CapabilityRunContext) {
  const endpoint = String(context.configuration.AGENT_RESEARCH_SEARCH_ENDPOINT || '').trim();
  if (!endpoint) return undefined;
  return async (input: { query: string; limit: number; domains?: string[]; recencyDays?: number }, execution: { abortSignal?: AbortSignal }) => {
    const timeout = AbortSignal.timeout(Number(context.configuration.AGENT_RESEARCH_TIMEOUT_MS) || 20_000);
    const signal = execution.abortSignal ? AbortSignal.any([execution.abortSignal, timeout]) : timeout;
    const response = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...optionalAuthorization(context.configuration.AGENT_RESEARCH_SEARCH_AUTHORIZATION) },
      body: JSON.stringify(input),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Research search provider returned HTTP ${response.status}: ${text.slice(0, 1000)}`);
    const payload = JSON.parse(text) as unknown;
    const values = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).results) ? (payload as { results: unknown[] }).results : [];
    return values.slice(0, input.limit).flatMap((item, index): ResearchSource[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const url = typeof record.url === 'string' ? record.url : '';
      if (!url) return [];
      return [{
        sourceId: typeof record.sourceId === 'string' ? record.sourceId : `source_${createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
        url,
        title: typeof record.title === 'string' ? record.title : `Search result ${index + 1}`,
        snippet: typeof record.snippet === 'string' ? record.snippet : undefined,
        provider: 'configured-search',
        retrievedAt: new Date().toISOString(),
      }];
    });
  };
}

function configuredConnectors(context: CapabilityRunContext): AgentConnector[] {
  return jsonArray(context.configuration.AGENT_CONNECTORS_JSON).flatMap((record) => {
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!id || !url || record.kind !== 'mcp') return [];
    const authorizationEnv = typeof record.authorizationEnv === 'string' ? record.authorizationEnv.trim() : '';
    const authorization = authorizationEnv ? process.env[authorizationEnv] : undefined;
    return [createMcpStreamableHttpConnector({
      id,
      name: typeof record.name === 'string' ? record.name : id,
      url,
      timeoutMs: Number(context.configuration.AGENT_CONNECTOR_TIMEOUT_MS) || 30_000,
      headers: optionalAuthorization(authorization),
    })];
  });
}

function configuredCommunicationChannels(context: CapabilityRunContext): CommunicationChannel[] {
  return jsonArray(context.configuration.AGENT_COMMUNICATION_WEBHOOKS_JSON).flatMap((record) => {
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!id || !url) return [];
    const authorizationEnv = typeof record.authorizationEnv === 'string' ? record.authorizationEnv.trim() : '';
    return [createJsonWebhookChannel({ id, name: typeof record.name === 'string' ? record.name : id, url, timeoutMs: Number(context.configuration.AGENT_COMMUNICATION_TIMEOUT_MS) || 30_000, headers: optionalAuthorization(authorizationEnv ? process.env[authorizationEnv] : undefined) })];
  });
}

async function configuredDataSources(context: CapabilityRunContext): Promise<AgentDataSource[]> {
  const sources: AgentDataSource[] = [];
  try {
    for (const record of jsonArray(context.configuration.AGENT_DATA_SOURCES_JSON)) {
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      const kind = typeof record.kind === 'string' ? record.kind.trim().toLowerCase() : '';
      if (!id || (kind !== 'sqlite' && kind !== 'postgres')) continue;
      const readOnly = record.readOnly !== false;
      let dataSource: DataSource;
      if (kind === 'sqlite') {
        const database = String(record.database || '').trim();
        if (!database) throw new Error(`Data source ${id} requires database.`);
        dataSource = new DataSource({
          type: 'better-sqlite3',
          database: path.resolve(database),
          readonly: readOnly,
        });
      } else {
        const urlEnv = String(record.urlEnv || '').trim();
        if (!urlEnv) throw new Error(`Data source ${id} requires urlEnv.`);
        const url = process.env[urlEnv];
        if (!url) throw new Error(`Data source ${id} references an unset environment variable.`);
        dataSource = new DataSource({
          type: 'postgres',
          url,
          ssl: record.ssl === true ? { rejectUnauthorized: record.rejectUnauthorized !== false } : false,
        });
      }
      await dataSource.initialize();
      const source = createTypeOrmAgentDataSource({
        id,
        name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
        source: dataSource,
        readOnly,
      });
      sources.push({
        ...source,
        async dispose() {
          if (dataSource.isInitialized) await dataSource.destroy();
        },
      });
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
    createNodeCodeSandboxCapability({ workspaceDirectory: (context) => artifactPath('agent-infrastructure', 'code', safeSegment(context.userId, 'shared'), safeSegment(context.runId, 'run')) }),
    createResearchCapability({ createOperations: (context) => createNodeResearchOperations({ search: researchSearch(context), timeoutMs: Number(context.configuration.AGENT_RESEARCH_TIMEOUT_MS) || 20_000 }) }),
    createNodeConnectorsCapability({ connectors: configuredConnectors }),
    createNodeKnowledgeCapability({ directory: (context) => artifactPath('agent-infrastructure', 'knowledge', safeSegment(context.userId, 'shared')) }),
    createDataCapability({ createRegistry: async (context) => createDataSourceRegistry(await configuredDataSources(context)) }),
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
