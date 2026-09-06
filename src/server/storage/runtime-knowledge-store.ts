import { databaseDriver, parseDatabaseJson, queryDatabase } from '@/server/db/database';
import type { SkillRecord } from '@/server/ai/schemas/runtime.schema';

/** Small metadata reads detect committed changes, including other server processes. */
export async function readRuntimeKnowledgeRevisions(userId: string, domain: string) {
  const rows = await queryDatabase<{ scope: string; kind: string; revision: string | number }>(
    'SELECT scope, kind, revision FROM runtime_knowledge_revision WHERE scope IN (?, ?) ORDER BY scope, kind',
    [`user:${userId}`, 'shared'],
  );
  const revision = (kind: string) => JSON.stringify([domain, ...rows.filter((row) => row.kind === kind).map((row) => [row.scope, String(row.revision)])]);
  return { skills: revision('skills'), memories: revision('memories') };
}

/** Catalog reads never transfer Skill bodies from the database. */
export async function readRuntimeSkillCatalog(userId: string): Promise<SkillRecord[]> {
  const field = (key: string) => databaseDriver() === 'postgres'
    ? `(CAST(record_json AS jsonb)->>'${key}')` : `json_extract(record_json, '$.${key}')`;
  const rows = await queryDatabase<{
    id: string; user_id: string; shared: boolean | number; title: string; status: SkillRecord['status'];
    created_at: string; updated_at: string; description: string; triggers: string; version: string | number;
  }>(`SELECT id, user_id, shared, title, status, created_at, updated_at,
    ${field('description')} AS description, ${field('triggerPhrases')} AS triggers, ${field('version')} AS version
    FROM skill WHERE (user_id = ? OR shared = ?) AND status = 'ready' ORDER BY id`, [userId, true]);
  return rows.map((row) => ({
    id: row.id, userId: row.user_id, shared: Boolean(row.shared), title: row.title,
    status: row.status, description: row.description || '', triggerPhrases: parseDatabaseJson<string[]>(row.triggers, []),
    version: Number(row.version) || 1, createdAt: row.created_at, updatedAt: row.updated_at, content: { details: '' },
  }));
}
