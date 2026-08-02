import { WEBPILOT_BASE_PATH, withWebPilotBasePath } from '@/lib/webpilot-base-path';
import type { AutomationScheduleRecord } from '@/server/automation/automation.schema';
import {
  createAutomationScheduleOccurrence,
  listAutomationRuns,
  listDueAutomationSchedules,
} from '@/server/storage/automation-store';

export type AutomationScheduleTiming = Pick<
  AutomationScheduleRecord,
  'recurrence' | 'time' | 'weekdays' | 'timezone'
>;

export type AutomationSchedulerTickResult = {
  due: number;
  created: number;
  launched: number;
  skipped: number;
  recovered: number;
  errors: number;
};

type SchedulerState = {
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  tick?: Promise<void>;
  stop: () => void;
};

type ZonedMinute = {
  dateKey: string;
  weekday: number;
  time: string;
};

const SCHEDULER_INTERVAL_MS = 20_000;
const MISFIRE_GRACE_MS = 60_000;
const MAX_DUE_PER_TICK = 500;
// Fifteen days also covers a weekly wall-clock time that disappears in a DST
// spring-forward gap; its next valid occurrence is the following week.
const SEARCH_MINUTES = 15 * 24 * 60;
const GLOBAL_STATE_KEY = '__webpilotAutomationScheduler';

const weekdayIndexes: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function dateValue(value: string | Date) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new Error('The automation schedule reference time is invalid.');
  }
  return result;
}

function zonedMinuteFormatter(timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-US-u-ca-gregory', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new Error(`Invalid automation schedule timezone: ${timezone}`);
  }
}

function readZonedMinute(formatter: Intl.DateTimeFormat, instant: Date): ZonedMinute {
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((item) => item.type === type)?.value || ''
  );
  const weekday = weekdayIndexes[part('weekday')];
  if (weekday === undefined) {
    throw new Error('Unable to resolve the automation schedule weekday.');
  }
  return {
    dateKey: `${part('year')}-${part('month')}-${part('day')}`,
    weekday,
    time: `${part('hour')}:${part('minute')}`,
  };
}

/**
 * Find the first calendar occurrence strictly after `after` in the schedule's
 * IANA timezone. Searching real UTC minutes handles DST gaps. Skipping the
 * already-reached local date prevents a duplicated run during a DST fold.
 */
function findNextAutomationOccurrence(
  schedule: AutomationScheduleTiming,
  after: string | Date,
  excludedLocalDate?: string,
) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new Error(`Invalid automation schedule time: ${schedule.time}`);
  }
  if (schedule.recurrence === 'weekly' && schedule.weekdays.length === 0) {
    throw new Error('Weekly automation schedules require at least one weekday.');
  }

  const reference = dateValue(after);
  const formatter = zonedMinuteFormatter(schedule.timezone);
  const referenceLocal = readZonedMinute(formatter, reference);
  const localDateAlreadyReached = referenceLocal.time >= schedule.time
    ? referenceLocal.dateKey
    : undefined;
  const firstMinute = Math.floor(reference.getTime() / 60_000) * 60_000 + 60_000;
  const allowedWeekdays = new Set(schedule.weekdays);

  for (let offset = 0; offset < SEARCH_MINUTES; offset += 1) {
    const candidate = new Date(firstMinute + offset * 60_000);
    const local = readZonedMinute(formatter, candidate);
    if (
      local.dateKey === localDateAlreadyReached
      || local.dateKey === excludedLocalDate
      || local.time !== schedule.time
    ) continue;
    if (schedule.recurrence === 'weekly' && !allowedWeekdays.has(local.weekday)) continue;
    return candidate.toISOString();
  }

  throw new Error(
    `No ${schedule.recurrence} automation occurrence was found within fifteen days in ${schedule.timezone}.`,
  );
}

export function nextAutomationOccurrence(
  schedule: AutomationScheduleTiming,
  after: string | Date = new Date(),
) {
  return findNextAutomationOccurrence(schedule, after);
}

function schedulerLog(message: string) {
  return {
    time: new Date().toISOString(),
    level: 'info' as const,
    message,
  };
}

function internalServerOrigin() {
  const configured = String(process.env.WEBPILOT_INTERNAL_ORIGIN || '').trim();
  if (configured) {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('WEBPILOT_INTERNAL_ORIGIN must use http or https.');
    }
    return parsed.origin;
  }
  const configuredPort = Number(process.env.PORT || 3000);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : 3000;
  return `http://127.0.0.1:${port}`;
}

function launchRun(runId: string, userId: string) {
  const pathname = withWebPilotBasePath(
    `/api/automation/runs/${encodeURIComponent(runId)}?userId=${encodeURIComponent(userId)}`,
    WEBPILOT_BASE_PATH,
  );
  void fetch(new URL(pathname, internalServerOrigin()), {
    method: 'POST',
    headers: {
      'x-webpilot-automation-scheduler': '1',
    },
    cache: 'no-store',
  }).then(async (response) => {
    if (response.ok) return;
    const detail = (await response.text().catch(() => '')).trim();
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }).catch((error: unknown) => {
    console.warn(`[automation-scheduler] Failed to launch run ${runId}.`, error);
  });
}

function recoverDurableRuns(now: Date) {
  let recovered = 0;
  const queued = listAutomationRuns({ status: 'queued', limit: MAX_DUE_PER_TICK });
  for (const run of queued) {
    launchRun(run.id, run.userId);
    recovered += 1;
  }

  const running = listAutomationRuns({ status: 'running', limit: MAX_DUE_PER_TICK });
  for (const run of running) {
    const leaseExpiry = run.lease ? Date.parse(run.lease.expiresAt) : Number.NaN;
    if (run.lease && Number.isFinite(leaseExpiry) && leaseExpiry > now.getTime()) continue;
    launchRun(run.id, run.userId);
    recovered += 1;
  }
  return recovered;
}

/** Process persistent queued work and all schedules due at `at`. */
export async function runAutomationSchedulerTick(
  at: string | Date = new Date(),
): Promise<AutomationSchedulerTickResult> {
  const tickTime = dateValue(at);
  const triggeredAt = tickTime.toISOString();
  const result: AutomationSchedulerTickResult = {
    due: 0,
    created: 0,
    launched: 0,
    skipped: 0,
    recovered: 0,
    errors: 0,
  };

  try {
    result.recovered = recoverDurableRuns(tickTime);
  } catch (error) {
    result.errors += 1;
    console.warn('[automation-scheduler] Failed to recover durable runs.', error);
  }

  const schedules = listDueAutomationSchedules({
    at: triggeredAt,
    limit: MAX_DUE_PER_TICK,
  });
  result.due = schedules.length;

  for (const schedule of schedules) {
    try {
      const occurrenceTime = dateValue(schedule.nextRunAt);
      const misfired = tickTime.getTime() - occurrenceTime.getTime() > MISFIRE_GRACE_MS;
      const occurrenceLocalDate = readZonedMinute(
        zonedMinuteFormatter(schedule.timezone),
        occurrenceTime,
      ).dateKey;
      const nextRunAt = findNextAutomationOccurrence(
        schedule,
        tickTime,
        occurrenceLocalDate,
      );
      const occurrence = createAutomationScheduleOccurrence({
        scheduleId: schedule.id,
        userId: schedule.userId,
        expectedNextRunAt: schedule.nextRunAt,
        nextRunAt,
        triggeredAt,
        misfired,
        log: [schedulerLog(
          misfired
            ? `Scheduled occurrence ${schedule.nextRunAt} was processed after its due time.`
            : `Scheduled occurrence ${schedule.nextRunAt} became due.`,
        )],
      });
      if (!occurrence?.created || !occurrence.run) continue;

      result.created += 1;
      if (occurrence.run.status === 'queued') {
        launchRun(occurrence.run.id, occurrence.run.userId);
        result.launched += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      result.errors += 1;
      console.warn(`[automation-scheduler] Failed to process schedule ${schedule.id}.`, error);
    }
  }

  return result;
}

function globalSchedulerState() {
  return globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: SchedulerState;
  };
}

/** Start one scheduler loop per Node.js process. Repeated calls are harmless. */
export function startAutomationScheduler() {
  const globalState = globalSchedulerState();
  const existing = globalState[GLOBAL_STATE_KEY];
  if (existing?.running) return existing.stop;

  const state = {} as SchedulerState;
  const stop = () => {
    state.running = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    if (globalState[GLOBAL_STATE_KEY] === state) {
      delete globalState[GLOBAL_STATE_KEY];
    }
  };
  state.running = true;
  state.stop = stop;
  globalState[GLOBAL_STATE_KEY] = state;

  const runTick = () => {
    if (!state.running) return;
    state.tick = runAutomationSchedulerTick()
      .catch((error: unknown) => {
        console.warn('[automation-scheduler] Scheduler tick failed.', error);
      })
      .then(() => undefined)
      .finally(() => {
        state.tick = undefined;
        if (!state.running) return;
        state.timer = setTimeout(runTick, SCHEDULER_INTERVAL_MS);
        (state.timer as NodeJS.Timeout).unref?.();
      });
  };
  runTick();
  return stop;
}
