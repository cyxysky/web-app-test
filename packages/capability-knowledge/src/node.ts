import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createKnowledgeCapability, type KnowledgeDocument, type KnowledgeSearchHit, type KnowledgeStore } from './index.js';
import type { CapabilityRunContext } from '@webpilot/capability-sdk';

type KnowledgeFile = { version: 1; documents: KnowledgeDocument[] };
function tokens(value: string) { return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])]; }
function chunks(value: string, size: number) { const output: string[] = []; for (let start = 0; start < value.length; start += size) output.push(value.slice(start, start + size)); return output; }
export function createFileKnowledgeStore(input: { directory: string }): KnowledgeStore {
  const directory = path.resolve(input.directory); const file = path.join(directory, 'knowledge.json'); let queue = Promise.resolve();
  const read = async (): Promise<KnowledgeFile> => { try { const value = JSON.parse(await readFile(file, 'utf8')) as KnowledgeFile; return value?.version === 1 && Array.isArray(value.documents) ? value : { version: 1, documents: [] }; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, documents: [] }; throw error; } };
  const save = async (value: KnowledgeFile) => { await mkdir(directory, { recursive: true }); const temporary = path.join(directory, `.knowledge-${randomUUID()}.tmp`); await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temporary, file); };
  const mutate = <T>(operation: () => Promise<T>) => { const pending = queue.then(operation, operation); queue = pending.then(() => undefined, () => undefined); return pending; };
  return {
    put(candidate) { return mutate(async () => { const state = await read(); const now = new Date().toISOString(); const id = candidate.id?.trim() || `knowledge_${createHash('sha256').update(`${candidate.source || ''}\0${candidate.title}`).digest('hex').slice(0, 20)}`; const existing = state.documents.find((item) => item.id === id); const document: KnowledgeDocument = { ...candidate, id, createdAt: existing?.createdAt || now, updatedAt: now }; state.documents = [...state.documents.filter((item) => item.id !== id), document]; await save(state); return document; }); },
    async get(id) { return (await read()).documents.find((item) => item.id === id); },
    async list(limit, offset) { return (await read()).documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(offset, offset + limit); },
    async search(query, limit, chunkChars) { const queryTokens = tokens(query); const state = await read(); const hits: KnowledgeSearchHit[] = []; for (const document of state.documents) for (const [chunkIndex, text] of chunks(document.content, chunkChars).entries()) { const haystack = text.toLocaleLowerCase(); const matched = queryTokens.filter((token) => haystack.includes(token)); if (!matched.length) continue; hits.push({ documentId: document.id, title: document.title, source: document.source, chunkIndex, text, score: matched.length / Math.max(1, queryTokens.length), metadata: document.metadata }); } return hits.sort((a, b) => b.score - a.score).slice(0, limit); },
    delete(id) { return mutate(async () => { const state = await read(); const next = state.documents.filter((item) => item.id !== id); if (next.length === state.documents.length) return false; state.documents = next; await save(state); return true; }); },
    async health() { try { await mkdir(directory, { recursive: true }); await read(); return { status: 'healthy' }; } catch (error) { return { status: 'unhealthy', message: error instanceof Error ? error.message : String(error) }; } },
  };
}
export function createNodeKnowledgeCapability(input: { directory: string | ((context: CapabilityRunContext) => string) }) { return createKnowledgeCapability({ createStore(context) { return createFileKnowledgeStore({ directory: typeof input.directory === 'function' ? input.directory(context) : input.directory }); } }); }
