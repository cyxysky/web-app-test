import { disposeOnce } from './execution.js';
export { CapabilityTaskQueue, type CapabilityTaskOptions } from './task-queue.js';
export { readBoundedResponseText } from './http.js';
export { createCapabilityExecutor, disposeOnce, type CapabilityExecutionPolicyOptions } from './execution.js';
export type JsonSchema = Readonly<Record<string, unknown>>;

export type CapabilityInputSchema<TInput> = {
  jsonSchema: JsonSchema;
  parse(value: unknown): TInput;
};

export type CapabilityContent =
  | { type: 'text'; text: string }
  | { type: 'image'; artifactId: string; mediaType?: string; data?: string }
  | { type: 'artifact'; artifactId: string; downloadUrl?: string; mediaType?: string }
  | { type: 'ui'; renderer: string; resourceId: string };

export type CapabilityResult<TData = unknown> =
  | {
      ok: true;
      summary: string;
      data?: TData;
      content?: CapabilityContent[];
    }
  | {
      ok: false;
      summary?: string;
      error: {
        code: string;
        message: string;
        retryable?: boolean;
        details?: unknown;
      };
    };

export type CapabilityToolPolicy = {
  concurrency?: 'parallel' | 'serial';
  concurrencyGroup?: string;
  permissions?: readonly string[];
  prerequisite?: string;
};

export type CapabilityExecutionContext = {
  invocationId: string;
  abortSignal?: AbortSignal;
  metadata?: Readonly<Record<string, unknown>>;
  reportProgress?: (event: CapabilityProgressEvent) => void | Promise<void>;
};

export type CapabilityProgressEvent = {
  phase: string;
  message: string;
  current?: number;
  total?: number;
  data?: unknown;
};

export interface CapabilityTool<TInput = unknown, TData = unknown> {
  name: string;
  description: string;
  input: CapabilityInputSchema<TInput>;
  inputExamples?: readonly TInput[];
  policy?: CapabilityToolPolicy;
  execute(input: TInput, context: CapabilityExecutionContext): Promise<CapabilityResult<TData>>;
}

// Capability collections intentionally erase individual input/output types. Each
// tool remains strongly typed at its definition and direct-import boundary.
export type CapabilityToolSet = Readonly<Record<string, CapabilityTool<unknown, unknown>>>;

export type CapabilitySkill = {
  id: string;
  title: string;
  summary: string;
  content: string;
  required?: boolean;
  activation?: ReadonlyArray<{
    toolName: string;
    actions?: readonly string[];
  }>;
};

export function capabilitySkillReadJsonSchema(skillIds: readonly string[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', const: 'read' },
      skillId: { type: 'string', enum: [...skillIds] },
      reason: { type: 'string', minLength: 1, maxLength: 300 },
    },
    required: ['action', 'skillId'],
  };
}

export type CapabilitySettingApplyMode = 'runtime' | 'startup';

export type CapabilitySettingDefinition<TSection extends string = string> = {
  key: string;
  label: string;
  description: string;
  section: TSection;
  group?: string;
  defaultValue: string;
  control: 'boolean' | 'number' | 'select' | 'text' | 'secret' | 'textarea';
  applyMode: CapabilitySettingApplyMode;
  min?: number;
  max?: number;
  step?: number;
  options?: ReadonlyArray<{ label: string; value: string }>;
  picker?: 'directory';
  secret?: boolean;
  hidden?: boolean;
  emptyUsesDefault?: boolean;
  valueAliases?: Readonly<Record<string, string>>;
};

export type CapabilityConfiguration = Readonly<Record<string, string | undefined>>;

export type CapabilityConfigurationDefinition = {
  settings: readonly CapabilitySettingDefinition[];
};

export type CapabilityHealth = {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'needs-runtime';
  message?: string;
  details?: Readonly<Record<string, unknown>>;
};

export type CapabilityManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  permissions?: readonly string[];
  runtimeRequirements?: Readonly<Record<string, unknown>>;
  configuration?: CapabilityConfigurationDefinition;
  skills?: readonly CapabilitySkill[];
};

export type CapabilityRunContext = {
  runId: string;
  sessionId?: string;
  userId?: string;
  abortSignal?: AbortSignal;
  metadata?: Readonly<Record<string, unknown>>;
  configuration: CapabilityConfiguration;
};

export interface CapabilityRuntime<TTools extends CapabilityToolSet = CapabilityToolSet> {
  tools: TTools;
  health(): Promise<CapabilityHealth>;
  dispose(): Promise<void>;
}

export interface CapabilityProvider<TTools extends CapabilityToolSet = CapabilityToolSet> {
  manifest: CapabilityManifest;
  createRuntime(context: CapabilityRunContext): Promise<CapabilityRuntime<TTools>>;
}

export function createCapabilityRuntime<TTools extends CapabilityToolSet>(input: {
  dispose?: () => Promise<void>;
  health?: () => Promise<CapabilityHealth>;
  tools: TTools;
}): CapabilityRuntime<TTools> {
  return {
    tools: input.tools,
    health: input.health || (() => Promise.resolve({ status: 'healthy' })),
    dispose: disposeOnce(input.dispose || (() => Promise.resolve())),
  };
}

export type ResolvedCapabilityTool = {
  capabilityId: string;
  capabilityVersion: string;
  internalId: string;
  publicName: string;
  tool: CapabilityTool<unknown, unknown>;
};

export type CapabilityRunSnapshot = {
  abortSignal?: AbortSignal;
  manifests: readonly CapabilityManifest[];
  skills: readonly CapabilitySkill[];
  tools: Readonly<Record<string, ResolvedCapabilityTool>>;
  dispose(): Promise<void>;
};

export class CapabilityRegistry {
  readonly #providers = new Map<string, CapabilityProvider>();

  register(provider: CapabilityProvider) {
    const id = provider.manifest.id.trim();
    if (!id) throw new Error('Capability manifest id is required.');
    if (this.#providers.has(id)) throw new Error(`Capability ${id} is already registered.`);
    this.#providers.set(id, provider);
    return this;
  }

  manifests() {
    return [...this.#providers.values()].map((provider) => provider.manifest);
  }

  async resolve(input: {
    context: Omit<CapabilityRunContext, 'configuration'> & { configuration?: CapabilityConfiguration };
    configurations?: Readonly<Record<string, CapabilityConfiguration>>;
    enabledCapabilityIds?: ReadonlySet<string>;
    allowedToolNames?: ReadonlySet<string>;
    onDisposeError?: (error: AggregateError) => void;
  }): Promise<CapabilityRunSnapshot> {
    const runtimes: CapabilityRuntime[] = [];
    const manifests: CapabilityManifest[] = [];
    const skills: CapabilitySkill[] = [];
    const skillOwners = new Map<string, string>();
    const tools: Record<string, ResolvedCapabilityTool> = {};
    const activeInvocations = new Set<Promise<unknown>>();
    const lifetime = new AbortController();
    const abortSignal = input.context.abortSignal ? AbortSignal.any([input.context.abortSignal, lifetime.signal]) : lifetime.signal;
    const dispose = disposeOnce(async () => {
      lifetime.abort(new Error('Capability run disposed.'));
      await Promise.allSettled([...activeInvocations]);
      const errors: unknown[] = [];
      // Providers may depend on resources mounted before them.
      for (const runtime of [...runtimes].reverse()) {
        try { await runtime.dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) {
        const error = new AggregateError(errors, 'Capability resource cleanup failed.');
        if (input.onDisposeError) input.onDisposeError(error);
        else throw error;
      }
    });
    try {
      for (const provider of this.#providers.values()) {
        const manifest = provider.manifest;
        if (input.enabledCapabilityIds && !input.enabledCapabilityIds.has(manifest.id)) continue;
        const runtime = await provider.createRuntime({
          ...input.context,
          abortSignal,
          configuration: input.configurations?.[manifest.id] || input.context.configuration || {},
        });
        runtimes.push(runtime);
        manifests.push(manifest);
        for (const skill of manifest.skills || []) {
          const owner = skillOwners.get(skill.id);
          if (owner) throw new Error(`Capability Skill id collision for ${skill.id}: ${owner} and ${manifest.id}.`);
          skillOwners.set(skill.id, manifest.id);
          skills.push(skill);
        }
        for (const [registeredName, tool] of Object.entries(runtime.tools)) {
          const publicName = String(tool.name || registeredName).trim();
          if (!publicName || (input.allowedToolNames && !input.allowedToolNames.has(publicName))) continue;
          const existing = tools[publicName];
          if (existing) {
            throw new Error(`Capability tool name collision for ${publicName}: ${existing.capabilityId} and ${manifest.id}.`);
          }
          tools[publicName] = Object.freeze({
            capabilityId: manifest.id,
            capabilityVersion: manifest.version,
            internalId: `${manifest.id}:${registeredName}`,
            publicName,
            tool: Object.freeze({
              ...tool,
              execute(value: unknown, context: CapabilityExecutionContext) {
                const signal = context.abortSignal ? AbortSignal.any([abortSignal, context.abortSignal]) : abortSignal;
                const invocation = Promise.resolve().then(() => {
                  signal.throwIfAborted();
                  return tool.execute(value, { ...context, abortSignal: signal });
                });
                activeInvocations.add(invocation);
                void invocation.then(() => activeInvocations.delete(invocation), () => activeInvocations.delete(invocation));
                return invocation;
              },
            }),
          });
        }
      }
      return Object.freeze({
        abortSignal,
        manifests: Object.freeze(manifests),
        skills: Object.freeze(skills),
        tools: Object.freeze(tools),
        dispose,
      });
    } catch (error) {
      try { await dispose(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Capability mounting and cleanup failed.', { cause: error });
      }
      throw error;
    }
  }
}

export function defineCapabilityInput<TInput>(
  jsonSchema: JsonSchema,
  parse: (value: unknown) => TInput,
): CapabilityInputSchema<TInput> {
  return Object.freeze({ jsonSchema: Object.freeze({ ...jsonSchema }), parse });
}

export function defineCapabilityTool<TInput, TData>(
  definition: CapabilityTool<TInput, TData>,
): CapabilityTool<TInput, TData> {
  return Object.freeze(definition);
}

export type JsonRecord = Record<string, unknown>;

export function jsonRecordFromUnknown(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

export function jsonValueFromString(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function unwrapToolTransport(value: unknown) {
  let current = jsonValueFromString(value);
  for (let depth = 0; depth < 3; depth += 1) {
    const record = jsonRecordFromUnknown(current);
    if (!record) return current;
    const wrapped = ['arguments', 'input', 'params']
      .map((key) => jsonValueFromString(record[key]))
      .find((candidate) => Boolean(jsonRecordFromUnknown(candidate)));
    const wrappedRecord = jsonRecordFromUnknown(wrapped);
    if (!wrappedRecord) return record;
    current = { ...record, ...wrappedRecord };
    delete (current as JsonRecord).arguments;
    delete (current as JsonRecord).input;
    delete (current as JsonRecord).params;
  }
  return current;
}

export function arrayFromJsonString(value: unknown) {
  if (typeof value !== 'string' || !value.trim().startsWith('[')) return value;
  const parsed = jsonValueFromString(value);
  return Array.isArray(parsed) ? parsed : value;
}

export function normalizeBoundedNumberSetting(input: {
  value: string;
  defaultValue: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  if (!input.value.trim()) return input.defaultValue;
  const numeric = Number(input.value);
  if (!Number.isFinite(numeric)) return input.defaultValue;
  const minimum = input.min ?? Number.NEGATIVE_INFINITY;
  const maximum = input.max ?? Number.POSITIVE_INFINITY;
  let normalized = Math.min(maximum, Math.max(minimum, numeric));
  if (input.step && Number.isFinite(input.step) && input.step > 0) {
    const base = input.min ?? 0;
    normalized = base + Math.round((normalized - base) / input.step) * input.step;
    normalized = Math.min(maximum, Math.max(minimum, normalized));
  }
  return String(normalized);
}

export function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return Number(normalizeBoundedNumberSetting({
    value: typeof value === 'string' ? value : String(value ?? ''),
    defaultValue: String(fallback),
    min: minimum,
    max: maximum,
    step: 1,
  }));
}

export function raceWithAbort<T>(
  operation: PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  const abortError = () => signal.reason instanceof Error
    ? signal.reason
    : new Error('Operation aborted.');
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
