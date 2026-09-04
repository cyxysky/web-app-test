# @webpilot/capability-data

Structured data discovery and bounded querying for agents. Sources are injected and default to read-only. The optional TypeORM adapter works with any initialized TypeORM DataSource, including SQLite and PostgreSQL. The WebPilot host manages concrete database connections through its structured data-source settings and encrypted credential vault instead of exposing serialized connection definitions to users.

## TypeScript Agent framework integration

```ts
import {
  createTypeOrmAgentDataSource,
  createTypeOrmDataCapability,
} from '@webpilot/capability-data/typeorm';

const provider = createTypeOrmDataCapability({
  sources: [createTypeOrmAgentDataSource({
    id: 'application',
    source: initializedTypeOrmDataSource,
    readOnly: true,
  })],
});
```

Register this provider with `mountCapabilities()` and expose the resolved
`data` tool through the consuming TypeScript Agent framework. The supplied
TypeORM `DataSource` must already be initialized and remains owned by the host.
Inject the package Skill before schema discovery or queries. See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).
