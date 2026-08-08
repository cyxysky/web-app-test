import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { artifactApiUrl, artifactApiUrlFromRelative } from '@/lib/artifacts';
import { normalizeApplicationUserId } from '@/server/auth/user-context';
import { artifactPath } from '@/server/storage/paths';

export type BrowserChatAttachment = {
  id: string;
  name: string;
  type: string;
  size?: number;
  path: string;
  url: string;
  kind?: 'image' | 'file' | 'tab';
  sourceUrl?: string;
};

export function normalizeBrowserChatUploadPath(value: unknown, userId?: unknown) {
  const raw = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
  if (!raw || raw.startsWith('/') || raw.includes('..') || !raw.startsWith('uploads/')) return undefined;
  const segments = raw.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  if (segments.length >= 3 && segments[1] !== normalizeApplicationUserId(userId)) return undefined;
  return segments.join('/');
}

export function normalizeBrowserChatAttachments(value: unknown, userId?: unknown): BrowserChatAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: BrowserChatAttachment[] = [];
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const rawType = typeof record.type === 'string' && record.type.trim() ? record.type.trim().slice(0, 160) : 'application/octet-stream';
    const requestedKind = record.kind === 'tab' || record.kind === 'file' || record.kind === 'image' ? record.kind : undefined;
    const isTabReference = requestedKind === 'tab' || rawType === 'application/x-webpilot-tab';
    const pathValue = isTabReference ? '' : normalizeBrowserChatUploadPath(record.path, userId);
    if (!isTabReference && !pathValue) continue;
    const attachmentPath = pathValue || '';
    const type = isTabReference ? 'application/x-webpilot-tab' : rawType;
    const kind = isTabReference ? 'tab' : (type.startsWith('image/') ? 'image' : 'file');
    const sourceUrl = typeof record.sourceUrl === 'string' ? record.sourceUrl.trim().slice(0, 2000) : '';
    const urlValue = typeof record.url === 'string' ? record.url.trim().slice(0, 2000) : '';
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim().slice(0, 160)
      : attachmentPath ? path.basename(attachmentPath) : randomUUID();
    const name = typeof record.name === 'string' && record.name.trim()
      ? record.name.trim().slice(0, 180)
      : attachmentPath ? path.basename(attachmentPath) : sourceUrl || urlValue || '新建标签页';
    const size = typeof record.size === 'number' && Number.isFinite(record.size)
      ? Math.max(0, Math.floor(record.size))
      : undefined;
    attachments.push({
      id,
      kind,
      name,
      type,
      size,
      path: attachmentPath,
      sourceUrl: isTabReference ? sourceUrl || urlValue : undefined,
      url: isTabReference
        ? sourceUrl || urlValue
        : (artifactApiUrl(typeof record.url === 'string' ? record.url : undefined) || artifactApiUrlFromRelative(attachmentPath)),
    });
  }
  return attachments;
}

export function uploadedBrowserChatAttachmentPath(attachment: BrowserChatAttachment, userId?: unknown) {
  if (attachment.kind === 'tab') return undefined;
  const relativePath = normalizeBrowserChatUploadPath(attachment.path, userId);
  if (relativePath) return artifactPath(...relativePath.split('/'));
  if (!attachment.id.startsWith('artifact:')) return undefined;
  const segments = attachment.path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) return undefined;
  return artifactPath(...segments);
}
