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
import { getSqliteDatabase, runSqliteTransaction } from '@/server/storage/sqlite-database';
import { appDataRoot } from '@/server/storage/paths';

export type LoginAccountStatus = 'active' | 'disabled';

export type LoginAccountMetadata = {
  id: string;
  userId: string;
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

export type CreateLoginAccountInput = {
  userId?: unknown;
  domain: string;
  username: string;
  password: string;
  label?: string;
  loginUrl?: string;
  status?: LoginAccountStatus;
};

export type UpdateLoginAccountInput = {
  domain?: string;
  username?: string;
  password?: string;
  label?: string;
  loginUrl?: string;
  status?: LoginAccountStatus;
};

type LoginAccountRow = {
  id: string;
  user_id: string;
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
  id, user_id, domain, username, label, login_url, status,
  CASE WHEN length(password_envelope) > 0 THEN 1 ELSE 0 END AS has_password,
  created_at, updated_at, last_used_at, use_count
`;
const keyFileName = 'credential-master.key';
let cachedMasterKey: Buffer | undefined;

function now() {
  return new Date().toISOString();
}

export function normalizeLoginAccountUserId(value: unknown) {
  const normalized = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
  return normalized || 'default';
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

function metadataById(id: string, userId: string) {
  return getSqliteDatabase().prepare(`
    SELECT ${metadataColumns}
    FROM login_account
    WHERE id = ? AND user_id = ?
  `).get(id, userId) as LoginAccountRow | undefined;
}

function fullRowById(id: string, userId: string) {
  return getSqliteDatabase().prepare(`
    SELECT * FROM login_account WHERE id = ? AND user_id = ?
  `).get(id, userId) as LoginAccountRow | undefined;
}

export function listLoginAccounts(input: { userId?: unknown; domain?: unknown } = {}) {
  const userId = normalizeLoginAccountUserId(input.userId);
  const domain = typeof input.domain === 'string' && input.domain.trim()
    ? normalizeLoginAccountDomain(input.domain)
    : '';
  const rows = (domain
    ? getSqliteDatabase().prepare(`
        SELECT ${metadataColumns}
        FROM login_account
        WHERE user_id = ? AND domain = ?
        ORDER BY updated_at DESC
      `).all(userId, domain)
    : getSqliteDatabase().prepare(`
        SELECT ${metadataColumns}
        FROM login_account
        WHERE user_id = ?
        ORDER BY updated_at DESC
      `).all(userId)) as LoginAccountRow[];
  return rows.map(metadataFromRow);
}

export function getLoginAccountById(id: string, userId?: unknown) {
  const normalizedUserId = normalizeLoginAccountUserId(userId);
  const row = metadataById(id.trim(), normalizedUserId);
  return row ? metadataFromRow(row) : undefined;
}

export function findLoginAccountByDomainUsername(input: {
  userId?: unknown;
  domain: unknown;
  username: unknown;
}) {
  const userId = normalizeLoginAccountUserId(input.userId);
  const domain = normalizeLoginAccountDomain(input.domain);
  const username = normalizeUsername(input.username);
  const row = getSqliteDatabase().prepare(`
    SELECT ${metadataColumns}
    FROM login_account
    WHERE user_id = ? AND domain = ? AND username = ?
  `).get(userId, domain, username) as LoginAccountRow | undefined;
  return row ? metadataFromRow(row) : undefined;
}

export function createLoginAccount(input: CreateLoginAccountInput) {
  const userId = normalizeLoginAccountUserId(input.userId);
  const domain = normalizeLoginAccountDomain(input.domain);
  const username = normalizeUsername(input.username);
  const label = normalizeLabel(input.label, username);
  const loginUrl = normalizeLoginUrl(input.loginUrl, domain);
  const status = normalizeStatus(input.status);
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
    getSqliteDatabase().prepare(`
      INSERT INTO login_account (
        id, user_id, domain, username, label, login_url, status,
        password_envelope, created_at, updated_at, last_used_at, use_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
    `).run(
      id,
      userId,
      domain,
      username,
      label,
      loginUrl,
      status,
      passwordEnvelope,
      timestamp,
      timestamp,
    );
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
      throw new Error('该域名和登录账号已经存在');
    }
    throw error;
  }
  return getLoginAccountById(id, userId)!;
}

export function updateLoginAccount(id: string, input: UpdateLoginAccountInput, userId?: unknown) {
  const normalizedUserId = normalizeLoginAccountUserId(userId);
  return runSqliteTransaction((database) => {
    const previous = database.prepare(`
      SELECT * FROM login_account WHERE id = ? AND user_id = ?
    `).get(id.trim(), normalizedUserId) as LoginAccountRow | undefined;
    if (!previous) return undefined;

    const domain = input.domain === undefined ? previous.domain : normalizeLoginAccountDomain(input.domain);
    const username = input.username === undefined ? previous.username : normalizeUsername(input.username);
    const label = input.label === undefined ? previous.label : normalizeLabel(input.label, username);
    const loginUrl = input.loginUrl === undefined
      ? normalizeLoginUrl(previous.login_url, domain)
      : normalizeLoginUrl(input.loginUrl, domain);
    const status = normalizeStatus(input.status, normalizeStatus(previous.status, 'disabled'));
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
      database.prepare(`
        UPDATE login_account
        SET domain = ?, username = ?, label = ?, login_url = ?, status = ?,
            password_envelope = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(
        domain,
        username,
        label,
        loginUrl,
        status,
        passwordEnvelope,
        timestamp,
        previous.id,
        previous.user_id,
      );
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
        throw new Error('该域名和登录账号已经存在');
      }
      throw error;
    }
    const updated = database.prepare(`
      SELECT ${metadataColumns}
      FROM login_account
      WHERE id = ? AND user_id = ?
    `).get(previous.id, previous.user_id) as LoginAccountRow;
    return metadataFromRow(updated);
  });
}

export function deleteLoginAccount(id: string, userId?: unknown) {
  const normalizedUserId = normalizeLoginAccountUserId(userId);
  const result = getSqliteDatabase().prepare(`
    DELETE FROM login_account WHERE id = ? AND user_id = ?
  `).run(id.trim(), normalizedUserId);
  return Number(result.changes) > 0;
}

function resolveCredentialRow(row: LoginAccountRow): LoginAccountCredential | undefined {
  if (row.status !== 'active') return undefined;
  const password = decryptPassword(row);
  const timestamp = now();
  getSqliteDatabase().prepare(`
    UPDATE login_account
    SET last_used_at = ?, use_count = use_count + 1
    WHERE id = ? AND user_id = ?
  `).run(timestamp, row.id, row.user_id);
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

export function resolveLoginAccountCredentialById(id: string, userId?: unknown) {
  const normalizedUserId = normalizeLoginAccountUserId(userId);
  const row = fullRowById(id.trim(), normalizedUserId);
  return row ? resolveCredentialRow(row) : undefined;
}

export function resolveLoginAccountCredential(input: {
  userId?: unknown;
  domain: unknown;
  username: unknown;
}) {
  const userId = normalizeLoginAccountUserId(input.userId);
  const domain = normalizeLoginAccountDomain(input.domain);
  const username = normalizeUsername(input.username);
  const row = getSqliteDatabase().prepare(`
    SELECT * FROM login_account
    WHERE user_id = ? AND domain = ? AND username = ?
  `).get(userId, domain, username) as LoginAccountRow | undefined;
  return row ? resolveCredentialRow(row) : undefined;
}
