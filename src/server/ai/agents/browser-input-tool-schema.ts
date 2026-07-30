import { z } from 'zod';

const stableTargetAttributeName = /^(?:id|aria-label|title|data-[\w:-]+|href|name|placeholder)$/;

const browserTargetAttributesSchema = z.record(
  z.string().min(1).max(80),
  z.string().min(1).max(500),
).superRefine((attributes, context) => {
  const entries = Object.entries(attributes);
  if (entries.length > 4) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A target may declare at most four stable attributes.',
    });
  }
  for (const [name] of entries) {
    if (!stableTargetAttributeName.test(name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsupported target attribute "${name}". Use id, aria-label, title, data-*, href, name, or placeholder.`,
        path: [name],
      });
    }
  }
});

export const browserTargetSelectorSchema = z.object({
  role: z.string().min(1).max(80).optional().describe('Exact semantic role from the same inspect snapshot.'),
  name: z.string().min(1).max(300).optional().describe('Exact visible or accessible name from the same inspect snapshot.'),
  attributes: browserTargetAttributesSchema.optional().describe('Exact stable attributes copied from the same inspect snapshot.'),
  exact: z.literal(true).optional().describe('Semantic matching is always exact; when present this must be true.'),
}).superRefine((selector, context) => {
  if (!selector.name?.trim() && !Object.keys(selector.attributes || {}).length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A semantic target requires an exact name or at least one stable attribute; role alone is not unique enough.',
    });
  }
});

export const browserElementTargetSchema = z.object({
  kind: z.enum(['semantic', 'ref']),
  ref: z.string().min(1).max(120).optional().describe('Fallback only: one exact ref returned by the declared snapshot.'),
  role: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(300).optional(),
  attributes: browserTargetAttributesSchema.optional(),
  scope: browserTargetSelectorSchema.optional().describe('Optional unique parent/container selector from the same snapshot.'),
  exact: z.literal(true).optional(),
}).superRefine((target, context) => {
  if (target.kind === 'ref') {
    if (!target.ref?.trim()) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'A ref target requires ref.', path: ['ref'] });
    }
    if (target.role || target.name || target.attributes || target.scope) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A ref target contains only kind and ref. Use kind="semantic" for role, name, attributes, or scope.',
      });
    }
    return;
  }
  if (target.ref) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A semantic target must not include ref.', path: ['ref'] });
  }
  if (!target.name?.trim() && !Object.keys(target.attributes || {}).length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A semantic target requires an exact name or at least one stable attribute; role alone is not unique enough.',
    });
  }
});

export const browserInteractToolDescription = '统一页面交互工具。DOM 目标必须绑定最新 inspect 返回的 snapshotId。优先使用 kind="semantic"，用同一快照中的精确 role/name/稳定 attributes 描述目标；重复目标用 scope 限定唯一父容器。运行时会在当前真实、可操作元素中精确匹配，只有一个结果才执行。只有缺少稳定语义时才使用 kind="ref" 的短生命周期快照引用；页面导航、节点替换或关键身份变化会使其失效，运行时不会模糊重绑。禁止 first/nth 式消歧。force 只允许明确关闭当前浮层的 click，并且只跳过可操作性/遮挡检查，不跳过快照归属与唯一性检查。纯图形元素可先截图后使用最新视口坐标。凭证必须通过 credentialRef。';

export const browserInteractToolShape = {
  action: z.enum(['click', 'move', 'drag', 'scroll', 'scrollIntoView', 'type', 'press', 'shortcut', 'selectOption']),
  snapshotId: z.string().min(1).max(120).optional().describe('target/toTarget 所属的最新 inspect snapshotId。使用 DOM 目标时必填。'),
  target: browserElementTargetSchema.optional().describe('源目标。优先 semantic；只有没有稳定语义时才使用 ref。'),
  x_thousandth: z.number().int().min(1).max(999).optional().describe('最新视口截图中的横向位置，范围 1 到 999。'),
  y_thousandth: z.number().int().min(1).max(999).optional().describe('最新视口截图中的纵向位置，范围 1 到 999。'),
  toTarget: browserElementTargetSchema.optional().describe('拖拽目标，必须与源目标属于同一个 snapshotId。'),
  toX_thousandth: z.number().int().min(1).max(999).optional().describe('拖拽目标在最新视口截图中的横向位置。'),
  toY_thousandth: z.number().int().min(1).max(999).optional().describe('拖拽目标在最新视口截图中的纵向位置。'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  force: z.boolean().optional().describe('仅 click 可用；只跳过可操作性和遮挡检查，不跳过目标唯一性、快照归属或真实节点校验。'),
  deltaX: z.number().optional().describe('action=scroll 时的横向滚轮增量。'),
  deltaY: z.number().optional().describe('action=scroll 时的纵向滚轮增量。'),
  text: z.string().optional(),
  credentialRef: z.string().min(1).optional().describe('运行时提供的凭证引用；只允许 action=type。'),
  key: z.string().optional(),
  keys: z.array(z.string()).max(6).optional(),
  replace: z.boolean().optional(),
  followByEnter: z.boolean().optional(),
  value: z.string().min(1).optional().describe('select options 属性中显示的精确 option value；存在时优先使用。'),
  label: z.string().min(1).optional().describe('select options 属性中显示的完整可见标签。'),
} satisfies z.ZodRawShape;

type BrowserElementTargetInput = z.infer<typeof browserElementTargetSchema>;

function coordinatePairState(x: number | undefined, y: number | undefined) {
  return { any: x !== undefined || y !== undefined, complete: x !== undefined && y !== undefined };
}

export function refineBrowserInteractTarget(
  input: {
    action?: string;
    force?: boolean;
    snapshotId?: string;
    target?: BrowserElementTargetInput;
    toTarget?: BrowserElementTargetInput;
    x_thousandth?: number;
    y_thousandth?: number;
    toX_thousandth?: number;
    toY_thousandth?: number;
  },
  context: z.RefinementCtx,
) {
  if (input.force && input.action !== 'click') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'force is allowed only for action=click.', path: ['force'] });
  }
  if ((input.target || input.toTarget) && !input.snapshotId?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'DOM targets require snapshotId from the same latest inspect result.',
      path: ['snapshotId'],
    });
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
  if (input.action === 'drag') {
    if (!input.target && !sourceCoordinates.complete) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'drag requires a source target or coordinates.' });
    }
    if (!input.toTarget && !destinationCoordinates.complete) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'drag requires toTarget or destination coordinates.' });
    }
  }
}
