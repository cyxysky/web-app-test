import { NextRequest } from 'next/server';
import {
  automationScheduleMisfireSchema,
  automationScheduleOverlapSchema,
  automationScheduleRecurrenceSchema,
} from '@/server/automation/automation.schema';
import { nextAutomationOccurrence } from '@/server/automation/automation-scheduler';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { noStoreJson } from '@/server/http/no-store-response';
import {
  createAutomationSchedule,
  deleteAutomationSchedule,
  listAutomationSchedules,
} from '@/server/storage/automation-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RequestBody = Record<string, unknown>;

function bodyRecord(value: unknown): RequestBody {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RequestBody : {};
}

function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function requestUserId(request: NextRequest, _body: RequestBody = {}) {
  return requestApplicationUserId(request, _body);
}

function normalizedTimezone(value: unknown) {
  const timezone = text(value);
  if (!timezone) throw new Error('Schedule timezone is required.');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

function normalizedWeekdays(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((item) => Number.isInteger(item));
}

function requestLimit(request: NextRequest) {
  const value = Number(request.nextUrl.searchParams.get('limit'));
  return Number.isFinite(value) ? value : undefined;
}

export async function GET(request: NextRequest) {
  const enabledValue = request.nextUrl.searchParams.get('enabled');
  const schedules = listAutomationSchedules({
    userId: requestUserId(request),
    caseId: request.nextUrl.searchParams.get('caseId')?.trim() || undefined,
    enabled: enabledValue === null ? undefined : enabledValue !== 'false' && enabledValue !== '0',
    limit: requestLimit(request),
  });
  return noStoreJson({ schedules });
}

export async function POST(request: NextRequest) {
  try {
    const body = bodyRecord(await request.json().catch(() => ({})));
    const userId = requestUserId(request, body);
    const recurrence = automationScheduleRecurrenceSchema.parse(body.recurrence ?? body.frequency);
    const time = text(body.time);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new Error('Schedule time must use HH:mm in 24-hour format.');
    }
    const weekdays = normalizedWeekdays(body.weekdays ?? (
      body.weekday === undefined ? undefined : [body.weekday]
    ));
    const timezone = normalizedTimezone(body.timezone ?? body.timeZone);
    const nextRunAt = nextAutomationOccurrence({ recurrence, time, weekdays, timezone });
    const schedule = createAutomationSchedule({
      userId,
      caseId: text(body.caseId),
      title: text(body.title ?? body.name) || '自动执行计划',
      recurrence,
      time,
      weekdays,
      timezone,
      nextRunAt,
      enabled: body.enabled !== false,
      overlap: automationScheduleOverlapSchema.parse(body.overlap ?? 'skip'),
      misfire: automationScheduleMisfireSchema.parse(body.misfire ?? 'run-once'),
    });
    return noStoreJson({
      ok: true,
      schedule,
      schedules: listAutomationSchedules({ userId }),
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create automation schedule.';
    return noStoreJson(
      { error: message },
      { status: /not found/i.test(message) ? 404 : 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const body = bodyRecord(await request.json().catch(() => ({})));
  const scheduleId = text(
    body.id
    ?? body.scheduleId
    ?? request.nextUrl.searchParams.get('id')
    ?? request.nextUrl.searchParams.get('scheduleId'),
  );
  if (!scheduleId) return noStoreJson({ error: 'Schedule id is required.' }, { status: 400 });
  const userId = requestUserId(request, body);
  if (!deleteAutomationSchedule(scheduleId, userId)) {
    return noStoreJson({ error: 'Automation schedule not found.' }, { status: 404 });
  }
  return noStoreJson({
    ok: true,
    deleted: { id: scheduleId },
    schedules: listAutomationSchedules({ userId }),
  });
}
