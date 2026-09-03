import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appDataRoot } from '@/server/storage/paths';

const credentialMasterKeyFileName = 'credential-master.key';
let cachedCredentialMasterKey: Buffer | undefined;

type CredentialEnvelope = {
  alg: 'aes-256-gcm';
  ciphertext: string;
  iv: string;
  kid: string;
  tag: string;
  v: 1;
};

function credentialMasterKeyPath() {
  return path.join(appDataRoot(), '.data', credentialMasterKeyFileName);
}

function configuredCredentialMasterKey(value: string) {
  const raw = value.trim();
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  }
  return createHash('sha256').update(raw, 'utf8').digest();
}

function readGeneratedCredentialMasterKey(filePath: string) {
  const decoded = Buffer.from(readFileSync(filePath, 'utf8').trim(), 'base64');
  if (decoded.length !== 32) throw new Error('本地凭据主密钥文件无效');
  return decoded;
}

function generatedCredentialMasterKey() {
  const filePath = credentialMasterKeyPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const existing = readGeneratedCredentialMasterKey(filePath);
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
      // Best effort on filesystems without POSIX permissions.
    }
    return created;
  } catch (error) {
    const raced = error && typeof error === 'object' && 'code' in error
      && (error as { code?: unknown }).code === 'EEXIST';
    if (!raced) throw error;
    return readGeneratedCredentialMasterKey(filePath);
  }
}

export function credentialMasterKey() {
  if (cachedCredentialMasterKey) return cachedCredentialMasterKey;
  const configured = String(process.env.WEBPILOT_CREDENTIAL_MASTER_KEY || '').trim();
  cachedCredentialMasterKey = configured
    ? configuredCredentialMasterKey(configured)
    : generatedCredentialMasterKey();
  return cachedCredentialMasterKey;
}

export function credentialMasterKeyId(key: Buffer) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function encryptCredentialSecret(secret: string, aad: Buffer) {
  const key = credentialMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    kid: credentialMasterKeyId(key),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  } satisfies CredentialEnvelope);
}

export function decryptCredentialSecret(input: {
  aad: Buffer;
  decryptionError: string;
  envelope: string;
  formatError: string;
  keyMismatchError?: string;
}) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.envelope);
  } catch {
    throw new Error(input.formatError);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(input.formatError);
  }
  const envelope = parsed as Partial<CredentialEnvelope>;
  if (envelope.v !== 1
    || envelope.alg !== 'aes-256-gcm'
    || typeof envelope.kid !== 'string'
    || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string'
    || typeof envelope.ciphertext !== 'string') {
    throw new Error(input.formatError);
  }
  const key = credentialMasterKey();
  if (envelope.kid !== credentialMasterKeyId(key)) {
    throw new Error(input.keyMismatchError || input.formatError);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(input.aad);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(input.decryptionError);
  }
}
