# @webpilot/capability-data

Structured data discovery and bounded querying for agents. Sources are injected and default to read-only. The optional TypeORM adapter works with any initialized TypeORM DataSource, including SQLite and PostgreSQL.

The WebPilot host accepts `AGENT_DATA_SOURCES_JSON`. SQLite sources use a host path and PostgreSQL sources reference an environment variable instead of embedding credentials:

```json
[
  { "id": "analytics", "kind": "sqlite", "database": "./data/analytics.db", "readOnly": true },
  { "id": "warehouse", "kind": "postgres", "urlEnv": "WAREHOUSE_DATABASE_URL", "readOnly": true }
]
```
