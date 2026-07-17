import { NextResponse } from 'next/server';
import type { StepToolCall } from '@/server/ai/schemas/test-case.schema';
import { store } from '@/server/db/store';

type RouteContext = {
  params: Promise<{ runId: string; stepIndex: string }>;
};

function cleanInput(input: unknown) {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'object' && !Array.isArray(input)) return input;
  throw new Error('工具参数必须是 JSON 对象');
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function normalizedToolInput(input: unknown) {
  return input === undefined ? {} : input;
}

function sameToolSignature(left: StepToolCall, right: StepToolCall) {
  return left.name === right.name
    && stableStringify(normalizedToolInput(left.input)) === stableStringify(normalizedToolInput(right.input));
}

function cleanTool(input: unknown, index: number, sourceTools: StepToolCall[]): StepToolCall {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`第 ${index + 1} 个工具不是合法对象`);
  }
  const raw = input as StepToolCall & { sourceToolIndex?: unknown };
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new Error(`第 ${index + 1} 个工具缺少工具名`);

  const sourceToolIndex = typeof raw.sourceToolIndex === 'number' && Number.isInteger(raw.sourceToolIndex)
    ? raw.sourceToolIndex
    : undefined;
  const sourceTool = sourceToolIndex !== undefined ? sourceTools[sourceToolIndex] : undefined;
  const tool: StepToolCall = {
    name,
    input: cleanInput(raw.input),
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : undefined,
    ok: typeof raw.ok === 'boolean' ? raw.ok : undefined,
  };

  if (!sourceTool || !sameToolSignature(tool, sourceTool)) return tool;
  return {
    ...tool,
    result: sourceTool.result,
    contextBefore: sourceTool.contextBefore,
    contextAfter: sourceTool.contextAfter,
    visualAfter: sourceTool.visualAfter,
    screenshots: sourceTool.screenshots,
  };
}

export async function PUT(request: Request, context: RouteContext) {
  const { runId, stepIndex } = await context.params;
  const numericStepIndex = Number(stepIndex);
  if (!Number.isInteger(numericStepIndex) || numericStepIndex <= 0) {
    return NextResponse.json({ error: 'Invalid step index' }, { status: 400 });
  }

  try {
    const run = store.getRun(runId);
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    if (run.status === 'running' || run.status === 'queued' || run.status === 'paused') {
      return NextResponse.json({ error: '运行中记录不能编辑工具，请结束或中断后再修改。' }, { status: 400 });
    }

    const result = run.result || { steps: [], consoleErrors: [], networkErrors: [] };
    const existingStep = result.steps.find((step) => step.index === numericStepIndex);
    if (!existingStep) return NextResponse.json({ error: 'Step not found' }, { status: 404 });

    const body = await request.json();
    const tools = Array.isArray(body.tools)
      ? body.tools.map((tool: unknown, index: number) => cleanTool(tool, index, existingStep.tools || []))
      : undefined;
    if (!tools) return NextResponse.json({ error: 'Missing tools array' }, { status: 400 });

    const steps = result.steps.map((step) => (
      step.index === numericStepIndex ? { ...step, tools } : step
    ));
    const updated = store.updateRun(runId, {
      result: {
        ...result,
        steps,
      },
    });

    return NextResponse.json({ ok: true, run: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存工具记录失败' },
      { status: 400 },
    );
  }
}
