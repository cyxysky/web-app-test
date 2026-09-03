import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  compareSensitiveDataEvaluationValues,
  normalizeSensitiveDataEvaluationCases,
  SENSITIVE_DATA_EVALUATION_CASE_LIMIT,
  SENSITIVE_DATA_EVALUATION_EXPECTED_VALUE_LIMIT,
  SENSITIVE_DATA_EVALUATION_TEXT_LIMIT,
  SENSITIVE_DATA_EVALUATION_TOTAL_TEXT_LIMIT,
} from '@/lib/sensitive-data-evaluation';
import { redactSensitiveTexts } from '@/server/capabilities/sensitive-data';
import { store } from '@/server/db/store';
import { ApiRequestError, apiError, apiJson, parseJsonRequest } from '@/server/http/api-request';
import { requestHasAdminSettingsAccess } from '@/server/settings/admin-settings-access';

const evaluationCaseSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().max(200),
  text: z.string().min(1).max(SENSITIVE_DATA_EVALUATION_TEXT_LIMIT),
  expectedValues: z.array(z.string().min(1).max(10_000)).max(SENSITIVE_DATA_EVALUATION_EXPECTED_VALUE_LIMIT),
}).strict();

const evaluationRequestSchema = z.object({
  cases: z.array(evaluationCaseSchema).max(SENSITIVE_DATA_EVALUATION_CASE_LIMIT),
}).strict().refine(
  (body) => body.cases.reduce((total, item) => total + item.text.length, 0) <= SENSITIVE_DATA_EVALUATION_TOTAL_TEXT_LIMIT,
  { message: '评测集文本总长度不能超过 1000000 个字符。' },
);

function requireAdmin(request: NextRequest) {
  if (!requestHasAdminSettingsAccess(request)) {
    throw new ApiRequestError('请先输入管理员设置密码。', { code: 'admin_access_required', status: 401 });
  }
}

export async function GET(request: NextRequest) {
  try {
    requireAdmin(request);
    return apiJson(request, { cases: await store.listSensitiveDataEvaluationCases() });
  } catch (error) {
    return apiError(request, error, { fallback: '读取脱敏评测集失败' });
  }
}

export async function PUT(request: NextRequest) {
  try {
    requireAdmin(request);
    const body = await parseJsonRequest(request, evaluationRequestSchema, { maxBytes: 4 * 1024 * 1024 });
    const cases = await store.saveSensitiveDataEvaluationCases(normalizeSensitiveDataEvaluationCases(body.cases));
    return apiJson(request, { ok: true, cases });
  } catch (error) {
    return apiError(request, error, { fallback: '保存脱敏评测集失败' });
  }
}

export async function POST(request: NextRequest) {
  try {
    requireAdmin(request);
    const body = await parseJsonRequest(request, evaluationRequestSchema, { maxBytes: 4 * 1024 * 1024 });
    const cases = normalizeSensitiveDataEvaluationCases(body.cases);
    if (!cases.length) {
      throw new ApiRequestError('请至少添加一个有效评测用例。', { code: 'evaluation_set_empty', status: 400 });
    }

    await store.applyRuntimeEnv();
    const redaction = await redactSensitiveTexts(cases.map((item) => item.text), request.signal);
    let truePositiveCount = 0;
    let falsePositiveCount = 0;
    let falseNegativeCount = 0;
    const results = cases.map((item, textIndex) => {
      const replacements = redaction.replacements
        .filter((replacement) => replacement.textIndex === textIndex)
        .map((replacement) => ({
          original: item.text.slice(replacement.start, replacement.end),
          placeholder: replacement.placeholder,
          label: replacement.label,
          start: replacement.start,
          end: replacement.end,
        }));
      const detectedValues = replacements.map((replacement) => replacement.original);
      const comparison = compareSensitiveDataEvaluationValues(item.expectedValues, detectedValues);
      truePositiveCount += comparison.matchedValues.length;
      falsePositiveCount += comparison.unexpectedValues.length;
      falseNegativeCount += comparison.missingValues.length;
      return {
        id: item.id,
        passed: comparison.passed,
        text: redaction.texts[textIndex] || '',
        replacements,
        detectedValues,
        matchedValues: comparison.matchedValues,
        missingValues: comparison.missingValues,
        unexpectedValues: comparison.unexpectedValues,
      };
    });
    const precisionDenominator = truePositiveCount + falsePositiveCount;
    const recallDenominator = truePositiveCount + falseNegativeCount;
    return apiJson(request, {
      summary: {
        total: results.length,
        passed: results.filter((item) => item.passed).length,
        failed: results.filter((item) => !item.passed).length,
        precision: precisionDenominator ? truePositiveCount / precisionDenominator : 1,
        recall: recallDenominator ? truePositiveCount / recallDenominator : 1,
      },
      results,
    });
  } catch (error) {
    return apiError(request, error, { fallback: '运行脱敏评测失败' });
  }
}
