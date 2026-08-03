import { z } from 'zod';

export const browserElementTargetSchema = z.object({
  kind: z.literal('ref'),
  ref: z.string().trim().min(1).max(120).describe('Exact ref returned by the latest inspect snapshot.'),
}).strict();

export const browserInteractToolDescription = '统一页面交互工具。DOM 操作只使用最近一次 inspect 快照返回的精确 dom-* ref：target 仅包含 kind="ref" 和 ref。后端只校验 ref 属于当前已暴露快照，不再比较元素文本、属性或语义指纹。普通操作仍由 Playwright 执行可操作性检查；force 仅用于明确关闭当前浮层。selectOption 支持原生 select，也支持以 virtualized="possible" 容器为 target 后由后端自动滚动查找并点击精确 value/label。纯图形元素可先截图后使用最新视口坐标。凭证必须通过 credentialRef。';

export const browserInteractTextInsertionDescription = 'insertTextAt 使用当前可编辑 dom-* ref，在 input、textarea、contenteditable 或富文本 iframe 中按 afterText、beforeText 或 offset 精确建立光标，并通过真实键盘插入 text；occurrence 用于选择重复锚点。';

export const browserInteractToolShape = {
  action: z.enum(['click', 'move', 'drag', 'scroll', 'scrollIntoView', 'type', 'insertTextAt', 'press', 'shortcut', 'selectOption']),
  target: browserElementTargetSchema.optional().describe('源目标，只能使用最新 inspect 返回的精确 dom-* ref。'),
  x_thousandth: z.number().int().min(1).max(999).optional().describe('最新视口截图中的横向位置，范围 1 到 999。'),
  y_thousandth: z.number().int().min(1).max(999).optional().describe('最新视口截图中的纵向位置，范围 1 到 999。'),
  toTarget: browserElementTargetSchema.optional().describe('拖拽目标，只能使用最新 inspect 返回的精确 dom-* ref。'),
  toX_thousandth: z.number().int().min(1).max(999).optional().describe('拖拽目标在最新视口截图中的横向位置。'),
  toY_thousandth: z.number().int().min(1).max(999).optional().describe('拖拽目标在最新视口截图中的纵向位置。'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  force: z.boolean().optional().describe('仅 click 可用；只跳过可操作性和遮挡检查，不跳过 ref 的当前快照归属检查。'),
  deltaX: z.number().optional().describe('action=scroll 时的横向滚轮增量。'),
  deltaY: z.number().optional().describe('action=scroll 时的纵向滚轮增量。'),
  text: z.string().optional(),
  offset: z.number().int().min(0).optional().describe('action=insertTextAt 时，从当前可编辑纯文本开头计算的字符偏移。'),
  afterText: z.string().min(1).optional().describe('action=insertTextAt 时，将文本插入到此精确文本锚点之后。'),
  beforeText: z.string().min(1).optional().describe('action=insertTextAt 时，将文本插入到此精确文本锚点之前。'),
  occurrence: z.number().int().min(1).optional().describe('文本锚点重复时选择第几次出现，默认 1。'),
  credentialRef: z.string().min(1).optional().describe('运行时提供的凭证引用；只允许 action=type。'),
  key: z.string().optional(),
  keys: z.array(z.string()).max(6).optional(),
  replace: z.boolean().optional(),
  followByEnter: z.boolean().optional(),
  value: z.string().min(1).optional().describe('原生 select 或虚拟列表选项的精确 value；存在时优先使用。'),
  label: z.string().min(1).optional().describe('原生 select 或虚拟列表选项的完整精确标签。'),
} satisfies z.ZodRawShape;

type BrowserElementTargetInput = z.infer<typeof browserElementTargetSchema>;

function coordinatePairState(x: number | undefined, y: number | undefined) {
  return { any: x !== undefined || y !== undefined, complete: x !== undefined && y !== undefined };
}

export function refineBrowserInteractTarget(
  input: {
    action?: string;
    force?: boolean;
    target?: BrowserElementTargetInput;
    toTarget?: BrowserElementTargetInput;
    x_thousandth?: number;
    y_thousandth?: number;
    toX_thousandth?: number;
    toY_thousandth?: number;
    value?: string;
    label?: string;
    text?: string;
    offset?: number;
    afterText?: string;
    beforeText?: string;
    occurrence?: number;
    credentialRef?: string;
  },
  context: z.RefinementCtx,
) {
  if (input.force && input.action !== 'click') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'force is allowed only for action=click.', path: ['force'] });
  }
  if (input.credentialRef && input.action !== 'type') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'credentialRef is allowed only for action=type.', path: ['credentialRef'] });
  }
  const sourceCoordinates = coordinatePairState(input.x_thousandth, input.y_thousandth);
  const destinationCoordinates = coordinatePairState(input.toX_thousandth, input.toY_thousandth);
  if (sourceCoordinates.any && !sourceCoordinates.complete) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Screenshot coordinates require both x_thousandth and y_thousandth.' });
  }
  if (destinationCoordinates.any && !destinationCoordinates.complete) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Drag coordinates require both toX_thousandth and toY_thousandth.' });
  }
  if (input.target && sourceCoordinates.any) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Use either target or screenshot coordinates, never both.' });
  }
  if (input.toTarget && destinationCoordinates.any) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Use either toTarget or destination screenshot coordinates, never both.' });
  }

  if (['click', 'move', 'type'].includes(input.action || '') && !input.target && !sourceCoordinates.complete) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${input.action} requires target or a complete latest screenshot coordinate.` });
  }
  if (input.action === 'scrollIntoView' && !input.target) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'scrollIntoView requires target.', path: ['target'] });
  }
  if (input.action === 'selectOption' && !input.target) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'selectOption requires target.', path: ['target'] });
  }
  if (input.action === 'selectOption' && !input.value?.trim() && !input.label?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'selectOption requires an exact value or full label.' });
  }
  if (input.action === 'insertTextAt') {
    if (!input.target) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'insertTextAt requires target.', path: ['target'] });
    }
    if (!input.text) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'insertTextAt requires non-empty text.', path: ['text'] });
    }
    const anchors = Number(input.offset !== undefined)
      + Number(input.afterText !== undefined)
      + Number(input.beforeText !== undefined);
    if (anchors !== 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'insertTextAt requires exactly one of offset, afterText, or beforeText.' });
    }
    if (input.occurrence !== undefined && input.offset !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'insertTextAt occurrence is available only with afterText or beforeText.', path: ['occurrence'] });
    }
  }
  if (input.action === 'drag') {
    if (!input.target && !sourceCoordinates.complete) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'drag requires a source target or coordinates.' });
    }
    if (!input.toTarget && !destinationCoordinates.complete) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'drag requires toTarget or destination coordinates.' });
    }
  }
}
