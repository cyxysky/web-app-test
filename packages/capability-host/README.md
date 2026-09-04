# @webpilot/capability-host

Framework-neutral mounting for WebPilot Capability providers. It owns the
three pieces that every Agent host otherwise has to rebuild:

- load and normalize package-owned settings;
- resolve providers into one disposable tool snapshot;
- expose a portable Skill catalog for eager or lazy context injection.

`mountCapabilities()` is the primary entrypoint for custom TypeScript Agent
frameworks. It does not create an AI SDK or MCP object. Consumers translate the
returned `runtime.tools` to their framework's tool type and inject
`runtime.skillCatalog` into that framework's instructions or Skill mechanism.
See the [framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md) for the
complete mapping and execution lifecycle.

```ts
import {
  EnvironmentCapabilityConfigStore,
  mountCapabilities,
} from '@webpilot/capability-host';

const runtime = await mountCapabilities({
  providers,
  context: { runId: crypto.randomUUID() },
  configStore: new EnvironmentCapabilityConfigStore(process.env),
});

console.log(runtime.tools, runtime.skillCatalog.skills);
await runtime.dispose();
```

## Configuration storage

Capability packages export setting definitions in their manifests. The host
selects persistence and injects the resolved values when each runtime starts.

- `MemoryCapabilityConfigStore`: tests, short-lived workers and embedded hosts.
- `EnvironmentCapabilityConfigStore`: environment-driven servers.
- `JsonFileCapabilityConfigStore` from `@webpilot/capability-host/node`: CLI and
  single-process Node applications.
- `TypeOrmCapabilityConfigStore` from `@webpilot/capability-host/typeorm`:
  SQLite or PostgreSQL through the same TypeORM Repository API.

For TypeORM, add `typeOrmCapabilityConfigurationEntity` to the DataSource
`entities` list. Use `synchronize: true` during prototypes or create an ordinary
migration for the `capability_configuration` table in production.

```ts
import { DataSource } from 'typeorm';
import {
  TypeOrmCapabilityConfigStore,
  typeOrmCapabilityConfigurationEntity,
} from '@webpilot/capability-host/typeorm';

const dataSource = new DataSource(process.env.DATABASE_URL
  ? {
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [typeOrmCapabilityConfigurationEntity],
    }
  : {
      type: 'better-sqlite3',
      database: './agent.db',
      entities: [typeOrmCapabilityConfigurationEntity],
    });
await dataSource.initialize();

const configStore = new TypeOrmCapabilityConfigStore({ source: dataSource });
await configStore.save(fileCapabilityManifest, {
  OFFICE_GENERATION_MODE: 'auto',
}, { userId: 'agent-user' });
```

Secret fields are metadata on package settings. To keep them outside the main
store, combine any database/file store with a vault or keychain-backed store:

```ts
const configStore = createSplitCapabilityConfigStore({
  values: databaseStore,
  secrets: vaultStore,
});
```

Explicit `configurations[capabilityId]` passed to `mountCapabilities` override
stored values. Package defaults fill missing or invalid values during
normalization.
