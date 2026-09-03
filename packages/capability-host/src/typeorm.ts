import {
  EntitySchema,
  type DataSource,
  type EntityTarget,
  type Repository,
} from 'typeorm';
import type {
  CapabilityConfiguration,
  CapabilityManifest,
} from '@webpilot/capability-sdk';
import {
  capabilityConfigScopeKey,
  type CapabilityConfigScope,
  type CapabilityConfigStore,
} from './index.js';

export type TypeOrmCapabilityConfigurationRecord = {
  scopeKey: string;
  capabilityId: string;
  valuesJson: string;
  updatedAt: string;
};

export function createTypeOrmCapabilityConfigurationEntitySchema(
  tableName = 'capability_configuration',
) {
  return new EntitySchema<TypeOrmCapabilityConfigurationRecord>({
    name: 'WebPilotCapabilityConfiguration',
    tableName,
    columns: {
      scopeKey: { name: 'scope_key', type: String, length: 512, primary: true },
      capabilityId: { name: 'capability_id', type: String, length: 200, primary: true },
      valuesJson: { name: 'values_json', type: 'text' },
      updatedAt: { name: 'updated_at', type: String, length: 40 },
    },
  });
}

export const typeOrmCapabilityConfigurationEntity =
  createTypeOrmCapabilityConfigurationEntitySchema();

type RepositorySource =
  | Repository<TypeOrmCapabilityConfigurationRecord>
  | DataSource
  | (() => Repository<TypeOrmCapabilityConfigurationRecord> | DataSource | Promise<Repository<TypeOrmCapabilityConfigurationRecord> | DataSource>);

export type TypeOrmCapabilityConfigStoreOptions = {
  source: RepositorySource;
  entity?: EntityTarget<TypeOrmCapabilityConfigurationRecord>;
};

/**
 * SQLite and PostgreSQL use the same Repository API. Register the exported
 * EntitySchema in the host DataSource, or pass an already configured Repository.
 */
export class TypeOrmCapabilityConfigStore implements CapabilityConfigStore {
  readonly #source: RepositorySource;
  readonly #entity: EntityTarget<TypeOrmCapabilityConfigurationRecord>;

  constructor(options: TypeOrmCapabilityConfigStoreOptions) {
    this.#source = options.source;
    this.#entity = options.entity || typeOrmCapabilityConfigurationEntity;
  }

  async load(manifest: CapabilityManifest, scope?: CapabilityConfigScope) {
    const repository = await this.#repository();
    const record = await repository.findOneBy({
      scopeKey: capabilityConfigScopeKey(scope),
      capabilityId: manifest.id,
    });
    if (!record) return undefined;
    let values: CapabilityConfiguration;
    try {
      values = JSON.parse(record.valuesJson) as CapabilityConfiguration;
    } catch {
      throw new Error(`Stored configuration for ${manifest.id} is not valid JSON.`);
    }
    return Object.freeze({ ...values });
  }

  async save(
    manifest: CapabilityManifest,
    values: CapabilityConfiguration,
    scope?: CapabilityConfigScope,
  ) {
    const repository = await this.#repository();
    await repository.upsert({
      scopeKey: capabilityConfigScopeKey(scope),
      capabilityId: manifest.id,
      valuesJson: JSON.stringify(values),
      updatedAt: new Date().toISOString(),
    }, ['scopeKey', 'capabilityId']);
  }

  async delete(manifest: CapabilityManifest, scope?: CapabilityConfigScope) {
    const repository = await this.#repository();
    await repository.delete({
      scopeKey: capabilityConfigScopeKey(scope),
      capabilityId: manifest.id,
    });
  }

  async #repository() {
    const source = typeof this.#source === 'function'
      ? await this.#source()
      : this.#source;
    return 'getRepository' in source
      ? source.getRepository(this.#entity)
      : source;
  }
}
