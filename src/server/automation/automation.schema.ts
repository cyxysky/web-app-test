import { z } from 'zod';
import { browserOperationRecordSchema } from '@/server/ai/schemas/runtime.schema';

const timestampSchema = z.string().trim().min(1);
const nonEmptyStringSchema = z.string().trim().min(1);

export const automationOperationRecordSchema = browserOperationRecordSchema.extend({
  recordedStatus: z.enum(['passed', 'failed', 'cancelled']).optional(),
  recordedResult: z.string().optional(),
  replayable: z.boolean().optional(),
}).passthrough();

export const automationCaseRecordSchema = z.object({
  id: nonEmptyStringSchema,
  userId: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  description: z.string().optional(),
  sourceSessionId: nonEmptyStringSchema,
  sourceMessageIds: z.array(nonEmptyStringSchema),
  targetUrl: nonEmptyStringSchema,
  instruction: nonEmptyStringSchema,
  operations: z.array(automationOperationRecordSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const automationRunTriggerSchema = z.enum(['manual', 'schedule', 'api', 'retry']);
export const automationRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'passed',
  'failed',
  'blocked',
  'cancelled',
  'skipped',
]);

export const automationRunStepRecordSchema = z.object({
  operationIndex: z.number().int().nonnegative(),
  name: nonEmptyStringSchema,
  status: z.enum(['fixed', 'repaired', 'failed']),
  actual: z.string(),
  fixedResult: z.string().optional(),
  repairSteps: z.array(z.unknown()).optional(),
  screenshotPath: z.string().trim().min(1).optional(),
  screenshotCapturedAt: timestampSchema.optional(),
  screenshotError: z.string().optional(),
  error: z.string().optional(),
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
}).passthrough();

export const automationRunLogEntrySchema = z.union([
  z.string(),
  z.object({
    time: timestampSchema,
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    details: z.unknown().optional(),
  }).passthrough(),
]);

export const automationRunLeaseSchema = z.object({
  owner: nonEmptyStringSchema,
  acquiredAt: timestampSchema,
  heartbeatAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict();

export const automationRunRecordSchema = z.object({
  id: nonEmptyStringSchema,
  userId: nonEmptyStringSchema,
  caseId: nonEmptyStringSchema,
  scheduleId: nonEmptyStringSchema.optional(),
  occurrenceKey: nonEmptyStringSchema.optional(),
  trigger: automationRunTriggerSchema,
  status: automationRunStatusSchema,
  steps: z.array(automationRunStepRecordSchema),
  log: z.array(automationRunLogEntrySchema),
  error: z.string().optional(),
  lease: automationRunLeaseSchema.optional(),
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const automationScheduleRecurrenceSchema = z.enum(['daily', 'weekly']);
export const automationScheduleOverlapSchema = z.enum(['allow', 'skip']);
export const automationScheduleMisfireSchema = z.enum(['skip', 'run-once']);

export const automationScheduleRecordSchema = z.object({
  id: nonEmptyStringSchema,
  userId: nonEmptyStringSchema,
  caseId: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  recurrence: automationScheduleRecurrenceSchema,
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  timezone: nonEmptyStringSchema,
  nextRunAt: timestampSchema,
  lastRunAt: timestampSchema.optional(),
  enabled: z.boolean(),
  overlap: automationScheduleOverlapSchema,
  misfire: automationScheduleMisfireSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((record, context) => {
  if (record.recurrence === 'weekly' && record.weekdays.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['weekdays'],
      message: 'Weekly schedules require at least one weekday.',
    });
  }
  if (new Set(record.weekdays).size !== record.weekdays.length) {
    context.addIssue({
      code: 'custom',
      path: ['weekdays'],
      message: 'Schedule weekdays must be unique.',
    });
  }
});

export type AutomationOperationRecord = z.infer<typeof automationOperationRecordSchema>;
export type AutomationCaseRecord = z.infer<typeof automationCaseRecordSchema>;
export type AutomationRunTrigger = z.infer<typeof automationRunTriggerSchema>;
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;
export type AutomationRunStepRecord = z.infer<typeof automationRunStepRecordSchema>;
export type AutomationRunLogEntry = z.infer<typeof automationRunLogEntrySchema>;
export type AutomationRunLease = z.infer<typeof automationRunLeaseSchema>;
export type AutomationRunRecord = z.infer<typeof automationRunRecordSchema>;
export type AutomationScheduleRecord = z.infer<typeof automationScheduleRecordSchema>;

export type CreateAutomationCaseInput = Omit<AutomationCaseRecord, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};

export type CreateAutomationRunInput = Omit<
  AutomationRunRecord,
  'id' | 'status' | 'steps' | 'log' | 'createdAt' | 'updatedAt'
> & {
  id?: string;
  status?: AutomationRunStatus;
  steps?: AutomationRunStepRecord[];
  log?: AutomationRunLogEntry[];
};

export type UpdateAutomationRunInput = Partial<Omit<
  AutomationRunRecord,
  | 'id'
  | 'userId'
  | 'caseId'
  | 'createdAt'
  | 'updatedAt'
  | 'error'
  | 'lease'
  | 'startedAt'
  | 'finishedAt'
>> & {
  appendLog?: AutomationRunLogEntry[];
  error?: string | null;
  lease?: AutomationRunLease | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type CreateAutomationScheduleInput = Omit<AutomationScheduleRecord, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};
