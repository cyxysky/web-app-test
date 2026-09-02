import { randomUUID } from 'node:crypto';
import { generateText, hasToolCall, streamText, ToolLoopAgent, tool, type ModelMessage, type StopCondition, type ToolCallRepairFunction, type ToolSet } from 'ai';
import { z } from 'zod';
import { CapabilityRegistry, type CapabilityProgressEvent } from '@webpilot/capability-sdk';
import { fileCapabilityToolNames, type FileReadInput } from '@webpilot/capability-file';
import { browserCapabilityToolNames } from '@webpilot/capability-browser';
import { chartCapabilityToolNames } from '@webpilot/capability-chart';
import { toAISDKToolSet } from '@webpilot/capability-adapter-ai-sdk';
import type { AiRequestSnapshot, AiToolContextSnapshot, BrowserOperationRecord, StepExecutionResult, StepToolCall, VisualFrameRecord } from '@/server/ai/schemas/runtime.schema';
import { getModel, getModelSettings } from '@/server/ai/model';
import { aiMaxOutputTokens, aiReasoningEffort, aiRuntimeRequestTimeoutMs, aiStreamTimeouts, aiTelemetry, createAiRequestWatchdog } from '@/server/ai/ai-sdk-runtime';
import { structuredLog } from '@/server/observability/runtime-observability';
import { buildCodexObjectPrompt, currentRuntimeTimePromptLine, customRuntimePromptFromEnv } from '@/server/ai/prompts/runtime-agent.prompt';
import {
  BrowserSession,
  type BrowserActionResult,
} from '@webpilot/capability-browser/node';
import {
  readBrowserStateCode,
  type BrowserCodeAttachmentBinding,
  type BrowserCodeCredentialBinding,
} from '@webpilot/capability-browser/node';
import { richTextToPlainText } from '@/lib/rich-text';
import {
  aiSdkEmptyStopRequiresRetry,
  aiSdkFinishMessage,
  aiSdkFinishState,
  aiSdkToolResultRequiresContinuation,
} from './ai-sdk-finish-state';
import { browserCodeServiceFileDeliveryViolation } from './browser-chat-file-delivery';
import { fileArtifactRuntimeSkillId } from '@webpilot/capability-file/runtime-skill';
import {
  activeBrowserRuntimeSkillId,
  hiddenRuntimeSkillContent,
  automaticallyLoadHiddenRuntimeSkill,
  hiddenRuntimeSkillIdsReadFromTraces,
  runtimeToolTypesWithAutomaticSkills,
} from './hidden-runtime-skills';
import { subagentRuntimeSkillId } from './subagent-runtime-skill';
import { chartRuntimeSkillId } from '@webpilot/capability-chart/runtime-skill';
import {
  browserChatChartCapability,
  executeBrowserChatChart,
} from '@/server/capabilities/browser-chat-chart';
import { capabilityResultToBrowserActionResult } from '@/server/capabilities/browser-chat-result';
import {
  createBrowserChatFileCapability,
  executeBrowserChatFile,
} from '@/server/capabilities/browser-chat-file';
import { createBrowserChatBrowserCapability } from '@/server/capabilities/browser-chat-browser';
import {
  browserChatFinalBlocksToText,
  browserChatFinalResponseSchema,
  type BrowserChatFinalBlock,
} from '@/lib/browser-chat-ui-message';
import { containsPrivateToolProtocol, isBrowserChatDomObservationText, normalizeBrowserChatFinalReplyText } from './browser-chat-reply-text';
import {
  formatFileArtifactResult,
  pendingOfficeDocumentWork,
  pendingOfficeVisualQa,
} from '@webpilot/capability-file/node/workspace';
import { repairFileArtifactDownloadLinks } from '@/server/capabilities/browser-chat-file-links';
import { browserChatCodeRules } from './runtime-prompt-rules';
import {
  appendRuntimePromptCacheMetadata,
  isRuntimePromptCacheMetadataMessage,
  runtimeCurrentTimeMarker,
  runtimeOperationalContextMarker,
  withoutRuntimePromptCacheMetadata,
} from './runtime-prompt-cache';
import { readScreenshotForAi } from './browser-chat-image-input';
import { summarizeRuntimeLogTimings } from './runtime-log-timings';
import {
  attachRuntimeFailureRecovery,
  cloneRuntimeRetryState,
  runtimeFailureRecoveryFromError,
  type RuntimeRetryState as RuntimeRetryStateBase,
} from './runtime-retry-state';
import {
  classifyRuntimeRetry,
  isProviderBillingLimitMessage,
  runtimeMissingToolCallId,
  runtimeExecutionDetails,
  runtimeExecutionIdentity,
  runtimeRetryDelayMs,
  waitForRuntimeRetry,
  type RuntimeExecutionIdentity,
  type RuntimeRetryDecision,
} from './runtime-retry-policy';

import {
  browserToolPrerequisiteNames,
  browserStatePrerequisiteToolName,
  isBrowserHumanVerificationCall,
  requiresBrowserStatePreflight,
  runtimeAllowedToolTypes,
  runtimeBrowserSessionToolNames,
  runtimeToolRequiresBrowserSession,
  runtimeToolLoopStopToolNames,
} from './runtime-tool-selection';
import { browserToolApprovalRequest } from './browser-tool-approval';
import { withToolFailureGuidance } from './runtime-tool-failure-guidance';
import {
  estimateRuntimeMessageContext,
  estimateRuntimeTextTokens,
  runtimeContextCompressionTargetCeilingRatio,
  runtimeContextCompressionTargetFloorRatio,
  runtimeContextCompressionThresholdRatio,
  runtimeContextWindowTokens,
} from './runtime-context-budget';
import {
  appendTerminalBrowserChatTurn,
  type BrowserChatModelContextCompression,
} from './browser-chat-model-context';
import {
  atomicRuntimeModelMessageBlocks,
  buildRuntimeContinuationSummaryPrompt,
  completeRuntimeModelToolChain,
  ensureRuntimeContinuationSummaryMessage,
  fallbackRuntimeContinuationSummary,
  mergeRuntimeModelMessageChain,
  normalizeRuntimeContinuationSummary,
  omitRuntimeModelToolExchange,
  sanitizeRuntimeContinuationSummary,
  selectRecentRuntimeMessageBlocks,
  runtimeContinuationDirectiveMarker,
  runtimeContinuationSummaryMarker,
} from './runtime-context-compression';
import {
  isEffectiveToolTraceFailure,
  notifyRuntimeToolTrace,
  runtimeToolTraceId,
} from './runtime-tool-trace';
import {
  normalizeBrowserChatSubagentTasks,
  type BrowserChatSubagentTask,
} from './browser-chat-subagent-task';
import {
  coerceBrowserChatToolInput,
  repairBrowserChatToolCallInput,
} from './browser-chat-tool-input-coercion';
import { racePromiseWithAbort } from './browser-chat-interrupt-state';
import type { FileVisualInput as BrowserChatFileVisualInput } from '@webpilot/capability-file/node';
import { createBrowserChatDefectReport } from '@/server/storage/browser-chat-defect-store';

export type { BrowserChatSubagentTask } from './browser-chat-subagent-task';

type ExecutionDebug = (event: { phase: string; message: string; stepIndex?: number; details?: unknown }) => void | Promise<void>;
type RuntimeModelMessage = ModelMessage;
type RuntimeRetryState = RuntimeRetryStateBase<RuntimeModelMessage>;

export type BrowserChatReadFileInput = FileReadInput;

export type BrowserChatReadSkill = (skillId: string) => Promise<BrowserActionResult>;

export type BrowserChatTextStreamUpdate = {
  delta: string;
  stepNumber: number;
  text: string;
};

type ToolTrace = {
  id?: string;
  name: string;
  input: unknown;
  result?: BrowserActionResult;
  recovered?: boolean;
  transient?: boolean;
  startedAt?: number;
  completedAt?: number;
  elapsedMs?: number;
  aiRequestElapsedMs?: number;
  actionElapsedMs?: number;
  postprocessTimings?: Record<string, number>;
  progress?: StepToolCall['progress'];
  contextBefore?: AiToolContextSnapshot;
  contextAfter?: AiToolContextSnapshot;
  screenshots?: Array<{
    title: string;
    path: string;
    kind?: 'current' | 'history' | 'pinned' | 'after' | 'marker' | 'original' | 'other';
  }>;
};

type ToolTraceProgress = {
  visualContext: ReturnType<VisualContextManager['snapshot']>;
};

type BrowserChatSafetyMode = 'strict' | 'full';

export type BrowserToolConfirmationDecision = 'confirmed' | 'cancelled';

export type BrowserToolConfirmationRequest = {
  toolName: string;
  input: unknown;
  reason?: string;
  prompt: string;
  stepIndex?: number;
};

export type BrowserChatSubagentRunner = (
  tasks: BrowserChatSubagentTask[],
  abortSignal?: AbortSignal,
  toolCallId?: string,
) => Promise<BrowserActionResult>;

export type BrowserChatSubagentReader = (
  uuid: string,
) => Promise<BrowserActionResult>;

type RuntimeDecision = {
  action: string;
  expected: string;
  actual: string;
  status: 'passed' | 'failed' | 'blocked';
  note?: string;
};

type BrowserChatRuntimeRecord = {
  description: string;
  targetUrl: string;
  systemPrompt: string;
};

type BrowserChatOperationalContext = {
  operationalContext: string;
  credentialBindings?: BrowserCodeCredentialBinding[];
};

type BrowserAgentRuntimeContext = {
  operationalContext: string;
  credentialRefs: string[];
  visualContext: ReturnType<VisualContextManager['snapshot']>;
};

const codexRuntimeObjectSchema = z.object({
  type: z.string().min(1).describe('Allowed tool type to execute, or answer when the current browser-chat request is complete.'),
  message: z.string().nullable().optional().describe('Optional short Chinese progress text that must match the selected tool.'),
  params: z.object({
    reason: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    urlOrPath: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    instruction: z.string().nullable().optional(),
    documentId: z.string().nullable().optional(),
    artifactId: z.string().nullable().optional(),
    screenshotIds: z.array(z.string()).nullable().optional(),
    fileName: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
    maxMs: z.number().nullable().optional(),
    action: z.string().nullable().optional(),
    tasks: z.array(z.object({
      title: z.string().min(1).max(160),
      instruction: z.string().min(1).max(4_000),
      url: z.string().url().max(4_000),
    })).min(1).nullable().optional(),
    uuid: z.string().uuid().nullable().optional(),
    limit: z.number().nullable().optional(),
    offset: z.number().nullable().optional(),
    ids: z.array(z.string()).nullable().optional(),
    selectionReason: z.string().nullable().optional(),
    sameInterfaceGroup: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
    maxOutputChars: z.number().nullable().optional(),
    skillId: z.string().nullable().optional(),
  }).passthrough().describe('Parameters for the selected tool. Include only keys needed by that tool plus a concise reason. Tool-specific keys not listed in this common envelope are preserved. Example file parameters: {"action":"plan","documentId":"xsbn-5d-yxg-guide","fileName":"西双版纳5日游攻略-野象谷周边.pptx","documentType":"presentation","operation":"create","intent":"创建一份西双版纳5日游攻略演示文稿"}. The browser tool uses action=state|code|waitForHumanVerification.'),
}).describe('Return exactly one object with type, optional message, and params. Example: {"type":"file","message":"准备演示文稿","params":{"action":"plan","documentId":"xsbn-5d-yxg-guide","fileName":"西双版纳5日游攻略-野象谷周边.pptx","documentType":"presentation","operation":"create","intent":"创建一份西双版纳5日游攻略演示文稿"}}.');
type CodexRuntimeObject = z.infer<typeof codexRuntimeObjectSchema>;

// 判断当前模型配置是否支持图片输入；这只是模型能力判断，不代表一定会发送截图。
function modelSupportsImageInput() {
  return getModelSettings().supportsImageInput;
}

function finiteContextStat(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function toolContextFromStats(
  stats: unknown,
  aiRequest?: Pick<AiRequestSnapshot, 'createdAt' | 'id'>,
): AiToolContextSnapshot | undefined {
  const record = recordFromUnknown(stats);
  const snapshot: AiToolContextSnapshot = {
    requestId: aiRequest?.id,
    requestCreatedAt: aiRequest?.createdAt,
    estimatedTotalTokens: finiteContextStat(record.estimatedTotalTokens),
    estimatedTextTokens: finiteContextStat(record.estimatedTextTokens),
    estimatedImageTokens: finiteContextStat(record.estimatedImageTokens),
    estimatedToolSchemaTokens: finiteContextStat(record.estimatedToolSchemaTokens),
    imageCount: finiteContextStat(record.imageCount),
    method: typeof record.method === 'string' ? record.method : undefined,
  };
  return Object.values(snapshot).some((value) => value !== undefined) ? snapshot : undefined;
}

function toolContextFromAiRequest(aiRequest?: AiRequestSnapshot): AiToolContextSnapshot | undefined {
  if (!aiRequest) return undefined;
  return toolContextFromStats(aiRequest.options?.modelContextStats, aiRequest);
}

// 是否启用视觉候选标识。关闭时仍发送截图，但候选元素只以文本摘要进入 prompt。

// Default to inline marker labels so visual mode screenshots show interactive targets.

// 将调试数据转成可安全 JSON 序列化的结构，避免 Buffer/BigInt 破坏持久化。
function jsonSafe(value: unknown) {
  if (value === undefined) return undefined;
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function' || typeof item === 'symbol') return undefined;
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack,
      };
    }
    if (Buffer.isBuffer(item)) return `[Buffer ${item.length} bytes]`;
    if (item instanceof ArrayBuffer) return `[ArrayBuffer ${item.byteLength} bytes]`;
    if (ArrayBuffer.isView(item)) return `[${item.constructor.name || 'TypedArray'} ${(item as ArrayBufferView).byteLength} bytes]`;
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
  return serialized ? JSON.parse(serialized) : serialized;
}

// 纯标识图必须跟随原图最终发送尺寸缩放，否则两张图经过压缩后会失去像素对齐关系。

function trimDebugText(value: string, max = 4000) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function looksLikeDomSnapshot(value?: string) {
  const text = (value || '').trim();
  return isBrowserChatDomObservationText(text);
}

function providerToolSchemaError(value?: string) {
  return /Failed to deserialize the JSON body|unknown variant `?custom`?|invalid_request_error|AnthropicException|litellm\.BadRequestError/i.test(value || '');
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  const normalized = Number.isFinite(numberValue) ? Math.floor(numberValue) : fallback;
  return Math.min(Math.max(normalized, min), max);
}

function runtimeRequestConsecutiveFailureLimit() {
  return boundedInteger(process.env.AI_RUNTIME_REQUEST_RETRY_ATTEMPTS, 3, 1, 3);
}

function upstreamApiDisconnectReason(value?: string) {
  const text = value || '';
  const apiMatch = text.match(/Cannot connect to API:\s*([^\n]+)/i);
  if (apiMatch?.[1]) return apiMatch[1].trim();
  const genericMatch = text.match(/(?:other side closed|socket hang up|ECONNRESET|connection (?:closed|reset|terminated)|fetch failed)/i);
  return genericMatch?.[0];
}

function aiRequestFromError(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  return (error as { aiRequest?: AiRequestSnapshot }).aiRequest;
}

function runtimeRetryFromError(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  const retry = (error as { runtimeRetry?: unknown }).runtimeRetry;
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) return undefined;
  const record = retry as Record<string, unknown>;
  const retryAttempts = Number(record.retryAttempts);
  const maxRetryAttempts = Number(record.maxRetryAttempts);
  const consecutiveFailures = Number(record.consecutiveFailures ?? retryAttempts);
  const consecutiveFailureLimit = Number(record.consecutiveFailureLimit ?? maxRetryAttempts);
  if (!Number.isFinite(consecutiveFailures) || !Number.isFinite(consecutiveFailureLimit)) return undefined;
  const decision = record.decision && typeof record.decision === 'object' && !Array.isArray(record.decision)
    ? record.decision as Record<string, unknown>
    : undefined;
  return {
    consecutiveFailures: Math.max(0, Math.floor(consecutiveFailures)),
    consecutiveFailureLimit: Math.max(1, Math.floor(consecutiveFailureLimit)),
    retryable: decision?.retryable === true,
  };
}

function diagnosticValueText(value: unknown, max = 900) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() ? trimDebugText(value.trim(), max) : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return trimDebugText(JSON.stringify(value), max);
  } catch {
    return trimDebugText(String(value), max);
  }
}

function aiRequestBrief(aiRequest?: AiRequestSnapshot) {
  if (!aiRequest) return undefined;
  const agentStepIndex = aiRequest.options?.agentStepIndex;
  return [
    aiRequest.id ? `requestId=${aiRequest.id}` : '',
    aiRequest.provider ? `provider=${aiRequest.provider}` : '',
    aiRequest.model ? `model=${aiRequest.model}` : '',
    `stepIndex=${aiRequest.stepIndex}`,
    typeof agentStepIndex === 'number' ? `agentStep=${agentStepIndex}` : '',
  ].filter(Boolean).join(', ');
}

function upstreamDisconnectLines(
  reason: string,
  text: string,
  context?: { error?: unknown; aiRequest?: AiRequestSnapshot },
) {
  const error = context?.error;
  const aiRequest = context?.aiRequest || aiRequestFromError(error);
  const requestBrief = aiRequestBrief(aiRequest);
  const retryInfo = runtimeRetryFromError(error);
  const code = firstErrorString(error, 'code');
  const status = firstErrorValue(error, 'status') ?? firstErrorValue(error, 'statusCode');
  const causeMessage = errorCauseMessage(error);
  const responseBody = firstErrorDisplay(error, 'responseBody', 1200)
    || firstErrorDisplay(error, 'body', 1200)
    || firstErrorDisplay(error, 'data', 1200);
  const technical = [
    code ? `code=${code}` : '',
    status !== undefined ? `status=${diagnosticValueText(status, 120)}` : '',
    causeMessage ? `cause=${trimDebugText(causeMessage, 600)}` : '',
    responseBody ? `responseBody=${responseBody}` : '',
  ].filter(Boolean).join('; ');
  const raw = trimDebugText(text, 1200);
  const lines = [
    `网关返回原因：${reason}`,
    requestBrief ? `请求信息：${requestBrief}` : '',
    retryInfo ? `重试信息：连续失败 ${retryInfo.consecutiveFailures} 次，达到上限 ${retryInfo.consecutiveFailureLimit} 次；仍然失败。` : '',
    technical ? `技术细节：${technical}` : '',
    raw ? `原始错误：${raw}` : '',
  ].filter(Boolean);
  if (!code && status === undefined && !causeMessage && !responseBody) {
    lines.push('补充：上游只返回了连接被对端关闭，未返回 HTTP 状态码或响应体。');
  }
  return lines;
}

function userFacingInfrastructureError(value?: string, context?: { error?: unknown; aiRequest?: AiRequestSnapshot }) {
  const text = value || '';
  const retryInfo = runtimeRetryFromError(context?.error);
  if (isProviderBillingLimitMessage(text)) {
    const status = firstErrorValue(context?.error, 'status') ?? firstErrorValue(context?.error, 'statusCode') ?? 429;
    const reason = trimDebugText(text.split(/\r?\n/, 1)[0] || text, 600);
    return `上游 AI 服务返回 ${status}：${reason}\n这是套餐或额度耗尽，不会进行无效重试。本轮操作已停止，当前页面状态已保留。`;
  }
  const upstreamReason = upstreamApiDisconnectReason(text);
  if (upstreamReason) {
    return [
      '上游 AI 服务连接已断开。',
      ...upstreamDisconnectLines(upstreamReason, text, context),
      '本轮操作已停止，当前页面状态已保留。',
    ].join('\n');
  }
  if (/AI SDK returned retryable finish reason "(?:error|other)"/i.test(text)) {
    const attempts = retryInfo
      ? `连续 ${retryInfo.consecutiveFailures} 次，达到上限 ${retryInfo.consecutiveFailureLimit} 次`
      : '达到请求级重试上限';
    return `AI SDK ${attempts}返回错误结束状态。本轮操作已停止，当前页面状态已保留。`;
  }
  if (providerToolSchemaError(text)) return 'AI 模型请求失败：当前模型网关不兼容本轮工具调用格式。本轮操作已停止，当前页面状态已保留。';
  if (/Request aborted|operation interrupted/i.test(text)) return '本轮 AI 请求被中断，未继续写入技术错误。';
  if (/timed out|timeout/i.test(text)) return 'AI 请求在请求级重试后仍然超时。本轮操作已停止，当前页面状态已保留。';
  if (/No capacity available|rate limit/i.test(text)) return 'AI 服务在请求级重试后仍然不可用。本轮操作已停止，当前页面状态已保留。';
  return 'AI 请求或响应处理在请求级重试后仍然失败。本轮操作已停止，当前页面状态已保留。';
}

function userFacingToolResult(name: string, result?: BrowserActionResult, _max = 360) {
  void _max;
  if (!result) return undefined;
  if (!result.ok && providerToolSchemaError(result.actual)) return userFacingInfrastructureError(result.actual);
  if (name === 'file' || name === 'downloadFile' || name === 'generateFile') return formatFileArtifactResult(name, result.actual);
  return result.actual;
}

function compactToolResultForModel(
  name: string,
  result: BrowserActionResult,
  input?: unknown,
): BrowserActionResult {
  const action = input && typeof input === 'object' && !Array.isArray(input)
    ? String((input as Record<string, unknown>).action || '')
    : '';
  const modelResult = { ...result };
  delete modelResult.snapshotId;
  if (name === 'browser' && action === 'code') delete modelResult.observation;
  if (modelResult.domChanges) {
    modelResult.domChanges = { ...modelResult.domChanges };
    delete modelResult.domChanges.snapshotId;
    if (name === 'browser' && action === 'code') delete modelResult.domChanges.observation;
  }
  delete modelResult.referenceImagePath;
  delete modelResult.referenceImagePaths;
  if (!modelResult.actual) return modelResult;
  // The trace/database retain the complete raw result. The model only needs a
  // compact, actionable representation; otherwise repeated Office validation
  // payloads and stack traces quickly dominate the conversation context.
  const fileResult = formatFileArtifactResult(name, modelResult.actual);
  if (fileResult) return { ...modelResult, actual: fileResult };
  if (name === 'file' && action === 'visualReport') {
    try {
      const payload = JSON.parse(modelResult.actual) as Record<string, unknown>;
      const kind = String(payload.kind || '');
      if (kind === 'file-visual-report') {
        const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
        return {
          ...modelResult,
          actual: JSON.stringify({
            kind,
            artifactId: payload.artifactId,
            fileName: payload.fileName,
            reportedScreenshotIds: reviews.flatMap((review) => (
              review && typeof review === 'object' && typeof (review as { screenshotId?: unknown }).screenshotId === 'string'
                ? [(review as { screenshotId: string }).screenshotId]
                : []
            )),
            reportedCount: reviews.length,
            instruction: payload.instruction,
            visualQa: payload.visualQa,
          }),
        };
      }
    } catch {
      // Keep the original result when this is not a structured visual-report payload.
    }
  }
  return modelResult;
}

function elapsedSince(startedAt: number) {
  return Date.now() - startedAt;
}

// 拆分工具参数和 AI 给出的调用原因，便于历史步骤里单独展示。
function splitToolInputAndReason(input: unknown) {
  const safeInput = jsonSafe(input);
  if (!safeInput || typeof safeInput !== 'object' || Array.isArray(safeInput)) {
    return { input: safeInput, reason: undefined };
  }
  const { reason, ...rest } = safeInput as Record<string, unknown>;
  const compactInput = Object.keys(rest).length ? rest : undefined;
  return {
    input: compactInput,
    reason: typeof reason === 'string' && reason.trim() ? trimDebugText(reason.trim(), 300) : undefined,
  };
}

async function requestBrowserToolApproval(input: {
  toolName: string;
  toolInput: unknown;
  stepIndex?: number;
  request?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
}) {
  if (!input.request) return 'not-applicable' as const;
  const approval = browserToolApprovalRequest({
    toolName: input.toolName,
    toolInput: input.toolInput,
  });
  if (!approval) return 'not-applicable' as const;
  const decision = await input.request({
    toolName: input.toolName,
    input: input.toolInput,
    reason: approval.reason,
    prompt: approval.prompt,
    stepIndex: input.stepIndex,
  });
  return decision === 'confirmed' ? 'approved' as const : 'denied' as const;
}

function parseJsonObjectText(text?: string) {
  const trimmed = (text || '').trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return undefined;
  try {
    const parsed = extractJson(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function toolNameLike(value?: string) {
  if (!value) return false;
  const names = new Set<string>(runtimeToolNames());
  return names.has(value);
}

function cleanDisplayText(value?: string) {
  const trimmed = (value || '').replace(/\s+/g, ' ').trim();
  if (!trimmed || /^无$|^none$/i.test(trimmed)) return undefined;
  if (looksLikeDomSnapshot(trimmed)) return undefined;
  if (parseJsonObjectText(trimmed)) return undefined;
  return trimmed;
}

function cleanFinalDisplayText(value?: string) {
  const trimmed = normalizeBrowserChatFinalReplyText(value);
  if (!trimmed || /^无$|^none$/i.test(trimmed)) return undefined;
  if (looksLikeDomSnapshot(trimmed)) return undefined;
  if (parseJsonObjectText(trimmed)) return undefined;
  return trimmed;
}

function readableTextFromToolRecord(record: Record<string, unknown>) {
  const preferredKeys = ['reason', 'targetVisual', 'action', 'actual'];
  for (const key of preferredKeys) {
    const value = typeof record[key] === 'string' ? cleanDisplayText(record[key] as string) : undefined;
    if (!value || toolNameLike(value)) continue;
    return value;
  }
  return undefined;
}

function readableActionFromRawText(value?: string) {
  const parsed = parseJsonObjectText(value);
  if (parsed) return readableTextFromToolRecord(parsed);
  const cleaned = cleanDisplayText(value);
  if (!cleaned || toolNameLike(cleaned)) return undefined;
  return cleaned;
}

function readableActionFromTrace(trace?: ToolTrace) {
  if (!trace?.input || typeof trace.input !== 'object' || Array.isArray(trace.input)) return undefined;
  return readableTextFromToolRecord(trace.input as Record<string, unknown>);
}

function toolConsistentAssistantText(value: string | undefined, toolName?: string) {
  void toolName;
  return readableActionFromRawText(value) || '';
}

function alignCodexRuntimeObjectTool(object: CodexRuntimeObject, allowedTypes: string[]) {
  void allowedTypes;
  return object;
}

function browserChatAbortError(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error('Browser chat operation interrupted by user.');
}

function isBrowserChatAbortError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  const text = error instanceof Error ? `${error.name}\n${error.message}` : String(error || '');
  return /Browser chat (?:operation interrupted|session (?:closed|deleted)) by user|operation interrupted by user/i.test(text);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw browserChatAbortError(signal);
}

function throwIfStopped(signal?: AbortSignal, shouldContinue?: () => boolean) {
  throwIfAborted(signal);
  if (shouldContinue && !shouldContinue()) throw browserChatAbortError(signal);
}

// 从模型回复中提取 JSON，兼容模型把 JSON 包在 markdown 代码块里的情况。
function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] || text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI did not return JSON.');
  return JSON.parse(raw.slice(start, end + 1));
}

// 将测试需求富文本转为纯文本，作为执行器理解目标的主输入。
function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function codexRuntimeObjectFromText(text: string): CodexRuntimeObject {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = recordFromUnknown(extractJson(text));
  } catch {
    const fallbackText = trimDebugText((text || '').trim() || 'Codex did not return a valid action JSON.', 2000);
    return {
      type: 'answer',
      message: fallbackText,
      params: {
        content: fallbackText,
      },
    };
  }

  const rawRecord = raw || {};
  const params = recordFromUnknown(rawRecord.params);
  const candidate = {
    type: typeof rawRecord.type === 'string' && rawRecord.type.trim() ? rawRecord.type.trim() : 'answer',
    message: typeof rawRecord.message === 'string' && rawRecord.message.trim() ? rawRecord.message.trim() : undefined,
    params,
  };
  const parsed = codexRuntimeObjectSchema.safeParse(candidate);
  return parsed.success ? parsed.data : candidate as CodexRuntimeObject;
}

function requirementOf(runtimeRecord: BrowserChatRuntimeRecord) {
  return richTextToPlainText(runtimeRecord.description) || runtimeRecord.description;
}

function systemPromptOf(runtimeRecord: BrowserChatRuntimeRecord) {
  return richTextToPlainText(runtimeRecord.systemPrompt || '').trim();
}

// 将浏览器工具调用轨迹压缩为步骤证据，保存到运行历史中。
const browserChatDefaultSystemPrompt = 'This is an interactive browser chat. Operate from the live page and answer the latest user message in Chinese.';

function browserChatSystemPromptForRuntime(value: string) {
  return value.replace(browserChatDefaultSystemPrompt, '').trim();
}

function summarizeToolTraces(traces: ToolTrace[]): StepToolCall[] {
  return traces.map((trace) => {
    const { input, reason } = splitToolInputAndReason(trace.input);
    return {
      id: trace.id,
      name: trace.name,
      input,
      reason,
      ok: trace.result?.ok,
      recovered: trace.recovered,
      transient: trace.transient,
      result: userFacingToolResult(trace.name, trace.result, 360),
      rawResult: trace.result,
      elapsedMs: trace.elapsedMs,
      aiRequestElapsedMs: trace.aiRequestElapsedMs,
      progress: trace.progress,
      contextBefore: trace.contextBefore,
      contextAfter: trace.contextAfter,
      screenshots: trace.screenshots,
    };
  });
}

const codexFinalResponsePrefix = '__WEBPILOT_FINAL_RESPONSE__:';

function finalResponseFromTraces(traces: ToolTrace[]) {
  for (const trace of [...traces].reverse()) {
    if (trace.name !== 'finalResponse' || trace.result?.ok !== true) continue;
    const parsed = browserChatFinalResponseSchema.safeParse(trace.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function finalResponseFromText(value: string) {
  if (!value.startsWith(codexFinalResponsePrefix)) return undefined;
  try {
    const parsed = browserChatFinalResponseSchema.safeParse(JSON.parse(value.slice(codexFinalResponsePrefix.length)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function subagentUuidsFromToolResult(result?: BrowserActionResult) {
  if (!result?.ok) return [];
  const parsed = parseJsonObjectText(result.actual);
  const subagents = Array.isArray(parsed?.subagents) ? parsed.subagents : [];
  return subagents.flatMap((item) => {
    const record = recordFromUnknown(item);
    const uuid = typeof record.uuid === 'string' ? record.uuid.trim() : '';
    return uuid ? [uuid] : [];
  });
}

function pendingSubagentUuidsFromTraces(traces: ToolTrace[]) {
  const spawned: string[] = [];
  const read = new Set<string>();
  for (const trace of traces) {
    const input = recordFromUnknown(trace.input);
    if (trace.name === 'spawnSubagents' || (trace.name === 'subagent' && input.action === 'spawn')) {
      for (const uuid of subagentUuidsFromToolResult(trace.result)) {
        if (!spawned.includes(uuid)) spawned.push(uuid);
      }
      continue;
    }
    if (!(trace.name === 'readSubagent' || (trace.name === 'subagent' && input.action === 'read')) || !trace.result?.ok) continue;
    const uuid = typeof input.uuid === 'string' ? input.uuid.trim() : '';
    if (uuid) read.add(uuid);
  }
  return spawned.filter((uuid) => !read.has(uuid));
}

function pendingSubagentUuidsFromSteps(steps: StepExecutionResult[]) {
  const spawned: string[] = [];
  const read = new Set<string>();
  for (const step of steps) {
    for (const toolCall of step.tools || []) {
      const rawResult = toolCall.rawResult && typeof toolCall.rawResult === 'object' && !Array.isArray(toolCall.rawResult)
        ? toolCall.rawResult as BrowserActionResult
        : undefined;
      const input = recordFromUnknown(toolCall.input);
      if (toolCall.name === 'spawnSubagents' || (toolCall.name === 'subagent' && input.action === 'spawn')) {
        for (const uuid of subagentUuidsFromToolResult(rawResult)) {
          if (!spawned.includes(uuid)) spawned.push(uuid);
        }
        continue;
      }
      if (!(toolCall.name === 'readSubagent' || (toolCall.name === 'subagent' && input.action === 'read')) || rawResult?.ok !== true) continue;
      const uuid = typeof input.uuid === 'string' ? input.uuid.trim() : '';
      if (uuid) read.add(uuid);
    }
  }
  return spawned.filter((uuid) => !read.has(uuid));
}

function requiredSubagentReadDirective(uuid: string, remaining: number) {
  return [
    '[Required child Agent result read]',
    `There are ${remaining} completed child Agent result(s) that have not been read.`,
    `In this model step, call subagent with action="read" and exactly this UUID: ${uuid}`,
    'Do not answer, synthesize, or call another tool until every returned child UUID has been read.',
  ].join('\n');
}

function upsertToolTrace(traces: ToolTrace[], trace: ToolTrace) {
  const index = trace.id ? traces.findIndex((item) => item.id === trace.id) : -1;
  if (index >= 0) traces[index] = trace;
  else traces.push(trace);
}

function concise(value?: string, max = 220) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatCurrentToolAttemptSummary(traces: ToolTrace[], limit = 5) {
  const recent = traces.slice(-limit);
  if (!recent.length) return '[none]';
  return recent.map((trace, index) => {
    const { reason } = splitToolInputAndReason(trace.input);
    const fileResult = trace.result?.ok ? formatFileArtifactResult(trace.name, trace.result.actual) : undefined;
    const status = !trace.result
      ? 'running'
      : trace.result.ok
        ? fileResult ? `ok: ${sanitizeHistoricalToolText(fileResult, 260)}` : 'ok'
        : `failed: ${sanitizeHistoricalToolText(trace.result.actual, 180)}`;
    const screenshotNames = trace.name === 'browser'
      && splitToolInputAndReason(trace.input).input.action === 'code'
      ? browserCodeScreenshotFileNames((trace.screenshots || []).map((screenshot) => screenshot.path))
      : [];
    const shots = screenshotNames.length
      ? `; screenshotFileNames=${JSON.stringify(screenshotNames)}`
      : trace.screenshots?.length ? `; screenshots=${trace.screenshots.length}` : '';
    const why = reason ? `; reason=${sanitizeHistoricalToolText(reason, 140)}` : '';
    return `${index + 1}. ${trace.name}: ${status}${why}${shots}`;
  }).join('\n');
}

function agentStepLabel(stepIndex: number) {
  return String(stepIndex + 1);
}

function continuationRuntimeStateFromTraces(traces: ToolTrace[]) {
  const finished = traces.filter((trace) => trace.result);
  const completed = finished
    .filter((trace) => trace.result?.ok)
    .slice(-12)
    .map((trace) => summarizeTraceForContinuation(trace));
  const blockers = finished
    .filter((trace) => isEffectiveToolTraceFailure(trace))
    .slice(-8)
    .map((trace) => concise(trace.result?.actual || '', 220));
  const last = finished.at(-1);
  const lastResult = last ? concise(userFacingToolResult(last.name, last.result, 400) || last.result?.actual || '', 240) : '';
  return {
    completed,
    findings: completed,
    blockers,
    currentState: last ? `${last.name}: ${lastResult}` : '',
    lastAction: last ? summarizeTraceForContinuation(last) : '',
    lastResult,
    nextStep: 'Continue from the latest live browser state and the newest tool result.',
  };
}


function imageTokenEstimatePerImage() {
  return Math.max(0, Number(process.env.AI_IMAGE_CONTEXT_ESTIMATE_TOKENS || 1200));
}

function sanitizeHistoricalToolText(value: unknown, max = 180) {
  if (typeof value !== 'string') return '';
  return concise(
    value
      .replace(/\b(?:candidate|Candidate)\s*#?\s*\d+\b/g, 'current screenshot target')
      .replace(/候选\s*\d+/g, '当前截图中的目标标识')
      .replace(/\b(?:areaId|id|fromId|toId)\s*=\s*["']?[^,\s)]+/gi, '$1=[current]')
      .replace(/\bS\d+\b/g, '当前截图中的滚动区域')
      .replace(/\bbox=\d+,\d+,\d+x\d+/gi, '')
      .replace(/\bat\s*\(\d+\s*,\s*\d+\)/gi, 'at the visible center')
      .replace(/\b(deltaX|deltaY|x|y)\s*=\s*-?\d+(?:\.\d+)?/gi, '$1=[current]')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  );
}

function summarizeTraceForContinuation(trace: ToolTrace) {
  const input = trace.input && typeof trace.input === 'object' && !Array.isArray(trace.input)
    ? trace.input as Record<string, unknown>
    : {};
  const { reason } = splitToolInputAndReason(input);
  const semanticAction = [
    typeof input.action === 'string' ? input.action : '',
    reason || '',
    typeof input.targetVisual === 'string' ? input.targetVisual : '',
    typeof input.expected === 'string' ? input.expected : '',
  ].map((item) => item.trim()).find((item): item is string => Boolean(item));
  const displayResult = userFacingToolResult(trace.name, trace.result, trace.result?.ok ? 160 : 180);
  const result = !trace.result
    ? 'running'
    : trace.result.ok
    ? sanitizeHistoricalToolText(displayResult, 160) || 'ok'
    : `failed: ${sanitizeHistoricalToolText(displayResult || trace.result.actual, 180)}`;
  return [
    `上一动作：${trace.name}${semanticAction ? ` - ${sanitizeHistoricalToolText(semanticAction, 180)}` : ''}`,
    `结果：${result}`,
  ].join('；');
}

function toolTraceStatus(trace: ToolTrace) {
  if (!trace.result) return 'started';
  return trace.result.ok ? 'ok' : 'failed';
}

class VisualContextManager {
  private frames: VisualFrameRecord[] = [];
  private currentId?: string;
  private sequence = 0;

  constructor(private readonly maxHistory = Number(process.env.AI_VISUAL_HISTORY_LIMIT || 6)) {}

  append(frame: Omit<VisualFrameRecord, 'id' | 'role' | 'createdAt'>) {
    this.demoteCurrent();
    const record = this.createFrame(frame, 'current');
    this.frames.push(record);
    this.currentId = record.id;
    this.trim();
    return record;
  }


  current() {
    return this.frames.find((frame) => frame.id === this.currentId);
  }

  snapshot() {
    return {
      current: this.current(),
      history: this.frames.filter((frame) => frame.id !== this.currentId),
    };
  }



  private createFrame(frame: Omit<VisualFrameRecord, 'id' | 'role' | 'createdAt'>, role: VisualFrameRecord['role']) {
    this.sequence += 1;
    return {
      ...frame,
      id: `vf-${this.sequence}`,
      role,
      createdAt: new Date().toISOString(),
    };
  }

  private demoteCurrent() {
    this.frames = this.frames.map((frame) => frame.id === this.currentId && frame.role === 'current'
      ? { ...frame, role: 'history' }
      : frame);
  }

  private trim() {
    const pinned = this.frames.filter((frame) => frame.role === 'pinned');
    const current = this.current();
    const history = this.frames
      .filter((frame) => frame.role !== 'pinned' && frame.id !== this.currentId)
      .slice(-this.maxHistory);
    this.frames = [...history, ...pinned, ...(current ? [current] : [])];
  }
}

function pushFailureFrameScreenshots(screenshots: ToolTrace['screenshots'], name: string, frame?: VisualFrameRecord) {
  if (!frame?.path) return;
  screenshots?.push({ title: `${name} failure evidence`, path: frame.path, kind: 'other' });
  if (frame.originalPath) screenshots?.push({ title: `${name} failure original`, path: frame.originalPath, kind: 'original' });
  if (frame.markerPath) screenshots?.push({ title: `${name} marker map`, path: frame.markerPath, kind: 'marker' });
}

const internalReferenceImageToolNames = new Set([
  'file',
  'readFile',
  'generateFile',
]);

function createToolTrace(input: {
  traces: ToolTrace[];
  name: string;
  toolInput: unknown;
  toolCallId?: string;
  aiRequest?: AiRequestSnapshot;
  aiRequestElapsedMs?: number;
  runId?: string;
  stepIndex?: number;
}) {
  const { traces, name, toolInput, toolCallId, aiRequest, aiRequestElapsedMs, runId, stepIndex } = input;
  const existing = toolCallId ? traces.find((trace) => trace.id === toolCallId) : undefined;
  if (existing) {
    existing.name = name;
    existing.input = toolInput;
    existing.startedAt ??= Date.now();
    existing.aiRequestElapsedMs ??= aiRequestElapsedMs;
    existing.contextBefore ??= toolContextFromAiRequest(aiRequest);
    existing.screenshots ??= [];
    return existing;
  }
  const screenshots: ToolTrace['screenshots'] = [];
  const traceId = toolCallId || runtimeToolTraceId({ runId, stepIndex, traceIndex: traces.length + 1 });
  const trace: ToolTrace = {
    id: traceId,
    name,
    input: toolInput,
    startedAt: Date.now(),
    aiRequestElapsedMs,
    contextBefore: toolContextFromAiRequest(aiRequest),
    screenshots,
  };
  traces.push(trace);
  return trace;
}

async function finalizeToolTraceVisuals(input: {
  trace: ToolTrace;
  result: BrowserActionResult;
  stepIndex?: number;
  visualContext?: VisualContextManager;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
}) {
  const { trace, stepIndex, visualContext, abortSignal, shouldContinue, onVisualContextChange } = input;
  throwIfStopped(abortSignal, shouldContinue);
  const result = input.result;
  const screenshots = trace.screenshots || [];
  const emittedImagePaths = result.referenceImagePaths?.length
    ? result.referenceImagePaths
    : result.referenceImagePath ? [result.referenceImagePath] : [];
  if (!internalReferenceImageToolNames.has(trace.name)) {
    for (const [index, imagePath] of emittedImagePaths.entries()) {
      if (!screenshots.some((item) => item.path === imagePath)) {
        screenshots.push({
          title: `${trace.name} explicit image ${index + 1}`,
          path: imagePath,
          kind: index === emittedImagePaths.length - 1 ? 'current' : 'history',
        });
      }
    }
  }
  if (result.ok && emittedImagePaths.length && visualContext) {
    const toolInput = trace.input && typeof trace.input === 'object' && !Array.isArray(trace.input)
      ? trace.input as Record<string, unknown>
      : {};
    const capture = toolInput.capture === 'fullPage' ? 'fullPage' : 'viewport';
    visualContext.append({
      path: emittedImagePaths.at(-1) || emittedImagePaths[0],
      stepIndex: stepIndex || 0,
      toolName: trace.name,
      capture,
      reason: `${trace.name} explicit visual evidence`,
    });
    await onVisualContextChange?.(visualContext.snapshot());
  } else if (!result.ok && visualContext && runtimeToolRequiresBrowserSession(trace.name)) {
    pushFailureFrameScreenshots(screenshots, trace.name, visualContext.current());
  }

  trace.result = result;
  trace.screenshots = screenshots;
  return result;
}

async function executeTracedBrowserAction(input: {
  traces: ToolTrace[];
  name: string;
  toolInput: unknown;
  toolCallId?: string;
  action: (abortSignal?: AbortSignal, trace?: ToolTrace) => Promise<BrowserActionResult>;
  aiRequest?: AiRequestSnapshot;
  aiRequestElapsedMs?: number;
  runId?: string;
  stepIndex?: number;
  visualContext?: VisualContextManager;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>;
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
}) {
  const { traces, name, toolInput, toolCallId, action, aiRequest, aiRequestElapsedMs, runId, stepIndex, visualContext, abortSignal, shouldContinue, onToolTrace, onVisualContextChange } = input;
  throwIfStopped(abortSignal, shouldContinue);
  const trace = createToolTrace({ traces, name, toolInput, toolCallId, aiRequest, aiRequestElapsedMs, runId, stepIndex });
  const postprocessTimings: Record<string, number> = {};
  trace.postprocessTimings = postprocessTimings;
  let postprocessStartedAt = Date.now();
  await notifyRuntimeToolTrace(onToolTrace, trace);
  postprocessTimings.notifyStartMs = elapsedSince(postprocessStartedAt);
  throwIfStopped(abortSignal, shouldContinue);

  let result: BrowserActionResult;
  const actionStartedAt = Date.now();
  try {
    result = await racePromiseWithAbort(action(abortSignal, trace), abortSignal);
    throwIfStopped(abortSignal, shouldContinue);
  } catch (error) {
    if (abortSignal?.aborted || (shouldContinue && !shouldContinue())) throw browserChatAbortError(abortSignal);
    result = {
      ok: false,
      actual: `Tool ${name} threw after execution started: ${infrastructureError(error)}`,
    };
  }
  result = withToolFailureGuidance(name, result);
  trace.actionElapsedMs = elapsedSince(actionStartedAt);

  throwIfStopped(abortSignal, shouldContinue);
  trace.result = result;
  postprocessStartedAt = Date.now();
  result = await finalizeToolTraceVisuals({
    trace,
    result,
    stepIndex,
    visualContext,
    abortSignal,
    shouldContinue,
    onVisualContextChange,
  });
  postprocessTimings.visualContextMs = elapsedSince(postprocessStartedAt);
  throwIfStopped(abortSignal, shouldContinue);
  trace.completedAt = Date.now();
  trace.elapsedMs = trace.startedAt ? trace.completedAt - trace.startedAt : undefined;
  postprocessStartedAt = Date.now();
  await notifyRuntimeToolTrace(onToolTrace, trace);
  postprocessTimings.notifyCompleteMs = elapsedSince(postprocessStartedAt);
  trace.completedAt = Date.now();
  trace.elapsedMs = trace.startedAt ? trace.completedAt - trace.startedAt : undefined;
  return result;
}

function initialBrowserStateCode() {
  return readBrowserStateCode;
}

async function readCurrentBrowserState(
  session: BrowserSession,
  options: { runId?: string; stepIndex?: number; abortSignal?: AbortSignal } = {},
): Promise<BrowserActionResult> {
  return session.executeBrowserCode({
    code: initialBrowserStateCode(),
    maxOutputChars: 40_000,
    runId: options.runId || 'browser-state',
    stepIndex: options.stepIndex || 0,
    abortSignal: options.abortSignal,
  });
}

function screenshotFileName(filePath: string) {
  return filePath.replace(/\\/g, '/').split('/').at(-1)?.trim() || '';
}

function browserCodeScreenshotFileNames(paths: string[]) {
  return [...new Set(paths.map(screenshotFileName).filter(Boolean))];
}

const reportDefectInputSchema = z.object({
  problemDescription: z.string().min(1).max(800).describe('A precise user-visible description of the observed defect.'),
  whyItIsAProblem: z.string().min(1).max(1_200).describe('Why the observed behavior harms correctness, usability, or task completion.'),
  reasons: z.array(z.string().min(1).max(500)).min(1).max(8).describe('Concrete evidence-based reasons that support classifying the behavior as a defect.'),
  reproductionSteps: z.array(z.string().min(1).max(500)).min(1).max(20).describe('Ordered steps that reproduce the defect from a known page state.'),
  screenshotFileNames: z.array(z.string().min(1).max(260).regex(/^[^\\/]+$/)).min(1).max(6).describe('One to six exact screenshot file names returned by prior successful browser action=code calls in this Agent run.'),
}).strict();

type ReportDefectInput = z.infer<typeof reportDefectInputSchema>;

function resolveDefectScreenshotEvidence(traces: ToolTrace[], requestedFileNames: string[]) {
  const candidates = new Map<string, { fileName: string; path: string }>();
  for (const trace of traces) {
    if (
      trace.name !== 'browser'
      || splitToolInputAndReason(trace.input).input.action !== 'code'
      || trace.result?.ok !== true
    ) continue;
    for (const screenshot of trace.screenshots || []) {
      if (screenshot.kind === 'marker') continue;
      const fileName = screenshotFileName(screenshot.path);
      if (fileName) candidates.set(fileName.toLocaleLowerCase(), { fileName, path: screenshot.path });
    }
  }
  const missing: string[] = [];
  const screenshots = requestedFileNames.flatMap((requested) => {
    const fileName = screenshotFileName(requested);
    const candidate = candidates.get(fileName.toLocaleLowerCase());
    if (!candidate) {
      missing.push(requested);
      return [];
    }
    return [candidate];
  });
  return {
    screenshots: [...new Map(screenshots.map((item) => [item.path, item])).values()],
    missing,
    availableFileNames: [...candidates.values()].map((item) => item.fileName),
  };
}

async function reportBrowserChatDefect(
  sessionId: string | undefined,
  traces: ToolTrace[],
  input: ReportDefectInput,
): Promise<BrowserActionResult> {
  if (!sessionId) return { ok: false, actual: 'reportDefect is unavailable because the conversation id is missing.' };
  const evidence = resolveDefectScreenshotEvidence(traces, input.screenshotFileNames);
  if (evidence.missing.length) {
    return {
      ok: false,
      actual: `Screenshot evidence rejected because these files were not emitted by a successful browser action=code call in this Agent run: ${evidence.missing.join(', ')}. Available screenshot file names: ${evidence.availableFileNames.join(', ') || '[none]'}.`,
    };
  }
  const report = await createBrowserChatDefectReport(sessionId, {
    problemDescription: input.problemDescription,
    whyItIsAProblem: input.whyItIsAProblem,
    reasons: input.reasons,
    reproductionSteps: input.reproductionSteps,
    screenshots: evidence.screenshots,
  });
  return {
    ok: true,
    actual: JSON.stringify({
      defectId: report.id,
      title: report.title,
      severity: report.severity,
      screenshotFileNames: report.screenshots.map((screenshot) => screenshot.fileName),
      stored: true,
    }),
  };
}

async function bundledBrowserToolPrerequisiteResults(input: {
  toolName: string;
  toolInput: unknown;
  preflightPending: boolean;
  session: BrowserSession;
  runId?: string;
  stepIndex?: number;
  abortSignal?: AbortSignal;
  ensureBrowserStarted?: () => Promise<void>;
}) {
  const prerequisiteNames = browserToolPrerequisiteNames(
    input.toolName,
    input.toolInput,
    input.preflightPending,
    runtimeBrowserSessionToolNames,
  );
  const results: NonNullable<BrowserActionResult['prerequisiteResults']> = [];

  for (const prerequisiteName of prerequisiteNames) {
    if (prerequisiteName !== browserStatePrerequisiteToolName) continue;
    await input.ensureBrowserStarted?.();
    results.push({
      toolName: prerequisiteName,
      result: await readCurrentBrowserState(input.session, {
        runId: input.runId,
        stepIndex: input.stepIndex,
        abortSignal: input.abortSignal,
      }),
    });
  }
  return results;
}

function attachPrerequisiteResults(
  result: BrowserActionResult,
  prerequisiteResults: NonNullable<BrowserActionResult['prerequisiteResults']>,
) {
  if (!prerequisiteResults.length) return result;
  return {
    ...result,
    prerequisiteResults: [
      ...prerequisiteResults,
      ...(result.prerequisiteResults || []),
    ],
  } satisfies BrowserActionResult;
}

async function makeBrowserTools(
  session: BrowserSession,
  traces: ToolTrace[],
  aiRequest?: AiRequestSnapshot,
  onToolTrace?: (trace: ToolTrace) => void | Promise<void>,
  referenceOptions?: {
    runId?: string;
    stepIndex?: number;
    allowedToolTypes?: string[];
    visualContext?: VisualContextManager;
    getAiRequest?: () => AiRequestSnapshot | undefined;
    getAiRequestElapsedMs?: (toolCallId?: string) => number | undefined;
    abortSignal?: AbortSignal;
    shouldContinue?: () => boolean;
    onDebug?: ExecutionDebug;
    onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
    requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
    runSubagents?: BrowserChatSubagentRunner;
    readSubagent?: BrowserChatSubagentReader;
    requiredSubagentUuid?: string;
    readFile?: (input: BrowserChatReadFileInput) => Promise<BrowserActionResult>;
    readFileVisuals?: (input: BrowserChatFileVisualInput) => Promise<BrowserActionResult>;
    readSkill?: BrowserChatReadSkill;
    onReferenceImage?: (input: { path: string; source: string }) => void;
    ensureBrowserStarted?: () => Promise<void>;
    attachmentBindings?: BrowserCodeAttachmentBinding[];
    credentialBindings?: BrowserCodeCredentialBinding[];
    getCredentialBindings?: () => BrowserCodeCredentialBinding[] | undefined;
    browserStatePreflightComplete?: () => boolean;
    loadedHiddenRuntimeSkillIds?: Set<string>;
  },
) {
  const imageInputAvailable = modelSupportsImageInput();
  const browserRuntimeSkillId = activeBrowserRuntimeSkillId();
  // Browser and document mutations stay ordered. Consecutive download calls are
  // independent and run as one concurrent batch; the next stateful tool waits
  // for that complete batch before it starts.
  let toolExecutionQueue = Promise.resolve();
  const activeConcurrentDownloads = new Set<Promise<BrowserActionResult>>();
  const loadedHiddenRuntimeSkillIds = referenceOptions?.loadedHiddenRuntimeSkillIds || new Set<string>();
  for (const skillId of hiddenRuntimeSkillIdsReadFromTraces(traces)) loadedHiddenRuntimeSkillIds.add(skillId);
  const toolTextRule = 'Do not include old tool params, candidate ids as business meaning, coordinates, screenshot ids/file names, or tool input JSON.';
  const toolReasonInput = z.string().min(1).max(300).describe(`Required: concise Chinese reason for this exact tool call. Name the visible target and expected page change; do not merely repeat a candidate ID. ${toolTextRule}`);
  const toolContextShape = {
    reason: toolReasonInput,
  };
  const withToolInputExamples = <TSchema extends z.ZodType>(
    schema: TSchema,
    examples: readonly Record<string, unknown>[],
  ): TSchema => {
    if (!examples.length) return schema;
    const exampleDescription = examples
      .map((example, index) => `Example ${index + 1}: ${JSON.stringify(example)}`)
      .join(' ');
    return schema
      .describe(`Valid tool parameter examples. ${exampleDescription}`)
      .meta({ examples: examples.map((example) => ({ ...example })) }) as TSchema;
  };
  const browserToolInput = <T extends z.ZodRawShape>(
    shape: T,
    examples: readonly Record<string, unknown>[] = [],
  ) => withToolInputExamples(z.object({ ...toolContextShape, ...shape }), examples);
  const fileProgressReporter = (trace?: ToolTrace) => async (progress: CapabilityProgressEvent) => {
    if (!trace) return;
    trace.progress = {
      ...progress,
      elapsedMs: trace.startedAt ? Date.now() - trace.startedAt : undefined,
    };
    await notifyRuntimeToolTrace(onToolTrace, trace);
  };
  async function record(
    name: string,
    input: unknown,
    action: (abortSignal?: AbortSignal, trace?: ToolTrace) => Promise<BrowserActionResult>,
    execution?: { abortSignal?: AbortSignal; toolCallId?: string },
  ) {
    const run = async () => {
      throwIfStopped(referenceOptions?.abortSignal, referenceOptions?.shouldContinue);
      const actionAfterBrowserStart = async (actionSignal?: AbortSignal, trace?: ToolTrace) => {
        const automaticSkill = automaticallyLoadHiddenRuntimeSkill(name, input, loadedHiddenRuntimeSkillIds);
        if (automaticSkill && 'ok' in automaticSkill) return automaticSkill;
        const attachAutomaticSkill = (result: BrowserActionResult) => automaticSkill?.loadedRuntimeSkill
          ? { ...result, loadedRuntimeSkill: automaticSkill.loadedRuntimeSkill }
          : result;
        const prerequisiteResults = await bundledBrowserToolPrerequisiteResults({
          toolName: name,
          toolInput: input,
          preflightPending: referenceOptions?.browserStatePreflightComplete
            ? !referenceOptions.browserStatePreflightComplete()
            : false,
          session,
          runId: referenceOptions?.runId,
          stepIndex: referenceOptions?.stepIndex,
          abortSignal: actionSignal,
          ensureBrowserStarted: referenceOptions?.ensureBrowserStarted,
        });
        if (runtimeToolRequiresBrowserSession(name)) await referenceOptions?.ensureBrowserStarted?.();
        const result = await action(actionSignal, trace);
        return attachAutomaticSkill(attachPrerequisiteResults(result, prerequisiteResults));
      };
      const traceVisualContext = referenceOptions?.visualContext;
      return executeTracedBrowserAction({
        traces,
        name,
        toolInput: input,
        toolCallId: execution?.toolCallId,
        runId: referenceOptions?.runId,
        stepIndex: referenceOptions?.stepIndex,
        visualContext: traceVisualContext,
        abortSignal: referenceOptions?.abortSignal,
        shouldContinue: referenceOptions?.shouldContinue,
        aiRequest: referenceOptions?.getAiRequest?.() || aiRequest,
        aiRequestElapsedMs: referenceOptions?.getAiRequestElapsedMs?.(execution?.toolCallId),
        onToolTrace,
        onVisualContextChange: traceVisualContext ? referenceOptions?.onVisualContextChange : undefined,
        action: actionAfterBrowserStart,
      }).then((result) => {
        const imagePaths = result.referenceImagePaths?.length
          ? result.referenceImagePaths
          : result.referenceImagePath ? [result.referenceImagePath] : [];
        const action = input && typeof input === 'object' && 'action' in input
          ? String((input as { action?: unknown }).action || '')
          : '';
        const source = name === 'file' && action
          ? `${name}:${action}`
          : name;
        const screenshotIds = name === 'file' && action === 'visualRead' && input && typeof input === 'object' && 'screenshotIds' in input
          ? (input as { screenshotIds?: unknown }).screenshotIds
          : undefined;
        // A render can produce every page preview at once. Those files are
        // indexed evidence, not implicit model attachments: visualRead attaches
        // only the requested pages in bounded batches.
        if (!(name === 'file' && action === 'render')) {
          for (const [index, path] of [...new Set(imagePaths)].entries()) {
            const screenshotId = Array.isArray(screenshotIds) && typeof screenshotIds[index] === 'string'
              ? screenshotIds[index]
              : undefined;
            referenceOptions?.onReferenceImage?.({ path, source: screenshotId ? `${source}:${screenshotId}` : source });
          }
        }
        const resultForModel = name === 'browser' && action === 'code' && imagePaths.length
          ? { ...result, screenshotFileNames: browserCodeScreenshotFileNames(imagePaths) }
          : result;
        return compactToolResultForModel(name, resultForModel, input);
      });
    };
    const inputAction = input && typeof input === 'object' && 'action' in input
      ? String((input as { action?: unknown }).action || '')
      : '';
    const concurrentDownload = name === 'downloadFile' || (name === 'file' && inputAction === 'download');
    if (concurrentDownload) {
      const pending = toolExecutionQueue.then(run, run);
      activeConcurrentDownloads.add(pending);
      pending.finally(() => activeConcurrentDownloads.delete(pending)).catch(() => undefined);
      return pending;
    }
    const precedingDownloads = [...activeConcurrentDownloads];
    const waitForDownloads = () => Promise.allSettled(precedingDownloads).then(() => undefined);
    const queued = toolExecutionQueue.then(waitForDownloads, waitForDownloads).then(run, run);
    toolExecutionQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  const capabilitySnapshot = await new CapabilityRegistry()
    .register(createBrowserChatBrowserCapability({
      session,
      runId: referenceOptions?.runId || '',
      stepIndex: referenceOptions?.stepIndex,
      attachmentBindings: referenceOptions?.attachmentBindings,
      credentialBindings: referenceOptions?.credentialBindings,
      getCredentialBindings: referenceOptions?.getCredentialBindings,
      imageInputAvailable,
    }))
    .register(browserChatChartCapability)
    .register(createBrowserChatFileCapability({
      attachmentBindings: referenceOptions?.attachmentBindings,
      currentPageUrl: () => session.currentUrl(),
      readFile: referenceOptions?.readFile,
      readFileVisuals: referenceOptions?.readFileVisuals,
      visualInputAvailable: imageInputAvailable,
    }))
    .resolve({
      context: {
        runId: referenceOptions?.runId || '',
        abortSignal: referenceOptions?.abortSignal,
      },
      allowedToolNames: referenceOptions?.allowedToolTypes?.length
        ? new Set(referenceOptions.allowedToolTypes)
        : undefined,
    });
  const capabilityTools = toAISDKToolSet(capabilitySnapshot, {
    metadata: {
      runId: referenceOptions?.runId || '',
      stepIndex: referenceOptions?.stepIndex,
    },
    execute: ({ resolvedTool, input, context, execution }) => record(
      resolvedTool.publicName,
      input,
      async (abortSignal, trace) => capabilityResultToBrowserActionResult(await resolvedTool.tool.execute(input, {
        ...context,
        abortSignal,
        reportProgress: fileProgressReporter(trace),
      })),
      execution,
    ),
  });

  const sharedTools = {
    reportDefect: tool({
      description: 'Proactively report one evidence-backed product defect or reproducible product problem found while testing the live interface. During a testing task, calling this tool is mandatory as soon as browser action=code has reproduced the issue and emitted at least one screenshot that visibly proves it; do not defer the report to the final answer or wait for the user to ask. Do not report speculation, expected behavior, environment/configuration/permission limitations, or the same issue twice. screenshotFileNames must exactly match the safe file names returned by a successful browser action=code call in this Agent run.',
      inputSchema: withToolInputExamples(reportDefectInputSchema, [{
        problemDescription: '长表格向下滚动后，横向滚动条离开当前视口。',
        whyItIsAProblem: '用户无法在浏览表格中段时横向查看右侧列。',
        reasons: ['横向滚动条只有到达表格底部后才可操作。'],
        reproductionSteps: ['打开包含宽表格的对话', '向下滚动到表格中段', '尝试横向滚动'],
        screenshotFileNames: ['step-1-browser-code-1-example.png'],
      }]),
      execute: (input, execution) => record(
        'reportDefect',
        input,
        () => reportBrowserChatDefect(referenceOptions?.runId, traces, input),
        execution,
      ),
    }),
    ...((referenceOptions?.runSubagents || referenceOptions?.readSubagent) ? {
      subagent: tool({
        description: `Spawn independent child Agents or read one returned result UUID. action=spawn requires hidden Skill ${subagentRuntimeSkillId}; action=read is never gated so pending results remain recoverable.`,
        inputSchema: browserToolInput({
          action: z.enum(['spawn', 'read']),
          tasks: z.array(z.object({
            title: z.string().min(1).max(160).describe('Short display title for this child Agent.'),
            instruction: z.string().min(1).max(4_000).describe('Self-contained task and expected evidence for this child Agent.'),
            url: z.string().url().max(4_000).describe('Independent page or PRD entry URL for this child Agent.'),
          })).min(1).optional().describe('Preferred batch form for two or more independent child Agents. Every task runs concurrently.'),
          title: z.string().min(1).max(160).optional().describe('Flat fallback title when spawning exactly one child Agent.'),
          instruction: z.string().min(1).max(4_000).optional().describe('Flat fallback instruction when spawning exactly one child Agent.'),
          url: z.string().url().max(4_000).optional().describe('Flat fallback URL when spawning exactly one child Agent.'),
          uuid: z.string().uuid().optional().describe('One child Agent UUID returned by action=spawn; required only for action=read.'),
        }, [
          { reason: '并行分析独立页面', action: 'spawn', tasks: [{ title: '分析需求A', url: 'https://example.com/a', instruction: '分析页面并返回关键证据。' }] },
          { reason: '读取子 Agent 分析结果', action: 'read', uuid: '123e4567-e89b-12d3-a456-426614174000' },
        ]).superRefine((input, context) => {
          if (input.action === 'spawn') {
            const hasFlatTask = Boolean(input.title && input.instruction && input.url);
            if (!input.tasks?.length && !hasFlatTask) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'spawn requires tasks, or the flat title, url, and instruction fields.',
              });
            }
          } else if (!input.uuid) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'read requires uuid.' });
          }
        }),
        execute: (input, execution) => {
          if (input.action === 'spawn') {
            const tasks = normalizeBrowserChatSubagentTasks(input.tasks ?? input);
            return record('subagent', input, (abortSignal, trace) => {
              if (!tasks.length) {
                return Promise.resolve({ ok: false, actual: 'subagent action=spawn requires at least one valid task.' });
              }
              return referenceOptions?.runSubagents
                ? referenceOptions.runSubagents(tasks, abortSignal, trace?.id)
                : Promise.resolve({ ok: false, actual: 'subagent action=spawn is unavailable in this runtime.' });
            }, execution);
          }
          return record('subagent', input, () => {
            const uuid = input.uuid?.trim() || '';
            if (!uuid) return Promise.resolve({ ok: false, actual: 'subagent action=read requires one UUID.' });
            const requiredUuid = referenceOptions?.requiredSubagentUuid || pendingSubagentUuidsFromTraces(traces)[0];
            if (requiredUuid && uuid !== requiredUuid) {
              return Promise.resolve({
                ok: false,
                actual: `Read rejected: child Agent results must be read in order. The required UUID is ${requiredUuid}.`,
              });
            }
            return referenceOptions?.readSubagent
              ? referenceOptions.readSubagent(uuid)
              : Promise.resolve({ ok: false, actual: 'subagent action=read is unavailable in this runtime.' });
          }, execution);
        },
      }),
    } : {}),
    ...capabilityTools,
    finalResponse: tool({
      description: 'Finish the request with ordered UI blocks. Use markdown for prose, chart for a successful chart id, and ui for declarative cards/layout. The client preserves this exact order in UIMessage.parts.',
      inputSchema: browserChatFinalResponseSchema,
      execute: (input, execution) => record('finalResponse', input, () => Promise.resolve({
        ok: true,
        actual: JSON.stringify({ accepted: true, blockCount: input.blocks.length }),
      }), execution),
    }),
    skill: tool({
      description: `Read a Skill by exact id. Hidden runtime Skills for this mode are ${browserRuntimeSkillId}, ${fileArtifactRuntimeSkillId}, ${chartRuntimeSkillId}, and ${subagentRuntimeSkillId}; successful reads remain loaded only for the current Agent run.`,
      inputSchema: withToolInputExamples(z.preprocess((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const record = value as Record<string, unknown>;
        if (typeof record.reason === 'string' && record.reason.trim()) return value;
        const skillId = typeof record.skillId === 'string' ? record.skillId.trim() : '';
        return { ...record, reason: skillId ? `读取 Skill：${skillId}` : '读取运行规范' };
      }, z.object({
        reason: toolReasonInput,
        action: z.literal('read'),
        skillId: z.string().min(1).max(160).describe('Exact Skill id from an available <system_skill> or user Skill summary.'),
      })), [
        { reason: '读取浏览器代码运行规范', action: 'read', skillId: browserRuntimeSkillId },
        { reason: '读取文件产物运行规范', action: 'read', skillId: fileArtifactRuntimeSkillId },
        { reason: '读取图表生成运行规范', action: 'read', skillId: chartRuntimeSkillId },
        { reason: '读取子 Agent 运行规范', action: 'read', skillId: subagentRuntimeSkillId },
      ]),
      execute: (input, execution) => record('skill', input, async () => {
        const hiddenContent = hiddenRuntimeSkillContent(input.skillId);
        if (hiddenContent) {
          return { ok: true, actual: hiddenContent } satisfies BrowserActionResult;
        }
        return referenceOptions?.readSkill
          ? referenceOptions.readSkill(input.skillId)
          : { ok: false, actual: `Skill ${input.skillId} is unavailable in this runtime.` } satisfies BrowserActionResult;
      }, execution),
    }),
  };

  const tools = sharedTools;
  const allowedToolTypes = referenceOptions?.allowedToolTypes;
  if (!allowedToolTypes?.length) return { tools, dispose: capabilitySnapshot.dispose };
  const allowed = new Set(allowedToolTypes);
  return {
    tools: Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name))) as typeof tools,
    dispose: capabilitySnapshot.dispose,
  };
}

type RuntimeToolDefinitions = ToolSet;

function toolInputJsonSchema(inputSchema: unknown) {
  if (!inputSchema) return undefined;
  if (typeof inputSchema === 'object' && 'jsonSchema' in inputSchema) {
    return (inputSchema as { jsonSchema?: unknown }).jsonSchema;
  }
  try {
    return z.toJSONSchema(inputSchema as z.ZodType);
  } catch (error) {
    return { unavailable: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

function toolSchemaEstimateInput(tools?: RuntimeToolDefinitions) {
  if (!tools) return [];
  return Object.entries(tools).map(([name, toolDefinition]) => {
    const record = toolDefinition as Record<string, unknown>;
    return {
      type: 'function',
      function: {
        name,
        description: typeof record.description === 'string' ? record.description : '',
        parameters: toolInputJsonSchema(record.inputSchema),
      },
    };
  });
}

function runtimePrompt(input: { runtimeRecord: BrowserChatRuntimeRecord; fileVisualAvailable?: boolean }) {
  const { runtimeRecord } = input;
  const rawCaseSystemPrompt = systemPromptOf(runtimeRecord);
  const caseSystemPrompt = browserChatSystemPromptForRuntime(rawCaseSystemPrompt);
  const customPrompt = customRuntimePromptFromEnv();
  const screenshotAvailable = modelSupportsImageInput();
  return [
    'You are an AI browser chat agent. Satisfy the latest user message from the live browser or answer directly when browser evidence is unnecessary.',
    '',
    'Operating rules:',
    '- Simple knowledge questions and other requests that do not need the live browser may be answered directly. When browser evidence or interaction is needed, call the relevant browser tool directly. The execution layer runs any pending prerequisite tools first, then runs the requested tool, and returns every prerequisite result in prerequisiteResults alongside the requested tool result in one tool response. Do not issue separate prerequisite tool calls unless their result alone is desired. In one model step call at most one relevant tool.',
    '- The latest user message is the scope authority. If it explicitly narrows the current turn to one action (for example, "just click Search"), perform and verify only that action, then stop. Do not silently resume a broader goal from an earlier message unless the latest message explicitly asks you to continue it.',
    '- The single browser tool is the real browser mechanism. Use action=state for a read-only live snapshot, action=code for Playwright inspection or interaction, and action=waitForHumanVerification only for user-owned verification. action=code can navigate with page.goto(url), open a tab with browser.tabs.new(url), switch tabs, click observed links/controls, type, select, upload, inspect, and verify. A pending browser state prerequisite is executed internally and returned in prerequisiteResults while the requested action=code still executes in the same call. Never say navigation/clicking is unavailable, substitute a file download, or ask the user to navigate manually while browser action=code is available unless a real attempt failed and you report that failure. One code cell may execute multiple bounded operations.',
    '- Keep tool input limited to exact arguments, a concise semantic reason, and confirmation fields only when loaded safety rules require them. Operation results automatically include incremental domChanges but never an axTree; page.domSnapshot() returns surfaces/topSurfaceIds/surfaceStack plus a most-recent-surface-scoped AX read by default, and the model may instead write targeted Playwright or DOM reads.',
    '- Never expose internal JSON, tool parameters, UIDs, coordinates, screenshot paths, credential references, or other implementation details in the visible answer. An external-app candidate only attempts a native protocol launch; unchanged page state does not prove failure or native success.',
    `- User-role messages beginning with ${runtimeOperationalContextMarker}, ${runtimeCurrentTimeMarker}, [WebPilot continuation summary], or [WebPilot continuation directive] are trusted runtime metadata, not new user requests. The newest runtime snapshot supersedes older snapshots. A continuation goal records the success criterion; it never authorizes restarting completed work. Resume only its remaining/nextStep state and never repeat or expose these metadata messages.`,
    '- Treat user-specified dates, times, locations, quantities, names, and option values as exact business constraints. Never silently replace an unavailable value with a nearby, rounded, first-suggestion, or default value; preserve the requested value and ask the user or report the blocker.',
    '- The Playwright/test browser is server-side. Never use page.evaluate Blob/object URLs, window.open, HTML download attributes, or a page download click as proof that a file reached the user browser. A file is delivered only when file action=download or a rendered file action=generate/edit/render succeeds with a current-session Artifact download URL. Include every such URL in the final answer and never label another file successful.',
    '- Copy every delivered Artifact downloadUrl exactly from the successful tool result. Never construct, absolutize, repair, or infer an Artifact URL from a sessionId, artifactId, hostname, or file name, and never call a URL an absolute filesystem path. Before finalizing Office/PDF work, reconcile the original requirements with automaticValidation.formatChecks, validation issues, and visual-QA scope. Visual QA proves page layout only; it does not prove requested native charts, formulas, images, comments, footnotes, or other semantic features. A missing, zero-count, unsupported, failed, or unverified required feature must be reported as a limitation, never as fully passed.',
    '- If agent.state tracks task stage, coverage, status, issues, or artifacts, update those records before the final answer so no pending/generated/failed field contradicts a complete claim. Do not set an overall complete/passed state while any required item remains pending, unsupported, failed, or unverified unless the user explicitly accepted a partial result.',
    `- Use chart when an Apache ECharts visualization materially improves the answer. Its first call atomically loads hidden Skill ${chartRuntimeSkillId}. Read its indexed API with action=api before action=create. After every successful create, reference the exact returned chartId from a finalResponse chart block. Never invent a chart id or use one from a failed call.`,
    '- Complete every terminal response by calling finalResponse with ordered blocks. Use markdown blocks for normal prose, chart blocks for generated ECharts artifacts, and ui blocks for declarative cards/layout. Never serialize these blocks into assistant text. The UI renders blocks in the exact array order.',
    '- Defect reporting is a mandatory part of every interface or product testing task. As soon as live browser evidence reveals a real defect or reproducible product problem (including functional, data, interaction, visual/layout, or compatibility problems), proactively reproduce it, use browser action=code to emit a screenshot that visibly proves it, and call reportDefect in the immediately following model step with the exact screenshotFileNames returned by browser before continuing unrelated test cases. Never wait for the user to ask, defer reporting until the final answer, or merely describe the problem in test notes or the final report. Create one report for each unique confirmed problem. Investigate permission, configuration, version, requirement, and environment explanations first; report only an observed product problem, never speculation or expected behavior, and do not report duplicates. Recording a defect does not end the requested test unless its full scope is complete.',
    screenshotAvailable && input.fileVisualAvailable
      ? `- Office/PDF visual QA is a server-enforced delivery gate. Read ${fileArtifactRuntimeSkillId} before file visual actions and follow its complete current-artifact page-review workflow with visualIndex, visualRead, and visualReport.`
      : screenshotAvailable
        ? '- A successful render is only a candidate. Inspect every returned preview and generationDiagnostics for clipping, overlap, hidden text, word/character wrapping, unexpectedly wrapped titles, covered captions, off-canvas content, empty pages, image distortion, broken tables/charts, contrast, and alignment. If a defect exists, read the exact current source, apply one Codex-format patch with its patchBaseDigest, render again, and inspect the replacement preview. Do not claim full visual verification when a complete screenshot-by-screenshot review was unavailable.'
      : '- This selected model has no image input. A successful document render is structural verification only; do not claim that you saw, inspected, confirmed, or corrected a visual layout, preview, overlap, contrast, clipping, or image quality. Do not request preview screenshots and do not describe visual defects as observed evidence. State the verification boundary accurately if it matters to the user.',
    '- PDF is a first-class deliverable, never an unsupported format or a manual-save workaround. UNO can produce it directly; JavaScript mode authors the matching Office intermediate and the local worker converts that exact result to PDF.',
    ...browserChatCodeRules(screenshotAvailable),
    '- Do not create a dedicated failure log, verification log, transparency disclosure, or similarly named section in the final answer. Recovered or irrelevant low-level tool failures remain in the process UI and logs. Mention only an unresolved failure that materially limits the requested outcome, and state it briefly alongside the affected result or limitation.',
    '- If progress stops or the target mismatches, inspect fresh evidence and change approach instead of repeating the same failed target.',
    `- Use subagent action=spawn only for independent parallel work and read ${subagentRuntimeSkillId} first. action=read stays ungated; collect one returned UUID per model step in the required order, then integrate results in the parent Agent.`,
    '- Use browser action=waitForHumanVerification only when an empty captcha/OTP/security check, unavailable user credential, QR scan, payment/identity confirmation, or personal-device action genuinely requires the user. If a detected captcha is already filled, submit and continue.',
    '- To upload a user attachment to a web file input, do not call file merely for upload and never reconstruct the file. First place and verify the editor caret at the requested destination when placement matters, then call attachmentVault.setInputFiles(locator, attachmentId) with the exact current file-input locator and listed attachmentId. After the site inserts it, verify exactly one attachment remains at the requested destination. For existing remote files use file action=download; to create a new file use the plan → generate → render document flow.',
    caseSystemPrompt ? `Loaded safety rules and Skills:\n${caseSystemPrompt}` : '',
    customPrompt,
    '',
    'When the request is satisfied, blocked, failed, or needs clarification, call finalResponse. Write user-facing prose inside Chinese Markdown blocks and do not return standalone JSON as assistant text.',
  ].filter(Boolean).join('\n');
}

function runtimeToolNames() {
  return [
    browserCapabilityToolNames.browser,
    'reportDefect',
    'subagent',
    fileCapabilityToolNames.file,
    chartCapabilityToolNames.chart,
    'finalResponse',
    'skill',
  ];
}

function isCodexProvider() {
  return getModelSettings().provider === 'codex';
}

// 记录一次 AI 请求的可展示上下文；图片只在真实发送给 AI 时写入 messages。
function createAiRequestSnapshot(input: {
  kind: AiRequestSnapshot['kind'];
  stepIndex: number;
  prompt: string;
  screenshotPath?: string;
  imagePaths?: string[];
  imageAttached: boolean;
  tools?: string[];
  options?: Record<string, unknown>;
  systemPrompt?: string;
}): AiRequestSnapshot {
  const { provider, model } = getModelSettings();
  const attachedImagePaths = input.imageAttached
    ? input.imagePaths?.length
      ? input.imagePaths
      : input.screenshotPath
        ? [input.screenshotPath]
        : []
    : [];
  const imageContent = attachedImagePaths.map((imagePath) => ({
    type: 'image' as const,
    imagePath,
    attached: true,
  }));
  return {
    id: randomUUID(),
    kind: input.kind,
    stepIndex: input.stepIndex,
    createdAt: new Date().toISOString(),
    provider,
    model,
    systemPrompt: input.systemPrompt,
    screenshotPath: input.screenshotPath,
    imageAttached: input.imageAttached,
    tools: input.tools,
    options: input.options,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: input.prompt },
          ...imageContent,
        ],
      },
    ],
  };
}

const fullLogDetailsFlag = '__browserChatFullLogDetails';function binaryLogDescriptor(value: unknown, imagePath?: string) {
  const bytes = Buffer.isBuffer(value)
    ? value.length
    : ArrayBuffer.isView(value)
      ? value.byteLength
      : value instanceof ArrayBuffer
        ? value.byteLength
        : typeof value === 'string'
          ? value.length
          : undefined;
  return {
    type: 'binary',
    bytes,
    imagePath,
    attached: Boolean(imagePath),
  };
}

export function sanitizeModelLogValue(
  value: unknown,
  imagePaths: string[],
  state: { imageIndex: number },
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const extraEntries = Object.entries(value).filter(([key]) => !['cause', 'message', 'name', 'stack'].includes(key));
    return {
      ...Object.fromEntries(extraEntries.map(([key, item]) => [
        key,
        sanitizeModelLogValue(item, imagePaths, state, seen),
      ])),
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause === undefined ? {} : { cause: sanitizeModelLogValue(value.cause, imagePaths, state, seen) }),
    };
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const imagePath = imagePaths[state.imageIndex++];
    return binaryLogDescriptor(value, imagePath);
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeModelLogValue(item, imagePaths, state, seen));
  }
  const sourceRecord = value as Record<string, unknown>;
  const sourceMediaType = typeof sourceRecord.mediaType === 'string' ? sourceRecord.mediaType : '';
  const serializedFilePart = sourceRecord.type === 'file' && typeof sourceRecord.data === 'string' && sourceRecord.data.startsWith('data:');
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(sourceRecord)) {
    if (key === 'image') {
      const imagePath = imagePaths[state.imageIndex++];
      output[key] = binaryLogDescriptor(item, imagePath);
    } else if (key === 'data' && serializedFilePart && typeof item === 'string') {
      const commaIndex = item.indexOf(',');
      const payloadCharacters = commaIndex >= 0 ? item.length - commaIndex - 1 : item.length;
      output[key] = {
        kind: 'serialized-file-data',
        mediaType: sourceMediaType || item.slice(5, item.indexOf(';') > 5 ? item.indexOf(';') : item.indexOf(',')),
        approximateBytes: Math.floor(payloadCharacters * 3 / 4),
      };
    } else {
      output[key] = sanitizeModelLogValue(item, imagePaths, state, seen);
    }
  }
  return output;
}

function sanitizeModelMessagesForLog(system: string | undefined, messages: unknown, imagePaths: string[]) {
  const orderedMessages = [
    ...(system?.trim() ? [{ role: 'system', content: system }] : []),
    ...(Array.isArray(messages) ? messages : []),
  ];
  return sanitizeModelLogValue(orderedMessages, imagePaths, { imageIndex: 0 });
}

function sanitizeModelInputForStats(system: string | undefined, messages: unknown, imagePaths: string[]) {
  return sanitizeModelLogValue({
    system: system || '',
    messages: Array.isArray(messages) ? messages : [],
  }, imagePaths, { imageIndex: 0 });
}

function modelMessagesTextAndImageStats(messages: unknown, tools?: RuntimeToolDefinitions) {
  const contextEstimate = estimateRuntimeMessageContext(messages);
  let textCharacters = 0;
  const countTextCharacters = (value: unknown) => {
    if (typeof value === 'string') {
      textCharacters += value.length;
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(countTextCharacters);
      return;
    }
    Object.values(value as Record<string, unknown>).forEach(countTextCharacters);
  };
  countTextCharacters(messages);
  const serialized = JSON.stringify(messages) || '';
  const estimatedValueTextTokens = contextEstimate.textTokens;
  const estimatedSerializedTextTokens = estimateRuntimeTextTokens(serialized);
  const estimatedTextTokens = Math.max(estimatedValueTextTokens, estimatedSerializedTextTokens);
  const estimatedImageTokens = contextEstimate.imageCount * imageTokenEstimatePerImage();
  const toolSchema = toolSchemaEstimateInput(tools);
  const serializedToolSchema = JSON.stringify(toolSchema) || '';
  const estimatedToolSchemaTokens = estimateRuntimeTextTokens(serializedToolSchema);
  return {
    textCharacters,
    serializedCharacters: serialized.length,
    imageCount: contextEstimate.imageCount,
    toolCount: toolSchema.length,
    toolSchemaCharacters: serializedToolSchema.length,
    estimatedValueTextTokens,
    estimatedSerializedTextTokens,
    estimatedTextTokens,
    estimatedImageTokens,
    estimatedToolSchemaTokens,
    estimatedTotalTokens: estimatedTextTokens + estimatedImageTokens + estimatedToolSchemaTokens,
    method: 'rough estimate from sanitized modelMessages plus current browser tool schemas: max(value-text tokens, serialized JSON tokens) + imageCount * AI_IMAGE_CONTEXT_ESTIMATE_TOKENS + serialized current tool definitions',
  };
}

function fullLogDetails(value: unknown) {
  return {
    [fullLogDetailsFlag]: true,
    value,
  };
}

function truncateModelLogStrings(value: unknown, maxCharacters = 6_000): unknown {
  if (typeof value === 'string') {
    return value.length <= maxCharacters
      ? value
      : `${value.slice(0, maxCharacters)}\n[... ${value.length - maxCharacters} characters omitted from log ...]`;
  }
  if (Array.isArray(value)) return value.map((item) => truncateModelLogStrings(item, maxCharacters));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, truncateModelLogStrings(item, maxCharacters)]));
}

function boundedModelMessagesForRequestLog(value: unknown) {
  if (!Array.isArray(value)) return { messages: value };
  const maxCharacters = 64 * 1024;
  const serialized = JSON.stringify(value) || '';
  if (serialized.length <= maxCharacters) return { messages: value };

  const compacted = value.map((message) => truncateModelLogStrings(message));
  const retained: unknown[] = [];
  let retainedCharacters = 0;
  for (let index = compacted.length - 1; index >= 0; index -= 1) {
    const message = compacted[index];
    const messageCharacters = (JSON.stringify(message) || '').length;
    if (retained.length && retainedCharacters + messageCharacters > maxCharacters - 12_000) break;
    retained.unshift(message);
    retainedCharacters += messageCharacters;
  }
  const first = compacted[0];
  if (first && retained[0] !== first) {
    const boundedFirst = truncateModelLogStrings(first, 8_000);
    retained.unshift(boundedFirst);
  }
  const omittedMessageCount = Math.max(0, compacted.length - retained.length);
  if (omittedMessageCount) {
    retained.splice(first && retained[0] === first ? 1 : 0, 0, {
      role: 'system',
      content: `[${omittedMessageCount} earlier model input messages omitted from this log view]`,
    });
  }
  return {
    messages: retained,
    truncation: {
      originalCharacters: serialized.length,
      originalMessageCount: value.length,
      retainedMessageCount: retained.length - (omittedMessageCount ? 1 : 0),
    },
  };
}

function aiRequestLogDetails(aiRequest: AiRequestSnapshot | undefined, extra: Record<string, unknown> = {}, modelMessages?: unknown) {
  const messages = modelMessages || aiRequest?.messages || [];
  const loggedMessages = boundedModelMessagesForRequestLog(messages);
  const preparedModelContextStats = aiRequest?.options?.modelContextStats;
  return fullLogDetails({
    aiInput: {
      provider: aiRequest?.provider || extra.provider,
      model: aiRequest?.model || extra.model,
      tools: aiRequest?.tools,
      options: {
        ...(aiRequest?.options || {}),
        ...extra,
      },
      system: aiRequest?.systemPrompt,
      messages: loggedMessages.messages,
      ...(loggedMessages.truncation ? { logTruncation: loggedMessages.truncation } : {}),
    },
    aiInputTokens: preparedModelContextStats && typeof preparedModelContextStats === 'object'
      ? { ...preparedModelContextStats }
      : modelMessagesTextAndImageStats(messages),
  });
}

function compactAiResponseForLog(response: unknown) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
  const record = response as Record<string, unknown>;
  return {
    content: record.content,
    finishReason: record.finishReason,
    reasoningText: record.reasoningText,
    text: record.text,
    toolCalls: record.toolCalls,
    usage: record.usage,
  };
}

function aiResponseLogDetails(input: {
  aiRequest?: AiRequestSnapshot;
  modelMessages?: unknown;
  response: unknown;
  elapsedMs: number;
  aiElapsedMs?: number;
  stepStartedAt?: number;
  traces?: ToolTrace[];
  visualContext?: ReturnType<VisualContextManager['snapshot']>;
  extra?: Record<string, unknown>;
}) {
  return fullLogDetails({
    aiOutput: sanitizeModelLogValue({
      ...(input.extra || {}),
      elapsedMs: input.elapsedMs,
      timings: summarizeRuntimeLogTimings({
        aiElapsedMs: input.aiElapsedMs,
        stepStartedAt: input.stepStartedAt,
        totalElapsedMs: input.elapsedMs,
        traces: input.traces,
      }),
      response: compactAiResponseForLog(input.response),
    }, [], { imageIndex: 0 }),
  });
}

function extractProgressNote(text: string) {
  if (!text) return undefined;
  // The model is asked to emit a single "PROGRESS: ... NEXT: ..." line alongside its tool call.
  const match = text.match(/PROGRESS\s*[:：][\s\S]*/i);
  const note = (match ? match[0] : text).replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  return readableActionFromRawText(note)?.slice(0, 400);
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
        const record = item as Record<string, unknown>;
        return textFromUnknown(record.text ?? record.content);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return textFromUnknown(record.text ?? record.content);
  }
  return '';
}

function deriveBrowserChatStepDecision(text: string, traces: ToolTrace[]): RuntimeDecision {
  const executed = traces.filter((trace) => trace.name && trace.result);
  const last = executed.at(-1);
  // Earlier failed attempts are diagnostic history, not the terminal outcome.
  // A later successful tool means the branch recovered.
  const failed = last ? isEffectiveToolTraceFailure(last) : false;
  const names = executed.map((trace) => summarizeTraceForContinuation(trace)).join('; ');
  const note = extractProgressNote(text);
  const toolReason = executed.map((trace) => readableActionFromTrace(trace)).find(Boolean);

  if (last && isBrowserHumanVerificationCall(last.name, last.input)) {
    return {
      action: readableActionFromTrace(last) || toolReason || 'Wait for human verification',
      expected: 'The user should complete captcha, login, security verification, or other manual work in the visible browser.',
      actual: last.result?.actual || 'AI requested human intervention before continuing browser-chat work.',
      status: 'blocked',
      note,
    };
  }

  return {
    action: note || readableActionFromTrace(last) || toolReason || `AI executed browser-chat action: ${names || last?.name || 'browser action'}`,
    expected: 'This browser-chat action should move the conversation forward; the next turn will decide whether to continue or answer.',
    actual: last
      ? userFacingToolResult(last.name, last.result, 500) || 'Tool call finished; waiting for the next browser-chat turn.'
      : text || 'Browser chat returned no browser tool result.',
    status: failed ? 'failed' : 'passed',
    note,
  };
}

// 执行单个运行时步骤：采集页面上下文，调用 AI 选择一个动作，并记录请求快照。
function browserChatReplyFromDecision(decision: RuntimeDecision) {
  const candidates = [
    decision.actual,
    decision.note,
    decision.action,
  ].map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = candidates.find((item) => (
    item
    && !/^Tool call finished/i.test(item)
    && !/^Browser chat returned no browser tool/i.test(item)
    && !/^AI executed browser-chat action/i.test(item)
  )) || candidates[0] || '';
  if (!text) return '';
  return text.length > 900 ? `${text.slice(0, 900)}...` : text;
}

function visualContextFieldsFromProgress(progress?: ToolTraceProgress): Partial<StepExecutionResult> {
  return {
    visualContext: progress?.visualContext,
  };
}

async function executeRuntimeStep(input: {
  session: BrowserSession;
  runtimeRecord: BrowserChatRuntimeRecord;
  runId: string;
  turnId?: string;
  stepIndex: number;
  instruction?: string;
  appendInstruction?: boolean;
  operationalContext?: string;
  conversation?: InteractiveBrowserTurnMessage[];
  continuationSummary?: string;
  referenceImagePaths?: string[];
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  onDebug?: ExecutionDebug;
  onToolTrace?: (trace: ToolTrace, progress?: ToolTraceProgress) => void | Promise<void>;
  onTextStream?: (update: BrowserChatTextStreamUpdate) => void | Promise<void>;
  onContextCompression?: (update: {
    activeMessages: ModelMessage[];
    contextCompression: BrowserChatModelContextCompression;
  }) => void | Promise<void>;
  suppressTextOutput?: boolean;
  getRuntimeOperationalContext?: () => BrowserChatOperationalContext | Promise<BrowserChatOperationalContext>;
  browserStatePreflightComplete?: boolean;
  requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
  allowedToolTypes?: string[];
  runSubagents?: BrowserChatSubagentRunner;
  readSubagent?: BrowserChatSubagentReader;
  requiredSubagentUuid?: string;
  readFile?: (input: BrowserChatReadFileInput) => Promise<BrowserActionResult>;
  readFileVisuals?: (input: BrowserChatFileVisualInput) => Promise<BrowserActionResult>;
  readSkill?: BrowserChatReadSkill;
  loadedHiddenRuntimeSkillIds?: Set<string>;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  credentialBindings?: BrowserCodeCredentialBinding[];
  ensureBrowserStarted?: () => Promise<void>;
  memoryTools?: ToolSet;
  useToolLoopAgent?: boolean;
}) {
  const {
    session,
    runtimeRecord,
    stepIndex,
    referenceImagePaths = [],
    abortSignal,
    onDebug,
    onToolTrace,
    onTextStream,
  } = input;
  const imageInputAvailable = modelSupportsImageInput();
  const markerEnabled = false;
  const loadedHiddenRuntimeSkillIds = input.loadedHiddenRuntimeSkillIds || new Set<string>();
  const ensureActive = () => throwIfStopped(abortSignal, input.shouldContinue);
  ensureActive();
  await onDebug?.({
    phase: 'ai:runtime-input:start',
    stepIndex,
    message: 'Preparing runtime input for unified browser execution.',
    details: { imageInputAvailable, markerEnabled },
  });
  const contextMs = 0;
  const screenshotReadStartedAt = Date.now();
  ensureActive();
  const userReferenceImagePaths = Array.from(new Set(referenceImagePaths.filter(Boolean))).slice(0, 4);
  const userReferenceImages = modelSupportsImageInput()
    ? await Promise.all(userReferenceImagePaths.map(async (imagePath) => ({
        imagePath,
        image: await readScreenshotForAi(imagePath).catch(() => undefined),
      })))
    : [];
  ensureActive();
  const screenshotReadMs = elapsedSince(screenshotReadStartedAt);
  const promptStartedAt = Date.now();
  const userReferenceImagePrompt = userReferenceImagePaths.length
    ? [
        '',
        'User uploaded reference images:',
        ...userReferenceImagePaths.map((imagePath, index) => `- reference image ${index + 1}: ${imagePath}`),
        'Use these reference images as user-provided visual context. Do not confuse them with the live browser screenshot.',
      ].join('\n')
    : '';
  const prompt = runtimePrompt({ runtimeRecord, fileVisualAvailable: Boolean(input.readFileVisuals) });
  const runtimeTimeLine = currentRuntimeTimePromptLine();
  let activeOperationalContext = input.operationalContext || '';
  let activeCredentialBindings = input.credentialBindings || [];
  const promptMs = elapsedSince(promptStartedAt);
  await onDebug?.({
    phase: 'perf:runtime-input',
    stepIndex,
    message: `Runtime input prepared: page context ${contextMs}ms, screenshot read/compress ${screenshotReadMs}ms, prompt build ${promptMs}ms.`,
    details: {
      contextMs,
      screenshotReadMs,
      promptMs,
      imageInputAvailable,
      screenshotBytes: undefined,
      markerScreenshotBytes: undefined,
      selectedReferenceScreenshotCount: 0,
      userReferenceImageCount: userReferenceImages.filter((item) => item.image).length,
    },
  });
  let lastAiRequest: AiRequestSnapshot | undefined;
  let lastRetryState: RuntimeRetryState | undefined;
  let consecutiveRequestFailures = 0;
  let privateToolProtocolFailures = 0;
  const durableTraces: ToolTrace[] = [];

  function rememberRetryState(state: RuntimeRetryState) {
    lastRetryState = cloneRuntimeRetryState(state);
  }

  async function runAgent(
    retryState: RuntimeRetryState | undefined,
    executionIdentity: RuntimeExecutionIdentity,
  ) {
    ensureActive();
    // This watchdog is deliberately separate from the user/session abort
    // signal: its timeout is retryable, while a user cancellation is terminal.
    const runtimeRequestTimeoutMs = aiRuntimeRequestTimeoutMs();
    const requestWatchdog = createAiRequestWatchdog(abortSignal, runtimeRequestTimeoutMs);
    const onAttemptDebug: ExecutionDebug | undefined = onDebug
      ? (event) => onDebug({
          ...event,
          details: runtimeExecutionDetails(event.details, executionIdentity),
        })
      : undefined;
    const traces: ToolTrace[] = [...durableTraces];
    const codexMode = isCodexProvider();
    const retryAgentStepOffset = retryState?.agentStepOffset || 0;
    const externalTools = codexMode ? {} : (input.memoryTools || {});
    const externalToolNames = new Set(Object.keys(externalTools));
    const availableRuntimeToolNames = [...runtimeToolNames(), ...externalToolNames].filter((name) => (
      name !== 'subagent' || Boolean(input.runSubagents || input.readSubagent)
    ));
    const runtimeTools = runtimeAllowedToolTypes({
      browserChatMode: true,
      codexMode,
      nativeToolNames: availableRuntimeToolNames,
      observationToolNames: new Set<string>(),
    });
    const requestedToolTypes = input.allowedToolTypes?.length ? new Set(input.allowedToolTypes) : undefined;
    const allowedToolTypes = requestedToolTypes
      ? runtimeTools.filter((toolType) => toolType === browserCapabilityToolNames.browser || toolType === 'skill' || requestedToolTypes.has(toolType))
      : runtimeTools;
    const nativeToolsRef: { current?: RuntimeToolDefinitions } = {};
    const visualContext = new VisualContextManager();
    const publishToolTrace = async (trace: ToolTrace) => {
      upsertToolTrace(traces, trace);
      upsertToolTrace(durableTraces, trace);
      await onToolTrace?.(trace, { visualContext: visualContext.snapshot() });
    };
    const attachContextAfterToCompletedTools = async (contextAfter?: AiToolContextSnapshot) => {
      if (contextAfter?.estimatedTotalTokens === undefined) return;
      for (const trace of traces) {
        if (!trace.result || !trace.completedAt || trace.contextAfter?.estimatedTotalTokens !== undefined) continue;
        if (!trace.contextBefore?.requestId) continue;
        trace.contextAfter = contextAfter;
        await publishToolTrace(trace);
      }
    };
    let requestSystemPrompt = codexMode ? buildCodexObjectPrompt(prompt, allowedToolTypes) : prompt;
    let latestText = '';
    const initialVisualPaths: string[] = [];
    const initialUserReferenceImagePaths = userReferenceImages.filter((item) => item.image).map((item) => item.imagePath);
    type PendingObservationMessage = {
      text: string;
      imagePaths: string[];
    };
    const pendingObservationMessages: PendingObservationMessage[] = [];
    const queuedReferenceImageKeys = new Set<string>();
    const reportedDocumentVisualSources = new Set<string>();
    const queueReferenceImage = ({ path, source }: { path: string; source: string }) => {
      const documentVisualQa = source === 'file:generate' || source === 'file:edit' || source.startsWith('file:visualRead');
      const normalizedSource = source.startsWith('file:visualRead:') ? 'file:visualRead' : source;
      const referenceKey = `${source}\u0000${path}`;
      if (queuedReferenceImageKeys.has(referenceKey)) return;
      queuedReferenceImageKeys.add(referenceKey);
      if (!modelSupportsImageInput()) {
        if (documentVisualQa && !reportedDocumentVisualSources.has(normalizedSource)) {
          reportedDocumentVisualSources.add(normalizedSource);
          void onAttemptDebug?.({
            phase: 'ai:document-visual-qa:unavailable',
            stepIndex,
            message: 'Selected model has no image input: document output passed structural rendering checks only; no visual layout review was performed.',
            details: { source: normalizedSource, verification: 'structural-only' },
          });
        }
        return;
      }
      const text = documentVisualQa
      ? '[Document visual QA]\nThe attached images are the exact pages returned by the latest file action=visualRead. Inspect the pixels for clipping, overlap, hierarchy, typography, contrast, alignment, chart/table legibility, image quality, and page-edge defects. Use the screenshot IDs from the tool result when reporting evidence. If any page fails, patch the same current source, render a replacement artifact, and inspect only that new artifact.'
        : source === 'file:read'
          ? '[Attachment visual content]\nThe file tool rendered or extracted this image from the source attachment. Analyze its layout, images, tables, and charts together with the extracted structure and text.'
          : '[Explicit visual evidence]\nA tool returned this image and attached it to the next model request. Analyze the image directly as fresh evidence.';
      const existingObservation = pendingObservationMessages.find((observation) => observation.text === text);
      if (existingObservation) existingObservation.imagePaths.push(path);
      else pendingObservationMessages.push({ text, imagePaths: [path] });
      if (documentVisualQa && !reportedDocumentVisualSources.has(normalizedSource)) {
        reportedDocumentVisualSources.add(normalizedSource);
        void onAttemptDebug?.({
          phase: 'ai:document-visual-qa:queued',
          stepIndex,
          message: 'Rendered document preview queued for model visual inspection and targeted correction.',
          details: { source: normalizedSource },
        });
      }
    };
    const durableContinuationSummary = sanitizeRuntimeContinuationSummary(input.continuationSummary || '');
    const historyMessages = completeRuntimeModelToolChain(ensureRuntimeContinuationSummaryMessage(
      [...(input.conversation || [])] as RuntimeModelMessage[],
      durableContinuationSummary,
    ));
    const initialImagePaths = [...initialVisualPaths, ...initialUserReferenceImagePaths];
    const initialImages: Awaited<ReturnType<typeof readScreenshotForAi>>[] = [];
    for (const imagePath of initialImagePaths) {
      const image = await readScreenshotForAi(imagePath).catch(() => undefined);
      if (image) initialImages.push(image);
    }
    let initialMessages = [...historyMessages] as RuntimeModelMessage[];
    const latestInstruction = (
      textFromUnknown(input.instruction)
      || textFromUnknown(runtimeRecord.description)
    ).trim();
    const hasLatestUserMessage = Boolean(latestInstruction && initialMessages.some((message) => {
      if (message.role !== 'user' || typeof message.content !== 'string') return false;
      const content = textFromUnknown(message.content);
      return content.trim() === latestInstruction || content.includes(latestInstruction);
    }));
    if (latestInstruction && (input.appendInstruction || !hasLatestUserMessage)) {
      initialMessages.push({ role: 'user' as const, content: latestInstruction });
    }
    if (initialImages.length) {
      const latestUserIndex = initialMessages.map((message) => message.role).lastIndexOf('user');
      const fallbackText = latestInstruction || 'User uploaded reference image(s).';
      if (latestUserIndex >= 0) {
        const latestUser = initialMessages[latestUserIndex];
        const text = typeof latestUser.content === 'string' && latestUser.content.trim()
          ? latestUser.content
          : fallbackText;
        initialMessages[latestUserIndex] = {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text },
            ...initialImages.map((image) => ({ type: 'file' as const, data: image.data, mediaType: image.mediaType })),
          ],
        };
      } else {
        initialMessages.push({
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: fallbackText },
            ...initialImages.map((image) => ({ type: 'file' as const, data: image.data, mediaType: image.mediaType })),
          ],
        });
      }
    }
    const turnInputMessages = initialMessages.slice(historyMessages.length);
    if (retryState?.messages.length) {
      initialMessages = [...retryState.messages];
    }
    let messageImagePaths = retryState?.messages.length ? [...retryState.imagePaths] : [...initialImagePaths];
    rememberRetryState({
      messages: initialMessages,
      imagePaths: messageImagePaths,
      agentStepOffset: retryAgentStepOffset,
    });
    let aiRequest = createAiRequestSnapshot({
      kind: 'runtime',
      stepIndex,
      prompt: '[system prompt]',
      systemPrompt: requestSystemPrompt,
      screenshotPath: undefined,
      imagePaths: messageImagePaths,
      imageAttached: Boolean(messageImagePaths.length),
      tools: allowedToolTypes,
      options: { agentLoop: true, explicitPageState: true, visualContext: visualContext.snapshot(), imageCount: messageImagePaths.length, isMarked: false, markerOverlayInScreenshot: false, separateMarkerMap: false, modelSupportsImageInput: imageInputAvailable, visualClickMode: false, codexObjectMode: codexMode, selectedReferenceScreenshotCount: 0, userReferenceImageCount: initialUserReferenceImagePaths.length },
    });
    lastAiRequest = aiRequest;
    const toolExecutionGate = { stepNumber: 0 };
    const stepTraceStarts = new Map<number, number>();
    const stepStartedAt = new Map<number, number>();
    const stepModelMessagesForLog = new Map<number, unknown>();
    const aiRequestElapsedByToolCallId = new Map<string, number>();
    let contextSegmentationTurns = 0;
    let lastPreparedMessages = [...initialMessages];
    let lastPreparedResponsePrefixLength = 0;
    let latestContextCompression: BrowserChatModelContextCompression | undefined;
    const originalGoal = requirementOf(runtimeRecord).trim();
    const continuationDirectiveText = [
      runtimeContinuationDirectiveMarker,
      'This is runtime continuation metadata, not a new user request.',
      'Resume only the unfinished remaining/nextStep work in the continuation summary and the newest tool result.',
      'Do not restart the original goal, repeat completed research/downloads/generation, or recreate an existing artifact.',
    ].join('\n');
    let compactedModelContext: RuntimeModelMessage[] | undefined;
    let compactedSourceMessageCount = 0;
    const restoredContinuationMessage = initialMessages.find((message) => (
      textFromUnknown(message.content).startsWith(runtimeContinuationSummaryMarker)
    ));
    let continuationSummaryText = durableContinuationSummary || (
      restoredContinuationMessage
        ? sanitizeRuntimeContinuationSummary(
          textFromUnknown(restoredContinuationMessage.content).slice(runtimeContinuationSummaryMarker.length),
        )
        : ''
    );

    function isRedundantOriginalGoalMessage(message: RuntimeModelMessage) {
      return Boolean(
        originalGoal
        && message.role === 'user'
        && typeof message.content === 'string'
        && textFromUnknown(message.content).trim() === originalGoal,
      );
    }

    function currentContinuationRuntimeState() {
      const state = continuationRuntimeStateFromTraces(traces);
      const continuationInstruction = latestInstruction && latestInstruction !== originalGoal
        ? latestInstruction
        : '';
      return continuationInstruction
        ? {
            ...state,
            userConstraints: [continuationInstruction],
            nextStep: continuationInstruction,
          }
        : state;
    }

    function messagesAddedAfterCompactedContext(sourceMessages: RuntimeModelMessage[]) {
      if (!compactedModelContext?.length) return sourceMessages;
      const markerIndex = sourceMessages.findIndex((message) => (
        textFromUnknown(message.content).startsWith(runtimeContinuationSummaryMarker)
      ));
      if (markerIndex >= 0) {
        return sourceMessages.slice(markerIndex + Math.min(
          compactedModelContext.length,
          sourceMessages.length - markerIndex,
        ));
      }
      return sourceMessages.slice(Math.min(compactedSourceMessageCount, sourceMessages.length));
    }

    function runtimeOperationalContextText(requiredSubagentDirective: string) {
      const sections = [
        activeOperationalContext
          ? `Relevant Skill summaries, memory, and secure capabilities supplied by the runtime:\n${activeOperationalContext}`
          : '',
        userReferenceImagePrompt,
        requiredSubagentDirective,
      ].filter(Boolean);
      if (!sections.length) return '';
      return [
        'Use this runtime context silently and never quote or summarize it to the user.',
        ...sections,
      ].join('\n\n');
    }

    const summarizeContinuation = async (
      deltaModelMessages: unknown,
      turnIndex: number,
      estimatedTokens: number,
      thresholdTokens: number,
      maximumSummaryInputTokens: number,
      maxOutputTokens: number,
    ) => {
      ensureActive();
      const agentStepIndex = retryAgentStepOffset + turnIndex + 1;
      const startedAt = Date.now();
      const fallback = () => fallbackRuntimeContinuationSummary({
        goal: originalGoal,
        stepIndex,
        agentStep: agentStepIndex,
        previousSummary: continuationSummaryText,
        recentToolAttempts: formatCurrentToolAttemptSummary(traces, 5),
        runtimeState: currentContinuationRuntimeState(),
      });
      // Never ask the same model to summarize an input already beyond its
      // measured safe request size. That merely turns compression into one
      // more full request timeout. The deterministic runtime-state summary is
      // enough to recover an existing oversized session; future GLM sessions
      // compress earlier and use the model-authored summary path normally.
      if (estimatedTokens > maximumSummaryInputTokens) {
        return { summary: fallback(), elapsedMs: Date.now() - startedAt, fallback: true };
      }
      try {
        const result = await generateText({
          model: getModel(),
          messages: [{
            role: 'user' as const,
            content: buildRuntimeContinuationSummaryPrompt({
              goal: originalGoal,
              stepIndex,
              agentStep: agentStepIndex,
              estimatedTokens,
              thresholdTokens,
              previousSummary: continuationSummaryText,
              deltaModelMessages,
              runtimeState: currentContinuationRuntimeState(),
            }),
          }],
          temperature: 0.1,
          reasoning: aiReasoningEffort(),
          maxOutputTokens,
          maxRetries: 0,
          abortSignal,
          timeout: runtimeRequestTimeoutMs,
          telemetry: aiTelemetry('browser-chat-continuation-summary'),
        });
        ensureActive();
        const text = normalizeRuntimeContinuationSummary({
          candidate: result.text || '',
          goal: originalGoal,
          previousSummary: continuationSummaryText,
          runtimeState: currentContinuationRuntimeState(),
        });
        return { summary: text || fallback(), elapsedMs: Date.now() - startedAt, fallback: !text };
      } catch (error) {
        if (isBrowserChatAbortError(error, abortSignal)) throw browserChatAbortError(abortSignal);
        return { summary: fallback(), elapsedMs: Date.now() - startedAt, fallback: true };
      }
    };

    async function prepareStep(turnIndex: number, previousMessages?: RuntimeModelMessage[]) {
      ensureActive();
      // Promote successful reads only at the next model-step boundary. A model
      // cannot bypass the gate by emitting skill and a governed tool together.
      for (const skillId of hiddenRuntimeSkillIdsReadFromTraces(traces)) {
        loadedHiddenRuntimeSkillIds.add(skillId);
      }
      if (input.getRuntimeOperationalContext) {
        try {
          const runtimeContext = await input.getRuntimeOperationalContext();
          ensureActive();
          activeOperationalContext = runtimeContext.operationalContext;
          activeCredentialBindings = runtimeContext.credentialBindings || [];
        } catch (error) {
          await onAttemptDebug?.({
            phase: 'runtime-context:refresh:error',
            stepIndex,
            message: `Unable to rebuild runtime context for the current page: ${infrastructureError(error)}`,
            details: serializeError(error),
          });
        }
      }
      const pendingSubagentUuids = pendingSubagentUuidsFromTraces(traces);
      const requiredSubagentUuid = pendingSubagentUuids[0];
      const requiredSubagentDirective = requiredSubagentUuid
        ? requiredSubagentReadDirective(requiredSubagentUuid, pendingSubagentUuids.length)
        : '';
      const browserStateGatePending = requiresBrowserStatePreflight(Boolean(input.browserStatePreflightComplete), traces);
      const stepAllowedToolTypes = runtimeToolTypesWithAutomaticSkills(allowedToolTypes);
      const baseSystemPrompt = codexMode ? buildCodexObjectPrompt(prompt, stepAllowedToolTypes) : prompt;
      const agentStepIndex = retryAgentStepOffset + turnIndex + 1;
      const activeModelSettings = getModelSettings();
      const windowTokens = runtimeContextWindowTokens(activeModelSettings);
      const thresholdRatio = runtimeContextCompressionThresholdRatio(activeModelSettings);
      const thresholdTokens = Math.floor(windowTokens * thresholdRatio);
      const appendedMessages: RuntimeModelMessage[] = [];
      const appendedImagePaths: string[] = [];
      while (pendingObservationMessages.length) {
        const observation = pendingObservationMessages.shift();
        if (!observation) break;
        const content: Array<{ type: 'text'; text: string } | { type: 'file'; data: Buffer; mediaType: string }> = [{ type: 'text', text: observation.text }];
        for (const imagePath of observation.imagePaths) {
          const image = await readScreenshotForAi(imagePath).catch(() => undefined);
          if (image) {
            content.push({ type: 'file', data: image.data, mediaType: image.mediaType });
            appendedImagePaths.push(imagePath);
          }
        }
        appendedMessages.push({ role: 'user' as const, content });
      }

      const sourceMessages = completeRuntimeModelToolChain(previousMessages?.length
        ? previousMessages.filter((message) => {
            if (message.role !== 'user' || !Array.isArray(message.content)) return true;
            const text = message.content.flatMap((part) => (
              part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
            )).join('\n');
            return !text.startsWith('[Document visual QA]')
              && !text.startsWith('[Attachment visual content]')
              && !text.startsWith('[Explicit visual evidence]');
          })
        : [...initialMessages]);
      if (previousMessages?.length) messageImagePaths = [...initialUserReferenceImagePaths];
      lastPreparedResponsePrefixLength = previousMessages?.length
        ? Math.max(0, sourceMessages.length - initialMessages.length)
        : 0;
      let unsummarizedMessages = compactedModelContext?.length
        ? messagesAddedAfterCompactedContext(sourceMessages)
        : sourceMessages;
      let messagesToSend = compactedModelContext?.length
        ? [...compactedModelContext, ...unsummarizedMessages]
        : unsummarizedMessages;
      if (appendedMessages.length) {
        messagesToSend = [...messagesToSend, ...appendedMessages];
        unsummarizedMessages = [...unsummarizedMessages, ...appendedMessages];
        messageImagePaths = [...messageImagePaths, ...appendedImagePaths];
      }

      const operationalContext = runtimeOperationalContextText(requiredSubagentDirective);
      requestSystemPrompt = baseSystemPrompt;
      const runtimeMetadata = appendRuntimePromptCacheMetadata({
        messages: withoutRuntimePromptCacheMetadata(messagesToSend),
        operationalContext,
        currentTimeLine: runtimeTimeLine,
      });
      messagesToSend = runtimeMetadata.messages;
      messagesToSend = completeRuntimeModelToolChain(messagesToSend);
      let requestMessages = [...messagesToSend];
      let attachedImagePaths = [...messageImagePaths];
      let modelMessagesForLog = sanitizeModelMessagesForLog(requestSystemPrompt, requestMessages, attachedImagePaths);
      let modelContextSegmentation: Record<string, unknown> | undefined;
      const modelInputForStats = sanitizeModelInputForStats(requestSystemPrompt, requestMessages, attachedImagePaths);
      const messageStats = modelMessagesTextAndImageStats(modelInputForStats, codexMode ? undefined : nativeToolsRef.current);
      // Attribute the complete would-be next model input to the tool before a
      // possible compression changes it. The compression trace below records
      // that separate decrease, so it is never charged to the preceding tool.
      await attachContextAfterToCompletedTools(toolContextFromStats(messageStats));
      if ((previousMessages?.length || messagesToSend.length > 1) && messageStats.estimatedTotalTokens > thresholdTokens) {
        const targetFloorTokens = Math.floor(windowTokens * runtimeContextCompressionTargetFloorRatio());
        const targetCeilingTokens = Math.floor(windowTokens * runtimeContextCompressionTargetCeilingRatio());
        const baseStats = modelMessagesTextAndImageStats(
          sanitizeModelInputForStats(requestSystemPrompt, runtimeMetadata.metadataMessages, []),
          codexMode ? undefined : nativeToolsRef.current,
        );
        const summarySourceMessages = messagesToSend.filter((message) => (
          !isRuntimePromptCacheMetadataMessage(message)
          &&
          !textFromUnknown(message.content).startsWith(runtimeContinuationSummaryMarker)
          && !isRedundantOriginalGoalMessage(message)
        ));
        const blocks = atomicRuntimeModelMessageBlocks(summarySourceMessages);
        const rawTailBudget = Math.max(0, targetFloorTokens - baseStats.estimatedTotalTokens);
        const selectedBlocks = selectRecentRuntimeMessageBlocks(
          blocks,
          (candidate) => modelMessagesTextAndImageStats(
            sanitizeModelInputForStats('', candidate, []),
            undefined,
          ).estimatedTotalTokens,
          rawTailBudget,
        );
        const olderBlocks = selectedBlocks.olderBlocks;
        const retainedTokens = selectedBlocks.retainedTokens;
        const retainedMessages = selectedBlocks.retainedBlocks.flat();
        const deltaInputForSummary = sanitizeModelInputForStats('', summarySourceMessages, appendedImagePaths);
        const deltaStats = modelMessagesTextAndImageStats(deltaInputForSummary, undefined);
        const summaryOutputBudget = Math.max(256, Math.min(
          8_192,
          targetCeilingTokens - baseStats.estimatedTotalTokens - retainedTokens - 256,
        ));
        await onAttemptDebug?.({
          phase: 'ai:context-compression:start',
          stepIndex,
          message: `Context compression started before agent step ${agentStepIndex}.`,
          details: {
            agentStepIndex,
            estimatedTokensBefore: messageStats.estimatedTotalTokens,
            summaryInputEstimatedTokens: deltaStats.estimatedTotalTokens,
            targetFloorTokens,
            targetCeilingTokens,
            thresholdTokens,
            modelContextStats: {
              ...messageStats,
              thresholdRatio,
              thresholdTokens,
              windowTokens,
            },
          },
        });
        const summaryResult = await summarizeContinuation(
          deltaInputForSummary,
          turnIndex,
          deltaStats.estimatedTotalTokens,
          thresholdTokens,
          Math.floor(windowTokens * 0.9),
          summaryOutputBudget,
        );
        const summary = summaryResult.summary;
        const previousSummaryChars = continuationSummaryText.length;
        continuationSummaryText = summary;
        contextSegmentationTurns += 1;
        messagesToSend = [
          { role: 'user' as const, content: `${runtimeContinuationSummaryMarker}\n${summary}` },
          ...retainedMessages,
          { role: 'user' as const, content: continuationDirectiveText },
        ];
        requestMessages = [...messagesToSend];
        attachedImagePaths = [];
        messageImagePaths = [...attachedImagePaths];
        modelMessagesForLog = sanitizeModelMessagesForLog(requestSystemPrompt, requestMessages, attachedImagePaths);
        let afterStats = modelMessagesTextAndImageStats(sanitizeModelInputForStats(requestSystemPrompt, requestMessages, attachedImagePaths), codexMode ? undefined : nativeToolsRef.current);
        while (afterStats.estimatedTotalTokens < targetFloorTokens && olderBlocks.length) {
          const candidate = olderBlocks.pop()!;
          const candidateMessages = candidate.concat(messagesToSend.slice(1));
          const candidateContext = [messagesToSend[0], ...candidateMessages];
          const candidateRequestMessages = [...candidateContext];
          const candidateStats = modelMessagesTextAndImageStats(sanitizeModelInputForStats(requestSystemPrompt, candidateRequestMessages, []), codexMode ? undefined : nativeToolsRef.current);
          if (candidateStats.estimatedTotalTokens > targetCeilingTokens) break;
          messagesToSend = candidateContext;
          requestMessages = candidateRequestMessages;
          afterStats = candidateStats;
        }
        while (afterStats.estimatedTotalTokens > targetCeilingTokens && messagesToSend.length > 1) {
          const removableBlocks = atomicRuntimeModelMessageBlocks(messagesToSend.slice(1));
          removableBlocks.shift();
          messagesToSend = [messagesToSend[0], ...removableBlocks.flat()];
          requestMessages = [...messagesToSend];
          afterStats = modelMessagesTextAndImageStats(sanitizeModelInputForStats(requestSystemPrompt, requestMessages, []), codexMode ? undefined : nativeToolsRef.current);
        }
        if (messagesToSend.length === 1) {
          messagesToSend.push({ role: 'user' as const, content: continuationDirectiveText });
          requestMessages = [...messagesToSend];
          afterStats = modelMessagesTextAndImageStats(sanitizeModelInputForStats(requestSystemPrompt, requestMessages, []), codexMode ? undefined : nativeToolsRef.current);
        }
        const compressedRuntimeMetadata = appendRuntimePromptCacheMetadata({
          messages: withoutRuntimePromptCacheMetadata(messagesToSend),
          operationalContext,
          currentTimeLine: runtimeTimeLine,
        });
        messagesToSend = compressedRuntimeMetadata.messages;
        messagesToSend = completeRuntimeModelToolChain(messagesToSend);
        requestMessages = [...messagesToSend];
        afterStats = modelMessagesTextAndImageStats(sanitizeModelInputForStats(requestSystemPrompt, requestMessages, []), codexMode ? undefined : nativeToolsRef.current);
        const retainedMessageCount = Math.max(0, messagesToSend.filter((message) => (
          !isRuntimePromptCacheMetadataMessage(message)
        )).length - 1);
        modelMessagesForLog = sanitizeModelMessagesForLog(requestSystemPrompt, requestMessages, attachedImagePaths);
        latestContextCompression = {
          compressedAt: new Date().toISOString(),
          continuationSummary: summary,
          estimatedTokensBefore: messageStats.estimatedTotalTokens,
          estimatedTokensAfter: afterStats.estimatedTotalTokens,
          retainedMessageCount,
          summarizedMessageCount: summarySourceMessages.length,
          targetCeilingTokens,
          targetFloorTokens,
          thresholdTokens,
          windowTokens,
        };
        const compressionCompletedAt = Date.now();
        const compressionToolCallId = `context-compression:${input.runId}:${stepIndex}:${contextSegmentationTurns}`;
        const compressionTrace: ToolTrace = {
          id: compressionToolCallId,
          name: 'contextCompression',
          input: {
            estimatedTokensBefore: messageStats.estimatedTotalTokens,
            estimatedTokensAfter: afterStats.estimatedTotalTokens,
            retainedMessageCount,
            summarizedMessageCount: summarySourceMessages.length,
            trigger: 'model context threshold exceeded',
          },
          result: {
            ok: true,
            actual: `Context compressed from ${messageStats.estimatedTotalTokens} to ${afterStats.estimatedTotalTokens} estimated tokens.`,
          },
          startedAt: compressionCompletedAt - summaryResult.elapsedMs,
          completedAt: compressionCompletedAt,
          elapsedMs: summaryResult.elapsedMs,
          actionElapsedMs: summaryResult.elapsedMs,
          contextBefore: toolContextFromStats(messageStats),
          contextAfter: toolContextFromStats(afterStats),
        };
        await publishToolTrace(compressionTrace);
        await input.onContextCompression?.({
          activeMessages: [...messagesToSend],
          contextCompression: latestContextCompression,
        });
        modelContextSegmentation = {
          segment: contextSegmentationTurns,
          reason: 'modelMessages exceeded context threshold',
          estimatedTokensBefore: messageStats.estimatedTotalTokens,
          estimatedTokensAfter: afterStats.estimatedTotalTokens,
          summaryInputEstimatedTokens: deltaStats.estimatedTotalTokens,
          summaryElapsedMs: summaryResult.elapsedMs,
          summaryFallback: summaryResult.fallback,
          previousSummaryChars,
          summaryChars: summary.length,
          unsummarizedMessageCount: unsummarizedMessages.length,
          targetFloorTokens,
          targetCeilingTokens,
          retainedMessageCount,
          thresholdTokens,
        };
        await onAttemptDebug?.({
          phase: 'ai:context-compression:complete',
          stepIndex,
          message: `Context compression completed for agent step ${agentStepIndex}.`,
          details: {
            ...modelContextSegmentation,
            toolCallId: compressionToolCallId,
            modelContextStats: {
              ...afterStats,
              thresholdRatio,
              thresholdTokens,
              windowTokens,
            },
          },
        });
        await onAttemptDebug?.({
          phase: 'ai:context-segmented',
          stepIndex,
          message: `Model message context exceeded threshold; inserted continuation summary segment ${contextSegmentationTurns}.`,
          details: modelContextSegmentation,
        });
      }
      const finalStats = modelContextSegmentation
        ? modelMessagesTextAndImageStats(sanitizeModelInputForStats(requestSystemPrompt, requestMessages, attachedImagePaths), codexMode ? undefined : nativeToolsRef.current)
        : messageStats;
      if (compactedModelContext?.length || modelContextSegmentation) {
        // The SDK passes its full pre-segmentation history back to every prepareStep.
        // Retain the compact form locally and append only newly produced SDK messages.
        compactedModelContext = [...messagesToSend];
        compactedSourceMessageCount = sourceMessages.length;
      }
      lastPreparedMessages = [...messagesToSend];
      rememberRetryState({
        messages: [...messagesToSend],
        imagePaths: [...attachedImagePaths],
        agentStepOffset: agentStepIndex - 1,
      });
      const nextAiRequest = createAiRequestSnapshot({ kind: 'runtime', stepIndex, prompt: '[modelMessages logged separately]', systemPrompt: requestSystemPrompt, screenshotPath: undefined, imagePaths: attachedImagePaths, imageAttached: attachedImagePaths.length > 0, tools: stepAllowedToolTypes, options: { agentLoop: true, agentStepIndex, visualContext: visualContext.snapshot(), imageCount: attachedImagePaths.length, explicitPageState: true, modelSupportsImageInput: imageInputAvailable, promptCachePrefixStrategy: 'stable-tools-system-and-conversation-prefix', runtimeOperationalContextCharacters: runtimeMetadata.operationalContextCharacters, modelContextStats: { ...finalStats, windowTokens, thresholdRatio, thresholdTokens }, modelContextSegmentation } });
      aiRequest = nextAiRequest;
      lastAiRequest = aiRequest;
      const hiddenSkillGateActive = stepAllowedToolTypes.length !== allowedToolTypes.length;
      const activeTools = browserStateGatePending || hiddenSkillGateActive
        ? stepAllowedToolTypes as Array<keyof typeof toolsForRequest>
        : requiredSubagentUuid
          ? ['subagent'] as Array<keyof typeof toolsForRequest>
          : undefined;
      const toolChoice = !browserStateGatePending && requiredSubagentUuid
        ? { type: 'tool' as const, toolName: 'subagent' as keyof typeof toolsForRequest }
        : undefined;
      return {
        system: requestSystemPrompt || undefined,
        messages: requestMessages,
        modelMessagesForLog,
        allowedTypes: stepAllowedToolTypes,
        activeTools,
        toolChoice,
      };
    }

      if (codexMode) {
      const aiStartedAt = Date.now();
      const { system, messages, modelMessagesForLog, allowedTypes: stepAllowedToolTypes } = await prepareStep(0);
      ensureActive();
      await onAttemptDebug?.({
        phase: 'ai:runtime:request',
        stepIndex,
        message: 'AI request started; waiting for browser action decision.',
        details: aiRequestLogDetails(aiRequest, {
          provider: getModelSettings().provider,
          model: getModelSettings().model,
          codexObjectMode: true,
        }, modelMessagesForLog),
      });
      const result = await requestWatchdog.run(generateText({
        model: getModel(),
        instructions: system,
        messages,
        temperature: 0.1,
        reasoning: aiReasoningEffort(),
        maxOutputTokens: aiMaxOutputTokens(),
        maxRetries: 0,
        abortSignal: requestWatchdog.abortSignal,
        timeout: runtimeRequestTimeoutMs,
        telemetry: aiTelemetry('browser-chat-codex-runtime'),
      })).finally(() => requestWatchdog.dispose());
      const aiElapsedMs = elapsedSince(aiStartedAt);
      ensureActive();
      const object = alignCodexRuntimeObjectTool(
        codexRuntimeObjectFromText(result.text),
        stepAllowedToolTypes,
      );
      const execution = await executeCodexRuntimeObject({
        session,
        runId: input.runId,
        stepIndex,
        type: object.type,
        message: object.message || undefined,
        params: object.params,
        allowedTypes: stepAllowedToolTypes,
        traces,
        aiRequest,
        visualContext,
        abortSignal,
        shouldContinue: input.shouldContinue,
        requestToolConfirmation: input.requestToolConfirmation,
        runSubagents: input.runSubagents,
        readSubagent: input.readSubagent,
        requiredSubagentUuid: input.requiredSubagentUuid,
        browserStatePreflightComplete: !requiresBrowserStatePreflight(
          Boolean(input.browserStatePreflightComplete),
          traces,
        ),
        readFile: input.readFile,
        readFileVisuals: input.readFileVisuals,
        readSkill: input.readSkill,
        loadedHiddenRuntimeSkillIds,
        attachmentBindings: input.attachmentBindings,
        credentialBindings: activeCredentialBindings,
        ensureBrowserStarted: input.ensureBrowserStarted,
        onVisualContextChange: async (snapshot) => { ensureActive(); await onAttemptDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot }); },
        onToolTrace: async (trace) => {
          ensureActive();
          upsertToolTrace(durableTraces, trace);
          await onToolTrace?.(trace, { visualContext: visualContext.snapshot() });
          ensureActive();
          if (!trace.result || trace.completedAt) {
            await onAttemptDebug?.({ phase: 'ai:tool', stepIndex, message: `${trace.name} -> ${toolTraceStatus(trace)}`, details: { trace, visualContext: visualContext.snapshot() } });
          }
        },
        onReferenceImage: queueReferenceImage,
      });
      ensureActive();
      await onAttemptDebug?.({
        phase: 'ai:runtime:object',
        stepIndex,
        message: 'Codex object -> ' + object.type + '; AI+tool ' + elapsedSince(aiStartedAt) + 'ms',
        details: aiResponseLogDetails({
          aiRequest,
          modelMessages: modelMessagesForLog,
          response: { result, object, execution },
          elapsedMs: elapsedSince(aiStartedAt),
          aiElapsedMs,
          traces,
          visualContext: visualContext.snapshot(),
          extra: { responseType: 'object', objectType: object.type, usage: result.usage },
        }),
      });
      const finishState = aiSdkFinishState(result.finishReason, {
        runtimeContinuationRequired: execution.executed,
      });
      if (finishState.retryRequest) {
        throw new Error(`AI SDK returned retryable finish reason "${finishState.finishReason}".`);
      }
      consecutiveRequestFailures = 0;
      return {
        text: execution.text,
        traces,
        aiRequest,
        modelMessages: mergeRuntimeModelMessageChain(
          lastPreparedMessages,
          result.responseMessages,
          lastPreparedResponsePrefixLength,
        ),
        turnMessages: [...turnInputMessages, ...result.responseMessages],
        contextCompression: latestContextCompression,
        visualContext: visualContext.snapshot(),
        finishReason: finishState.finishReason,
        responseFinished: finishState.terminatesTurn,
        responseStatus: finishState.status,
      };
    }

    const browserToolRuntime = await makeBrowserTools(session, traces, aiRequest, async (trace) => {
      if (!trace.result && !trace.completedAt) requestWatchdog.pause();
      else requestWatchdog.resume();
      ensureActive();
      upsertToolTrace(durableTraces, trace);
      await onToolTrace?.(trace, { visualContext: visualContext.snapshot() });
      ensureActive();
      if (!trace.result || trace.completedAt) {
        await onAttemptDebug?.({
          phase: 'ai:tool',
          stepIndex,
          message: `${trace.name} -> ${toolTraceStatus(trace)}`,
          details: { trace, visualContext: visualContext.snapshot() },
        });
      }
    }, {
      allowedToolTypes,
      runId: input.runId,
      stepIndex,
      visualContext,
      getAiRequest: () => aiRequest,
      getAiRequestElapsedMs: (toolCallId) => toolCallId
        ? aiRequestElapsedByToolCallId.get(toolCallId)
        : undefined,
      abortSignal,
      shouldContinue: input.shouldContinue,
      requestToolConfirmation: input.requestToolConfirmation,
      runSubagents: input.runSubagents,
      readSubagent: input.readSubagent,
      requiredSubagentUuid: input.requiredSubagentUuid,
      readFile: input.readFile,
      readFileVisuals: input.readFileVisuals,
      readSkill: input.readSkill,
      loadedHiddenRuntimeSkillIds,
      attachmentBindings: input.attachmentBindings,
      credentialBindings: input.credentialBindings,
      getCredentialBindings: () => activeCredentialBindings,
      browserStatePreflightComplete: () => !requiresBrowserStatePreflight(
        Boolean(input.browserStatePreflightComplete),
        traces,
      ),
      onReferenceImage: queueReferenceImage,
      ensureBrowserStarted: input.ensureBrowserStarted,
      onDebug: onAttemptDebug,
      onVisualContextChange: async (snapshot) => {
        ensureActive();
        await onAttemptDebug?.({ phase: 'ai:visual-context', stepIndex, message: 'Visual Context Manager updated.', details: snapshot });
      },
    });
    const browserTools = browserToolRuntime.tools;
    const allowedToolNameSet = new Set(allowedToolTypes);
    const allowedExternalTools = Object.fromEntries(
      Object.entries(externalTools).filter(([name]) => allowedToolNameSet.has(name)),
    );
    const conflictingExternalToolName = Object.keys(allowedExternalTools).find((name) => name in browserTools);
    if (conflictingExternalToolName) {
      await browserToolRuntime.dispose();
      throw new Error(`External tool name conflicts with an enabled capability: ${conflictingExternalToolName}.`);
    }
    nativeToolsRef.current = {
      ...browserTools,
      ...allowedExternalTools,
    };
    const toolsForRequest = nativeToolsRef.current;
    const stableToolOrder = Object.keys(toolsForRequest).sort() as Array<keyof typeof toolsForRequest>;
    const repairToolCall: ToolCallRepairFunction<typeof toolsForRequest> = async ({ toolCall }) => {
      const repairedInput = repairBrowserChatToolCallInput(toolCall.toolName, toolCall.input);
      return repairedInput ? { ...toolCall, input: repairedInput } : null;
    };
    const stopWhen = runtimeToolLoopStopToolNames.map((toolName) => (
      hasToolCall<typeof toolsForRequest>(toolName)
    ));
    const stopAfterHumanVerification: StopCondition<typeof toolsForRequest> = ({ steps }) => steps.some((step) => (
      step.toolCalls.some((call) => isBrowserHumanVerificationCall(call.toolName, call.input))
    ));
    stopWhen.push(stopAfterHumanVerification);
    try {
      let streamedStepText = '';
      const runtimeContext = {
        operationalContext: activeOperationalContext,
        credentialRefs: activeCredentialBindings.map((binding) => binding.ref),
        visualContext: visualContext.snapshot(),
      } satisfies BrowserAgentRuntimeContext;
      const prepareAgentStep = async ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) => {
        requestWatchdog.touch();
        ensureActive();
        const prepared = await prepareStep(stepNumber, messages as RuntimeModelMessage[]);
        ensureActive();
        stepModelMessagesForLog.set(stepNumber, prepared.modelMessagesForLog);
        toolExecutionGate.stepNumber = stepNumber;
        stepTraceStarts.set(stepNumber, traces.length);
        stepStartedAt.set(stepNumber, Date.now());
        streamedStepText = '';
        await onAttemptDebug?.({
          phase: 'ai:runtime:request',
          stepIndex,
          message: 'AI request started; waiting for browser action decision. agent step ' + agentStepLabel(retryAgentStepOffset + stepNumber) + '.',
          details: aiRequestLogDetails(aiRequest, {
            provider: getModelSettings().provider,
            model: getModelSettings().model,
            agentStepIndex: retryAgentStepOffset + stepNumber + 1,
            nativeToolLoop: true,
            toolLoopAgent: input.useToolLoopAgent === true,
          }, prepared.modelMessagesForLog),
        });
        return {
          instructions: prepared.system,
          messages: prepared.messages,
          activeTools: prepared.activeTools,
          toolChoice: prepared.toolChoice,
          runtimeContext: {
            operationalContext: activeOperationalContext,
            credentialRefs: activeCredentialBindings.map((binding) => binding.ref),
            visualContext: visualContext.snapshot(),
          } satisfies BrowserAgentRuntimeContext,
        };
      };
      const approveAgentTool = input.requestToolConfirmation ? async ({ toolCall }: { toolCall?: { toolName: string; input: unknown } }) => {
        if (!toolCall) return 'not-applicable' as const;
        const approval = await requestBrowserToolApproval({
          toolName: toolCall.toolName,
          toolInput: toolCall.input,
          stepIndex,
          request: input.requestToolConfirmation!,
        });
        ensureActive();
        if (approval === 'approved') return { type: 'approved' as const, reason: 'User confirmed the server-classified operation.' };
        if (approval === 'denied') return { type: 'denied' as const, reason: 'User cancelled the server-classified operation.' };
        return 'not-applicable' as const;
      } : undefined;
      const onAgentLanguageModelCallEnd = (event: {
        content: ReadonlyArray<unknown>;
        performance: { responseTimeMs: number };
      }) => {
        const responseTimeMs = finiteContextStat(event.performance.responseTimeMs);
        if (responseTimeMs === undefined) return;
        for (const part of event.content) {
          const record = recordFromUnknown(part);
          if (record.type !== 'tool-call' || typeof record.toolCallId !== 'string') continue;
          aiRequestElapsedByToolCallId.set(record.toolCallId, responseTimeMs);
        }
      };
      const onAgentToolExecutionStart = async (event: { toolCall: { toolCallId: string; toolName: string; input: unknown } }) => {
        if (!externalToolNames.has(event.toolCall.toolName)) return;
        requestWatchdog.pause();
        const trace: ToolTrace = {
          id: event.toolCall.toolCallId,
          name: event.toolCall.toolName,
          input: event.toolCall.input,
          startedAt: Date.now(),
          aiRequestElapsedMs: aiRequestElapsedByToolCallId.get(event.toolCall.toolCallId),
          contextBefore: toolContextFromAiRequest(aiRequest),
        };
        upsertToolTrace(traces, trace);
        upsertToolTrace(durableTraces, trace);
        await onToolTrace?.(trace, { visualContext: visualContext.snapshot() });
      };
      const onAgentToolExecutionEnd = async (event: { toolCall: { toolCallId: string; toolName: string; input: unknown }; toolExecutionMs: number; toolOutput: unknown }) => {
        if (!externalToolNames.has(event.toolCall.toolName)) return;
        requestWatchdog.resume();
        const output = event.toolOutput as { type?: string; output?: unknown; error?: unknown };
        const resultValue = output.type === 'tool-result' ? output.output : output.error;
        const actual = typeof resultValue === 'string'
          ? resultValue
          : JSON.stringify(jsonSafe(resultValue));
        const trace: ToolTrace = {
          id: event.toolCall.toolCallId,
          name: event.toolCall.toolName,
          input: event.toolCall.input,
          result: {
            ok: output.type === 'tool-result',
            actual: actual || (output.type === 'tool-result' ? 'Memory tool completed.' : 'Memory tool failed.'),
          },
          startedAt: traces.find((item) => item.id === event.toolCall.toolCallId)?.startedAt,
          completedAt: Date.now(),
          elapsedMs: event.toolExecutionMs,
          actionElapsedMs: event.toolExecutionMs,
          aiRequestElapsedMs: aiRequestElapsedByToolCallId.get(event.toolCall.toolCallId),
          contextBefore: toolContextFromAiRequest(aiRequest),
        };
        upsertToolTrace(traces, trace);
        upsertToolTrace(durableTraces, trace);
        await onToolTrace?.(trace, { visualContext: visualContext.snapshot() });
      };
      const onAgentStepEnd = async (event: { text?: string; stepNumber?: number; toolCalls?: unknown[]; toolResults?: unknown[] }) => {
        requestWatchdog.touch();
        ensureActive();
        latestText = event.text || '';
        const hasStructuredToolCalls = Array.isArray(event.toolCalls) && event.toolCalls.length > 0;
        const visibleText = input.suppressTextOutput || hasStructuredToolCalls || containsPrivateToolProtocol(latestText)
          ? ''
          : normalizeBrowserChatFinalReplyText(latestText);
        const debugResponseText = input.suppressTextOutput || hasStructuredToolCalls
          ? 'AI response withheld until the tool workflow reaches a terminal response.'
          : visibleText || 'AI returned no text; tool call completed.';
        const turnIndex = typeof event.stepNumber === 'number' ? event.stepNumber : toolExecutionGate.stepNumber;
        if (visibleText) {
          await onTextStream?.({
            delta: visibleText,
            stepNumber: turnIndex,
            text: visibleText,
          });
          ensureActive();
        }
        const traceStart = stepTraceStarts.get(turnIndex) ?? 0;
        const newTraces = traces.slice(traceStart);
        const startedAt = stepStartedAt.get(turnIndex) || Date.now();
        await onAttemptDebug?.({
          phase: 'ai:runtime:response',
          stepIndex,
          message: trimDebugText(debugResponseText, 220) + '; agent step ' + agentStepLabel(retryAgentStepOffset + turnIndex) + '; AI+tool ' + elapsedSince(startedAt) + 'ms',
          details: aiResponseLogDetails({
            aiRequest,
            modelMessages: stepModelMessagesForLog.get(turnIndex),
            // Preserve the SDK's ordered step transcript. The client can now
            // render text/calls/results directly, rather than guessing which
            // later execution trace belongs under a model sentence.
            response: {
              content: [
                ...(visibleText ? [{ type: 'text', text: visibleText }] : []),
                ...(Array.isArray(event.toolCalls) ? event.toolCalls.map((toolCall) => ({
                  ...(typeof toolCall === 'object' && toolCall ? toolCall : {}),
                  type: 'tool-call',
                })) : []),
                ...(Array.isArray(event.toolResults) ? event.toolResults.map((toolResult) => ({
                  ...(typeof toolResult === 'object' && toolResult ? toolResult : {}),
                  type: 'tool-result',
                })) : []),
              ],
              text: visibleText,
            },
            elapsedMs: elapsedSince(startedAt),
            stepStartedAt: startedAt,
            traces: newTraces,
            visualContext: visualContext.snapshot(),
            extra: {
              responseType: 'text',
              text: visibleText,
              agentStepIndex: retryAgentStepOffset + turnIndex + 1,
              nativeToolLoop: true,
              toolLoopAgent: input.useToolLoopAgent === true,
            },
          }),
        });
      };
      const timeout = {
        ...aiStreamTimeouts(runtimeRequestTimeoutMs),
        tools: {
          spawnSubagentsMs: boundedInteger(process.env.AI_SUBAGENT_LOOP_TIMEOUT_MS, 600_000, 1_000, 3_600_000),
        },
      };
      let streamedRequestError: unknown;
      const agentSettings = {
        model: getModel(),
        tools: toolsForRequest,
        toolOrder: stableToolOrder,
        runtimeContext,
        stopWhen,
        prepareStep: prepareAgentStep,
        toolApproval: approveAgentTool,
        onLanguageModelCallEnd: onAgentLanguageModelCallEnd,
        onToolExecutionStart: onAgentToolExecutionStart,
        onToolExecutionEnd: onAgentToolExecutionEnd,
        onStepEnd: onAgentStepEnd,
        temperature: 0.1,
        reasoning: aiReasoningEffort(),
        maxOutputTokens: aiMaxOutputTokens(),
        maxRetries: 0,
        repairToolCall,
        onError: ({ error }: { error: unknown }) => {
          streamedRequestError ??= error;
        },
        telemetry: aiTelemetry(input.useToolLoopAgent ? 'browser-chat-subagent-tool-loop-agent' : 'browser-chat-agent-loop'),
      };
      const result = input.useToolLoopAgent
        ? await new ToolLoopAgent(agentSettings).stream({
          messages: initialMessages,
          abortSignal: requestWatchdog.abortSignal,
          timeout,
        })
        : streamText({
          ...agentSettings,
          messages: initialMessages,
          abortSignal: requestWatchdog.abortSignal,
          timeout,
          onChunk: async ({ chunk }) => {
            if (chunk.type !== 'text-delta' || !chunk.text) return;
            requestWatchdog.touch();
            ensureActive();
            streamedStepText += chunk.text;
            latestText = streamedStepText;
          },
        });
      let resultText: Awaited<typeof result.text>;
      let resultFinishReason: Awaited<typeof result.finishReason>;
      let resultSteps: Awaited<typeof result.steps>;
      let responseMessages: Awaited<typeof result.responseMessages>;
      try {
        [resultText, resultFinishReason, resultSteps, responseMessages] = await requestWatchdog.run(Promise.all([
          result.text,
          result.finishReason,
          result.steps,
          result.responseMessages,
        ]));
        requestWatchdog.dispose();
      } catch (error) {
        throw streamedRequestError || error;
      }
      if (streamedRequestError) throw streamedRequestError;
      const responseToolCallCount = responseMessages.reduce((count, message) => (
        count + (Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'tool-call').length
          : 0)
      ), 0);
      const responseToolResultCount = responseMessages.reduce((count, message) => (
        count + (Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'tool-result').length
          : 0)
      ), 0);
      const toolCallCount = Math.max(
        responseToolCallCount,
        resultSteps.reduce((count, step) => count + step.toolCalls.length, 0),
      );
      const toolResultCount = Math.max(
        responseToolResultCount,
        resultSteps.reduce((count, step) => count + step.toolResults.length, 0),
      );
      const modelSettings = getModelSettings();
      const miniMaxRuntime = /minimax/i.test(`${modelSettings.provider} ${modelSettings.model}`);
      if (miniMaxRuntime && containsPrivateToolProtocol(resultText || latestText) && toolCallCount === 0) {
        privateToolProtocolFailures += 1;
        if (lastRetryState) {
          lastRetryState.messages = [
            ...lastRetryState.messages,
            {
              role: 'user',
              content: '[Provider protocol correction] The previous response emitted a private textual tool protocol. Do not repeat or quote it. Use only the standard structured tool_calls interface supplied by this request, or return ordinary final text when no tool is needed.',
            },
          ];
        }
        const error = new Error('MiniMax emitted a private textual tool protocol instead of a standard structured tool call.');
        error.name = 'AI_PrivateToolProtocolError';
        Object.assign(error, { privateToolProtocolRetryable: privateToolProtocolFailures === 1 });
        throw error;
      }
      if (aiSdkEmptyStopRequiresRetry({
        finishReason: resultFinishReason,
        responseText: resultText,
        toolCallCount,
      })) {
        const error = new Error('No output generated: provider returned stop with reasoning only and no displayable text or tool call.');
        error.name = 'AI_NoOutputGeneratedError';
        throw error;
      }
      const finishState = aiSdkFinishState(resultFinishReason, {
        runtimeContinuationRequired: aiSdkToolResultRequiresContinuation({
          finishReason: resultFinishReason,
          responseText: resultText,
          toolCallCount,
          toolResultCount,
        }),
      });
      ensureActive();
      latestText = finishState.terminatesTurn
        ? cleanFinalDisplayText(resultText || latestText) || ''
        : toolConsistentAssistantText(resultText || latestText, traces.at(-1)?.name);
      if (finishState.retryRequest) {
        throw new Error(`AI SDK returned retryable finish reason "${finishState.finishReason}".`);
      }
      consecutiveRequestFailures = 0;
      return {
        text: latestText,
        traces,
        aiRequest,
        modelMessages: mergeRuntimeModelMessageChain(
          lastPreparedMessages,
          responseMessages,
          lastPreparedResponsePrefixLength,
        ),
        turnMessages: [...turnInputMessages, ...responseMessages],
        contextCompression: latestContextCompression,
        visualContext: visualContext.snapshot(),
        finishReason: finishState.finishReason,
        responseFinished: finishState.terminatesTurn,
        responseStatus: finishState.status,
      };
    } catch (error) {
      requestWatchdog.dispose();
      if (isBrowserChatAbortError(error, abortSignal) || (input.shouldContinue && !input.shouldContinue())) throw browserChatAbortError(abortSignal);
      if (error && typeof error === 'object') {
        (error as { aiRequest?: AiRequestSnapshot }).aiRequest = aiRequest;
        attachRuntimeFailureRecovery(error, lastRetryState, historyMessages.length, turnInputMessages);
      }
      throw error;
    } finally {
      await browserToolRuntime.dispose();
    }
  }

  // Keep SDK retries disabled, but allow the runtime loop to retry transient upstream
  // disconnects with the prepared model messages. A provider-rejected tool exchange
  // is removed before retry because replaying that identical invalid chain cannot work.
  // The limit is consecutive failures; only a resolved SDK response resets the counter.
  const consecutiveFailureLimit = runtimeRequestConsecutiveFailureLimit();
  let lastError: unknown;
  let retryingAfterFailure = false;
  let lastRetryDecision: RuntimeRetryDecision | undefined;
  let retryDelayMs = 0;
  let attemptNumber = 0;

  while (true) {
    ensureActive();
    attemptNumber += 1;
    const executionIdentity = runtimeExecutionIdentity(
      input.turnId || input.runId,
      stepIndex,
      attemptNumber,
    );
    const retryState = retryingAfterFailure && lastRetryState?.messages.length ? lastRetryState : undefined;
    try {
      if (retryingAfterFailure) {
        if (!retryState) {
          await onDebug?.({
            phase: 'ai:runtime:retry-skipped',
            stepIndex,
            message: 'AI request failed, but no preserved model messages exist; not rebuilding messages for retry.',
            details: {
              error: infrastructureError(lastError),
              consecutiveFailures: consecutiveRequestFailures,
              consecutiveFailureLimit,
              execution: executionIdentity,
              retryDecision: lastRetryDecision,
            },
          });
          ensureActive();
          break;
        }
        ensureActive();
        await onDebug?.({
          phase: 'ai:runtime:retry',
          stepIndex,
          message: `第 ${attemptNumber - 1}/${consecutiveFailureLimit} 次 AI 请求失败；等待 ${retryDelayMs}ms 后开始第 ${attemptNumber}/${consecutiveFailureLimit} 次请求。`,
          details: {
            error: infrastructureError(lastError),
            consecutiveFailures: consecutiveRequestFailures,
            consecutiveFailureLimit,
            delayMs: retryDelayMs,
            execution: executionIdentity,
            retryDecision: lastRetryDecision,
            reusePreparedMessages: Boolean(retryState),
            messageCount: retryState?.messages.length,
            imageCount: retryState?.imagePaths.length,
            agentStepIndex: retryState ? retryState.agentStepOffset + 1 : undefined,
          },
        });
        ensureActive();
        await waitForRuntimeRetry(retryDelayMs, abortSignal, input.shouldContinue);
        ensureActive();
      }
      ensureActive();
      await onDebug?.({
        phase: 'ai:runtime:attempt',
        stepIndex,
        message: `开始第 ${attemptNumber}/${consecutiveFailureLimit} 次 AI 请求${attemptNumber > 1 ? '（重试）' : ''}。最大 ${consecutiveFailureLimit} 次（首次请求 + ${Math.max(0, consecutiveFailureLimit - 1)} 次重试）。`,
        details: {
          attemptNumber,
          attemptLimit: consecutiveFailureLimit,
          execution: executionIdentity,
          isRetry: attemptNumber > 1,
        },
      });
      structuredLog({
        event: 'ai.runtime.request.attempt_started',
        operationId: executionIdentity.turnId,
        attemptId: executionIdentity.attemptId,
        attemptNumber,
        attemptLimit: consecutiveFailureLimit,
        isRetry: attemptNumber > 1,
        provider: getModelSettings().provider,
        model: getModelSettings().model,
      });
      const result = await runAgent(retryState, executionIdentity);
      const requestOutcomeMessage = result.responseFinished
        ? result.responseStatus === 'passed'
          ? `第 ${attemptNumber}/${consecutiveFailureLimit} 次 AI 请求已返回并正常结束。`
          : `第 ${attemptNumber}/${consecutiveFailureLimit} 次 AI 请求已返回，但结束状态为 ${result.finishReason || result.responseStatus}。`
        : `第 ${attemptNumber}/${consecutiveFailureLimit} 次 AI 请求已返回，Agent 将继续处理。`;
      await onDebug?.({
        phase: 'ai:runtime:attempt-succeeded',
        stepIndex,
        message: requestOutcomeMessage,
        details: {
          attemptNumber,
          attemptLimit: consecutiveFailureLimit,
          execution: executionIdentity,
          finishReason: result.finishReason,
          responseFinished: result.responseFinished,
          responseStatus: result.responseStatus,
        },
      });
      structuredLog({
        event: 'ai.runtime.request.attempt_succeeded',
        operationId: executionIdentity.turnId,
        attemptId: executionIdentity.attemptId,
        attemptNumber,
        attemptLimit: consecutiveFailureLimit,
        provider: getModelSettings().provider,
        model: getModelSettings().model,
        finishReason: result.finishReason,
        responseFinished: result.responseFinished,
        responseStatus: result.responseStatus,
      });
      return result;
    } catch (error) {
      if (isBrowserChatAbortError(error, abortSignal) || (input.shouldContinue && !input.shouldContinue())) throw browserChatAbortError(abortSignal);
      lastError = error;
      consecutiveRequestFailures += 1;
      lastRetryDecision = classifyRuntimeRetry(error, abortSignal);
      const missingToolCallId = runtimeMissingToolCallId(error);
      if (missingToolCallId && lastRetryState?.messages.length) {
        lastRetryState = {
          ...lastRetryState,
          messages: omitRuntimeModelToolExchange(lastRetryState.messages, missingToolCallId),
        };
      }
      const retryExhausted = lastRetryDecision.retryable
        && consecutiveRequestFailures >= consecutiveFailureLimit;
      const willRetry = lastRetryDecision.retryable && !retryExhausted;
      retryDelayMs = willRetry
        ? runtimeRetryDelayMs(consecutiveRequestFailures, lastRetryDecision)
        : 0;
      const failurePhase = willRetry
        ? 'ai:runtime:attempt-failed'
        : retryExhausted
          ? 'ai:runtime:retry-exhausted'
          : 'ai:runtime:retry-skipped';
      const failureMessage = willRetry
        ? `第 ${attemptNumber}/${consecutiveFailureLimit} 次 AI 请求失败（${lastRetryDecision.category}）；${retryDelayMs}ms 后将进行第 ${attemptNumber + 1}/${consecutiveFailureLimit} 次请求。`
        : retryExhausted
          ? `第 ${attemptNumber}/${consecutiveFailureLimit} 次 AI 请求失败（${lastRetryDecision.category}）；已用完 ${consecutiveFailureLimit} 次请求机会，本轮最终失败。`
          : `第 ${attemptNumber}/${consecutiveFailureLimit} 次 AI 请求失败（${lastRetryDecision.category}）；该错误不可重试，本轮最终失败。`;
      await onDebug?.({
        phase: failurePhase,
        stepIndex,
        message: failureMessage,
        details: {
          error: infrastructureError(error),
          attemptNumber,
          attemptLimit: consecutiveFailureLimit,
          consecutiveFailures: consecutiveRequestFailures,
          consecutiveFailureLimit,
          delayMs: willRetry ? retryDelayMs : undefined,
          nextAttemptNumber: willRetry ? attemptNumber + 1 : undefined,
          willRetry,
          finalFailure: !willRetry,
          execution: executionIdentity,
          retryDecision: lastRetryDecision,
          ...(missingToolCallId ? {
            protocolRepair: {
              action: 'removed rejected tool call/result exchange from preserved context',
              toolCallId: missingToolCallId,
            },
          } : {}),
        },
      });
      structuredLog({
        event: willRetry ? 'ai.runtime.request.attempt_failed' : 'ai.runtime.request.failed',
        level: willRetry ? 'info' : 'warn',
        operationId: executionIdentity.turnId,
        attemptId: executionIdentity.attemptId,
        attemptNumber,
        attemptLimit: consecutiveFailureLimit,
        category: lastRetryDecision.category,
        reason: lastRetryDecision.reason,
        statusCode: lastRetryDecision.statusCode,
        retryDelayMs: willRetry ? retryDelayMs : undefined,
        nextAttemptNumber: willRetry ? attemptNumber + 1 : undefined,
        willRetry,
        finalFailure: !willRetry,
        provider: getModelSettings().provider,
        model: getModelSettings().model,
        ...(willRetry
          ? { errorMessage: infrastructureError(error) }
          : { error }),
      });
      if (!willRetry) break;
      retryingAfterFailure = true;
    }
  }

  ensureActive();
  if (lastError && typeof lastError === 'object') {
    (lastError as { aiRequest?: AiRequestSnapshot }).aiRequest ??= lastAiRequest;
    (lastError as { runtimeRetry?: Record<string, unknown> }).runtimeRetry ??= {
      consecutiveFailures: consecutiveRequestFailures,
      consecutiveFailureLimit,
      decision: lastRetryDecision,
      retryDelayMs,
    };
    throw lastError;
  }

  const wrapped = new Error(String(lastError || 'AI request failed before a response was returned'));
  (wrapped as { aiRequest?: AiRequestSnapshot }).aiRequest = lastAiRequest;
  (wrapped as { runtimeRetry?: Record<string, unknown> }).runtimeRetry = {
    consecutiveFailures: consecutiveRequestFailures,
    consecutiveFailureLimit,
    decision: lastRetryDecision,
    retryDelayMs,
  };
  throw wrapped;
}

export type InteractiveBrowserTurnMessage = ModelMessage;

export type InteractiveBrowserTurnResult = {
  status: 'passed' | 'failed' | 'blocked';
  reply: string;
  blocks: BrowserChatFinalBlock[];
  steps: StepExecutionResult[];
  newSteps: StepExecutionResult[];
  consoleErrors: string[];
  networkErrors: string[];
  modelMessages: ModelMessage[];
  turnMessages: ModelMessage[];
  contextCompression?: BrowserChatModelContextCompression;
  continuationSummary?: string;
};

function browserChatSafetyInstructions(mode?: BrowserChatSafetyMode) {
  if (mode === 'full') {
    return [
      'Safety mode: full.',
      '- When the user request is clear, do not ask for extra confirmation only because an operation is important.',
      '- Still stop or ask for help when the page requires captcha/OTP/security verification, missing credentials, or information only the user can provide.',
    ].join('\n');
  }
  return [
    'Safety mode: strict.',
    '- The backend independently evaluates important, irreversible, externally visible, data-changing, privacy-sensitive, or costly tool calls and pauses them for user approval before execution.',
    '- Do not ask for approval in plain text and do not add approval flags to tool input. Call the intended tool normally; the backend is the authority.',
    '- Preparatory field entry, including filling a username or password for an explicitly requested login, does not pause separately; the final submit/login action does.',
  ].join('\n');
}

function createInteractiveBrowserRuntimeRecord(input: {
  safetyMode?: BrowserChatSafetyMode;
  targetUrl: string;
  instruction: string;
}): BrowserChatRuntimeRecord {
  const targetUrl = input.targetUrl || 'about:blank';
  const systemPrompt = browserChatSafetyInstructions(input.safetyMode);
  return {
    description: input.instruction,
    targetUrl,
    systemPrompt,
  };
}

function upsertStep(steps: StepExecutionResult[], step: StepExecutionResult) {
  const index = steps.findIndex((item) => item.index === step.index);
  if (index >= 0) steps[index] = { ...steps[index], ...step };
  else steps.push(step);
  steps.sort((a, b) => a.index - b.index);
}

export async function executeInteractiveBrowserTurn(input: {
  session: BrowserSession;
  runId: string;
  turnId?: string;
  initialStepIndex?: number;
  targetUrl: string;
  instruction: string;
  modelInstruction?: string;
  operationalContext?: string;
  conversation?: InteractiveBrowserTurnMessage[];
  continuationSummary?: string;
  completedSteps?: StepExecutionResult[];
  safetyMode?: BrowserChatSafetyMode;
  referenceImagePaths?: string[];
  getRuntimeOperationalContext?: () => BrowserChatOperationalContext | Promise<BrowserChatOperationalContext>;
  onProgress?: (step: StepExecutionResult) => void | Promise<void>;
  onTextStream?: (update: BrowserChatTextStreamUpdate) => void | Promise<void>;
  onModelMessages?: (update: {
    activeMessages: ModelMessage[];
    turnMessages: ModelMessage[];
  }) => void | Promise<void>;
  onContextCompression?: (update: {
    activeMessages: ModelMessage[];
    contextCompression: BrowserChatModelContextCompression;
  }) => void | Promise<void>;
  onContinuationSummary?: (summary: string) => void | Promise<void>;
  onDebug?: ExecutionDebug;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
  runSubagents?: BrowserChatSubagentRunner;
  readSubagent?: BrowserChatSubagentReader;
  readFile?: (input: BrowserChatReadFileInput) => Promise<BrowserActionResult>;
  readFileVisuals?: (input: BrowserChatFileVisualInput) => Promise<BrowserActionResult>;
  readSkill?: BrowserChatReadSkill;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  credentialBindings?: BrowserCodeCredentialBinding[];
  ensureBrowserStarted?: () => Promise<void>;
  allowedToolTypes?: string[];
  memoryTools?: ToolSet;
  useToolLoopAgent?: boolean;
}): Promise<InteractiveBrowserTurnResult> {
  const ensureActive = () => throwIfStopped(input.abortSignal, input.shouldContinue);
  const steps = [...(input.completedSteps || [])];
  const newSteps: StepExecutionResult[] = [];
  let activeModelMessages = [...(input.conversation || [])];
  let activeContinuationSummary = sanitizeRuntimeContinuationSummary(input.continuationSummary || '');
  const turnModelMessages: ModelMessage[] = [];
  let contextCompression: BrowserChatModelContextCompression | undefined;
  const runtimeRecord = createInteractiveBrowserRuntimeRecord({
    safetyMode: input.safetyMode,
    targetUrl: input.targetUrl,
    instruction: input.instruction,
  });
  let finalStatus: InteractiveBrowserTurnResult['status'] = 'passed';
  let reply = '';
  let finalBlocks: BrowserChatFinalBlock[] = [];
  let endedWithFinalAnswer = false;
  let browserStatePreflightComplete = false;
  // Runtime Skills are scoped to this Agent run. Every model step and both
  // tool protocols share successful reads, but a new invocation starts empty.
  const loadedHiddenRuntimeSkillIds = new Set<string>();
  const turnRenderedArtifactIds = new Set<string>();
  const turnDocumentIds = new Set<string>();
  const requiresOfficeVisualQa = modelSupportsImageInput() && Boolean(input.readFileVisuals);
  while (true) {
    ensureActive();
    const stepIndex = Math.max(input.initialStepIndex || 0, ...steps.map((step) => step.index)) + 1;
    await input.onDebug?.({ phase: 'chat:step:start', stepIndex, message: `正在准备第 ${stepIndex} 步浏览器操作。` });
    const runningStep: StepExecutionResult = {
      index: stepIndex,
      action: 'AI is handling the latest browser chat message',
      expected: 'AI should inspect the live browser state and perform one useful browser action or report the current state.',
      actual: 'AI is choosing the next browser action from the current page.',
      status: 'running',
    };

    const liveToolTraces: ToolTrace[] = [];
    let latestToolProgress: ToolTraceProgress | undefined;
    let actionResult: Awaited<ReturnType<typeof executeRuntimeStep>>;
    let withheldTextUpdate: BrowserChatTextStreamUpdate | undefined;
    const flushWithheldText = async () => {
      if (!withheldTextUpdate) return;
      await input.onTextStream?.(withheldTextUpdate);
      withheldTextUpdate = undefined;
    };

    try {
      const pendingSubagentUuids = pendingSubagentUuidsFromSteps(newSteps);
      const requiredSubagentUuid = pendingSubagentUuids[0];
      const pendingVisualQa = requiresOfficeVisualQa
        ? await pendingOfficeVisualQa(input.runId, turnRenderedArtifactIds)
        : [];
      const requiredVisualQa = pendingVisualQa[0];
      const pendingDocumentWork = await pendingOfficeDocumentWork(input.runId, turnDocumentIds, {
        requireVisualQa: requiresOfficeVisualQa,
      });
      const requiredDocumentWork = pendingDocumentWork[0];
      const initialRuntimeStep = turnModelMessages.length === 0;
      const requiredSubagentInstruction = requiredSubagentUuid
        ? requiredSubagentReadDirective(requiredSubagentUuid, pendingSubagentUuids.length)
        : '';
      const requiredVisualQaInstruction = requiredVisualQa
        ? requiredVisualQa.failedPages.length
          ? `[Mandatory Office visual repair gate]
Continue the current artifact workflow and the same documentId=${requiredVisualQa.documentId}; do not recreate the document or repeat source research. Do not present a delivery/final-success summary yet.
The latest rendered artifact failed visual QA on pages ${requiredVisualQa.failedPages.join(', ')}. Repair the current saved source with file action=edit using these recorded findings: ${JSON.stringify(requiredVisualQa.failedReviews.flatMap((review) => review.issues.map((issue) => ({ page: review.pageNumber, ...issue }))).slice(0, 20))}. Do not call a file visual action again until the source has been edited and re-rendered. Success is forbidden until the new rendered digest passes every page.`
          : `[Mandatory Office visual QA gate]
Continue the current artifact workflow; do not restart the user's original task, revisit source research, or recreate already generated documents. Do not present a delivery/final-success summary yet.
The latest rendered artifact ${requiredVisualQa.artifactId} cannot be delivered yet. Its renderedDigest is ${requiredVisualQa.renderedDigest}, visualQaDigest is ${requiredVisualQa.visualQaDigest || 'null'}, ${requiredVisualQa.seenPageCount}/${requiredVisualQa.pageCount || '?'} pages have been read, and ${requiredVisualQa.reviewedPageCount}/${requiredVisualQa.pageCount || '?'} pages have explicit reviews. Call file action=visualIndex, then visualRead, then visualReport with an explicit passed/failed conclusion for every page. Reading alone never passes QA. Success is forbidden until every page passes and visualQaDigest === renderedDigest.`
        : '';
      const requiredDocumentWorkInstruction = requiredDocumentWork
        ? `[Mandatory Office document completion gate]
Continue the existing documentId=${requiredDocumentWork.documentId}; do not create a replacement document. The current workflow state is ${requiredDocumentWork.state} and the required next action is file action=${requiredDocumentWork.requiredNextAction}. Rendering will validate the current source before publishing it. A final response is forbidden until the current source is rendered and any required visual QA is completed.`
        : '';
      actionResult = await executeRuntimeStep({
        session: input.session,
        runtimeRecord,
        runId: input.runId,
        turnId: input.turnId || input.runId,
        stepIndex,
        instruction: [
          initialRuntimeStep ? input.modelInstruction || input.instruction : '',
          requiredSubagentInstruction,
          requiredVisualQaInstruction,
          requiredDocumentWorkInstruction,
        ].filter(Boolean).join('\n\n'),
        appendInstruction: initialRuntimeStep || Boolean(requiredSubagentInstruction) || Boolean(requiredVisualQaInstruction) || Boolean(requiredDocumentWorkInstruction),
        operationalContext: input.operationalContext,
        conversation: activeModelMessages,
        continuationSummary: activeContinuationSummary,
        referenceImagePaths: input.referenceImagePaths,
        getRuntimeOperationalContext: input.getRuntimeOperationalContext,
        browserStatePreflightComplete,
        abortSignal: input.abortSignal,
        shouldContinue: input.shouldContinue,
        requestToolConfirmation: input.requestToolConfirmation,
        allowedToolTypes: requiredSubagentUuid ? [browserCapabilityToolNames.browser, 'subagent'] : input.allowedToolTypes,
        requiredSubagentUuid,
        runSubagents: input.runSubagents,
        readSubagent: input.readSubagent,
        readFile: input.readFile,
        readFileVisuals: input.readFileVisuals,
        readSkill: input.readSkill,
        loadedHiddenRuntimeSkillIds,
        attachmentBindings: input.attachmentBindings,
        credentialBindings: input.credentialBindings,
        ensureBrowserStarted: input.ensureBrowserStarted,
        memoryTools: input.memoryTools,
        useToolLoopAgent: input.useToolLoopAgent,
        suppressTextOutput: Boolean(requiredVisualQa || requiredDocumentWork),
        // Text is held server-side until every terminal gate below accepts the
        // response. Tool progress remains visible through onProgress.
        onTextStream: (update) => { withheldTextUpdate = update; },
        onContextCompression: async (update) => {
          activeModelMessages = [...update.activeMessages];
          activeContinuationSummary = update.contextCompression.continuationSummary;
          contextCompression = update.contextCompression;
          await input.onContextCompression?.(update);
        },
        onDebug: input.onDebug,
        onToolTrace: async (trace, progress) => {
          ensureActive();
          upsertToolTrace(liveToolTraces, trace);
          latestToolProgress = progress || latestToolProgress;
          await input.onProgress?.({
            ...runningStep,
            actual: 'AI called a browser tool; waiting for page feedback.',
            tools: summarizeToolTraces(liveToolTraces),
            ...visualContextFieldsFromProgress(latestToolProgress),
          });
          ensureActive();
        },
      });
      ensureActive();
      activeModelMessages = actionResult.modelMessages;
      turnModelMessages.push(...actionResult.turnMessages);
      const operationalTraces = actionResult.traces.filter((trace) => trace.name !== 'contextCompression');
      for (const skillId of hiddenRuntimeSkillIdsReadFromTraces(operationalTraces)) {
        loadedHiddenRuntimeSkillIds.add(skillId);
      }
      await input.onModelMessages?.({
        activeMessages: [...activeModelMessages],
        turnMessages: [...turnModelMessages],
      });
      ensureActive();
      contextCompression = actionResult.contextCompression || contextCompression;
      activeContinuationSummary = actionResult.contextCompression?.continuationSummary || activeContinuationSummary;
      browserStatePreflightComplete ||= !requiresBrowserStatePreflight(false, operationalTraces);
      for (const trace of operationalTraces) {
        const toolInput = splitToolInputAndReason(trace.input).input;
        if (trace.name === 'file' && typeof toolInput.documentId === 'string' && toolInput.documentId) {
          turnDocumentIds.add(toolInput.documentId);
        }
        if (trace.name !== 'file' || toolInput.action !== 'render' || trace.result?.ok !== true) continue;
        const artifactId = parseJsonObjectText(trace.result.actual)?.artifactId;
        if (typeof artifactId === 'string' && artifactId) turnRenderedArtifactIds.add(artifactId);
      }
      if (operationalTraces.length) {
        activeContinuationSummary = fallbackRuntimeContinuationSummary({
          goal: input.instruction,
          stepIndex,
          agentStep: newSteps.length + 1,
          previousSummary: activeContinuationSummary,
          recentToolAttempts: formatCurrentToolAttemptSummary(operationalTraces, 5),
          runtimeState: continuationRuntimeStateFromTraces(operationalTraces),
        });
        await input.onContinuationSummary?.(activeContinuationSummary);
      }
    } catch (error) {
      if (isBrowserChatAbortError(error, input.abortSignal) || (input.shouldContinue && !input.shouldContinue())) throw browserChatAbortError(input.abortSignal);
      const retryInfo = runtimeRetryFromError(error);
      const recovery = runtimeFailureRecoveryFromError(error);
      if (recovery?.messages.length) {
        activeModelMessages = [...recovery.messages];
        turnModelMessages.splice(0, turnModelMessages.length, ...recovery.turnMessages);
      }
      const operationalLiveToolTraces = liveToolTraces.filter((trace) => trace.name !== 'contextCompression');
      if (operationalLiveToolTraces.length) {
        activeContinuationSummary = fallbackRuntimeContinuationSummary({
          goal: input.instruction,
          stepIndex,
          agentStep: newSteps.length + 1,
          previousSummary: activeContinuationSummary,
          recentToolAttempts: formatCurrentToolAttemptSummary(operationalLiveToolTraces, 8),
          runtimeState: continuationRuntimeStateFromTraces(operationalLiveToolTraces),
        });
        await input.onContinuationSummary?.(activeContinuationSummary);
      }
      ensureActive();
      const recoveredVisualContext = latestToolProgress?.visualContext;
      const errorStep = await createRuntimeErrorStep({
        stepIndex,
        error,
        tools: summarizeToolTraces(liveToolTraces),
        aiRequest: error && typeof error === 'object' ? (error as { aiRequest?: AiRequestSnapshot }).aiRequest : undefined,
        visualContext: recoveredVisualContext,
      });
      ensureActive();
      upsertStep(steps, errorStep);
      newSteps.push(errorStep);
      await input.onProgress?.(errorStep);
      ensureActive();
      await input.onDebug?.({
        phase: retryInfo ? 'ai:runtime:retry-exhausted' : 'ai:runtime:error',
        stepIndex,
        message: userFacingRecoverableRuntimeError(error),
        details: {
          error: serializeError(error),
          screenshotPath: errorStep.screenshotPath,
          aiRequest: errorStep.aiRequest,
          tools: errorStep.tools,
          retryInfo,
        },
      });
      finalStatus = 'failed';
      reply = userFacingRecoverableRuntimeError(error);
      finalBlocks = [{ type: 'markdown', text: reply }];
      activeModelMessages = appendTerminalBrowserChatTurn(
        activeModelMessages,
        input.modelInstruction || input.instruction,
        reply,
      );
      turnModelMessages.splice(
        0,
        turnModelMessages.length,
        ...appendTerminalBrowserChatTurn(
          turnModelMessages,
          input.modelInstruction || input.instruction,
          reply,
        ),
      );
      await input.onModelMessages?.({
        activeMessages: [...activeModelMessages],
        turnMessages: [...turnModelMessages],
      });
      endedWithFinalAnswer = true;
      break;
    }

    ensureActive();
    const browserChatReply = textFromUnknown(actionResult.text).trim();
    const structuredFinalResponse = finalResponseFromTraces(actionResult.traces)
      || finalResponseFromText(browserChatReply);
    if (structuredFinalResponse?.blocks.length) {
      const pendingVisualQa = requiresOfficeVisualQa
        ? await pendingOfficeVisualQa(input.runId, turnRenderedArtifactIds)
        : [];
      if (pendingVisualQa.length) {
        await input.onDebug?.({
          phase: 'chat:file-visual-qa-required',
          stepIndex,
          message: 'A rendered Office artifact has not completed full-page visual QA; rejecting the structured final response.',
          details: { pendingVisualQa },
        });
        continue;
      }
      const pendingDocumentWork = await pendingOfficeDocumentWork(input.runId, turnDocumentIds, {
        requireVisualQa: requiresOfficeVisualQa,
      });
      if (pendingDocumentWork.length) {
        await input.onDebug?.({
          phase: 'chat:file-document-completion-required',
          stepIndex,
          message: 'An Office document has pending source, render, or QA work; rejecting the structured final response.',
          details: { pendingDocumentWork },
        });
        continue;
      }
      const runningIndex = steps.findIndex((step) => step.index === stepIndex && step.status === 'running');
      if (runningIndex >= 0) steps.splice(runningIndex, 1);
      finalBlocks = structuredFinalResponse.blocks;
      reply = browserChatFinalBlocksToText(finalBlocks);
      finalStatus = structuredFinalResponse.status;
      endedWithFinalAnswer = true;
      break;
    }
    if (!actionResult.traces.length) {
      const runningIndex = steps.findIndex((step) => step.index === stepIndex && step.status === 'running');
      if (runningIndex >= 0) steps.splice(runningIndex, 1);
      if (actionResult.responseFinished) {
        const pendingVisualQa = requiresOfficeVisualQa
          ? await pendingOfficeVisualQa(input.runId, turnRenderedArtifactIds)
          : [];
        if (pendingVisualQa.length) {
          await input.onDebug?.({
            phase: 'chat:file-visual-qa-required',
            stepIndex,
            message: 'A rendered Office artifact has not completed full-page visual QA; rejecting the final response.',
            details: { pendingVisualQa },
          });
          continue;
        }
        const pendingDocumentWork = await pendingOfficeDocumentWork(input.runId, turnDocumentIds, {
          requireVisualQa: requiresOfficeVisualQa,
        });
        if (pendingDocumentWork.length) {
          await input.onDebug?.({
            phase: 'chat:file-document-completion-required',
            stepIndex,
            message: 'An Office document has pending source, render, or QA work; rejecting the final response.',
            details: { pendingDocumentWork },
          });
          continue;
        }
        await input.onDebug?.({
          phase: 'chat:ai-response-finished',
          stepIndex,
          message: `AI SDK finished the response with reason ${actionResult.finishReason}; ending the current browser chat turn.`,
          details: {
            finishReason: actionResult.finishReason,
            responseStatus: actionResult.responseStatus,
          },
        });
        await flushWithheldText();
        reply = browserChatReply || aiSdkFinishMessage(actionResult.finishReason);
        finalBlocks = [{ type: 'markdown', text: reply }];
        finalStatus = actionResult.responseStatus;
        endedWithFinalAnswer = true;
        break;
      }
      await input.onDebug?.({
        phase: 'chat:no-tool-response',
        stepIndex,
        message: `AI SDK did not finish the response and returned no browser tool; finish reason is ${actionResult.finishReason || 'unknown'}.`,
        details: { finishReason: actionResult.finishReason },
      });
      continue;
    }

    const operationalTraces = actionResult.traces.filter((trace) => trace.name !== 'contextCompression');
    const decision = deriveBrowserChatStepDecision(actionResult.text, operationalTraces);
    const completedStep: StepExecutionResult = {
      index: stepIndex,
      action: decision.action,
      expected: decision.expected,
      actual: decision.actual,
      status: decision.status,
      note: decision.note,
      aiRequest: actionResult.aiRequest,
      tools: summarizeToolTraces(actionResult.traces),
      visualContext: actionResult.visualContext,
    };
    upsertStep(steps, completedStep);
    newSteps.push(completedStep);
    ensureActive();
    await input.onProgress?.(completedStep);
    ensureActive();
    const lastTool = operationalTraces.at(-1);
    const pendingSubagentUuids = pendingSubagentUuidsFromSteps(newSteps);
    if (pendingSubagentUuids.length) {
      await input.onDebug?.({
        phase: 'chat:subagent-read-required',
        stepIndex,
        message: `${pendingSubagentUuids.length} completed child Agent result(s) remain unread; forcing subagent action=read before final synthesis.`,
        details: { pendingSubagentUuids },
      });
      continue;
    }
    if (actionResult.responseFinished) {
      const pendingVisualQa = requiresOfficeVisualQa
        ? await pendingOfficeVisualQa(input.runId, turnRenderedArtifactIds)
        : [];
      if (pendingVisualQa.length) {
        await input.onDebug?.({
          phase: 'chat:file-visual-qa-required',
          stepIndex,
          message: 'A rendered Office artifact has not completed full-page visual QA; rejecting the final response.',
          details: { pendingVisualQa },
        });
        continue;
      }
      const pendingDocumentWork = await pendingOfficeDocumentWork(input.runId, turnDocumentIds, {
        requireVisualQa: requiresOfficeVisualQa,
      });
      if (pendingDocumentWork.length) {
        await input.onDebug?.({
          phase: 'chat:file-document-completion-required',
          stepIndex,
          message: 'An Office document has pending source, render, or QA work; rejecting the final response.',
          details: { pendingDocumentWork },
        });
        continue;
      }
      await input.onDebug?.({
        phase: 'chat:ai-response-finished',
        stepIndex,
        message: `AI SDK finished the response with reason ${actionResult.finishReason}; ending the current browser chat turn without starting another browser step.`,
        details: {
          finishReason: actionResult.finishReason,
          responseStatus: actionResult.responseStatus,
          tools: completedStep.tools,
        },
      });
      await flushWithheldText();
      reply = browserChatReply || aiSdkFinishMessage(actionResult.finishReason);
      finalBlocks = [{ type: 'markdown', text: reply }];
      finalStatus = actionResult.responseStatus === 'passed'
        ? decision.status === 'failed' || decision.status === 'blocked' ? decision.status : 'passed'
        : actionResult.responseStatus;
      endedWithFinalAnswer = true;
      break;
    }
    if (lastTool && isBrowserHumanVerificationCall(lastTool.name, lastTool.input)) {
      finalStatus = 'blocked';
      if (!reply) reply = browserChatReplyFromDecision(decision);
      finalBlocks = [{ type: 'markdown', text: reply }];
      endedWithFinalAnswer = true;
      break;
    }
  }

  if (!endedWithFinalAnswer) reply = '';

  const completedTools = newSteps.flatMap((step) => (step.tools || []).map((toolCall) => ({
      name: toolCall.name,
      result: toolCall.rawResult,
    })));
  reply = repairFileArtifactDownloadLinks(reply, completedTools);
  if (finalBlocks.length) {
    finalBlocks = finalBlocks.map((block) => block.type === 'markdown'
      ? { ...block, text: repairFileArtifactDownloadLinks(block.text, completedTools) }
      : block);
    reply = browserChatFinalBlocksToText(finalBlocks);
  } else if (reply) {
    finalBlocks = [{ type: 'markdown', text: reply }];
  }
  ensureActive();
  return {
    status: finalStatus,
    reply,
    blocks: finalBlocks,
    steps,
    newSteps,
    consoleErrors: [],
    networkErrors: input.session.getNetworkErrors(),
    modelMessages: activeModelMessages,
    turnMessages: turnModelMessages,
    contextCompression,
    continuationSummary: activeContinuationSummary || undefined,
  };
}

function errorRecordSources(error: unknown) {
  if (!error || typeof error !== 'object') return [];
  const root = error as Record<string, unknown>;
  const sources: Record<string, unknown>[] = [root];
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    sources.push(root.data as Record<string, unknown>);
  }
  if (root.cause && typeof root.cause === 'object' && !Array.isArray(root.cause)) {
    const cause = root.cause as Record<string, unknown>;
    sources.push(cause);
    if (cause.data && typeof cause.data === 'object' && !Array.isArray(cause.data)) {
      sources.push(cause.data as Record<string, unknown>);
    }
  }
  return sources;
}

function firstErrorString(error: unknown, key: string) {
  for (const source of errorRecordSources(error)) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstErrorValue(error: unknown, key: string) {
  for (const source of errorRecordSources(error)) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return undefined;
}

function firstErrorDisplay(error: unknown, key: string, max = 900) {
  return diagnosticValueText(firstErrorValue(error, key), max);
}

function firstErrorNumber(error: unknown, key: string) {
  for (const source of errorRecordSources(error)) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function errorCauseMessage(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  const cause = (error as Record<string, unknown>).cause;
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === 'object' && !Array.isArray(cause)) {
    const message = (cause as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return undefined;
}

function errorDetailText(error: unknown) {
  const exitCode = firstErrorNumber(error, 'exitCode');
  const code = firstErrorString(error, 'code');
  const status = firstErrorValue(error, 'status') ?? firstErrorValue(error, 'statusCode');
  const stderr = firstErrorString(error, 'stderr');
  const responseBody = firstErrorDisplay(error, 'responseBody', 1200) || firstErrorDisplay(error, 'body', 1200);
  const promptExcerpt = firstErrorString(error, 'promptExcerpt');
  return [
    typeof exitCode === 'number' ? `exitCode=${exitCode}` : '',
    code ? `code=${code}` : '',
    status !== undefined ? `status=${diagnosticValueText(status, 120)}` : '',
    stderr ? `stderr=${trimDebugText(stderr, 1200)}` : '',
    responseBody ? `responseBody=${responseBody}` : '',
    promptExcerpt ? `promptExcerpt=${trimDebugText(promptExcerpt, 600)}` : '',
  ].filter(Boolean).join('\n');
}

function infrastructureError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown execution error');
  const details = errorDetailText(error);
  return details ? `${message}\n${details}` : message;
}

function userFacingRecoverableRuntimeError(error: unknown) {
  return userFacingInfrastructureError(infrastructureError(error), {
    error,
    aiRequest: aiRequestFromError(error),
  });
}

function serializeError(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    exitCode: firstErrorNumber(error, 'exitCode'),
    code: firstErrorString(error, 'code'),
    status: firstErrorValue(error, 'status'),
    statusCode: firstErrorValue(error, 'statusCode'),
    stderr: firstErrorString(error, 'stderr'),
    responseBody: firstErrorDisplay(error, 'responseBody', 2000),
    body: firstErrorDisplay(error, 'body', 2000),
    causeMessage: errorCauseMessage(error),
    promptExcerpt: firstErrorString(error, 'promptExcerpt'),
    stack: error.stack,
  };
}

async function createRuntimeErrorStep(input: {
  stepIndex: number;
  error: unknown;
  tools?: StepToolCall[];
  aiRequest?: AiRequestSnapshot;
  visualContext?: StepExecutionResult['visualContext'];
}): Promise<StepExecutionResult> {
  const { stepIndex, error, tools, aiRequest, visualContext } = input;
  const retryInfo = runtimeRetryFromError(error);
  const retriesExhausted = Boolean(
    retryInfo?.retryable
    && retryInfo.consecutiveFailures >= retryInfo.consecutiveFailureLimit,
  );

  return {
    index: stepIndex,
    action: retriesExhausted
      ? 'AI request retries were exhausted; stopping this browser-chat turn'
      : 'AI request or response handling failed; stopping this browser-chat turn',
    expected: retriesExhausted
      ? 'The assistant should stop after the request-level retry limit and preserve the latest browser state.'
      : 'The assistant should stop this turn and preserve the latest browser state.',
    actual: userFacingRecoverableRuntimeError(error),
    status: 'failed',
    visualContext,
    tools,
    aiRequest,
  };
}

function flowInput(input: unknown) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

export type RecordedBrowserOperationExecutionOptions = {
  runId?: string;
  abortSignal?: AbortSignal;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  credentialBindings?: BrowserCodeCredentialBinding[];
};

/**
 * Execute one previously recorded browser-chat tool against an existing browser
 * session. This is intentionally a low-level dispatcher: callers own ordering,
 * retries, repair, and final verification.
 */
export async function executeRecordedBrowserOperation(
  session: BrowserSession,
  flow: BrowserOperationRecord,
  options: RecordedBrowserOperationExecutionOptions = {},
): Promise<BrowserActionResult> {
  const input = flowInput(flow.input);
  const reason = flow.reason ? ` Recorded reason: ${flow.reason}` : '';
  const runId = options.runId;
  const abortSignal = options.abortSignal;
  const attachmentBindings = options.attachmentBindings;
  const credentialBindings = options.credentialBindings;

  switch (flow.name) {
    case 'browser': {
      if (input.action === 'state') {
        return readCurrentBrowserState(session, {
          runId,
          stepIndex: flow.index,
          abortSignal,
        });
      }
      if (input.action === 'waitForHumanVerification') {
        return session.waitForManualVerification(typeof input.maxMs === 'number' ? input.maxMs : undefined);
      }
      if (input.action !== 'code') {
        return { ok: false, actual: 'browser requires action=state|code|waitForHumanVerification.' };
      }
      const code = typeof input.code === 'string' ? input.code : '';
      const violation = browserCodeServiceFileDeliveryViolation(code);
      if (violation) return { ok: false, actual: violation };
      return session.executeBrowserCode({
        code,
        maxOutputChars: typeof input.maxOutputChars === 'number' ? input.maxOutputChars : undefined,
        attachments: attachmentBindings,
        credentials: credentialBindings,
        runId: runId || 'browser-code',
        stepIndex: flow.index,
        abortSignal,
      });
    }
    case 'readBrowserState':
      return readCurrentBrowserState(session, {
        runId,
        stepIndex: flow.index,
        abortSignal,
      });
    case 'browserCode': {
      const code = typeof input.code === 'string' ? input.code : '';
      const violation = browserCodeServiceFileDeliveryViolation(code);
      if (violation) return { ok: false, actual: violation };
      return session.executeBrowserCode({
        code,
        maxOutputChars: typeof input.maxOutputChars === 'number' ? input.maxOutputChars : undefined,
        attachments: attachmentBindings,
        credentials: credentialBindings,
        runId: runId || 'browser-code',
        stepIndex: flow.index,
        abortSignal,
      });
    }
    case 'waitForHumanVerification':
      return session.waitForManualVerification(typeof input.maxMs === 'number' ? input.maxMs : undefined);
    case 'file':
      return executeBrowserChatFile({
        runId: runId || '',
        params: input,
        options: {
          attachmentBindings,
          currentPageUrl: () => session.currentUrl(),
          visualInputAvailable: true,
        },
        abortSignal,
        invocationId: `recorded:file:${flow.index}`,
      });
    case 'downloadFile':
      return executeBrowserChatFile({
        runId: runId || '',
        params: { ...input, action: 'download' },
        options: {
          attachmentBindings,
          currentPageUrl: () => session.currentUrl(),
          visualInputAvailable: true,
        },
        abortSignal,
        invocationId: `recorded:downloadFile:${flow.index}`,
      });
    default:
      return { ok: false, actual: `Unsupported recorded tool: ${flow.name}.${reason}` };
  }
}

async function executeCodexRuntimeObject(input: {
  session: BrowserSession;
  runId: string;
  stepIndex: number;
  type: string;
  message?: string;
  params: Record<string, unknown>;
  allowedTypes: string[];
  traces: ToolTrace[];
  aiRequest?: AiRequestSnapshot;
  visualContext?: VisualContextManager;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean;
  requestToolConfirmation?: (request: BrowserToolConfirmationRequest) => Promise<BrowserToolConfirmationDecision>;
  runSubagents?: BrowserChatSubagentRunner;
  readSubagent?: BrowserChatSubagentReader;
  requiredSubagentUuid?: string;
  browserStatePreflightComplete?: boolean;
  readFile?: (input: BrowserChatReadFileInput) => Promise<BrowserActionResult>;
  readFileVisuals?: (input: BrowserChatFileVisualInput) => Promise<BrowserActionResult>;
  readSkill?: BrowserChatReadSkill;
  loadedHiddenRuntimeSkillIds?: Set<string>;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  credentialBindings?: BrowserCodeCredentialBinding[];
  ensureBrowserStarted?: () => Promise<void>;
  onVisualContextChange?: (snapshot: ReturnType<VisualContextManager['snapshot']>) => void | Promise<void>;
  onToolTrace?: (trace: ToolTrace, progress?: ToolTraceProgress) => void | Promise<void>;
  onReferenceImage?: (input: { path: string; source: string }) => void;
}) {
  const { session, runId, stepIndex, type, message, params, allowedTypes, traces, aiRequest, visualContext, abortSignal, shouldContinue, requestToolConfirmation, runSubagents, readSubagent, requiredSubagentUuid, browserStatePreflightComplete, readFile, readFileVisuals, readSkill, attachmentBindings, credentialBindings, ensureBrowserStarted, onVisualContextChange, onToolTrace, onReferenceImage } = input;
  const loadedHiddenRuntimeSkillIds = input.loadedHiddenRuntimeSkillIds || new Set<string>();
  for (const skillId of hiddenRuntimeSkillIdsReadFromTraces(traces)) loadedHiddenRuntimeSkillIds.add(skillId);
  throwIfStopped(abortSignal, shouldContinue);
  if (!allowedTypes.includes(type)) {
    return {
      text: `Codex returned unsupported action type: ${type}. Allowed types: ${allowedTypes.join(', ')}.`,
      executed: false,
    };
  }

  if (type === 'answer') {
    const answerText = [
      message,
      typeof params.text === 'string' ? params.text : '',
      typeof params.content === 'string' ? params.content : '',
    ].map((item) => (item || '').trim()).find(Boolean) || '';
    return {
      text: readableActionFromRawText(answerText) || answerText,
      executed: false,
    };
  }

  if (type === 'finalResponse') {
    const parsed = browserChatFinalResponseSchema.safeParse(params);
    if (!parsed.success) {
      return {
        text: `finalResponse input is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        executed: true,
      };
    }
    return {
      text: `${codexFinalResponsePrefix}${JSON.stringify(parsed.data)}`,
      executed: false,
    };
  }

  const normalizedParams = {
    ...(coerceBrowserChatToolInput(type, params) as Record<string, unknown>),
  };
  const flow: BrowserOperationRecord = {
    index: stepIndex,
    name: type,
    input: normalizedParams,
    reason: typeof normalizedParams.reason === 'string' ? normalizedParams.reason : undefined,
  };
    const runTool = async (toolCallId?: string) => {
      if (type === 'chart') {
        return executeBrowserChatChart(runId, normalizedParams, {
          abortSignal,
          invocationId: toolCallId,
        });
      }
      if (type === 'file') {
        return executeBrowserChatFile({
          runId,
          params: normalizedParams,
          options: {
            attachmentBindings,
            currentPageUrl: () => session.currentUrl(),
            readFile,
            readFileVisuals,
            visualInputAvailable: modelSupportsImageInput(),
          },
          abortSignal,
          invocationId: toolCallId,
        });
      }
    if (type === 'subagent' && normalizedParams.action === 'spawn') {
      if (!runSubagents) return { ok: false, actual: 'subagent action=spawn is unavailable in this runtime.' };
      const tasks = normalizeBrowserChatSubagentTasks(normalizedParams.tasks ?? normalizedParams);
      if (!tasks.length) return { ok: false, actual: 'subagent action=spawn requires at least one valid task.' };
      return runSubagents(tasks, abortSignal, toolCallId);
    }
    if (type === 'subagent' && normalizedParams.action === 'read') {
      if (!readSubagent) return { ok: false, actual: 'subagent action=read is unavailable in this runtime.' };
      const uuid = typeof normalizedParams.uuid === 'string' ? normalizedParams.uuid.trim() : '';
      if (!uuid) return { ok: false, actual: 'subagent action=read requires one UUID.' };
      if (requiredSubagentUuid && uuid !== requiredSubagentUuid) {
        return {
          ok: false,
          actual: `Read rejected: child Agent results must be read in order. The required UUID is ${requiredSubagentUuid}.`,
        };
      }
      return readSubagent(uuid);
    }
    if (type === 'reportDefect') {
      const parsed = reportDefectInputSchema.safeParse({
        problemDescription: normalizedParams.problemDescription,
        whyItIsAProblem: normalizedParams.whyItIsAProblem,
        reasons: normalizedParams.reasons,
        reproductionSteps: normalizedParams.reproductionSteps,
        screenshotFileNames: normalizedParams.screenshotFileNames,
      });
      if (!parsed.success) {
        return {
          ok: false,
          actual: `reportDefect input is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        };
      }
      return await reportBrowserChatDefect(runId, traces, parsed.data);
    }
    if (type === 'skill' && normalizedParams.action === 'read') {
      const skillId = typeof normalizedParams.skillId === 'string' ? normalizedParams.skillId.trim() : '';
      if (!skillId) return { ok: false, actual: 'skill action=read requires one Skill id.' };
      const hiddenContent = hiddenRuntimeSkillContent(skillId);
      if (hiddenContent) {
        loadedHiddenRuntimeSkillIds.add(skillId);
        return { ok: true, actual: hiddenContent };
      }
      if (!readSkill) return { ok: false, actual: 'skill action=read is unavailable in this runtime.' };
      return readSkill(skillId);
    }
    return executeRecordedBrowserOperation(session, flow, {
      runId,
      abortSignal,
      attachmentBindings,
      credentialBindings,
    });
  };

  const result = await executeTracedBrowserAction({
    traces,
    name: type,
    toolInput: normalizedParams,
    aiRequest,
    runId,
    stepIndex,
    visualContext,
    abortSignal,
    shouldContinue,
    onToolTrace,
    onVisualContextChange,
    action: async (actionSignal, trace) => {
      const automaticSkill = automaticallyLoadHiddenRuntimeSkill(type, normalizedParams, loadedHiddenRuntimeSkillIds);
      if (automaticSkill && 'ok' in automaticSkill) return automaticSkill;
      const attachAutomaticSkill = (result: BrowserActionResult) => automaticSkill?.loadedRuntimeSkill
        ? { ...result, loadedRuntimeSkill: automaticSkill.loadedRuntimeSkill }
        : result;
      const prerequisiteResults = await bundledBrowserToolPrerequisiteResults({
        toolName: type,
        toolInput: normalizedParams,
        preflightPending: !Boolean(browserStatePreflightComplete),
        session,
        runId,
        stepIndex,
        abortSignal: actionSignal,
        ensureBrowserStarted,
      });
      const approval = await requestBrowserToolApproval({
        toolName: type,
        toolInput: normalizedParams,
        stepIndex,
        request: requestToolConfirmation,
      });
      throwIfStopped(abortSignal, shouldContinue);
      if (approval === 'denied') {
        return attachAutomaticSkill(attachPrerequisiteResults({
          ok: true,
          actual: 'Skipped before execution because the user cancelled this server-approved tool call. Do not retry the same operation in this turn unless the user explicitly asks again.',
        }, prerequisiteResults));
      }
      if (runtimeToolRequiresBrowserSession(type)) await ensureBrowserStarted?.();
      const result = await runTool(trace?.id);
      const resultWithSkill = attachAutomaticSkill(attachPrerequisiteResults(result, prerequisiteResults));
      if (approval === 'approved') {
        return {
          ...resultWithSkill,
          actual: `用户已确认本次工具调用，现已执行。\n${resultWithSkill.actual}`,
        } satisfies BrowserActionResult;
      }
      return resultWithSkill;
    },
  });
  const imagePaths = result.referenceImagePaths?.length
    ? result.referenceImagePaths
    : result.referenceImagePath ? [result.referenceImagePath] : [];
  const imageSource = type === 'file'
    ? `${type}:${String(normalizedParams.action || 'unknown')}`
    : type;
  const screenshotIds = type === 'file' && normalizedParams.action === 'visualRead' && Array.isArray(normalizedParams.screenshotIds)
    ? normalizedParams.screenshotIds
    : undefined;
  for (const [index, imagePath] of [...new Set(imagePaths)].entries()) {
    const screenshotId = typeof screenshotIds?.[index] === 'string' ? screenshotIds[index] : undefined;
    onReferenceImage?.({ path: imagePath, source: screenshotId ? `${imageSource}:${screenshotId}` : imageSource });
  }
  const fileResult = result.ok ? formatFileArtifactResult(type, result.actual) : undefined;
  return { text: fileResult || toolConsistentAssistantText(message, type), executed: true };
}
