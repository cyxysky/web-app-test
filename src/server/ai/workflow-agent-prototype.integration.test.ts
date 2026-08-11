import { describe, expect, it } from 'vitest';
import { getRun, start } from 'workflow/api';
import { waitForHook } from '@workflow/vitest';
import {
  runWorkflowAgentDurabilityPrototype,
  workflowAgentPrototypeApprovalHook,
  workflowAgentPrototypeApprovalToken,
} from './workflow-agent-prototype';

describe('WorkflowAgent durability prototype', () => {
  it('rehydrates a run handle and resumes after delayed human approval', async () => {
    const input = {
      requestId: 'restart-proof-1',
      userId: 'workflow-user',
      action: 'continue the browser job after approval',
    };
    const run = await start(runWorkflowAgentDurabilityPrototype, [input]);
    const token = workflowAgentPrototypeApprovalToken(input.userId, input.requestId);

    await waitForHook(run as never, { token });

    // Discard the original handle and resolve the run again, matching the path
    // used by a new request/process after the original request has disappeared.
    const rehydratedRun = getRun(run.runId);
    await workflowAgentPrototypeApprovalHook.resume(token, {
      approved: true,
      reviewer: 'integration-test',
      comment: 'resume after delayed approval',
    });

    const result = await rehydratedRun.returnValue as Awaited<ReturnType<typeof runWorkflowAgentDurabilityPrototype>>;
    expect(await rehydratedRun.status).toBe('completed');
    expect(result).toMatchObject({
      requestId: input.requestId,
      userId: input.userId,
      status: 'resumed',
      text: 'WorkflowAgent resumed after the delayed approval.',
      approval: {
        approved: true,
        reviewer: 'integration-test',
      },
    });
    expect(result.stepCount).toBeGreaterThanOrEqual(2);
  });
});
