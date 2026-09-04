import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  decryptCredentialSecret,
  encryptCredentialSecret,
} from '@/server/credentials/credential-master-key';
import { readRuntimeMeta, writeRuntimeMeta } from '@/server/storage/database-record-store';

export type ExternalIntegrationCategory = 'connector' | 'communication' | 'data' | 'research';
export type ExternalIntegrationConfiguration = Record<string, string>;

export type ResolvedExternalIntegration = {
  id: string;
  category: ExternalIntegrationCategory;
  driverId: string;
  name: string;
  configuration: ExternalIntegrationConfiguration;
  enabled: boolean;
  updatedAt: string;
};

type StoredExternalIntegration = {
  id: string;
  category: ExternalIntegrationCategory;
  driverId: string;
  name: string;
  configurationEnvelope: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

const externalIntegrationStoreKey = 'external-integrations.v2';
const storedIntegrationSchema = z.object({
  id: z.string().uuid(),
  category: z.enum(['connector', 'communication', 'data', 'research']),
  driverId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,99}$/),
  name: z.string().min(1).max(200),
  configurationEnvelope: z.string().min(1),
  enabled: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();
const storeSchema = z.object({
  version: z.literal(2),
  items: z.array(storedIntegrationSchema).max(200),
}).strict();

let mutationQueue = Promise.resolve();

function integrationAad(record: Pick<StoredExternalIntegration, 'id' | 'category' | 'driverId'>) {
  return Buffer.from(`webpilot-external-integration\0${record.category}\0${record.driverId}\0${record.id}\0configuration`, 'utf8');
}

function normalizedConfiguration(value: ExternalIntegrationConfiguration) {
  const entries = Object.entries(value);
  if (entries.length > 50) throw new Error('外部集成配置字段过多。');
  const result: ExternalIntegrationConfiguration = {};
  for (const [key, rawValue] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(key)) throw new Error(`无效的外部集成配置字段：${key}`);
    if (typeof rawValue !== 'string') throw new Error(`外部集成配置字段 ${key} 必须是文本。`);
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    if (trimmed.length > 20_000) throw new Error(`外部集成配置字段 ${key} 过长。`);
    result[key] = trimmed;
  }
  if (JSON.stringify(result).length > 128 * 1024) throw new Error('外部集成配置过大。');
  return result;
}

function encryptConfiguration(configuration: ExternalIntegrationConfiguration, record: Pick<StoredExternalIntegration, 'id' | 'category' | 'driverId'>) {
  return encryptCredentialSecret(JSON.stringify(normalizedConfiguration(configuration)), integrationAad(record));
}

function decryptConfiguration(record: StoredExternalIntegration) {
  const serialized = decryptCredentialSecret({
    aad: integrationAad(record),
    envelope: record.configurationEnvelope,
    formatError: '外部集成配置密文格式无效',
    keyMismatchError: '外部集成配置无法使用当前主密钥解密',
    decryptionError: '外部集成配置解密失败',
  });
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return normalizedConfiguration(parsed as ExternalIntegrationConfiguration);
  } catch {
    throw new Error('外部集成配置内容损坏。');
  }
}

async function readStore() {
  const serialized = await readRuntimeMeta(externalIntegrationStoreKey);
  if (!serialized) return { version: 2 as const, items: [] as StoredExternalIntegration[] };
  try {
    return storeSchema.parse(JSON.parse(serialized));
  } catch {
    throw new Error('外部集成配置损坏，无法读取。');
  }
}

async function mutateStore<T>(operation: (items: StoredExternalIntegration[]) => Promise<T> | T) {
  const pending = mutationQueue.then(async () => {
    const store = await readStore();
    const result = await operation(store.items);
    await writeRuntimeMeta(externalIntegrationStoreKey, JSON.stringify({ version: 2, items: store.items }));
    return result;
  });
  mutationQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

function resolveStored(record: StoredExternalIntegration): ResolvedExternalIntegration {
  return {
    id: record.id,
    category: record.category,
    driverId: record.driverId,
    name: record.name,
    configuration: decryptConfiguration(record),
    enabled: record.enabled,
    updatedAt: record.updatedAt,
  };
}

export async function listExternalIntegrations(category?: ExternalIntegrationCategory) {
  const store = await readStore();
  return store.items
    .filter((item) => !category || item.category === category)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(resolveStored);
}

export async function resolveExternalIntegrations(category: ExternalIntegrationCategory) {
  const store = await readStore();
  return store.items
    .filter((item) => item.category === category && item.enabled)
    .map(resolveStored);
}

export async function resolveExternalIntegration(id: string) {
  const record = (await readStore()).items.find((item) => item.id === id);
  return record ? resolveStored(record) : undefined;
}

export async function upsertExternalIntegration(input: {
  id?: string;
  category: ExternalIntegrationCategory;
  driverId: string;
  name: string;
  configuration: ExternalIntegrationConfiguration;
  enabled: boolean;
}) {
  return mutateStore((items) => {
    const existingIndex = input.id ? items.findIndex((item) => item.id === input.id) : -1;
    const existing = existingIndex >= 0 ? items[existingIndex] : undefined;
    if (input.id && !existing) throw new Error('外部集成不存在。');
    if (existing && (existing.category !== input.category || existing.driverId !== input.driverId)) {
      throw new Error('外部集成的类别和驱动不能修改。');
    }
    const id = existing?.id || randomUUID();
    const timestamp = new Date().toISOString();
    const identity = { id, category: input.category, driverId: input.driverId };
    const record: StoredExternalIntegration = {
      ...identity,
      name: input.name.trim(),
      configurationEnvelope: encryptConfiguration(input.configuration, identity),
      enabled: input.enabled,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    if (existingIndex >= 0) items[existingIndex] = record;
    else items.push(record);
    return resolveStored(record);
  });
}

export async function deleteExternalIntegration(id: string) {
  return mutateStore((items) => {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    items.splice(index, 1);
    return true;
  });
}
