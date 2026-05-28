import { executeTestCase } from '@/server/ai/agents/test-executor.agent';
import { store } from '@/server/db/mock-store';
import { writeReport } from '@/server/reports/report-writer.agent';

export async function runTestCase(testCaseId: string) {
  const testCase = store.getTestCase(testCaseId);
  if (!testCase) throw new Error('Test case not found');

  const run = store.createRun(testCaseId);
  store.updateTestCaseStatus(testCaseId, 'running');
  store.updateRun(run.id, { status: 'running', startedAt: new Date().toISOString() });

  const execution = await executeTestCase(testCase, run.id);
  const finished = store.updateRun(run.id, {
    status: execution.status,
    endedAt: new Date().toISOString(),
    result: execution.result,
  });

  if (!finished) throw new Error('Run not found after execution');
  const report = writeReport(testCase, finished);
  const withReport = store.updateRun(run.id, { report });
  store.updateTestCaseStatus(testCaseId, execution.status);

  return withReport;
}
