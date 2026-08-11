import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';

type PrototypeModelResponse =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; input: string };

class WorkflowPrototypeLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'webpilot-workflow-prototype';
  readonly modelId = 'deterministic-approval-model';
  readonly supportedUrls = {};

  constructor(private readonly responses: PrototypeModelResponse[]) {}

  static [WORKFLOW_SERIALIZE](instance: WorkflowPrototypeLanguageModel) {
    return { responses: instance.responses };
  }

  static [WORKFLOW_DESERIALIZE](data: { responses: PrototypeModelResponse[] }) {
    return new WorkflowPrototypeLanguageModel(data.responses);
  }

  async doGenerate(): Promise<LanguageModelV4GenerateResult> {
    throw new Error('The WorkflowAgent durability prototype uses streaming only.');
  }

  async doStream(options: LanguageModelV4CallOptions) {
      const responseIndex = Math.min(
        options.prompt.filter((message) => message.role === 'assistant').length,
        this.responses.length - 1,
      );
      const selected = this.responses[responseIndex];
      const parts: LanguageModelV4StreamPart[] = selected.type === 'text'
        ? [
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: `prototype-${responseIndex}`, modelId: 'workflow-prototype', timestamp: new Date() },
          { type: 'text-start', id: `text-${responseIndex}` },
          { type: 'text-delta', id: `text-${responseIndex}`, delta: selected.text },
          { type: 'text-end', id: `text-${responseIndex}` },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 10, text: 10, reasoning: 0 },
            },
          },
        ]
        : [
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: `prototype-${responseIndex}`, modelId: 'workflow-prototype', timestamp: new Date() },
          {
            type: 'tool-call',
            toolCallId: `prototype-call-${responseIndex + 1}`,
            toolName: selected.toolName,
            input: selected.input,
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 10, text: 10, reasoning: 0 },
            },
          },
        ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
  }
}

// Keep construction outside the workflow function so the Workflow compiler
// can register the serializable model class before it crosses a step boundary.
export function createWorkflowPrototypeModel(responses: PrototypeModelResponse[]) {
  return new WorkflowPrototypeLanguageModel(responses);
}
