import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { executeDatabase, queryDatabase } from '@/server/db/database';
import { appDataRoot } from '@/server/storage/paths';

export type BrowserDomainCookie = {
  name: string;
  url: string;
  value: string;
};

type CookieEnvelope = {
  alg: 'aes-256-gcm';
  ciphertext: string;
  iv: string;
  kid: string;
  tag: string;
  v: 1;
};

type CookieRow = {
  cookie_envelope: string;
  created_at: string;
  domain: string;
  updated_at: string;
  user_id: string;
};

const cookieAttributeNames = new Set([
  'domain',
  'expires',
  'httponly',
  'max-age',
  'partitioned',
  'path',
  'priority',
  'samesite',
  'secure',
]);
const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const keyFileName = 'credential-master.key';
let cachedMasterKey: Buffer | undefined;

function now() {
  return new Date().toISOString();
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
  const decoded = Buffer.from(readFileSync(filePath, 'utf8').trim(), 'base64');
  if (decoded.length !== 32) throw new Error('本地凭据主密钥文件无效');
  return decoded;
}

function generatedMasterKey() {
  const filePath = masterKeyPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const existing = readGeneratedMasterKey(filePath);
    try { chmodSync(filePath, 0o600); } catch {
      // Windows and some filesystems do not implement POSIX mode bits.
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
    try { chmodSync(filePath, 0o600); } catch {
      // Windows and some filesystems do not implement POSIX mode bits.
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

function keyId(key: Buffer) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function cookieAad(userId: string, domain: string) {
  return Buffer.from(JSON.stringify(['webpilot-browser-domain-cookie', userId, domain]), 'utf8');
}

function encryptCookie(cookie: string, userId: string, domain: string) {
  const key = credentialMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(cookieAad(userId, domain));
  const ciphertext = Buffer.concat([cipher.update(cookie, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    kid: keyId(key),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  } satisfies CookieEnvelope);
}

function decryptCookie(row: CookieRow) {
  const envelope = JSON.parse(row.cookie_envelope) as Partial<CookieEnvelope>;
  const key = credentialMasterKey();
  if (envelope.v !== 1
    || envelope.alg !== 'aes-256-gcm'
    || envelope.kid !== keyId(key)
    || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string'
    || typeof envelope.ciphertext !== 'string') {
    throw new Error('浏览器 Cookie 密文格式无效');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(cookieAad(row.user_id, row.domain));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('浏览器 Cookie 解密失败');
  }
}

export function normalizeBrowserCookieDomain(value: unknown) {
  const domain = String(value ?? '').trim().toLowerCase().replace(/^\./, '');
  if (!domain || domain.length > 253) throw new Error('Cookie 域名无效');
  if (domain === 'localhost') return domain;
  const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(domain)
    && domain.split('.').every((part) => Number(part) <= 255);
  const isHostname = domain.split('.').every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
  if (!isIpv4 && !isHostname) {
    throw new Error('Cookie 域名必须是不带协议、端口和路径的有效主机名');
  }
  return domain;
}

export function parseBrowserCookieHeader(value: string, domainValue: unknown): BrowserDomainCookie[] {
  const domain = normalizeBrowserCookieDomain(domainValue);
  const cookieUrl = `https://${domain}/`;
  const cookies = new Map<string, BrowserDomainCookie>();
  const header = value.trim().replace(/^(?:cookie|set-cookie)\s*:\s*/i, '');
  for (const part of header.split(';')) {
    const segment = part.trim();
    if (!segment) continue;
    const separator = segment.indexOf('=');
    const rawName = (separator >= 0 ? segment.slice(0, separator) : segment).trim();
    const name = rawName.startsWith('$') ? rawName.slice(1) : rawName;
    if (!name || cookieAttributeNames.has(name.toLowerCase())) continue;
    if (separator < 1 || !cookieNamePattern.test(name)) throw new Error(`Cookie 名称无效：${name || '[empty]'}`);
    let cookieValue = segment.slice(separator + 1).trim();
    if (cookieValue.startsWith('"') && cookieValue.endsWith('"') && cookieValue.length >= 2) {
      cookieValue = cookieValue.slice(1, -1);
    }
    if (/[\u0000-\u001F\u007F;]/.test(cookieValue)) throw new Error(`Cookie 值无效：${name}`);
    cookies.set(name, { name, value: cookieValue, url: cookieUrl });
    if (cookies.size > 200) throw new Error('Cookie 数量不能超过 200 个');
  }
  if (!cookies.size) throw new Error('没有找到可注入的 Cookie');
  return [...cookies.values()];
}

export async function saveBrowserDomainCookie(userIdValue: unknown, domainValue: unknown, cookie: string) {
  const userId = normalizeApplicationUserId(userIdValue);
  const domain = normalizeBrowserCookieDomain(domainValue);
  const cookies = parseBrowserCookieHeader(cookie, domain);
  const timestamp = now();
  await executeDatabase(`
    INSERT INTO browser_domain_cookie (
      user_id, domain, cookie_envelope, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, domain) DO UPDATE SET
      cookie_envelope = excluded.cookie_envelope,
      updated_at = excluded.updated_at
  `, [userId, domain, encryptCookie(cookie, userId, domain), timestamp, timestamp]);
  return { cookieCount: cookies.length, domain, updatedAt: timestamp, userId };
}

export async function readBrowserDomainCookies(userIdValue: unknown) {
  const userId = normalizeApplicationUserId(userIdValue);
  const rows = await queryDatabase<CookieRow>(`
    SELECT user_id, domain, cookie_envelope, created_at, updated_at
    FROM browser_domain_cookie
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `, [userId]);
  return rows.flatMap((row) => parseBrowserCookieHeader(decryptCookie(row), row.domain));
}
