import type { DataSource, EntityMetadata } from 'typeorm';
import { createDataCapability, createDataSourceRegistry, isReadOnlyStatement, type AgentDataSource, type DataQueryResult, type DataTable } from './index.js';
import type { CapabilityExecutionContext, CapabilityRunContext } from '@webpilot/capability-sdk';
import { boundedReadStatement, sqlTokens } from './sql.js';
import { querySqliteFile } from './sqlite-query.js';
import { cancelPostgresQuery, type PostgresCancelableClient } from './postgres-cancel.js';

function tableFromMetadata(metadata: EntityMetadata): DataTable {
  return {
    name: metadata.tableName,
    columns: metadata.columns.map((column) => ({
      name: column.databaseName,
      type: typeof column.type === 'string' ? column.type : String(column.type),
      nullable: column.isNullable,
    })),
  };
}

function quoteSqliteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

async function introspectSchema(source: DataSource): Promise<DataTable[]> {
  if (!source.isInitialized) throw new Error('TypeORM DataSource is not initialized.');
  if ((source.options.type as string) === 'sqlite' || source.options.type === 'better-sqlite3') {
    const tables = await source.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as Array<{ name?: unknown }>;
    return Promise.all(tables.flatMap((row) => typeof row.name === 'string' ? [row.name] : []).map(async (name) => {
      const columns = await source.query(`PRAGMA table_info(${quoteSqliteIdentifier(name)})`) as Array<{ name?: unknown; type?: unknown; notnull?: unknown; pk?: unknown }>;
      return {
        name,
        columns: columns.flatMap((column) => typeof column.name === 'string' ? [{
          name: column.name,
          type: typeof column.type === 'string' ? column.type : undefined,
          nullable: Number(column.notnull) === 0 && Number(column.pk) === 0,
        }] : []),
      };
    }));
  }
  if (source.options.type === 'postgres') {
    const columns = await source.query(`
      SELECT table_schema, table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position
    `) as Array<Record<string, unknown>>;
    const tables = new Map<string, DataTable>();
    for (const column of columns) {
      if (typeof column.table_name !== 'string' || typeof column.column_name !== 'string') continue;
      const schema = typeof column.table_schema === 'string' ? column.table_schema : '';
      const name = schema && schema !== 'public' ? `${schema}.${column.table_name}` : column.table_name;
      const table = tables.get(name) || { name, columns: [] };
      table.columns.push({
        name: column.column_name,
        type: typeof column.data_type === 'string' ? column.data_type : undefined,
        nullable: column.is_nullable === 'YES',
      });
      tables.set(name, table);
    }
    return [...tables.values()];
  }
  return source.entityMetadatas.map(tableFromMetadata);
}
export function createTypeOrmAgentDataSource(input: { id: string; name?: string; source: DataSource; readOnly?: boolean; timeoutMs?: number }): AgentDataSource {
  return {
    id: input.id, name: input.name || input.id, dialect: input.source.options.type, readOnly: input.readOnly !== false,
    async schema() { return introspectSchema(input.source); },
    async query(statement, parameters, options, context: CapabilityExecutionContext): Promise<DataQueryResult> {
      if (!input.source.isInitialized) throw new Error('TypeORM DataSource is not initialized.');
      const readOnly = isReadOnlyStatement(statement);
      const allowWrite = options.allowWrite && input.readOnly === false;
      if (!readOnly && !allowWrite) throw new Error('Data source rejected a write statement.');
      if (!sqlTokens(statement).length) throw new Error('Exactly one valid SQL statement is required.');
      context.abortSignal?.throwIfAborted();
      const maxRows = Math.max(1, Math.min(10_000, Math.floor(options.maxRows) || 500));
      const timeoutMs = Math.max(100, Math.min(300_000, Math.floor(input.timeoutMs || 15_000)));
      const sql = readOnly ? boundedReadStatement(statement, maxRows) : statement;
      const startedAt = Date.now();
      let raw: unknown;
      const driver = input.source.options.type as string;
      if (driver === 'sqlite' || driver === 'better-sqlite3') {
        const database = String(input.source.options.database || '');
        if (!database || database === ':memory:' || database.startsWith('file:')) throw new Error('Bounded SQLite queries require a file-backed database.');
        raw = await querySqliteFile({ database, statement: sql, parameters, readOnly: !allowWrite, maxRows, timeoutMs, signal: context.abortSignal });
      } else if (driver === 'postgres') {
        const runner = input.source.createQueryRunner();
        let cancel: (() => void) | undefined;
        let cancelling: Promise<unknown> | undefined;
        try {
          const client = await runner.connect() as PostgresCancelableClient;
          await runner.startTransaction();
          if (!allowWrite) await runner.query('SET TRANSACTION READ ONLY');
          await runner.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
          cancel = () => { cancelling ||= cancelPostgresQuery(client); };
          context.abortSignal?.addEventListener('abort', cancel, { once: true });
          context.abortSignal?.throwIfAborted();
          raw = await runner.query(sql, parameters);
          context.abortSignal?.throwIfAborted();
          context.abortSignal?.removeEventListener('abort', cancel);
          await runner.commitTransaction();
        } catch (error) {
          if (cancel) context.abortSignal?.removeEventListener('abort', cancel);
          await cancelling;
          if (runner.isTransactionActive) await runner.rollbackTransaction();
          throw error;
        } finally {
          if (cancel) context.abortSignal?.removeEventListener('abort', cancel);
          // Do not return a connection to the pool while cancellation is still in flight.
          await cancelling;
          await runner.release();
        }
      } else throw new Error('Bounded TypeORM queries support PostgreSQL and file-backed SQLite. Supply a driver-specific AgentDataSource for other engines.');
      const rows = Array.isArray(raw) ? raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
      const bounded = rows.slice(0, maxRows);
      return { columns: [...new Set(bounded.flatMap((row) => Object.keys(row)))], rows: bounded, rowCount: bounded.length, truncated: rows.length > maxRows, elapsedMs: Date.now() - startedAt };
    },
    async health() { return input.source.isInitialized ? { status: 'healthy' } : { status: 'unhealthy', message: 'TypeORM DataSource is not initialized.' }; },
  };
}
export function createTypeOrmDataCapability(input: { sources: readonly AgentDataSource[] | ((context: CapabilityRunContext) => readonly AgentDataSource[]) }) { return createDataCapability({ createRegistry(context) { return createDataSourceRegistry(typeof input.sources === 'function' ? input.sources(context) : input.sources); } }); }
