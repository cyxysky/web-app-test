import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  automationScheduleMisfireSchema,
  automationScheduleOverlapSchema,
  automationScheduleRecurrenceSchema,
} from '@/server/automation/automation.schema';
import { nextAutomationOccurrence, startAutomationScheduler } from '@/server/automation/automation-scheduler';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { ApiRequestError, apiError, apiJson, boundedQueryInteger, parseJsonRequest, parseOptionalJsonRequest } from '@/server/http/api-request';
import { idempotencyFingerprint, runIdempotentJson } from '@/server/http/idempotency';
import { createAutomationSchedule, deleteAutomationSchedule, listAutomationSchedules } from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const scheduleSchema = z.object({
  caseId: z.union([z.string(), z.number()]),
  title: z.union([z.string(), z.number()]).optional(),
  name: z.union([z.string(), z.number()]).optional(),
  recurrence: z.unknown().optional(),
  frequency: z.unknown().optional(),
  time: z.union([z.string(), z.number()]),
  weekdays: z.array(z.union([z.string(), z.number()])).optional(),
  weekday: z.union([z.string(), z.number()]).optional(),
  timezone: z.union([z.string(), z.number()]).optional(),
  timeZone: z.union([z.string(), z.number()]).optional(),
  enabled: z.boolean().optional(),
  overlap: z.unknown().optional(),
  misfire: z.unknown().optional(),
}).strict();

const deleteSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  scheduleId: z.union([z.string(), z.number()]).optional(),
}).strict();

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function ensureDevelopmentScheduler() {
  if (process.env.NODE_ENV === 'development') startAutomationScheduler();
}

function normalizedTimezone(value: unknown) {
  const timezone = text(value);
  if (!timezone) throw new ApiRequestError('计划时区不能为空', { code: 'timezone_required' });
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new ApiRequestError(`无效的 IANA 时区：${timezone}`, { code: 'invalid_timezone' });
  }
}

export async function GET(request: NextRequest) {
  ensureDevelopmentScheduler();
  const enabled = request.nextUrl.searchParams.get('enabled');
  return apiJson(request, {
    schedules: await listAutomationSchedules({
      userId: requestApplicationUserId(request),
      caseId: request.nextUrl.searchParams.get('caseId')?.trim() || undefined,
      enabled: enabled === null ? undefined : enabled !== 'false' && enabled !== '0',
      limit: boundedQueryInteger(request.nextUrl.searchParams.get('limit'), { fallback: 100, max: 500 }),
    }),
  });
}

export async function POST(request: NextRequest) {
  ensureDevelopmentScheduler();
  try {
    const body = await parseJsonRequest(request, scheduleSchema, { maxBytes: 32 * 1024 });
    const userId = requestApplicationUserId(request);
    const recurrence = automationScheduleRecurrenceSchema.parse(body.recurrence ?? body.frequency);
    const time = text(body.time);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new ApiRequestError('计划时间必须使用 24 小时制 HH:mm 格式', { code: 'invalid_time' });
    }
    const weekdays = (body.weekdays ?? (body.weekday === undefined ? [] : [body.weekday]))
      .map(Number).filter((item) => Number.isInteger(item));
    const timezone = normalizedTimezone(body.timezone ?? body.timeZone);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint(body),
      scope: 'automation_schedule.create',
      userId,
    }, async () => {
      const schedule = await createAutomationSchedule({
        userId,
        caseId: text(body.caseId),
        title: text(body.title ?? body.name) || '自动执行计划',
        recurrence,
        time,
        weekdays,
        timezone,
        nextRunAt: nextAutomationOccurrence({ recurrence, time, weekdays, timezone }),
        enabled: body.enabled !== false,
        overlap: automationScheduleOverlapSchema.parse(body.overlap ?? 'skip'),
        misfire: automationScheduleMisfireSchema.parse(body.misfire ?? 'run-once'),
      });
      return apiJson(request, { ok: true, schedule, schedules: await listAutomationSchedules({ userId }) }, { status: 201 });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return apiError(request, error instanceof ApiRequestError ? error : new ApiRequestError(message || '计划参数无效', {
      code: /not found/i.test(message) ? 'not_found' : 'validation_failed',
      status: /not found/i.test(message) ? 404 : 400,
    }), { fallback: '创建自动化计划失败' });
  }
}

export async function DELETE(request: NextRequest) {
  ensureDevelopmentScheduler();
  try {
    const body = await parseOptionalJsonRequest(request, deleteSchema, { maxBytes: 8 * 1024 });
    const scheduleId = text(body.id ?? body.scheduleId ?? request.nextUrl.searchParams.get('id') ?? request.nextUrl.searchParams.get('scheduleId'));
    if (!scheduleId) throw new ApiRequestError('计划 ID 不能为空', { code: 'schedule_id_required' });
    const userId = requestApplicationUserId(request);
    return runIdempotentJson(request, {
      fingerprint: idempotencyFingerprint({ scheduleId }),
      scope: 'automation_schedule.delete',
      userId,
    }, async () => {
      if (!await deleteAutomationSchedule(scheduleId, userId)) {
        throw new ApiRequestError('自动化计划不存在', { code: 'not_found', status: 404 });
      }
      return apiJson(request, { ok: true, deleted: { id: scheduleId }, schedules: await listAutomationSchedules({ userId }) });
    });
  } catch (error) {
    return apiError(request, error, { fallback: '删除自动化计划失败' });
  }
}
