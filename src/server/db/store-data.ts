import type {
  ModelConfigRecord,
  RunScheduleRecord,
  RuntimeEnvRecord,
  TestCaseRecord,
  TestGroupRecord,
  TestRunRecord,
} from '@/server/ai/schemas/test-case.schema';

export type StoreData = {
  testCases: TestCaseRecord[];
  runs: TestRunRecord[];
  groups?: TestGroupRecord[];
  runtimeEnv?: RuntimeEnvRecord[];
  modelConfig?: ModelConfigRecord;
  schedules?: RunScheduleRecord[];
};

export function normalizeStoreData(data: StoreData): StoreData {
  return {
    ...data,
    groups: data.groups || [],
    runtimeEnv: data.runtimeEnv || [],
    modelConfig: data.modelConfig,
    schedules: data.schedules || [],
  };
}
