export const subagentRuntimeSkillId = 'system-subagent-runtime';

export const subagentRuntimeSkillSummary = [
  '<system_skill>',
  `<id>${subagentRuntimeSkillId}</id>`,
  '<title>Subagent Runtime</title>',
  '<description>Hidden built-in operating manual for safe child-Agent task splitting, shared browser state, page ownership, and ordered result collection.</description>',
  '<required>conditional</required>',
  '</system_skill>',
].join('\n');

export const subagentRuntimeSkillContent = `# Subagent Runtime

This hidden built-in Skill is authoritative for subagent action=spawn. The first spawn in an Agent run automatically loads and returns it while continuing the original spawn. subagent action=read is deliberately ungated, so pending results can always be collected.

## Host tool boundary and API signatures

\`subagent\` is a model tool, not a browserCode JavaScript global. Every example below is one provider-neutral model-tool call.

\`\`\`ts
type SubagentTask = {
  title: string;       // 1-160 characters
  url: string;         // absolute URL, maximum 4,000 characters
  instruction: string; // self-contained task and evidence contract, 1-4,000 characters
};

type SubagentInput =
  | {
      action: "spawn";
      reason?: string;
      tasks: SubagentTask[]; // preferred batch form; every task runs concurrently
    }
  | {
      action: "spawn";
      reason?: string;
      title: string;
      url: string;
      instruction: string; // flat fallback for exactly one child
    }
  | {
      action: "read";
      reason?: string;
      uuid: string; // exact UUID returned by spawn
    };

type SubagentToolResult = {
  ok: boolean;
  actual: string; // JSON text; inspect and preserve UUID order
  failureCategory?: string;
  requiredSkillId?: string;
};

declare function subagent(input: SubagentInput): Promise<SubagentToolResult>;
\`\`\`

The successful spawn result has this semantic shape:

\`\`\`ts
type SpawnActual = {
  subagents: Array<{
    uuid: string;
    index: number;
    title: string;
    status: "passed" | "blocked" | "failed";
  }>;
  summary: string;
  batchId: string;
  next: string;
};
\`\`\`

The successful read result has this semantic shape:

\`\`\`ts
type ReadActual = {
  uuid: string;
  title: string;
  status: "passed" | "blocked" | "failed";
  summary?: string;
  summaryChars?: number;
  summaryOriginalChars?: number;
  summaryTruncated: false;
  partial: boolean;
  error?: string;
};
\`\`\`

\`actual\` is JSON text inside the outer tool result. Read it semantically. A successful batch barrier means all branches settled; it does not mean every branch passed, and it does not expose each child summary until that UUID is read.

## Spawn examples

Spawn independent pages in one concurrent batch:

\`\`\`js
subagent({
  action: "spawn",
  reason: "并行检查三个互不依赖的业务页面",
  tasks: [
    {
      title: "检查订单 A",
      url: "https://example.com/orders/a",
      instruction: "读取订单 A 的当前状态、金额、更新时间和页面证据；不要修改数据。返回来源 URL、精确字段值、未读取区域和任何阻塞。"
    },
    {
      title: "检查订单 B",
      url: "https://example.com/orders/b",
      instruction: "读取订单 B 的当前状态、金额、更新时间和页面证据；不要修改数据。返回来源 URL、精确字段值、未读取区域和任何阻塞。"
    },
    {
      title: "检查订单 C",
      url: "https://example.com/orders/c",
      instruction: "读取订单 C 的当前状态、金额、更新时间和页面证据；不要修改数据。返回来源 URL、精确字段值、未读取区域和任何阻塞。"
    }
  ]
})
\`\`\`

Spawn exactly one child with the flat form:

\`\`\`js
subagent({
  action: "spawn",
  reason: "让独立页面由单个子 Agent 检查",
  title: "检查独立报表",
  url: "https://example.com/report",
  instruction: "读取报表日期、总计和异常行；返回来源 URL、精确值和可追溯页面证据，不要修改页面。"
})
\`\`\`

Strong child instructions contain five things:

1. One independent objective and its explicit non-goals.
2. The exact starting URL.
3. The facts or action outcome required from the child.
4. The evidence format: URLs, visible fields, table rows, confirmation text, tab id, or failure details.
5. The stopping/handoff condition, including whether the child may retain an owned deliverable tab.

Do not send a vague instruction such as \`"看看这个页面"\`. Use a self-contained contract:

\`\`\`js
{
  title: "核对发票状态",
  url: "https://example.com/invoices/INV-2048",
  instruction: "只核对 INV-2048，不处理其他发票。返回发票号、客户、金额、付款状态、最后更新时间及其页面证据；若被登录或验证阻塞，返回当前 URL、tab id、active surface、失败操作和交接建议。不要提交、下载或修改任何数据。"
}
\`\`\`

## Ordered read examples

If spawn returns UUIDs \`u1\`, \`u2\`, and \`u3\` in that order, read them in three later model steps:

\`\`\`js
subagent({
  action: "read",
  uuid: "u1-exact-uuid-from-spawn",
  reason: "读取第一个子 Agent 结果"
})
\`\`\`

\`\`\`js
subagent({
  action: "read",
  uuid: "u2-exact-uuid-from-spawn",
  reason: "读取第二个子 Agent 结果"
})
\`\`\`

\`\`\`js
subagent({
  action: "read",
  uuid: "u3-exact-uuid-from-spawn",
  reason: "读取第三个子 Agent 结果"
})
\`\`\`

Never put several UUIDs in one read call, invent a UUID, skip ahead, or synthesize from the spawn status list. If a read returns \`not_found\`, preserve that UUID and report that it is outside the current conversation or no longer exists. If it reports \`running\` or \`queued\`, the batch barrier was not complete and the returned failure guidance is authoritative.

## When to delegate

- Spawn only concrete tasks that are independent and useful in parallel.
- Give each child a self-contained title, URL, instruction, expected output, and evidence requirement.
- Good boundaries include independent URLs, documents, research questions, comparisons, or test branches.
- Keep dependent steps, final synthesis, and externally consequential decisions in the parent Agent.
- Never split consecutive operations on the same interactive page across children. One owner must retain the complete page transaction.

## Shared browser identity and isolated pages

Children may reuse the parent's browser context and authenticated identity, including Cookie-backed login state and, when the runtime supports it, shared storage. They should verify the target page directly and must not log in again or log out merely because they are children.

Each child must work in its own page or tab. It must not take over, navigate, close, or race the parent's current active page. Background children must not steal foreground focus. A child may switch only among tabs it owns or has explicitly claimed for its task.

## Tab ownership and cleanup

- The Agent that creates or explicitly claims a tab owns it.
- A child closes only tabs it owns and only when they are no longer required for evidence, handoff, or delivery.
- Never close the parent's tabs, sibling tabs, or an unowned login/verification page.
- At completion, retain only explicit deliverable or handoff tabs and return their ids, URLs, titles, and status to the parent when relevant.
- The parent decides the final retained-tab set after all child results are integrated.

## Spawning and reading results

For multiple independent tasks, pass tasks=[{ title, url, instruction }, ...]. For exactly one child, the flat title, url, and instruction form is allowed. Do not retry the same rejected parameter shape repeatedly.

The spawn result returns child UUIDs in collection order. After the batch barrier completes, call subagent action=read with exactly one UUID per model step, in the returned order. Never synthesize unread child output or read multiple UUIDs out of order. The parent Agent alone combines evidence, resolves conflicts, decides whether follow-up work is required, and writes the final answer.

## Browser failure handoff

When a child cannot complete a browser operation, it should return:

- the owned tab/page id, current URL, and title;
- the latest active surface id, surface stack, and relevant page state;
- the failed locator or operation and the exact failure;
- whether login/session state was present;
- a concrete suggested next inspection or action for the parent.

Do not hide an unresolved child failure behind a generic summary. The parent should use the returned surface and page evidence to continue safely without rerunning completed child work.
`;
