import { createHash } from 'node:crypto';
import { createCapabilityDocumentDatabase } from '@webpilot/capability-sdk/node';
import { createKnowledgeCapability, type KnowledgeDocument, type KnowledgeSearchHit, type KnowledgeStore } from './index.js';
import type { CapabilityRunContext } from '@webpilot/capability-sdk';

function tokens(value: string) {
  const words = value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  return [...new Set(words.flatMap((word) => {
    if (!/\p{Script=Han}/u.test(word)) return word.length > 1 ? [word] : [];
    const characters = [...word];
    return characters.length === 1 ? characters : characters.slice(1).map((character, i) => characters[i] + character);
  }))];
}

export function createFileKnowledgeStore(input: { directory: string }): KnowledgeStore {
  const store = createCapabilityDocumentDatabase<KnowledgeDocument>({
    directory: input.directory, filename: 'knowledge.db', legacyFilename: 'knowledge.json',
    readLegacy(value) {
      const file = value as { version?: number; documents?: KnowledgeDocument[] };
      if (file.version !== 1 || !Array.isArray(file.documents)) throw new Error('Invalid legacy knowledge store.');
      return file.documents;
    },
  });
  let initialized = false;
  function database() {
    const db = store.database();
    if (!initialized) {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(
        document_id UNINDEXED, chunk_index UNINDEXED, chunk_chars UNINDEXED, text UNINDEXED, terms);
        CREATE TABLE IF NOT EXISTS knowledge_sizes (size INTEGER PRIMARY KEY);`);
      initialized = true;
    }
    return db;
  }
  function indexDocument(document: KnowledgeDocument, size: number) {
    const insert = database().prepare('INSERT INTO knowledge_chunks VALUES (?, ?, ?, ?, ?)');
    const stride = Math.max(1, size - Math.min(120, Math.floor(size / 10)));
    for (let start = 0, index = 0; start < document.content.length; start += stride, index++) {
      const text = document.content.slice(start, start + size);
      insert.run(document.id, index, size, text, tokens(document.title + ' ' + text).join(' '));
      if (start + size >= document.content.length) break;
    }
  }
  return {
    async put(candidate) {
      database();
      return store.transaction((db) => {
        const id = candidate.id?.trim() || 'knowledge_' + createHash('sha256').update((candidate.source || '') + '\0' + candidate.title).digest('hex').slice(0, 20);
        const previous = store.get(id);
        const now = new Date().toISOString();
        const document: KnowledgeDocument = { ...candidate, id, createdAt: previous?.createdAt || now, updatedAt: now };
        store.save(document);
        db.prepare('DELETE FROM knowledge_chunks WHERE document_id=?').run(id);
        for (const row of db.prepare('SELECT size FROM knowledge_sizes').all()) indexDocument(document, Number(row.size));
        return document;
      });
    },
    async get(id) { return store.get(id); },
    async list(limit, offset) {
      return store.database().prepare('SELECT record_json FROM records ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?')
        .all(Math.max(1, Math.min(100, limit)), Math.max(0, offset)).map((row) => JSON.parse(String(row.record_json)) as KnowledgeDocument);
    },
    async search(query, limit, chunkChars) {
      const words = tokens(query).slice(0, 100);
      if (!words.length) return [];
      const size = Math.max(400, Math.min(8000, Math.floor(chunkChars)));
      const db = database();
      return store.transaction(() => {
        if (!db.prepare('SELECT 1 FROM knowledge_sizes WHERE size=?').get(size)) {
          // Keep the persistent index bounded when hosts change chunk settings repeatedly.
          db.exec('DELETE FROM knowledge_chunks; DELETE FROM knowledge_sizes;');
          for (const row of db.prepare('SELECT record_json FROM records').iterate()) indexDocument(JSON.parse(String(row.record_json)) as KnowledgeDocument, size);
          db.prepare('INSERT INTO knowledge_sizes VALUES (?)').run(size);
        }
        const expression = words.map((word) => '"' + word.replace(/"/g, '""') + '"').join(' OR ');
        const rows = db.prepare(`SELECT c.document_id, c.chunk_index, c.text,
          json_extract(r.record_json, '$.title') AS title, json_extract(r.record_json, '$.source') AS source,
          json_extract(r.record_json, '$.metadata') AS metadata, bm25(knowledge_chunks) AS rank
          FROM knowledge_chunks c JOIN records r ON r.id=c.document_id
          WHERE knowledge_chunks MATCH ? AND c.chunk_chars=?
          ORDER BY rank, c.document_id, c.chunk_index LIMIT ?`).all(expression, size, Math.max(1, Math.min(100, limit)));
        return rows.map((row): KnowledgeSearchHit => {
          return { documentId: String(row.document_id), title: String(row.title), source: row.source == null ? undefined : String(row.source),
            metadata: row.metadata == null ? undefined : JSON.parse(String(row.metadata)),
            chunkIndex: Number(row.chunk_index), text: String(row.text), score: 1 / (1 + Math.exp(Number(row.rank))) };
        });
      });
    },
    async delete(id) {
      database();
      return store.transaction((db) => {
        db.prepare('DELETE FROM knowledge_chunks WHERE document_id=?').run(id);
        return Number(db.prepare('DELETE FROM records WHERE id=?').run(id).changes) > 0;
      });
    },
    async health() {
      try { database(); return { status: 'healthy' }; }
      catch (error) { return { status: 'unhealthy', message: error instanceof Error ? error.message : String(error) }; }
    },
    dispose: store.dispose,
  };
}
export function createNodeKnowledgeCapability(input: { directory: string | ((context: CapabilityRunContext) => string) }) {
  return createKnowledgeCapability({ createStore(context) {
    return createFileKnowledgeStore({ directory: typeof input.directory === 'function' ? input.directory(context) : input.directory });
  } });
}
