export type JsonSchema = Readonly<Record<string, unknown>>;

export type CapabilityInputSchema<TInput> = {
  jsonSchema: JsonSchema;
  parse(value: unknown): TInput;
};

export type CapabilityContent =
  | { type: 'text'; text: string }
  | { type: 'image'; artifactId: string; mediaType?: string }
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
  runtimeInstructionId?: string;
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

export type CapabilityInstruction = {
  id: string;
  title: string;
  content: string;
  required?: boolean;
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
};

export type CapabilityRunContext = {
  runId: string;
  sessionId?: string;
  userId?: string;
  abortSignal?: AbortSignal;
  metadata?: Readonly<Record<string, unknown>>;
};

export interface CapabilityRuntime<TTools extends CapabilityToolSet = CapabilityToolSet> {
  tools: TTools;
  instructions?: readonly CapabilityInstruction[];
  health(): Promise<CapabilityHealth>;
  dispose(): Promise<void>;
}

export interface CapabilityProvider<TTools extends CapabilityToolSet = CapabilityToolSet> {
  manifest: CapabilityManifest;
  createRuntime(context: CapabilityRunContext): Promise<CapabilityRuntime<TTools>>;
}

export type ResolvedCapabilityTool = {
  capabilityId: string;
  capabilityVersion: string;
  internalId: string;
  publicName: string;
  tool: CapabilityTool<unknown, unknown>;
};

export type CapabilityRunSnapshot = {
  manifests: readonly CapabilityManifest[];
  instructions: readonly CapabilityInstruction[];
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
    context: CapabilityRunContext;
    enabledCapabilityIds?: ReadonlySet<string>;
    allowedToolNames?: ReadonlySet<string>;
  }): Promise<CapabilityRunSnapshot> {
    const runtimes: CapabilityRuntime[] = [];
    const manifests: CapabilityManifest[] = [];
    const instructions: CapabilityInstruction[] = [];
    const tools: Record<string, ResolvedCapabilityTool> = {};
    try {
      for (const provider of this.#providers.values()) {
        const manifest = provider.manifest;
        if (input.enabledCapabilityIds && !input.enabledCapabilityIds.has(manifest.id)) continue;
        const runtime = await provider.createRuntime(input.context);
        runtimes.push(runtime);
        manifests.push(manifest);
        instructions.push(...(runtime.instructions || []));
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
            tool,
          });
        }
      }
      return Object.freeze({
        manifests: Object.freeze(manifests),
        instructions: Object.freeze(instructions),
        tools: Object.freeze(tools),
        dispose: async () => {
          await Promise.allSettled([...runtimes].reverse().map((runtime) => runtime.dispose()));
        },
      });
    } catch (error) {
      await Promise.allSettled([...runtimes].reverse().map((runtime) => runtime.dispose()));
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
