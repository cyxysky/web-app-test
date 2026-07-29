import { z } from 'zod';

export const browserInteractToolDescription = '统一页面交互工具。click、move、drag、scroll、scrollIntoView 处理指针输入；type、press、shortcut 处理键盘输入；selectOption 不打开平台下拉框，直接选择原生 HTML select。语义目标优先使用最新 inspect action=capture 返回的 uid；x_thousandth/y_thousandth 只能对应最新视口截图。运行时提供凭证引用时必须使用 credentialRef，禁止把密钥放入 text。';

export const browserInteractToolShape = {
  action: z.enum(['click', 'move', 'drag', 'scroll', 'scrollIntoView', 'type', 'press', 'shortcut', 'selectOption']),
  uid: z.string().optional().describe('最新 inspect action=capture 结果中的 uid。'),
  x_thousandth: z.number().int().min(1).max(999).optional().describe('最新视口截图中的横向位置，范围 1 到 999。'),
  y_thousandth: z.number().int().min(1).max(999).optional().describe('最新视口截图中的纵向位置，范围 1 到 999。'),
  toUid: z.string().optional().describe('拖拽目标的 uid。'),
  toX_thousandth: z.number().int().min(1).max(999).optional().describe('拖拽目标在最新视口截图中的横向位置。'),
  toY_thousandth: z.number().int().min(1).max(999).optional().describe('拖拽目标在最新视口截图中的纵向位置。'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  deltaX: z.number().optional().describe('action=scroll 时的横向滚轮增量。'),
  deltaY: z.number().optional().describe('action=scroll 时的纵向滚轮增量。'),
  text: z.string().optional(),
  credentialRef: z.string().min(1).max(200).optional().describe('不透明的运行时凭证引用。输入密钥时使用它，不得使用 text；模型永远不会获得实际值。'),
  key: z.string().optional(),
  keys: z.array(z.string().min(1)).max(6).optional(),
  replace: z.boolean().optional().describe('action=type 时默认替换已有内容；设为 false 才追加。'),
  followByEnter: z.boolean().optional(),
  value: z.string().min(1).optional().describe('select options 属性中显示的精确 option value；存在时优先使用。'),
  label: z.string().min(1).optional().describe('select options 属性中显示的完整可见标签。'),
} satisfies z.ZodRawShape;
