import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { executeDatabase, queryDatabase } from '@/server/db/database';
import { decryptCredentialSecret, encryptCredentialSecret } from './credential-master-key';

export type BrowserDomainCookie = {
  name: string;
  url: string;
  value: string;
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
function now() {
  return new Date().toISOString();
}

function cookieAad(userId: string, domain: string) {
  return Buffer.from(JSON.stringify(['webpilot-browser-domain-cookie', userId, domain]), 'utf8');
}

function encryptCookie(cookie: string, userId: string, domain: string) {
  return encryptCredentialSecret(cookie, cookieAad(userId, domain));
}

function decryptCookie(row: CookieRow) {
  return decryptCredentialSecret({
    aad: cookieAad(row.user_id, row.domain),
    envelope: row.cookie_envelope,
    formatError: '浏览器 Cookie 密文格式无效',
    decryptionError: '浏览器 Cookie 解密失败',
  });
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
