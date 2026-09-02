import { randomUUID } from 'node:crypto';
import { executeDatabase, parseDatabaseJson, queryDatabase, queryDatabaseOne, runDatabaseTransaction } from '@/server/db/database';
import { publishBrowserChatRuntimeRecordsChanged } from './browser-chat-runtime-record-refresh';

export type BrowserChatDefectSeverity = 'high' | 'medium' | 'low';

export type BrowserChatDefectEvidence = {
  fileName: string;
  path: string;
};

export type BrowserChatDefectReport = {
  id: string;
  sessionId: string;
  title: string;
  problemDescription: string;
  whyItIsAProblem: string;
  reasons: string[];
  reproductionSteps: string[];
  screenshots: BrowserChatDefectEvidence[];
  severity: BrowserChatDefectSeverity;
  createdAt: string;
};

export type CreateBrowserChatDefectInput = {
  problemDescription: string;
  whyItIsAProblem: string;
  reasons: string[];
  reproductionSteps: string[];
  screenshots: BrowserChatDefectEvidence[];
};

type BrowserChatDefectRow = {
  record_json: string;
};

const MAX_DEFECTS_PER_SESSION = 100;

function normalizedText(value: string, name: string, maxLength: number) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} characters.`);
  }
  return text;
}

function normalizedTextList(values: string[], name: string, maxItems: number, maxLength: number) {
  if (!Array.isArray(values) || !values.length || values.length > maxItems) {
    throw new Error(`${name} must contain 1-${maxItems} items.`);
  }
  return values.map((value, index) => normalizedText(value, `${name}[${index}]`, maxLength));
}

function normalizedEvidence(values: BrowserChatDefectEvidence[]) {
  if (!Array.isArray(values) || !values.length || values.length > 6) {
    throw new Error('screenshots must contain 1-6 items.');
  }
  const paths = new Set<string>();
  return values.flatMap((value, index) => {
    const fileName = normalizedText(value.fileName, `screenshots[${index}].fileName`, 260);
    const evidencePath = normalizedText(value.path, `screenshots[${index}].path`, 4_000);
    if (paths.has(evidencePath)) return [];
    paths.add(evidencePath);
    return [{ fileName, path: evidencePath }];
  });
}

function defectTitle(problemDescription: string) {
  const firstLine = problemDescription.split(/[\r\n。！？!?]/, 1)[0]?.trim() || problemDescription;
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

function inferDefectSeverity(problemDescription: string, whyItIsAProblem: string): BrowserChatDefectSeverity {
  const text = `${problemDescription}\n${whyItIsAProblem}`;
  if (/(无法|不能|阻断|崩溃|丢失|泄露|安全|越权|支付|提交失败|unable|blocked|crash|data loss|security)/i.test(text)) {
    return 'high';
  }
  if (/(文案|间距|颜色|对齐|轻微|样式|cosmetic|spacing|alignment)/i.test(text)) return 'low';
  return 'medium';
}

function normalizeDefectReport(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const report = value as BrowserChatDefectReport;
  if (!report.id || !report.sessionId || !report.problemDescription || !report.createdAt) return undefined;
  return report;
}

export async function createBrowserChatDefectReport(
  rawSessionId: string,
  input: CreateBrowserChatDefectInput,
): Promise<BrowserChatDefectReport> {
  const sessionId = normalizedText(rawSessionId, 'sessionId', 240);
  const problemDescription = normalizedText(input.problemDescription, 'problemDescription', 800);
  const whyItIsAProblem = normalizedText(input.whyItIsAProblem, 'whyItIsAProblem', 1_200);
  const reasons = normalizedTextList(input.reasons, 'reasons', 8, 500);
  const reproductionSteps = normalizedTextList(input.reproductionSteps, 'reproductionSteps', 20, 500);
  const screenshots = normalizedEvidence(input.screenshots);
  const createdAt = new Date().toISOString();
  const report: BrowserChatDefectReport = {
    id: randomUUID(),
    sessionId,
    title: defectTitle(problemDescription),
    problemDescription,
    whyItIsAProblem,
    reasons,
    reproductionSteps,
    screenshots,
    severity: inferDefectSeverity(problemDescription, whyItIsAProblem),
    createdAt,
  };

  const stored = await runDatabaseTransaction(async (database) => {
    const count = await queryDatabaseOne<{ count?: number }>(`
      SELECT COUNT(*) AS count FROM browser_chat_defect WHERE session_id = ?
    `, [sessionId], database);
    if ((Number(count?.count) || 0) >= MAX_DEFECTS_PER_SESSION) {
      throw new Error(`A conversation can store at most ${MAX_DEFECTS_PER_SESSION} defect reports.`);
    }
    await executeDatabase(`
      INSERT INTO browser_chat_defect (session_id, id, created_at, record_json)
      VALUES (?, ?, ?, ?)
    `, [sessionId, report.id, createdAt, JSON.stringify(report)], database);
    return report;
  });
  publishBrowserChatRuntimeRecordsChanged(sessionId, 'defects');
  return stored;
}

export async function readBrowserChatDefectReports(sessionId: string) {
  const rows = await queryDatabase<BrowserChatDefectRow>(`
    SELECT record_json
    FROM browser_chat_defect
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `, [sessionId, MAX_DEFECTS_PER_SESSION]);
  return rows.flatMap((row) => {
    const report = normalizeDefectReport(parseDatabaseJson<unknown>(row.record_json, undefined));
    return report ? [report] : [];
  });
}
