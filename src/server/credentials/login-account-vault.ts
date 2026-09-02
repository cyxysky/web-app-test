import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { executeDatabase, queryDatabase, queryDatabaseOne, runDatabaseTransaction, type DatabaseExecutor } from '@/server/db/database';
import { appDataRoot } from '@/server/storage/paths';
import { queueDatabaseWrite, type DatabaseWriteStatement } from '@/server/storage/database-write-queue';

export type LoginAccountStatus = 'active' | 'disabled';

export type LoginAccountMetadata = {
  id: string;
  userId: string;
  shared: boolean;
  domain: string;
  username: string;
  label: string;
  loginUrl: string;
  status: LoginAccountStatus;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
};

export type LoginAccountCredential = {
  account: LoginAccountMetadata;
  password: string;
};

export type LoginAccountPortableRecord = {
  domain: string;
  username: string;
  password: string;
  label: string;
  loginUrl: string;
  status: LoginAccountStatus;
  shared: boolean;
};

export type CreateLoginAccountInput = {
  userId?: unknown;
  domain: string;
  username: string;
  password: string;
  label?: string;
  loginUrl?: string;
  status?: LoginAccountStatus;
  shared?: boolean;
};

export type UpdateLoginAccountInput = {
  domain?: string;
  username?: string;
  password?: string;
  label?: string;
  loginUrl?: string;
  status?: LoginAccountStatus;
  shared?: boolean;
};

type LoginAccountRow = {
  id: string;
  user_id: string;
  shared: boolean | number;
  domain: string;
  username: string;
  label: string;
  login_url: string;
  status: string;
  password_envelope?: string;
  has_password?: number;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
  use_count: number;
};

type PasswordEnvelope = {
  v: 1;
  alg: 'aes-256-gcm';
  kid: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

const metadataColumns = `
  id, user_id, shared, domain, username, label, login_url, status,
  CASE WHEN length(password_envelope) > 0 THEN 1 ELSE 0 END AS has_password,
  created_at, updated_at, last_used_at, use_count
`;
const keyFileName = 'credential-master.key';
let cachedMasterKey: Buffer | undefined;

function now() {
  return new Date().toISOString();
}

export function normalizeLoginAccountUserId(value: unknown) {
  return normalizeApplicationUserId(value);
}

export function normalizeLoginAccountDomain(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('账号域名不能为空');
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname) throw new Error('missing hostname');
    return hostname;
  } catch {
    throw new Error('账号域名格式无效');
  }
}

function normalizeUsername(value: unknown) {
  const username = typeof value === 'string' ? value.trim() : '';
  if (!username) throw new Error('登录账号不能为空');
  return username;
}

function normalizeLabel(value: unknown, username: string) {
  const label = typeof value === 'string' ? value.trim() : '';
  return label || username;
}

function normalizeStatus(value: unknown, fallback: LoginAccountStatus = 'active'): LoginAccountStatus {
  if (value === 'active' || value === 'disabled') return value;
  return fallback;
}

function normalizeLoginUrl(value: unknown, domain: string) {
  const raw = typeof value === 'string' ? value.trim() : '';
  try {
    const parsed = new URL(raw || `https://${domain}/`);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('unsupported protocol');
    if (normalizeLoginAccountDomain(parsed.hostname) !== domain) {
      throw new Error('domain mismatch');
    }
    return parsed.toString();
  } catch {
    throw new Error('登录地址必须是与账号域名一致的 http(s) 地址');
  }
}

function masterKeyPath() {
  return path.join(appDataRoot(), '.data', keyFileName);
}

function configuredMasterKey(value: string) {
  const raw = value.trim();
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  }
  return createHash('sha256').update(raw, 'utf8').digest();
}

function readGeneratedMasterKey(filePath: string) {
  const raw = readFileSync(filePath, 'utf8').trim();
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== 32) throw new Error('本地账号凭据主密钥文件无效');
  return decoded;
}

function generatedMasterKey() {
  const filePath = masterKeyPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const existing = readGeneratedMasterKey(filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Some filesystems (notably Windows) do not implement POSIX mode bits.
    }
    return existing;
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT';
    if (!missing) throw error;
  }

  const created = randomBytes(32);
  try {
    writeFileSync(filePath, created.toString('base64'), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
    return created;
  } catch (error) {
    const raced = error && typeof error === 'object' && 'code' in error
      && (error as { code?: unknown }).code === 'EEXIST';
    if (!raced) throw error;
    return readGeneratedMasterKey(filePath);
  }
}

function credentialMasterKey() {
  if (cachedMasterKey) return cachedMasterKey;
  const configured = String(process.env.WEBPILOT_CREDENTIAL_MASTER_KEY || '').trim();
  cachedMasterKey = configured ? configuredMasterKey(configured) : generatedMasterKey();
  return cachedMasterKey;
}

function masterKeyId(key: Buffer) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function passwordAad(input: Pick<LoginAccountRow, 'id' | 'user_id' | 'domain' | 'username'>) {
  return Buffer.from(JSON.stringify([
    'webpilot-login-account',
    input.id,
    input.user_id,
    input.domain,
    input.username,
  ]), 'utf8');
}

function encryptPassword(password: string, identity: Pick<LoginAccountRow, 'id' | 'user_id' | 'domain' | 'username'>) {
  if (!password) throw new Error('登录密码不能为空');
  const key = credentialMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(passwordAad(identity));
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const envelope: PasswordEnvelope = {
    v: 1,
    alg: 'aes-256-gcm',
    kid: masterKeyId(key),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return JSON.stringify(envelope);
}

function parsePasswordEnvelope(value: string): PasswordEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('账号凭据密文格式无效');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('账号凭据密文格式无效');
  }
  const envelope = parsed as Partial<PasswordEnvelope>;
  if (envelope.v !== 1
    || envelope.alg !== 'aes-256-gcm'
    || typeof envelope.kid !== 'string'
    || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string'
    || typeof envelope.ciphertext !== 'string') {
    throw new Error('账号凭据密文格式无效');
  }
  return envelope as PasswordEnvelope;
}

function decryptPassword(row: LoginAccountRow) {
  if (!row.password_envelope) throw new Error('账号没有可用的登录密码');
  const key = credentialMasterKey();
  const envelope = parsePasswordEnvelope(row.password_envelope);
  if (envelope.kid !== masterKeyId(key)) throw new Error('账号凭据主密钥不匹配');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(passwordAad(row));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('账号凭据解密失败');
  }
}

function metadataFromRow(row: LoginAccountRow): LoginAccountMetadata {
  return {
    id: row.id,
    userId: row.user_id,
    shared: Boolean(row.shared),
    domain: row.domain,
    username: row.username,
    label: row.label,
    loginUrl: row.login_url,
    status: normalizeStatus(row.status, 'disabled'),
    hasPassword: Boolean(row.has_password ?? row.password_envelope),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || undefined,
    useCount: Math.max(0, Number(row.use_count) || 0),
  };
}

function metadataById(id: string, userId: string, database?: DatabaseExecutor) {
  return queryDatabaseOne<LoginAccountRow>(`
    SELECT ${metadataColumns}
    FROM login_account
    WHERE id = ? AND (user_id = ? OR shared = ?)
  `, [id, userId, true], database);
}

function fullRowById(id: string, userId: string, database?: DatabaseExecutor) {
  return queryDatabaseOne<LoginAccountRow>(`
    SELECT * FROM login_account WHERE id = ? AND (user_id = ? OR shared = ?)
  `, [id, userId, true], database);
}

export async function listLoginAccounts(input: { userId?: unknown; domain?: unknown } = {}) {
  const userId = normalizeLoginAccountUserId(input.userId);
  const domain = typeof input.domain === 'string' && input.domain.trim()
    ? normalizeLoginAccountDomain(input.domain)
    : '';
  const rows = domain
    ? await queryDatabase<LoginAccountRow>(`
        SELECT ${metadataColumns}
        FROM login_account
        WHERE (user_id = ? OR shared = ?) AND domain = ?
        ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, updated_at DESC
      `, [userId, true, domain, userId])
    : await queryDatabase<LoginAccountRow>(`
        SELECT ${metadataColumns}
        FROM login_account
        WHERE user_id = ? OR shared = ?
        ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, updated_at DESC
      `, [userId, true, userId]);
  return rows.map(metadataFromRow);
}

export async function exportLoginAccountCredentials(userId?: unknown): Promise<LoginAccountPortableRecord[]> {
  const normalizedUserId = normalizeLoginAccountUserId(userId);
  const rows = await queryDatabase<LoginAccountRow>(`
    SELECT * FROM login_account
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `, [normalizedUserId]);
  return rows.map((row) => ({
    domain: row.domain,
    username: row.username,
    password: decryptPassword(row),
    label: row.label,
    loginUrl: row.login_url,
    status: normalizeStatus(row.status, 'disabled'),
    shared: Boolean(row.shared),
  }));
}

export async function getLoginAccountById(id: string, userId?: unknown) {
  const normalizedUserId = normalizeLoginAccountUserId(userId);
  const row = await metadataById(id.trim(), normalizedUserId);
  return row ? metadataFromRow(row) : undefined;
}

export async function createLoginAccount(input: CreateLoginAccountInput) {
  const userId = normalizeLoginAccountUserId(input.userId);
  const domain = normalizeLoginAccountDomain(input.domain);
  const username = normalizeUsername(input.username);
  const label = normalizeLabel(input.label, username);
  const loginUrl = normalizeLoginUrl(input.loginUrl, domain);
  const status = normalizeStatus(input.status);
  const shared = input.shared === true;
  const id = `account_${randomUUID()}`;
  const timestamp = now();
  const identity: Pick<LoginAccountRow, 'id' | 'user_id' | 'domain' | 'username'> = {
    id,
    user_id: userId,
    domain,
    username,
  };
  const passwordEnvelope = encryptPassword(input.password, identity);
  try {
    await executeDatabase(`
      INSERT INTO login_account (
        id, user_id, shared, domain, username, label, login_url, status,
        password_envelope, created_at, updated_at, last_used_at, use_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
    `, [
      id,
      userId,
      shared,
      domain,
      username,
      label,
      loginUrl,
      status,
      passwordEnvelope,
      timestamp,
      timestamp,
    ]);
  } catch (error) {
    if (/unique|duplicate/i.test(error instanceof Error ? error.message : String(error))) {
      throw new Error('该域名和登录账号已经存在');
    }
    throw error;
  }
  return (await getLoginAccountById(id, userId))!;
}

export async function updateLoginAccount(id: string, input: UpdateLoginAccountInput, userId?: unknown) {
  const normalizedUserId = normalizeLoginAccountUserId(userId);
  return runDatabaseTransaction(async (database) => {
    const previous = await queryDatabaseOne<LoginAccountRow>(`
      SELECT * FROM login_account WHERE id = ? AND user_id = ?
    `, [id.trim(), normalizedUserId], database);
    if (!previous) return undefined;

    const domain = input.domain === undefined ? previous.domain : normalizeLoginAccountDomain(input.domain);
    const username = input.username === undefined ? previous.username : normalizeUsername(input.username);
    const label = input.label === undefined ? previous.label : normalizeLabel(input.label, username);
    const loginUrl = input.loginUrl === undefined
      ? normalizeLoginUrl(previous.login_url, domain)
      : normalizeLoginUrl(input.loginUrl, domain);
    const status = normalizeStatus(input.status, normalizeStatus(previous.status, 'disabled'));
    const shared = input.shared ?? Boolean(previous.shared);
    const identity: Pick<LoginAccountRow, 'id' | 'user_id' | 'domain' | 'username'> = {
      id: previous.id,
      user_id: previous.user_id,
      domain,
      username,
    };
    let passwordEnvelope = previous.password_envelope || '';
    if (input.password) {
      passwordEnvelope = encryptPassword(input.password, identity);
    } else if (domain !== previous.domain || username !== previous.username) {
      passwordEnvelope = encryptPassword(decryptPassword(previous), identity);
    }
    const timestamp = now();
    try {
      await executeDatabase(`
        UPDATE login_account
        SET domain = ?, username = ?, label = ?, login_url = ?, status = ?, shared = ?,
            password_envelope = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `, [
        domain,
        username,
        label,
        loginUrl,
        status,
        shared,
        passwordEnvelope,
        timestamp,
        previous.id,
        previous.user_id,
      ], database);
    } catch (error) {
      if (/unique|duplicate/i.test(error instanceof Error ? error.message : String(error))) {
        throw new Error('该域名和登录账号已经存在');
      }
      throw error;
    }
    const updated = await queryDatabaseOne<LoginAccountRow>(`
      SELECT ${metadataColumns}
      FROM login_account
      WHERE id = ? AND user_id = ?
    `, [previous.id, previous.user_id], database);
    if (!updated) return undefined;
    return metadataFromRow(updated);
  });
}

export async function importLoginAccountsQueued(items: CreateLoginAccountInput[], userId?: unknown) {
  const normalizedUserId = normalizeLoginAccountUserId(userId);
  const existing = await queryDatabase<LoginAccountRow>(`
    SELECT * FROM login_account WHERE user_id = ?
  `, [normalizedUserId]);
  const byIdentity = new Map(existing.map((row) => [`${row.domain}\u0001${row.username}`, row]));
  const statements: DatabaseWriteStatement[] = [];
  let created = 0;
  let updated = 0;
  for (const input of items) {
    const domain = normalizeLoginAccountDomain(input.domain);
    const username = normalizeUsername(input.username);
    const identityKey = `${domain}\u0001${username}`;
    const previous = byIdentity.get(identityKey);
    const id = previous?.id || `account_${randomUUID()}`;
    const timestamp = now();
    const passwordEnvelope = encryptPassword(input.password, {
      id,
      user_id: normalizedUserId,
      domain,
      username,
    });
    statements.push({
      sql: `
        INSERT INTO login_account (
          id, user_id, shared, domain, username, label, login_url, status,
          password_envelope, created_at, updated_at, last_used_at, use_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
        ON CONFLICT(user_id, domain, username) DO UPDATE SET
          shared = excluded.shared,
          label = excluded.label,
          login_url = excluded.login_url,
          status = excluded.status,
          password_envelope = excluded.password_envelope,
          updated_at = excluded.updated_at
      `,
      params: [
        id,
        normalizedUserId,
        input.shared === true,
        domain,
        username,
        normalizeLabel(input.label, username),
        normalizeLoginUrl(input.loginUrl, domain),
        normalizeStatus(input.status),
        passwordEnvelope,
        previous?.created_at || timestamp,
        timestamp,
      ],
    });
    if (previous) updated += 1;
    else created += 1;
    byIdentity.set(identityKey, {
      id,
      user_id: normalizedUserId,
      shared: input.shared === true,
      domain,
      username,
      label: normalizeLabel(input.label, username),
      login_url: normalizeLoginUrl(input.loginUrl, domain),
      status: normalizeStatus(input.status),
      password_envelope: passwordEnvelope,
      created_at: previous?.created_at || timestamp,
      updated_at: timestamp,
      use_count: 0,
    });
  }
  await queueDatabaseWrite(statements);
  return { created, updated };
}

export async function deleteLoginAccount(id: string, userId?: unknown) {
  const normalizedUserId = normalizeLoginAccountUserId(userId);
  const rows = await queryDatabase<{ id: string }>(`
    DELETE FROM login_account WHERE id = ? AND user_id = ? RETURNING id
  `, [id.trim(), normalizedUserId]);
  return rows.length > 0;
}

type ResolveCredentialOptions = { trackUsage?: boolean };

async function resolveCredentialRow(row: LoginAccountRow, options: ResolveCredentialOptions = {}): Promise<LoginAccountCredential | undefined> {
  if (row.status !== 'active') return undefined;
  const password = decryptPassword(row);
  if (options.trackUsage === false) {
    return {
      account: metadataFromRow({ ...row, has_password: 1 }),
      password,
    };
  }
  const timestamp = now();
  await executeDatabase(`
    UPDATE login_account
    SET last_used_at = ?, use_count = use_count + 1
    WHERE id = ? AND user_id = ?
  `, [timestamp, row.id, row.user_id]);
  return {
    account: metadataFromRow({
      ...row,
      has_password: 1,
      last_used_at: timestamp,
      use_count: Math.max(0, Number(row.use_count) || 0) + 1,
    }),
    password,
  };
}

export async function resolveLoginAccountCredentialById(id: string, userId?: unknown, options: ResolveCredentialOptions = {}) {
  const normalizedUserId = normalizeLoginAccountUserId(userId);
  const row = await fullRowById(id.trim(), normalizedUserId);
  return row ? resolveCredentialRow(row, options) : undefined;
}
