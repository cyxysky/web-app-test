import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createResearchCapability, type ResearchOperations, type ResearchSource } from './index.js';
import type { CapabilityExecutionContext, CapabilityRunContext } from '@webpilot/capability-sdk';

function sourceId(url: string) { return `source_${createHash('sha256').update(url).digest('hex').slice(0, 16)}`; }
function privateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '::' || normalized === '::1' || normalized.startsWith('::ffff:')
    || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)
    || /^169\.254\./.test(normalized) || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) || /^0\./.test(normalized);
}
async function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Research fetch accepts only HTTP(S) URLs.');
  if (url.username || url.password) throw new Error('Credential-bearing URLs are not allowed.');
  if (url.hostname === 'localhost') throw new Error('Local research targets are not allowed.');
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error('Private or unresolved research targets are not allowed.');
  return url;
}
function decodeEntities(value: string) { return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'"); }
function htmlText(value: string) { return decodeEntities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }
function titleFromHtml(value: string, fallback: string) { const matched = value.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i); return matched ? htmlText(matched[1]).slice(0, 300) : fallback; }
async function boundedResponseText(response: Response, maximum: number) {
  if (!response.body) return (await response.text()).slice(0, maximum);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (output.length < maximum) {
    const chunk = await reader.read();
    if (chunk.done) {
      output += decoder.decode();
      break;
    }
    output += decoder.decode(chunk.value, { stream: true });
    if (output.length >= maximum) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return output.slice(0, maximum);
}

export function createNodeResearchOperations(input: {
  search?: ResearchOperations['search'];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowUrl?: (url: URL) => boolean | Promise<boolean>;
} = {}): ResearchOperations {
  const fetchImpl = input.fetchImpl || fetch;
  return {
    search: input.search,
    async fetch(request, context: CapabilityExecutionContext): Promise<ResearchSource> {
      let url = await assertPublicUrl(request.url);
      const timeout = AbortSignal.timeout(input.timeoutMs || 20_000);
      const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
      let response: Response | undefined;
      for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
        if (input.allowUrl && !(await input.allowUrl(url))) throw new Error('The host network policy rejected this URL.');
        response = await fetchImpl(url, { redirect: 'manual', signal, headers: { accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.2', 'user-agent': 'WebPilotResearch/0.1' } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        if (!location) throw new Error(`Research redirect ${response.status} did not include a location.`);
        if (redirectCount === 5) throw new Error('Research fetch exceeded the redirect limit.');
        url = await assertPublicUrl(new URL(location, url).href);
      }
      if (!response) throw new Error('Research fetch did not return a response.');
      if (!response.ok) throw new Error(`Research fetch returned HTTP ${response.status}.`);
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
      const raw = await boundedResponseText(response, Math.max(request.maxChars * 4, request.maxChars));
      const content = mediaType.includes('html') ? htmlText(raw) : raw;
      return { sourceId: sourceId(url.href), url: url.href, title: mediaType.includes('html') ? titleFromHtml(raw, url.hostname) : url.pathname.split('/').pop() || url.hostname, content: content.slice(0, request.maxChars), mediaType, retrievedAt: new Date().toISOString(), provider: 'http' };
    },
  };
}

export function createNodeResearchCapability(input: Parameters<typeof createNodeResearchOperations>[0] = {}) {
  return createResearchCapability({ createOperations(context: CapabilityRunContext) { return createNodeResearchOperations({ ...input, timeoutMs: Number(context.configuration.AGENT_RESEARCH_TIMEOUT_MS) || input.timeoutMs }); } });
}
