import {
  CapabilityRegistry,
  normalizeBoundedNumberSetting,
  type CapabilityConfiguration,
  type CapabilityManifest,
  type CapabilityProvider,
  type CapabilityRunContext,
  type CapabilityRunSnapshot,
  type CapabilitySettingApplyMode,
  type CapabilitySkill,
} from '@webpilot/capability-sdk';

export type CapabilityConfigScope = Readonly<{
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  profile?: string;
}>;

export interface CapabilityConfigStore {
  load(
    manifest: CapabilityManifest,
    scope?: CapabilityConfigScope,
  ): Promise<CapabilityConfiguration | undefined>;
  save(
    manifest: CapabilityManifest,
    values: CapabilityConfiguration,
    scope?: CapabilityConfigScope,
  ): Promise<void>;
  delete(
    manifest: CapabilityManifest,
    scope?: CapabilityConfigScope,
  ): Promise<void>;
}

export type CapabilityConfigStoreOperations = {
  load: CapabilityConfigStore['load'];
  save: CapabilityConfigStore['save'];
  delete: CapabilityConfigStore['delete'];
};

export function createCapabilityConfigStore(
  operations: CapabilityConfigStoreOperations,
): CapabilityConfigStore {
  return Object.freeze({ ...operations });
}

const defaultScopeKey = 'global';

export function capabilityConfigScopeKey(scope?: CapabilityConfigScope) {
  if (!scope) return defaultScopeKey;
  const entries = Object.entries(scope)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : defaultScopeKey;
}

function normalizedSettingValue(
  definition: NonNullable<CapabilityManifest['configuration']>['settings'][number],
  rawValue: string | undefined,
) {
  let value = rawValue ?? definition.defaultValue;
  if (definition.emptyUsesDefault && !value.trim()) value = definition.defaultValue;
  value = definition.valueAliases?.[value] ?? value;

  if (definition.control === 'boolean') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === 'false'
      ? normalized
      : definition.defaultValue;
  }
  if (definition.control === 'select' && definition.options?.length) {
    return definition.options.some((option) => option.value === value)
      ? value
      : definition.defaultValue;
  }
  if (definition.control !== 'number') return value;
  return normalizeBoundedNumberSetting({
    value,
    defaultValue: definition.defaultValue,
    min: definition.min,
    max: definition.max,
    step: definition.step,
  });
}

export function normalizeCapabilityConfiguration(
  manifest: CapabilityManifest,
  values: CapabilityConfiguration = {},
): CapabilityConfiguration {
  const normalized: Record<string, string | undefined> = { ...values };
  for (const definition of manifest.configuration?.settings || []) {
    normalized[definition.key] = normalizedSettingValue(definition, values[definition.key]);
  }
  return Object.freeze(normalized);
}

export function capabilityConfigurationForApplyMode(
  manifest: CapabilityManifest,
  configuration: CapabilityConfiguration,
  applyMode: CapabilitySettingApplyMode,
): CapabilityConfiguration {
  const keys = new Set((manifest.configuration?.settings || [])
    .filter((definition) => definition.applyMode === applyMode)
    .map((definition) => definition.key));
  return Object.freeze(Object.fromEntries(
    Object.entries(configuration).filter(([key]) => keys.has(key)),
  ));
}

export function capabilityConfigurationFromEnvironment(
  manifest: CapabilityManifest,
  environment: Record<string, string | undefined>,
) {
  return normalizeCapabilityConfiguration(manifest, Object.fromEntries(
    (manifest.configuration?.settings || []).map((definition) => [definition.key, environment[definition.key]]),
  ));
}

export function capabilityConfigurationsFromEnvironment(
  manifests: readonly CapabilityManifest[],
  environment: Record<string, string | undefined>,
) {
  return Object.freeze(Object.fromEntries(manifests.map((manifest) => [
    manifest.id,
    capabilityConfigurationFromEnvironment(manifest, environment),
  ])));
}

export class MemoryCapabilityConfigStore implements CapabilityConfigStore {
  readonly #entries = new Map<string, CapabilityConfiguration>();

  constructor(initial: Readonly<Record<string, CapabilityConfiguration>> = {}) {
    for (const [capabilityId, value] of Object.entries(initial)) {
      this.#entries.set(`${defaultScopeKey}\u0000${capabilityId}`, Object.freeze({ ...value }));
    }
  }

  async load(manifest: CapabilityManifest, scope?: CapabilityConfigScope) {
    const value = this.#entries.get(this.#key(manifest, scope));
    return value ? Object.freeze({ ...value }) : undefined;
  }

  async save(
    manifest: CapabilityManifest,
    values: CapabilityConfiguration,
    scope?: CapabilityConfigScope,
  ) {
    this.#entries.set(
      this.#key(manifest, scope),
      Object.freeze({ ...values }),
    );
  }

  async delete(manifest: CapabilityManifest, scope?: CapabilityConfigScope) {
    this.#entries.delete(this.#key(manifest, scope));
  }

  #key(manifest: CapabilityManifest, scope?: CapabilityConfigScope) {
    return `${capabilityConfigScopeKey(scope)}\u0000${manifest.id}`;
  }
}

export class EnvironmentCapabilityConfigStore implements CapabilityConfigStore {
  constructor(private readonly environment: Record<string, string | undefined>) {}

  async load(manifest: CapabilityManifest) {
    return Object.freeze(Object.fromEntries(
      (manifest.configuration?.settings || [])
        .filter((definition) => this.environment[definition.key] !== undefined)
        .map((definition) => [definition.key, this.environment[definition.key]]),
    ));
  }

  async save(manifest: CapabilityManifest, values: CapabilityConfiguration) {
    for (const definition of manifest.configuration?.settings || []) {
      const value = values[definition.key];
      if (value === undefined) delete this.environment[definition.key];
      else this.environment[definition.key] = value;
    }
  }

  async delete(manifest: CapabilityManifest) {
    for (const definition of manifest.configuration?.settings || []) {
      delete this.environment[definition.key];
    }
  }
}

function subsetConfiguration(
  manifest: CapabilityManifest,
  values: CapabilityConfiguration,
  secret: boolean,
) {
  const definitions = new Map((manifest.configuration?.settings || [])
    .map((definition) => [definition.key, definition]));
  return Object.freeze(Object.fromEntries(Object.entries(values).filter(([key]) => {
    const definition = definitions.get(key);
    return definition
      ? Boolean(definition.secret || definition.control === 'secret') === secret
      : !secret;
  })));
}

function subsetManifest(manifest: CapabilityManifest, secret: boolean): CapabilityManifest {
  return Object.freeze({
    ...manifest,
    configuration: {
      settings: (manifest.configuration?.settings || []).filter((definition) => (
        Boolean(definition.secret || definition.control === 'secret') === secret
      )),
    },
  });
}

/**
 * Keeps secret settings in a host-selected vault/keychain store while normal
 * values remain in the ordinary configuration store.
 */
export function createSplitCapabilityConfigStore(input: {
  values: CapabilityConfigStore;
  secrets: CapabilityConfigStore;
}): CapabilityConfigStore {
  return createCapabilityConfigStore({
    async load(manifest, scope) {
      const valuesManifest = subsetManifest(manifest, false);
      const secretsManifest = subsetManifest(manifest, true);
      const [values, secrets] = await Promise.all([
        input.values.load(valuesManifest, scope),
        input.secrets.load(secretsManifest, scope),
      ]);
      return Object.freeze({ ...values, ...secrets });
    },
    async save(manifest, values, scope) {
      const valuesManifest = subsetManifest(manifest, false);
      const secretsManifest = subsetManifest(manifest, true);
      await Promise.all([
        input.values.save(valuesManifest, subsetConfiguration(manifest, values, false), scope),
        input.secrets.save(secretsManifest, subsetConfiguration(manifest, values, true), scope),
      ]);
    },
    async delete(manifest, scope) {
      await Promise.all([
        input.values.delete(subsetManifest(manifest, false), scope),
        input.secrets.delete(subsetManifest(manifest, true), scope),
      ]);
    },
  });
}

export type CapabilitySkillInstructionMode = 'disabled' | 'eager' | 'lazy';

export class CapabilitySkillCatalog {
  readonly skills: readonly CapabilitySkill[];
  readonly #byId: ReadonlyMap<string, CapabilitySkill>;

  constructor(skills: readonly CapabilitySkill[]) {
    this.skills = Object.freeze([...skills]);
    this.#byId = new Map(this.skills.map((skill) => [skill.id, skill]));
  }

  get(skillId: string) {
    return this.#byId.get(skillId);
  }

  instructions(
    mode: CapabilitySkillInstructionMode,
    options: { skillToolName?: string } = {},
  ) {
    if (mode === 'disabled' || !this.skills.length) return '';
    if (mode === 'eager') {
      return this.skills.map((skill) => `${skill.summary}\n${skill.content}`).join('\n\n');
    }
    const skillToolName = options.skillToolName || 'skill';
    return [
      ...this.skills.map((skill) => skill.summary),
      `Capability Skills use Agent-controlled lazy loading. Call ${skillToolName} with action=read and an exact skillId before using the related capability. Capability packages only publish Skill content; the Agent host owns preloading and execution gates.`,
    ].join('\n');
  }
}

export type MountCapabilitiesOptions = {
  providers: readonly CapabilityProvider[];
  context: Omit<CapabilityRunContext, 'configuration'> & { configuration?: CapabilityConfiguration };
  configStore?: CapabilityConfigStore;
  configScope?: CapabilityConfigScope;
  configurations?: Readonly<Record<string, CapabilityConfiguration>>;
  enabledCapabilityIds?: ReadonlySet<string>;
  allowedToolNames?: ReadonlySet<string>;
};

export type MountedCapabilities = CapabilityRunSnapshot & {
  configurations: Readonly<Record<string, CapabilityConfiguration>>;
  skillCatalog: CapabilitySkillCatalog;
};

export async function mountCapabilities(
  options: MountCapabilitiesOptions,
): Promise<MountedCapabilities> {
  const registry = new CapabilityRegistry();
  for (const provider of options.providers) registry.register(provider);
  const enabledManifests = registry.manifests().filter((manifest) => (
    !options.enabledCapabilityIds || options.enabledCapabilityIds.has(manifest.id)
  ));
  const entries = await Promise.all(enabledManifests.map(async (manifest) => {
    const stored = await options.configStore?.load(manifest, options.configScope);
    const values = {
      ...options.context.configuration,
      ...stored,
      ...options.configurations?.[manifest.id],
    };
    return [manifest.id, normalizeCapabilityConfiguration(manifest, values)] as const;
  }));
  const configurations = Object.freeze(Object.fromEntries(entries));
  const snapshot = await registry.resolve({
    context: options.context,
    configurations,
    enabledCapabilityIds: options.enabledCapabilityIds,
    allowedToolNames: options.allowedToolNames,
  });
  return Object.freeze({
    ...snapshot,
    configurations,
    skillCatalog: new CapabilitySkillCatalog(snapshot.skills),
  });
}
