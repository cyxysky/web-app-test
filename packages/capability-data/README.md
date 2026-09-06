# @webpilot/capability-data

Structured data discovery and bounded querying for agents. Sources are injected and default to read-only. The optional TypeORM adapter supports PostgreSQL and file-backed SQLite. SELECT/CTE queries receive a database-side row limit. PostgreSQL uses read-only transactions, statement timeouts and cancellation; SQLite runs in a cancellable worker process with a read-only connection. The default timeout is 15 seconds (`timeoutMs` overrides it). In-memory SQLite and other TypeORM engines require a driver-specific `AgentDataSource` implementation.

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
