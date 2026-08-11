import { WorkflowAgent } from '@ai-sdk/workflow';
import { tool } from 'ai';
import { defineHook, getWritable } from 'workflow';
import { z } from 'zod';
import { createWorkflowPrototypeModel } from './workflow-agent-prototype-model';

export const workflowAgentPrototypeInputSchema = z.object({
  requestId: z.string().min(1).max(120),
  userId: z.string().min(1).max(120),
  action: z.string().min(1).max(500),
});

export type WorkflowAgentPrototypeInput = z.infer<typeof workflowAgentPrototypeInputSchema>;

export const workflowAgentPrototypeApprovalSchema = z.object({
  approved: z.boolean(),
  reviewer: z.string().min(1).max(120),
  comment: z.string().max(1_000).optional(),
});

export type WorkflowAgentPrototypeApproval = z.infer<typeof workflowAgentPrototypeApprovalSchema>;

export const workflowAgentPrototypeApprovalHook = defineHook({
  schema: workflowAgentPrototypeApprovalSchema,
});

export function workflowAgentPrototypeApprovalToken(userId: string, requestId: string) {
  return `workflow-agent-prototype:${encodeURIComponent(userId)}:${encodeURIComponent(requestId)}`;
}

async function waitForPrototypeApproval(
  input: WorkflowAgentPrototypeInput,
) {
  const hook = workflowAgentPrototypeApprovalHook.create({
    token: workflowAgentPrototypeApprovalToken(input.userId, input.requestId),
  });
  return await hook;
}

/**
 * Isolated durability prototype. It deliberately uses a deterministic model so
 * the test validates WorkflowAgent checkpoint/replay and delayed approval,
 * without calling a configured production model or opening a BrowserSession.
 */
export async function runWorkflowAgentDurabilityPrototype(rawInput: WorkflowAgentPrototypeInput) {
  'use workflow';

  const input = workflowAgentPrototypeInputSchema.parse(rawInput);
  let resolvedApproval: WorkflowAgentPrototypeApproval | undefined;
  const agent = new WorkflowAgent({
    id: 'webpilot-workflow-agent-durability-prototype',
    model: createWorkflowPrototypeModel([
      {
        type: 'tool-call',
        toolName: 'requestHumanApproval',
        input: JSON.stringify(input),
      },
      {
        type: 'text',
        text: 'WorkflowAgent resumed after the delayed approval.',
      },
    ]),
    instructions: 'Exercise exactly one durable human-approval tool, then report that execution resumed.',
    tools: {
      requestHumanApproval: tool({
        description: 'Pause this durable prototype until a human approves or rejects the proposed action.',
        inputSchema: workflowAgentPrototypeInputSchema,
        execute: async (toolInput) => {
          resolvedApproval = await waitForPrototypeApproval(toolInput);
          return resolvedApproval;
        },
      }),
    },
  });

  const result = await agent.stream({
    messages: [{ role: 'user', content: `Request durable approval for: ${input.action}` }],
    writable: getWritable(),
  });
  const lastStep = result.steps.at(-1);
  return {
    requestId: input.requestId,
    userId: input.userId,
    status: 'resumed' as const,
    text: lastStep?.text || '',
    finishReason: result.finishReason,
    stepCount: result.steps.length,
    approval: resolvedApproval,
  };
}
