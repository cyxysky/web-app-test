import { generateText } from 'ai';
import { retrievalQueryTexts } from '@/lib/fuzzy-retrieval';
import { aiMaxOutputTokens, aiRequestTimeoutMs, aiTelemetry } from '@/server/ai/ai-sdk-runtime';
import { getModel } from '@/server/ai/model';

const retrievalQueryCache = new Map<string, string[]>();

function parsedVariants(value: string) {
  const match = value.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function cacheVariants(key: string, variants: string[]) {
  retrievalQueryCache.set(key, variants);
  if (retrievalQueryCache.size <= 200) return;
  const oldest = retrievalQueryCache.keys().next().value;
  if (oldest) retrievalQueryCache.delete(oldest);
}

export async function expandMultilingualRetrievalQuery(value: unknown) {
  const base = retrievalQueryTexts(value).slice(0, 8);
  const key = base.join('\n').slice(0, 2_000);
  if (!key) return [];
  const cached = retrievalQueryCache.get(key);
  if (cached) return cached;

  try {
    const result = await generateText({
      model: getModel(),
      maxOutputTokens: aiMaxOutputTokens(768),
      temperature: 0,
      maxRetries: 0,
      timeout: Math.min(aiRequestTimeoutMs(), 12_000),
      telemetry: aiTelemetry('multilingual-retrieval-query-expansion'),
      prompt: [
        'Create search variants for matching a browser Skill and durable personal memory.',
        'Return only one JSON array containing 6 to 16 short strings.',
        'Include both Simplified Chinese and English variants, synonyms, abbreviations, and the same business entities.',
        'Do not add new intent, names, identifiers, dates, or facts.',
        `Query:\n${key}`,
      ].join('\n'),
    });
    const variants = retrievalQueryTexts([...base, ...parsedVariants(result.text)]).slice(0, 24);
    const resolved = variants.length ? variants : base;
    cacheVariants(key, resolved);
    return resolved;
  } catch {
    cacheVariants(key, base);
    return base;
  }
}
