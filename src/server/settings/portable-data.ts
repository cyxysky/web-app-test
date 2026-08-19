import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scrypt,
} from 'node:crypto';
import { z } from 'zod';
import { modelProviderDefinitions, modelProviderValues } from '@/config/settings';
import {
  exportLoginAccountCredentials,
  importLoginAccountsQueued,
} from '@/server/credentials/login-account-vault';
import {
  listPersonalMemoryItems,
  savePersonalMemoryItems,
} from '@/server/ai/personal-memory';
import { store } from '@/server/db/store';
import type { ModelProvider, ModelProviderSettings } from '@/server/ai/schemas/runtime.schema';
import { normalizeApplicationUserId } from '@/server/auth/user-context';

export type PortableDataKind = 'credentials' | 'skills' | 'memory' | 'model';
type SecretDataKind = 'credentials' | 'model';

const portableFormat = 'webpilot-data-transfer';
const portableVersion = 2;

const credentialItemSchema = z.object({
  domain: z.string().trim().min(1).max(1_000),
  username: z.string().trim().min(1).max(500),
  password: z.string().min(1).max(4_000),
  label: z.string().trim().max(500),
  loginUrl: z.string().trim().max(4_000),
  status: z.enum(['active', 'disabled']),
  shared: z.boolean(),
}).strict();

const skillItemSchema = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(4_000),
  triggerPhrases: z.array(z.string().trim().max(500)).max(100),
  content: z.object({
    details: z.string().max(30_000),
  }).strict(),
  status: z.enum(['draft', 'ready', 'disabled']),
  shared: z.boolean(),
}).strict();

const memoryItemSchema = z.object({
  scope: z.enum(['global', 'domain']),
  domain: z.string().trim().max(1_000),
  type: z.enum(['alias', 'preference', 'workflow', 'domain_fact']),
  key: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().max(80)).max(20),
  value: z.string().trim().min(1).max(260),
  confidence: z.number().min(0).max(1),
  sourceUrl: z.string().trim().max(2_000).optional(),
  status: z.enum(['active', 'disabled']),
  shared: z.boolean(),
}).strict();

const modelProviderSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  defaultModel: z.string().trim().max(1_000).optional(),
  model: z.string().trim().min(1).max(1_000),
  models: z.array(z.string().trim().min(1).max(1_000)).max(500).optional(),
  apiKey: z.string().max(10_000).optional(),
  baseURL: z.string().trim().max(4_000).optional(),
}).strict();

const rawModelConfigSchema = z.object({
  provider: z.string(),
  providers: z.record(z.string(), modelProviderSettingsSchema),
}).strict();

const plainBundleSchema = z.object({
  format: z.literal(portableFormat),
  version: z.literal(portableVersion),
  kind: z.enum(['skills', 'memory']),
  exportedAt: z.string(),
  items: z.array(z.unknown()).max(5_000),
}).strict();

const encryptedBundleSchema = z.object({
  format: z.literal(portableFormat),
  version: z.literal(portableVersion),
  kind: z.enum(['credentials', 'model']),
  exportedAt: z.string(),
  encryption: z.object({
    algorithm: z.literal('aes-256-gcm'),
    kdf: z.literal('scrypt'),
    salt: z.string(),
    iv: z.string(),
    tag: z.string(),
  }).strict(),
  ciphertext: z.string().max(28_000_000),
}).strict();

type CredentialItem = z.infer<typeof credentialItemSchema>;
type SkillItem = z.infer<typeof skillItemSchema>;
type MemoryItem = z.infer<typeof memoryItemSchema>;

export type PortableDataExport = {
  fileName: string;
  bundle: Record<string, unknown>;
  count: number;
};

export type PortableDataImportResult = {
  kind: PortableDataKind;
  created: number;
  updated: number;
  total: number;
};

function requirePassphrase(value: unknown) {
  const passphrase = typeof value === 'string' ? value : '';
  if (passphrase.trim().length < 8) throw new Error('导出密码至少需要 8 个字符');
  if (passphrase.length > 1_024) throw new Error('导出密码过长');
  return passphrase;
}

function decodeBase64(value: string, expectedLength: number) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('加密文件格式无效');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedLength) throw new Error('加密文件格式无效');
  return decoded;
}

async function secretKey(passphrase: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(passphrase, salt, 32, {
      N: 16_384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function secretAad(kind: SecretDataKind) {
  return `${portableFormat}:${kind}:${portableVersion}`;
}

async function encryptSecretPayload(kind: SecretDataKind, payload: unknown, passphraseValue: unknown, exportedAt: string) {
  const passphrase = requirePassphrase(passphraseValue);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await secretKey(passphrase, salt), iv);
  cipher.setAAD(Buffer.from(secretAad(kind), 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return {
    format: portableFormat,
    version: portableVersion,
    kind,
    exportedAt,
    encryption: {
      algorithm: 'aes-256-gcm' as const,
      kdf: 'scrypt' as const,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    },
    ciphertext: ciphertext.toString('base64'),
  };
}

async function decryptSecretPayload(bundleValue: unknown, kind: SecretDataKind, passphraseValue: unknown) {
  const bundle = encryptedBundleSchema.parse(bundleValue);
  if (bundle.kind !== kind) throw new Error('导入文件类型与当前设置项不一致');
  const passphrase = requirePassphrase(passphraseValue);
  try {
    const salt = decodeBase64(bundle.encryption.salt, 16);
    const iv = decodeBase64(bundle.encryption.iv, 12);
    const tag = decodeBase64(bundle.encryption.tag, 16);
    const decipher = createDecipheriv('aes-256-gcm', await secretKey(passphrase, salt), iv);
    decipher.setAAD(Buffer.from(secretAad(kind), 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(bundle.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error('导入密码错误或加密文件已损坏');
  }
}

function parseModelConfig(value: unknown): Pick<ReturnType<typeof store.saveModelConfig>, 'provider' | 'providers'> {
  const parsed = rawModelConfigSchema.parse(value);
  if (!modelProviderValues.includes(parsed.provider as ModelProvider)) throw new Error('模型服务商无效');
  const providers: Partial<Record<ModelProvider, ModelProviderSettings>> = {};
  for (const [providerValue, settings] of Object.entries(parsed.providers)) {
    if (!modelProviderValues.includes(providerValue as ModelProvider)) throw new Error(`未知模型服务商：${providerValue}`);
    providers[providerValue as ModelProvider] = settings;
  }
  return { provider: parsed.provider as ModelProvider, providers };
}

function fileTimestamp(value: string) {
  return value.replace(/[:.]/g, '-');
}

function skillIdentity(item: Pick<SkillItem, 'title'>) {
  return item.title.trim().toLowerCase();
}

export async function exportPortableData(input: {
  kind: PortableDataKind;
  userId?: unknown;
  passphrase?: unknown;
}): Promise<PortableDataExport> {
  const exportedAt = new Date().toISOString();
  const suffix = fileTimestamp(exportedAt);
  if (input.kind === 'credentials') {
    const items = z.array(credentialItemSchema).parse(exportLoginAccountCredentials(input.userId));
    return {
      fileName: `webpilot-credentials-${suffix}.json`,
      bundle: await encryptSecretPayload('credentials', { items }, input.passphrase, exportedAt),
      count: items.length,
    };
  }
  if (input.kind === 'model') {
    const saved = store.getModelConfig();
    if (!saved) throw new Error('请先保存模型配置再导出');
    const providers = Object.fromEntries(modelProviderDefinitions.map((definition) => {
      const current = saved.providers[definition.value];
      if (!current) return [definition.value, undefined];
      return [definition.value, {
        enabled: current.enabled === true,
        defaultModel: current.defaultModel,
        model: current.model,
        models: current.models,
        apiKey: current.apiKey,
        baseURL: current.baseURL,
      }];
    }).filter((entry) => entry[1] !== undefined));
    const config = parseModelConfig({ provider: saved.provider, providers });
    return {
      fileName: `webpilot-model-config-${suffix}.json`,
      bundle: await encryptSecretPayload('model', { config }, input.passphrase, exportedAt),
      count: Object.keys(config.providers).length,
    };
  }
  if (input.kind === 'skills') {
    const ownerUserId = normalizeApplicationUserId(input.userId);
    const items = z.array(skillItemSchema).parse(store.listSkills(undefined, ownerUserId)
      .filter((skill) => skill.userId === ownerUserId)
      .map((skill) => ({
        id: skill.id,
        title: skill.title,
        description: skill.description,
        triggerPhrases: skill.triggerPhrases,
        content: skill.content,
        status: skill.status,
        shared: skill.shared,
      })));
    return {
      fileName: `webpilot-skills-${suffix}.json`,
      bundle: { format: portableFormat, version: portableVersion, kind: input.kind, exportedAt, items },
      count: items.length,
    };
  }
  const ownerUserId = normalizeApplicationUserId(input.userId);
  const items = z.array(memoryItemSchema).parse(listPersonalMemoryItems({
    userId: ownerUserId,
    includeDisabled: true,
  }).filter((item) => item.userId === ownerUserId).map((item) => ({
    scope: item.scope,
    domain: item.domain,
    type: item.type,
    key: item.key,
    aliases: item.aliases,
    value: item.value,
    confidence: item.confidence,
    sourceUrl: item.sourceUrl,
    status: item.status,
    shared: item.shared,
  })));
  return {
    fileName: `webpilot-memory-${suffix}.json`,
    bundle: { format: portableFormat, version: portableVersion, kind: input.kind, exportedAt, items },
    count: items.length,
  };
}

function importCredentials(items: CredentialItem[], userId: unknown) {
  return importLoginAccountsQueued(items.map((item) => ({ ...item, userId })), userId);
}

async function importSkills(items: SkillItem[], userId: unknown) {
  const normalizedUserId = normalizeApplicationUserId(userId);
  const existingSkills = store.listSkills(undefined, normalizedUserId)
    .filter((skill) => skill.userId === normalizedUserId);
  const byId = new Map(existingSkills.map((skill) => [skill.id, skill]));
  const targetIdByIdentity = new Map(existingSkills.map((skill) => [skillIdentity(skill), skill.id]));
  const batch: Parameters<typeof store.upsertSkillsBatch>[0] = [];
  let created = 0;
  let updated = 0;
  for (const item of items) {
    const identity = skillIdentity(item);
    const targetId = byId.get(item.id)?.id || targetIdByIdentity.get(identity);
    const id = targetId || `skl_${randomUUID()}`;
    batch.push({
      id,
      title: item.title,
      description: item.description,
      triggerPhrases: item.triggerPhrases,
      content: item.content,
      status: item.status,
      shared: item.shared,
      userId: normalizedUserId,
    });
    if (targetId) updated += 1;
    else created += 1;
    targetIdByIdentity.set(identity, id);
  }
  await store.upsertSkillsBatch(batch, { queued: true });
  return { created, updated };
}

async function importMemory(items: MemoryItem[], userId: unknown) {
  const normalizedUserId = normalizeApplicationUserId(userId);
  const result = await savePersonalMemoryItems(items, normalizedUserId, { queued: true });
  return { created: result.created, updated: result.updated };
}

export async function importPortableData(input: {
  kind: PortableDataKind;
  userId?: unknown;
  passphrase?: unknown;
  bundle: unknown;
}): Promise<PortableDataImportResult> {
  let counts: { created: number; updated: number };
  if (input.kind === 'credentials') {
    const payload = z.object({ items: z.array(credentialItemSchema).max(5_000) }).strict()
      .parse(await decryptSecretPayload(input.bundle, 'credentials', input.passphrase));
    counts = await importCredentials(payload.items, input.userId);
  } else if (input.kind === 'model') {
    const payload = z.object({ config: z.unknown() }).strict()
      .parse(await decryptSecretPayload(input.bundle, 'model', input.passphrase));
    const existing = Boolean(store.getModelConfig());
    const config = parseModelConfig(payload.config);
    store.saveModelConfig(config);
    counts = existing ? { created: 0, updated: 1 } : { created: 1, updated: 0 };
  } else {
    const bundle = plainBundleSchema.parse(input.bundle);
    if (bundle.kind !== input.kind) throw new Error('导入文件类型与当前设置项不一致');
    if (input.kind === 'skills') {
      counts = await importSkills(z.array(skillItemSchema).parse(bundle.items), input.userId);
    } else {
      counts = await importMemory(z.array(memoryItemSchema).parse(bundle.items), input.userId);
    }
  }
  return {
    kind: input.kind,
    ...counts,
    total: counts.created + counts.updated,
  };
}
