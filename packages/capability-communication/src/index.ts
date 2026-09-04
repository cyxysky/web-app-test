import { z } from 'zod';
import {
  defineCapabilityInput,
  defineCapabilityTool,
  type CapabilityExecutionContext,
  type CapabilityHealth,
  type CapabilityManifest,
  type CapabilityProvider,
  type CapabilityRunContext,
} from '@webpilot/capability-sdk';
import { communicationRuntimeSkill } from './runtime-skill.js';
import { communicationCapabilitySettings } from './settings.js';

export * from './runtime-skill.js';
export * from './settings.js';

export const communicationCapabilityToolNames = Object.freeze({ communication: 'communication' } as const);

export type CommunicationTargetKind = 'user' | 'group' | 'department' | 'email' | 'address';
export type CommunicationContentFormat = 'text' | 'markdown';

export type CommunicationTarget = {
  kind: CommunicationTargetKind;
  id: string;
  name?: string;
};

export type CommunicationContent = {
  format: CommunicationContentFormat;
  title?: string;
  body: string;
};

export type CommunicationDraft = {
  id: string;
  channelId: string;
  targets: CommunicationTarget[];
  content: CommunicationContent;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type CommunicationReceipt = {
  channelId: string;
  deliveryIds: string[];
  acceptedAt: string;
  details?: unknown;
};

export type CommunicationChannelCapabilities = {
  targetKinds: readonly CommunicationTargetKind[];
  contentFormats: readonly CommunicationContentFormat[];
  requiresExplicitTargets: boolean;
};

export interface CommunicationChannel {
  id: string;
  name: string;
  driverId: string;
  capabilities: CommunicationChannelCapabilities;
  send(draft: CommunicationDraft, context: CapabilityExecutionContext): Promise<CommunicationReceipt>;
  health?(): Promise<CapabilityHealth>;
  dispose?(): Promise<void>;
}

export interface CommunicationDraftStore {
  create(input: Omit<CommunicationDraft, 'id' | 'createdAt'>): Promise<CommunicationDraft>;
  get(id: string): Promise<CommunicationDraft | undefined>;
}

export function createMemoryCommunicationDraftStore(): CommunicationDraftStore {
  const drafts = new Map<string, CommunicationDraft>();
  return {
    async create(input) {
      const draft = { ...input, id: globalThis.crypto.randomUUID(), createdAt: new Date().toISOString() };
      drafts.set(draft.id, draft);
      return draft;
    },
    async get(id) {
      return drafts.get(id);
    },
  };
}

const targetParser = z.object({
  kind: z.enum(['user', 'group', 'department', 'email', 'address']),
  id: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(500).optional(),
}).strict();

const contentParser = z.object({
  format: z.enum(['text', 'markdown']),
  title: z.string().trim().max(1_000).optional(),
  body: z.string().min(1).max(200_000),
}).strict();

const parser = z.object({
  action: z.enum(['channels', 'draft', 'readDraft', 'send']),
  reason: z.string().trim().min(1).max(300),
  channelId: z.string().trim().min(1).max(200).optional(),
  targets: z.array(targetParser).max(100).optional(),
  content: contentParser.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  draftId: z.string().uuid().optional(),
}).strict().superRefine((input, context) => {
  if (input.action === 'draft' && (!input.channelId || !input.content)) {
    context.addIssue({ code: 'custom', message: 'draft requires channelId and content.' });
  }
  if ((input.action === 'readDraft' || input.action === 'send') && !input.draftId) {
    context.addIssue({ code: 'custom', path: ['draftId'], message: `${input.action} requires draftId.` });
  }
});

export type CommunicationToolInput = z.infer<typeof parser>;
export const communicationCapabilityToolInput = defineCapabilityInput<CommunicationToolInput>(
  z.toJSONSchema(parser) as Readonly<Record<string, unknown>>,
  (value) => parser.parse(value),
);

export const communicationCapabilityManifest = Object.freeze({
  schemaVersion: 1,
  id: 'com.webpilot.communication',
  name: 'Communication',
  version: '0.1.0',
  description: 'Create drafts and send approved messages through host-configured communication channels.',
  permissions: ['communication:draft', 'communication:send', 'network:external'],
  runtimeRequirements: { node: '>=22.16' },
  configuration: { settings: communicationCapabilitySettings },
  skills: [communicationRuntimeSkill],
} satisfies CapabilityManifest);

function channelDraftError(channel: CommunicationChannel, input: CommunicationToolInput) {
  const targets = input.targets || [];
  if (channel.capabilities.requiresExplicitTargets && !targets.length) {
    return `Channel ${channel.id} requires at least one explicit target.`;
  }
  const unsupportedTarget = targets.find((target) => !channel.capabilities.targetKinds.includes(target.kind));
  if (unsupportedTarget) {
    return `Channel ${channel.id} does not support target kind ${unsupportedTarget.kind}.`;
  }
  if (input.content && !channel.capabilities.contentFormats.includes(input.content.format)) {
    return `Channel ${channel.id} does not support ${input.content.format} content.`;
  }
  return '';
}

export function createCommunicationTool(
  channels: readonly CommunicationChannel[],
  drafts: CommunicationDraftStore,
  configuration: CapabilityRunContext['configuration'],
) {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return defineCapabilityTool<CommunicationToolInput, unknown>({
    name: 'communication',
    description: 'List outbound channels, create/read an exact message draft, or send an existing draft after host approval.',
    input: communicationCapabilityToolInput,
    policy: {
      concurrency: 'serial',
      concurrencyGroup: 'outbound-communication',
      permissions: communicationCapabilityManifest.permissions,
    },
    async execute(input, context) {
      try {
        if (input.action === 'channels') {
          return {
            ok: true,
            summary: 'Configured communication channels.',
            data: channels.map(({ id, name, driverId, capabilities }) => ({ id, name, driverId, capabilities })),
          };
        }
        if (input.action === 'draft') {
          const channel = byId.get(input.channelId!);
          if (!channel) {
            return { ok: false, error: { code: 'communication-channel-not-found', message: `Unknown channel: ${input.channelId}.` } };
          }
          const validationError = channelDraftError(channel, input);
          if (validationError) {
            return { ok: false, error: { code: 'communication-draft-invalid', message: validationError } };
          }
          const draft = await drafts.create({
            channelId: input.channelId!,
            targets: input.targets || [],
            content: input.content!,
            metadata: input.metadata,
          });
          return { ok: true, summary: `Communication draft ${draft.id} created.`, data: draft };
        }
        const draft = await drafts.get(input.draftId!);
        if (!draft) {
          return { ok: false, error: { code: 'communication-draft-not-found', message: `Unknown draft: ${input.draftId}.` } };
        }
        if (input.action === 'readDraft') {
          return { ok: true, summary: `Communication draft ${draft.id}.`, data: draft };
        }
        if (configuration.AGENT_COMMUNICATION_ALLOW_SEND !== 'true') {
          return { ok: false, error: { code: 'communication-send-disabled', message: 'Outbound communication is disabled by host configuration.' } };
        }
        const channel = byId.get(draft.channelId);
        if (!channel) {
          return { ok: false, error: { code: 'communication-channel-not-found', message: `Unknown channel: ${draft.channelId}.` } };
        }
        const receipt = await channel.send(draft, context);
        return { ok: true, summary: `Message accepted by ${channel.name}.`, data: receipt };
      } catch (error) {
        return {
          ok: false,
          error: { code: 'communication-operation-failed', message: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  });
}

export function createCommunicationCapability(options: {
  createChannels(context: CapabilityRunContext): readonly CommunicationChannel[] | Promise<readonly CommunicationChannel[]>;
  createDraftStore?(context: CapabilityRunContext): CommunicationDraftStore | Promise<CommunicationDraftStore>;
}): CapabilityProvider {
  return {
    manifest: communicationCapabilityManifest,
    async createRuntime(context) {
      const channels = await options.createChannels(context);
      const drafts = await options.createDraftStore?.(context) || createMemoryCommunicationDraftStore();
      return {
        tools: Object.freeze({ communication: createCommunicationTool(channels, drafts, context.configuration) }),
        health: async () => {
          const statuses = await Promise.all(channels.map((channel) => channel.health?.() || Promise.resolve({ status: 'healthy' as const })));
          return statuses.some((item) => item.status === 'unhealthy')
            ? { status: 'degraded', message: 'One or more communication channels are unhealthy.' }
            : { status: 'healthy' };
        },
        dispose: async () => {
          await Promise.allSettled(channels.map((channel) => channel.dispose?.()));
        },
      };
    },
  };
}
