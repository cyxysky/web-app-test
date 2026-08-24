import type { ModelMessage } from 'ai';

type RuntimeContinuationState = {
  blockers?: unknown;
  completed?: unknown;
  currentState?: unknown;
  findings?: unknown;
  lastAction?: unknown;
  lastResult?: unknown;
  nextStep?: unknown;
  pageUnderstanding?: unknown;
  userConstraints?: unknown;
};

type RuntimeContinuationSummary = {
  goal?: unknown;
  completed?: unknown;
  currentPage?: unknown;
  confirmedFacts?: unknown;
  negativeResults?: unknown;
  failedAttempts?: unknown;
  importantEvidence?: unknown;
  openObservations?: unknown;
  remaining?: unknown;
  nextStep?: unknown;
};

const TRANSIENT_BROWSER_EVIDENCE_KEYS = new Set(['axTree', 'domChanges', 'domSnapshot']);

export const runtimeContinuationSummaryMarker = '[WebPilot continuation summary]';

function modelMessageContainsToolCall(message: ModelMessage) {
  return message.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((part) => part.type === 'tool-call');
}

export function atomicRuntimeModelMessageBlocks(messages: ModelMessage[]) {
  const blocks: ModelMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (modelMessageContainsToolCall(message)) {
      const block = [message];
      while (messages[index + 1]?.role === 'tool') block.push(messages[++index]);
      blocks.push(block);
      continue;
    }
    blocks.push([message]);
  }
  return blocks;
}

function runtimeModelMessageFingerprint(message: ModelMessage) {
  try {
    return JSON.stringify(message);
  } catch {
    return undefined;
  }
}

export function mergeRuntimeModelMessageChain(base: ModelMessage[], response: ModelMessage[]) {
  if (!response.length) return [...base];
  const baseFingerprints = base.map(runtimeModelMessageFingerprint);
  const responseFingerprints = response.map(runtimeModelMessageFingerprint);
  for (let overlap = Math.min(base.length, response.length); overlap > 0; overlap -= 1) {
    const baseStart = base.length - overlap;
    const matches = responseFingerprints.slice(0, overlap).every((fingerprint, index) => (
      fingerprint !== undefined
      && fingerprint === baseFingerprints[baseStart + index]
    ));
    if (matches) return [...base, ...response.slice(overlap)];
  }
  return [...base, ...response];
}

export function selectRecentRuntimeMessageBlocks(
  blocks: ModelMessage[][],
  tokenEstimate: (block: ModelMessage[]) => number,
  budgetTokens: number,
) {
  const olderBlocks = [...blocks];
  const retainedBlocks: ModelMessage[][] = [];
  let retainedTokens = 0;
  while (olderBlocks.length) {
    const candidate = olderBlocks.at(-1)!;
    const candidateTokens = tokenEstimate(candidate);
    if (retainedTokens + candidateTokens > budgetTokens) break;
    olderBlocks.pop();
    retainedBlocks.unshift(candidate);
    retainedTokens += candidateTokens;
    if (retainedTokens >= budgetTokens) break;
  }
  return { olderBlocks, retainedBlocks, retainedTokens };
}

function sanitizeContinuationValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return /\[ax-tree\]|"(?:axTree|domChanges|domSnapshot)"\s*:/.test(value)
      ? undefined
      : value;
  }
  if (Array.isArray(value)) {
    return value
      .map(sanitizeContinuationValue)
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (TRANSIENT_BROWSER_EVIDENCE_KEYS.has(key)) continue;
    const next = sanitizeContinuationValue(child);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

export function sanitizeRuntimeContinuationSummary(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return JSON.stringify(sanitizeContinuationValue(JSON.parse(trimmed)));
  } catch {
    return /\[ax-tree\]|"(?:axTree|domChanges|domSnapshot)"\s*:/.test(trimmed) ? '' : trimmed;
  }
}

export function ensureRuntimeContinuationSummaryMessage(
  messages: ModelMessage[],
  continuationSummary: string,
) {
  const summary = sanitizeRuntimeContinuationSummary(continuationSummary);
  if (!summary) return [...messages];
  const withoutSummaryMarkers = messages.filter((message) => !(
    typeof message.content === 'string'
    && message.content.startsWith(runtimeContinuationSummaryMarker)
  ));
  return [{
    role: 'user' as const,
    content: `${runtimeContinuationSummaryMarker}\n${summary}`,
  }, ...withoutSummaryMarkers];
}

function parsedRuntimeContinuationSummary(value: string | undefined) {
  const sanitized = sanitizeRuntimeContinuationSummary(value || '');
  if (!sanitized) return undefined;
  try {
    const parsed = JSON.parse(sanitized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as RuntimeContinuationSummary
      : undefined;
  } catch {
    return undefined;
  }
}

function continuationStrings(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}

function uniqueContinuationStrings(...values: unknown[]) {
  return [...new Set(values.flatMap(continuationStrings))];
}

function continuationText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim() || '';
}

/**
 * Canonicalize a model-authored continuation summary and merge durable fields
 * with the previous segment. A prose answer or malformed JSON is rejected so
 * it cannot silently replace a useful task-state checkpoint.
 */
export function normalizeRuntimeContinuationSummary(input: {
  candidate: string;
  goal: string;
  previousSummary?: string;
  runtimeState: RuntimeContinuationState;
}) {
  const candidate = parsedRuntimeContinuationSummary(input.candidate);
  if (!candidate || !continuationText(candidate.nextStep)) return '';
  const previous = parsedRuntimeContinuationSummary(input.previousSummary) || {};
  const authoritativeDirective = continuationText(...continuationStrings(input.runtimeState.userConstraints));
  const currentPage = continuationText(
    input.runtimeState.currentState,
    input.runtimeState.pageUnderstanding,
    candidate.currentPage,
    previous.currentPage,
  );
  const nextStep = continuationText(
    authoritativeDirective,
    candidate.nextStep,
    previous.nextStep,
    input.runtimeState.nextStep,
    'Continue only the unfinished work recorded in this summary.',
  );
  return JSON.stringify({
    goal: input.goal,
    completed: uniqueContinuationStrings(previous.completed, candidate.completed, input.runtimeState.completed),
    currentPage,
    confirmedFacts: uniqueContinuationStrings(previous.confirmedFacts, candidate.confirmedFacts, input.runtimeState.findings),
    negativeResults: uniqueContinuationStrings(previous.negativeResults, candidate.negativeResults),
    failedAttempts: uniqueContinuationStrings(previous.failedAttempts, candidate.failedAttempts, input.runtimeState.blockers),
    importantEvidence: uniqueContinuationStrings(previous.importantEvidence, candidate.importantEvidence, input.runtimeState.findings),
    openObservations: uniqueContinuationStrings(previous.openObservations, candidate.openObservations),
    remaining: authoritativeDirective
      ? [authoritativeDirective]
      : continuationStrings(candidate.remaining).length
        ? continuationStrings(candidate.remaining)
        : continuationStrings(previous.remaining),
    nextStep,
  });
}

function serializedMessageDelta(modelMessages: unknown) {
  const record = modelMessages && typeof modelMessages === 'object' && !Array.isArray(modelMessages)
    ? modelMessages as Record<string, unknown>
    : {};
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return JSON.stringify({ messages }, null, 2);
}

export function buildRuntimeContinuationSummaryPrompt(input: {
  agentStep: number;
  deltaModelMessages: unknown;
  estimatedTokens: number;
  goal: string;
  previousSummary?: string;
  runtimeState: RuntimeContinuationState;
  stepIndex: number;
  thresholdTokens: number;
}) {
  return [
    'You are incrementally compressing a WebPilot browser-agent loop so the SAME user request can continue in a fresh model context.',
    'Return concise JSON only. Do not use markdown.',
    '',
    'Required JSON shape:',
    '{ "goal": string, "completed": string[], "currentPage": string, "confirmedFacts": string[], "negativeResults": string[], "failedAttempts": string[], "importantEvidence": string[], "openObservations": string[], "remaining": string[], "nextStep": string }',
    '',
    'Rules:',
    '- Merge the previous summary with only the new unsummarized message delta below.',
    '- Preserve stable Playwright locator intent and exact structured evidence when it materially affects the next action.',
    '- Preserve current URL/page state, blockers, manual verification state, user constraints, completed searches, empty results, and failed attempts.',
    '- The authoritative runtime state was produced after the latest completed tool call and wins on conflict.',
    '- Goal is the success criterion, not an instruction to restart. Never repeat completed research, downloads, generation, rendering, or QA. Continue only remaining and nextStep.',
    '- A later continuation/gate directive is authoritative for the immediate next action and must not be replaced by the original goal.',
    '- Never copy raw screenshots, AX trees, page.domSnapshot() output, domChanges payloads, candidate coordinates, full DOM dumps, long logs, or old tool parameter JSON into the summary. Preserve only the durable fact learned from that transient evidence.',
    '- Write Chinese for user-facing summaries when possible.',
    '',
    `Goal: ${input.goal}`,
    `Executor step: ${input.stepIndex}`,
    `Agent step before compression: ${input.agentStep}`,
    `Estimated model-context tokens: ${input.estimatedTokens}/${input.thresholdTokens}`,
    '',
    `Previous continuation summary JSON:\n${input.previousSummary || '[none]'}`,
    '',
    `Authoritative current runtime state JSON:\n${JSON.stringify(input.runtimeState, null, 2)}`,
    '',
    `New unsummarized message delta JSON:\n${serializedMessageDelta(input.deltaModelMessages)}`,
  ].join('\n');
}

export function fallbackRuntimeContinuationSummary(input: {
  agentStep: number;
  goal: string;
  previousSummary?: string;
  recentToolAttempts: string;
  runtimeState: RuntimeContinuationState;
  stepIndex: number;
}) {
  const previous = parsedRuntimeContinuationSummary(input.previousSummary) || {};
  const runtimeNextStep = continuationText(input.runtimeState.nextStep);
  const authoritativeDirective = continuationText(...continuationStrings(input.runtimeState.userConstraints));
  const previousRemaining = continuationStrings(previous.remaining);
  return JSON.stringify({
    goal: input.goal,
    executorStep: input.stepIndex,
    agentStepBeforeCompression: input.agentStep,
    completed: uniqueContinuationStrings(previous.completed, input.runtimeState.completed),
    currentPage: continuationText(input.runtimeState.currentState, input.runtimeState.pageUnderstanding, previous.currentPage),
    importantEvidence: uniqueContinuationStrings(previous.importantEvidence, input.runtimeState.findings),
    confirmedFacts: uniqueContinuationStrings(previous.confirmedFacts, input.runtimeState.findings),
    negativeResults: uniqueContinuationStrings(previous.negativeResults),
    failedAttempts: uniqueContinuationStrings(previous.failedAttempts, input.runtimeState.blockers),
    openObservations: uniqueContinuationStrings(previous.openObservations),
    remaining: authoritativeDirective
      ? [authoritativeDirective]
      : previousRemaining.length ? previousRemaining : runtimeNextStep ? [runtimeNextStep] : [],
    nextStep: continuationText(authoritativeDirective, previous.nextStep, runtimeNextStep, 'Continue only the unfinished work recorded in this summary.'),
    recentToolAttempts: input.recentToolAttempts,
  }, null, 2);
}
