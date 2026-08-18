# 浏览器对话子 Agent 与页面快照修复方案

状态：待实施  
适用范围：浏览器对话模式、并行子 Agent、`takeSnapshot`、`searchSnapshot`、浏览器提示词与相关前端事件  
兼容策略：项目仍处于早期阶段，不保留旧执行语义和旧快照协议的兼容分支

## 1. 背景

当前浏览器对话已经具备并行子 Agent、分页 DOM 快照、iframe 读取和增量 DOM 变化能力，但真实会话暴露出以下问题：

1. `spawnSubagents` 尚未形成可靠的主 Agent 执行屏障。原始 attempt 等待子 Agent 时，Agent Loop 超时会启动新的 attempt，导致主 Agent 与子 Agent 同时继续执行。
2. 重试 attempt 遇到重复子任务时直接得到空 `results`，没有等待或复用原批次，因此子 Agent 结果没有进入当前主 Agent 上下文。
3. 子 Agent 聚合结果会被通用工具结果预览上限从头截断，可能完整保留第一个分支，却完全丢失后面的分支。
4. 快照分页把页面任意异步 DOM 变化都判定为整份 cursor 失效，即使分页内容已经冻结且两次读取之间没有浏览器操作。
5. `searchSnapshot` 会消费 mutation queue，却不一致地使分页失效，导致同一个 cursor 是否可继续取决于工具调用顺序。
6. `takeSnapshot({ mode: "text" })` 当前只读取视窗范围；`full` 才读取整页已加载 DOM。两者的真实语义与产品预期不一致。
7. `text` 只读取与顶层视窗相交的 iframe；视窗外 iframe 内容不会进入结果。
8. 模型把 `domChanges.overflow` 误解成“页面下方还有内容”，继而滚动普通长页面，并把“滚动到底部”继续写进子 Agent 指令。
9. 快照预采集上限没有明确返回 `truncated` 等覆盖信息，模型可能把不完整内容报告为“已完整读取”。
10. 模型可以在同一个输出步骤中生成多个 `readSubagent` 调用，但当前通用 `toolExecutionGate` 只允许第一个工具真正执行；前端随后又通过 fallback 把其余没有 trace 和真实结果的模型请求渲染成正常工具卡片，因此出现“实际只读取一个，界面却展示四个读取工具”的假象。
11. 当前每个子 Agent 使用 `isolated: true` 启动独立无头 Chromium。并发会话和并发子任务叠加后，浏览器进程数按任务数增长；同时 `BrowserSession` 仍围绕“活动页面”组织，缺少可在后台稳定操作指定页面的页面租约。

## 2. 修复目标

完成修改后必须满足以下产品语义：

- 主 Agent 调用 `spawnSubagents` 后，必须等待当前批次所有子 Agent 进入终态，才能进入下一次模型推理或调用其他工具。
- 单个子 Agent 失败不得取消兄弟分支；失败分支已经获得的部分内容必须返回主 Agent。
- 同一回合的重复委托必须等待并复用原批次，不能返回空结果，也不能创建第二批重复任务。
- `spawnSubagents` 返回每个子 Agent 的 UUID；主 Agent 必须使用单结果工具逐个读取，不能一次把多个总结注入上下文。
- 每个模型步骤最多真实执行一次 `readSubagent`；前端不得把未执行、被闸门忽略或没有真实结果的模型请求渲染成已执行工具。
- 子 Agent 总结建议长度来自 `AI_SUBAGENT_RESULT_MAX_CHARS` 配置，只用于提示模型控制篇幅；后端必须完整保存和返回模型结果，不得按该配置截断。
- 子 Agent 的浏览器并发必须受进程池和页面租约控制；后台任务绑定自己的 `Page`，不得依赖用户当前可见或当前激活的标签页。
- `text` 和 `full` 都覆盖当前已经加载的整页 DOM 及所有可读取 iframe；二者只在输出格式上不同。
- 快照分页是对一次冻结采集结果的字符分页，不是视窗分页，不应通过滚动获取下一页。
- 页面后台异步变化不能阻止继续读取冻结快照的后续文本页；UID 是否仍可操作必须独立判断。
- 模型只有在确认内容尚未进入 DOM，且页面属于懒加载、虚拟列表或无限滚动时，才能调用滚动。
- 任何“不完整读取”都必须通过结构化元数据暴露，模型不得在 `truncated`、`skippedFrames` 或未消费完 `nextCursor` 时声称已完整分析。

## 3. 子 Agent 执行屏障

### 3.1 目标执行流程

```text
主 Agent 调用 spawnSubagents
  -> 创建或复用 SubagentBatch
  -> 并行启动全部独立任务
  -> Promise.allSettled 等待全部任务终态
  -> 为每个任务保留 passed / failed / blocked 和部分结果
  -> 生成面向主模型的聚合工具结果
  -> 将该工具结果写入发起调用的同一个 attempt
  -> 主 Agent 进入下一次推理
```

在批次完成前，不允许主 Agent出现新的 `mouse`、`keyboard`、`openPage`、`takeSnapshot`、`spawnSubagents` 或最终回答。

### 3.2 Attempt 生命周期

为每次 `runAgent` 创建独立的 `attemptId` 和 `AbortController`：

```ts
type BrowserChatAttempt = {
  id: string;
  assistantMessageId: string;
  controller: AbortController;
  status: 'running' | 'cancelling' | 'completed' | 'failed';
};
```

执行规则：

1. 工具调用、子 Agent、`shouldContinue` 和日志写入均同时校验 `assistantMessageId` 与 `attemptId`。
2. Agent Loop 超时后先把当前 attempt 标记为 `cancelling`，传播 abort，并等待旧 attempt 与活动工具完成清理。
3. 旧 attempt 未进入终态前禁止启动重试 attempt。
4. 已取消 attempt 的工具结果不得继续写入当前会话或模型上下文。
5. 原生 `generateText` 的整体超时不得把一个仍有心跳的长时间工具误判为模型请求超时。模型请求超时与工具执行超时必须分开。

建议取消当前包住整个原生工具循环的 `AI_AGENT_LOOP_TIMEOUT_MS + Promise.race` 行为，改成：

- 模型请求使用独立超时；
- 普通浏览器工具使用各自超时；
- 子 Agent 批次使用 `AI_SUBAGENT_LOOP_TIMEOUT_MS`；
- 用户中断使用会话级 abort；
- 只有对应层级的信号可以结束对应任务。

### 3.3 批次复用与去重

在会话回合内维护批次注册表：

```ts
type SubagentBatchRegistryEntry = {
  batchId: string;
  assistantMessageId: string;
  normalizedTaskKey: string;
  promise: Promise<SubagentBatchResult>;
  result?: SubagentBatchResult;
};
```

规则：

- 相同 `assistantMessageId + normalizedTaskKey` 的任务正在运行时，后续调用直接 `await existing.promise`。
- 原批次已完成时，后续调用返回同一份 `result`。
- 不再使用 `tasks: [], results: []` 表示“已经委托过”。
- 回合结束或用户中断后清理注册表。
- 子 Agent 自身不得再次派生子 Agent，除非后续明确设计嵌套批次和总并发限制。

### 3.4 子 Agent 结果与单结果读取协议

`spawnSubagents` 只返回批次状态和子 Agent 引用，不直接把全部总结塞进该工具结果：

```ts
type SubagentBatchResult = {
  batchId: string;
  status: 'completed';
  results: Array<{
    uuid: string;
    title: string;
    status: 'passed' | 'failed' | 'blocked';
    partial: boolean;
    error?: string;
  }>;
  totals: {
    passed: number;
    failed: number;
    blocked: number;
    partial: number;
  };
};
```

只保留每次读取一个结果的工具：

```ts
readSubagent({
  uuid: z.string().uuid(),
})
```

一次调用返回稳定顺序的完整结果数组：

```ts
type ReadSubagentsResult = {
  results: Array<{
    uuid: string;
    title: string;
    status: 'passed' | 'failed' | 'blocked';
    summary: string;
    summaryChars: number;
    summaryTruncated: boolean;
    partial: boolean;
    error?: string;
    evidenceCount: number;
    fullResultId: string;
  }>;
};
```

执行与上下文规则：

- `spawnSubagents` 完成后，主 Agent 使用 `readSubagent({ uuid })` 每次读取一个结果；需要更多结果时进入后续模型步骤继续读取。
- `readSubagent` 重新纳入通用“一模型步骤一个工具”闸门；同一步中额外生成的读取请求不执行，也不产生正常工具卡片。
- UUID 不存在、尚未终态或读取失败时返回该 UUID 的结构化错误，不影响后续读取其他结果。
- `AI_SUBAGENT_RESULT_MAX_CHARS` 是模型总结建议长度，不是后端上限。提示词应要求优先覆盖来源地址、已验证事实、表格/字段、图片与 iframe 信息、失败步骤、未读取区域和剩余风险。
- 后端不根据建议长度执行 `slice`、截断或丢弃；`summaryChars` 反映真实文本长度，`summaryTruncated` 始终为 `false`。
- 不把每个子 Agent 的全部工具日志、完整快照和调试对象直接塞入聚合结果。
- 完整内容与证据保存在服务端结果存储中，通过 `fullResultId` 分页读取。
- 失败分支的 `summary` 使用其最后有效模型文本或已完成步骤内容，不能因为最终状态是 `failed` 就丢弃已获取信息。

### 3.5 工具执行事实与前端渲染

前端必须区分“模型提出了工具调用”和“后端真实执行了工具”：

- 正常工具胶囊只能由持久化的 tool trace/tool result 驱动；`toolDetail` 不存在时不得通过 `fallbackAiCycleToolDetail()` 伪造 `running` 工具。
- `spawnSubagents` 与每一次 `readSubagent` 都以真实 `toolCallId/traceId` 归属到模型输出中的准确位置，不能按工具名猜测，也不能在消息尾部补挂一份。
- 每次真实读取只渲染一个对应 UUID 的工具胶囊；没有 trace/result 的模型请求不渲染。
- 被执行闸门拒绝、参数校验失败或模型重复生成但未进入执行器的调用，只能进入调试日志；不得显示成普通“执行中/已完成”工具。
- 会话结束、刷新或切换后，工具状态完全从持久化 trace/result 恢复，不能根据主消息是否结束推断。

### 3.6 需要修改的文件

- `src/server/ai/agents/browser-chat-executor.agent.ts`
  - 分离模型请求超时与工具等待。
  - 将 attempt signal 传入所有工具执行路径。
  - 为 `spawnSubagents` 使用专用结果压缩逻辑，不再走通用前缀截断。
  - 注册单结果 `readSubagent`，并纳入一步一个工具的执行闸门。
- `src/server/ai/agents/browser-chat.service.ts`
  - 增加 attempt 级所有权校验。
  - 不再忽略 `runSubagents` 收到的 abort signal。
  - 增加批次注册表，重复任务等待或复用原 Promise。
  - 回合中断时取消并清理对应批次。
  - 实现单 UUID 读取，并完整保存和返回子 Agent 总结。
- `src/server/ai/agents/browser-chat-subagents.ts`
  - 保留 `Promise.allSettled` 语义。
  - 明确批次结果顺序、失败分支和部分结果规则。
- `src/components/BrowserChatWorkspace.tsx`
  - 移除无真实 trace/result 工具的 fallback 正常渲染。
  - 将每条真实单结果读取 trace 渲染为对应位置的可展开胶囊。
- 浏览器聊天会话类型文件
  - 增加 `attemptId`、批次注册和完整结果引用类型。

## 4. 快照分页与 UID 生命周期

### 4.1 分离两种状态

当前代码把“能否继续读旧文本”和“旧 UID 能否操作”混为一谈。修改后必须分成两个 generation：

```ts
type SnapshotContentGeneration = {
  id: string;
  mode: 'full' | 'text';
  lines: string[];
  capturedUrl: string;
  capturedNavigationSequence: number;
  coverage: SnapshotCoverage;
};

type LiveUidGeneration = {
  id: string;
  page: Page;
  url: string;
  navigationSequence: number;
  references: Map<string, DomNodeReference>;
  stale: boolean;
};
```

- `SnapshotContentGeneration` 是冻结的只读内容，cursor 始终可以继续分页读取。
- `LiveUidGeneration` 表示 UID 的实时可操作性，页面变化后可以失效。
- 文本继续可读不代表旧 UID 仍可点击。

### 4.2 Cursor 行为

读取 `nextCursor` 时：

1. 只校验 cursor 格式、snapshot id、mode 和索引。
2. 直接从冻结的 `record.lines` 返回下一页。
3. 不调用 `readDomChanges()`，不消费 mutation queue。
4. 如果当前页面或导航已经变化，仍允许返回冻结文本，但同时返回：

```json
{
  "liveState": "stale",
  "uidsUsable": false,
  "staleReason": "navigation-or-document-changed"
}
```

5. 模型如需执行 UID 操作，必须重新建立新快照 baseline。

### 4.3 `searchSnapshot` 行为

- `searchSnapshot` 只搜索指定的冻结 `SnapshotContentGeneration`。
- 搜索不得调用或消费 `readDomChanges()`。
- 搜索结果必须携带 `snapshotId` 和 `uidsUsable`。
- 如果搜索的是旧 generation，允许返回文本匹配，但不得把其中 UID 标记为可执行。

### 4.4 增量变化

`mode="changes"` 继续作为独立的交互间日志，但调整字段命名：

- `overflow` 改为 `mutationQueueOverflow`。
- 工具描述明确说明：该字段表示 MutationObserver 队列容量不足，与页面高度、视窗、快照分页和“页面下方是否还有内容”无关。
- 读取 changes 是否消费队列必须只有一种明确语义；建议使用带序号的持久 journal 和 cursor，避免不同工具互相消费状态。

### 4.5 需要修改的文件

- `src/server/browser/browser-session.ts`
  - cursor 分页不再读取 DOM changes。
  - 分离冻结内容 generation 与实时 UID generation。
  - `searchSnapshot` 不再消费变化队列。
  - 返回 `snapshotId`、`uidsUsable`、`liveState` 和覆盖信息。
- `src/server/ai/agents/runtime-observation.ts`
  - stale 只约束 UID 操作，不阻断冻结文本分页。
  - 移除与 cursor 内容读取重复的 generation 状态。
- `src/server/ai/agents/browser-chat-executor.agent.ts`
  - 将新增的状态字段完整返回模型。

## 5. `text`、`full` 与 iframe 统一语义

### 5.1 模式定义

| 模式 | 数据范围 | 输出格式 | UID |
|---|---|---|---|
| `full` | 当前已加载的整页 DOM，以及所有可读取的 attached iframe | 有层级的语义 DOM | 包含 |
| `text` | 与 `full` 相同的整页和 iframe 数据范围 | 去重后的纯文本阅读视图 | 不作为操作依据 |
| `changes` | 交互间 DOM 与请求 journal | 变化记录 | 不包含可操作 UID |

`text` 不再使用 `scope: "visible"`。推荐一次采集同时构建 `full` 和 `text` 两个 view，避免分别遍历页面产生不同 generation。

### 5.2 iframe

- 使用 `activePage.frames()` 遍历所有已挂载且可读取的 frame，不以 iframe 是否与当前视窗相交为条件。
- 每个 frame 输出边界、URL、frame path 和读取状态。
- frame 读取失败不能静默丢弃，必须增加到 `skippedFrames`，包含失败原因。
- 同域与跨域 iframe 使用相同结果协议。
- 隐藏 iframe 是否读取采用统一产品规则；默认跳过 `display:none`/`hidden` 子树，并在覆盖元数据中计数。

### 5.3 覆盖信息

每次新快照必须返回：

```ts
type SnapshotCoverage = {
  scope: 'loaded-dom';
  frameCount: number;
  skippedFrames: Array<{ frameUrl?: string; reason: string }>;
  elementCount: number;
  charCount: number;
  truncated: boolean;
  truncationReason?: 'element-limit' | 'char-limit' | 'frame-limit';
  virtualizedContentPossible: boolean;
};
```

规则：

- 10,000 元素或 1,000,000 字符等安全上限可以保留，但达到上限必须设置 `truncated=true`。
- 预采集阶段不能静默丢数据后再把剩余部分包装成“完整分页”。
- `nextCursor` 只表示同一冻结快照仍有字符页，不代表需要滚动。
- `truncated=true`、`skippedFrames.length > 0` 或 `nextCursor` 尚未消费完时，模型不得声称“已读取完整页面”。
- `full/text` 只负责 DOM 语义。图片像素、图表、canvas 和原型视觉内容必须通过截图或专门的图片分析流程补充，不能从 DOM 文本结果推断。

### 5.4 需要修改的文件

- `src/server/browser/browser-session.ts`
  - `text` 改为 full scope。
  - 同一次采集构建 full/text。
  - 统一整页 iframe 遍历。
  - 增加覆盖与截断元数据。
- `src/server/ai/agents/browser-chat-executor.agent.ts`
  - 修改 `takeSnapshot` schema 和工具描述。
- `src/server/ai/agents/target-executor.agent.ts`
  - 与浏览器聊天保持相同模式定义。
- `docs/BROWSER_SNAPSHOT_ARCHITECTURE.md`
  - 实施后更新或替换旧 CDP 主路径描述，避免继续误导维护者。

## 6. 提示词与滚动策略

### 6.1 快照规则

系统提示词必须明确包含：

```text
- full 和 text 都覆盖当前已加载的整页 DOM 与全部可读取 iframe。
- nextCursor 是同一冻结快照的字符分页；必须使用相同 mode 和原 cursor 继续读取。
- 不得通过滚动获取 snapshot 的下一页。
- mutationQueueOverflow 只表示 DOM 变化队列溢出，不表示页面下方还有内容。
- 只有确认目标内容尚未进入 DOM，并识别到 lazy-loaded、virtualized 或 infinite-scroll 容器时，才能滚动。
- 在所有 nextCursor 消费完成、truncated=false 且 skippedFrames 为空前，不得报告“完整读取”。
```

### 6.2 子 Agent 委托规则

主 Agent生成子任务时：

- 不得默认写“滚动到底部获取完整内容”。
- 默认写“先读取 full/text 并消费全部 nextCursor”。
- 只有上游证据明确指出虚拟列表或懒加载，才把滚动写入子任务。
- 子任务必须说明完成条件，例如“所有 cursor 已消费”“所有指定 tab 已读取”“iframe/图片失败必须列出”。
- 子 Agent 的最终总结必须区分已验证事实、未读取区域、失败原因和剩余工作。

### 6.3 需要修改的文件

- `src/server/ai/agents/runtime-prompt-rules.ts`
- `src/server/ai/prompts/runtime-agent.prompt.ts`
- `src/server/ai/agents/browser-chat-executor.agent.ts`
- `src/server/ai/agents/target-executor.agent.ts`
- `src/server/ai/agents/browser-chat.service.ts` 中的子 Agent 固定指令模板

## 7. 浏览器进程池与后台页面执行

### 7.1 当前实现为什么会卡

当前子 Agent 在 `browser-chat.service.ts` 中使用 `headless: true, isolated: true` 创建 `BrowserSession`。其中 `isolated: true` 会绕过现有的 `sharedBrowserState/acquireSharedBrowser`，强制每个子 Agent 启动独立 Playwright Chromium。四个会话各自并发四个子 Agent 时，理论上会额外出现十六个无头浏览器进程；即使每个任务只开一页，也会重复承担浏览器主进程、网络进程和基础渲染进程的成本。

Playwright 的 DOM、locator、`page.evaluate`、网络监听和截图并不要求页面是操作系统前台标签。当前限制来自应用把目标组织成 `activePage`，以及初始化、弹窗认领、切换标签等路径频繁调用 `bringToFront()`，不是浏览器自动化本身必须前台执行。

### 7.2 目标架构

采用“少量浏览器进程 + 会话 Context + 子 Agent Page 租约”，不再采用“一个子 Agent 一个浏览器进程”：

```text
BrowserProcessPool（按标准化 userId 分区，缺省 userId="0"）
  ├─ foreground process / Electron CDP
  │    ├─ conversation A visible page
  │    └─ conversation B visible page
  └─ background Chromium process（默认 1 个，可配置最多 2 个）
       ├─ context A（由会话 A 的 storageState 初始化）
       │    ├─ page lease A-1 -> child Agent 1
       │    ├─ page lease A-2 -> child Agent 2
       │    └─ page lease A-3 -> child Agent 3
       └─ context B（由会话 B 的 storageState 初始化）
            └─ page lease B-1 -> child Agent 1
```

核心对象：

```ts
type BrowserContextLease = {
  contextId: string;
  conversationId: string;
  context: BrowserContext;
  authRevision: string;
  release(): Promise<void>;
};

type BrowserPageGroupLease = {
  leaseId: string;
  userId: string;
  conversationId: string;
  subagentUuid: string;
  pages: Set<Page>;
  activePage: Page;
  visibility: 'background' | 'foreground';
  release(): Promise<void>;
};
```

同一 `userId` 共享浏览器进程与登录 Context，不同 `userId` 使用不同 runtime/partition；缺失、空字符串和数字 `0` 统一归一化为字符串 `"0"`，会话归属必须严格比较，不得把缺失 ID 当成跨用户通配符。

`BrowserSession` 的权威目标改为注入的 `BrowserPageGroupLease`，一个 Agent 可以在自己的页面组中扩展多个标签页；所有 `takeSnapshot`、`mouse`、`keyboard`、`openPage`、`tab` 和弹窗认领都只在该租约拥有的页面集合中工作。Agent 默认不得操作其他 Agent 的页面组；用户切换可见会话或前台标签时，不得改变子 Agent 的目标页面。

### 7.3 Context 与登录态策略

推荐使用混合隔离，而不是所有任务无条件共享同一个 Context：

- 只读需求调研、PRD/Axure/Wiki 分析：同一会话的子 Agent 共享一个后台 Context，每个子 Agent 独享 Page。这样 cookies、localStorage 和登录状态可直接共享，资源开销最低。
- 会写数据、会退出登录、会切换账号或可能相互污染的测试：在同一个后台 Chromium 进程中创建独立 Context，并使用主会话导出的 `storageState` 初始化。隔离的是 Context，不再额外启动浏览器进程。
- 主会话登录态变化后，为其生成新的 `authRevision`。新租约使用新的 storage state；旧任务继续使用启动时的 revision，不在任务中途替换 Context。
- `storageState` 能复制 cookie、localStorage 和 IndexedDB，但不能复制内存变量、页面 JS 状态、已建立的 WebSocket 或临时设备验证。遇到这类登录依赖时，应把任务留在同会话共享 Context，或明确转入一次人工校验流程。

同 Context 的并发副作用必须明确：登出、刷新 token、修改同源 localStorage、服务工作线程和单会话互踢都会影响兄弟页面。因此任务创建时增加：

```ts
isolation: 'shared-readonly-context' | 'isolated-context'
```

默认由调度器根据工具权限选择；只要子任务允许写操作，就使用 `isolated-context`。

### 7.4 后台页面规则

- 后台 Page 创建、导航、点击、输入、截图和弹窗处理均不得调用 `bringToFront()`。
- `activePage` 只表示该 Agent 页面组内部的当前页，不表示用户可见标签；建议重命名为 `ownedActivePage` 或直接由 `pageLease` 解析，避免继续混淆。
- 新窗口和 `target=_blank` 页面只有 opener 属于当前租约时才能被认领，并加入同一子 Agent 的页面组。
- `tab(action=list/switch)` 只列出和切换该租约拥有的页面，不扫描其他会话或其他子 Agent 的标签。
- 只有“等待人工校验”“用户主动查看子 Agent 页面”或需要可见调试时，才调用 `promotePageLease(leaseId)` 把后台页临时挂到可见 BrowserView；该操作只改变展示层，不改变所有权。
- 子 Agent 完成或取消后立即关闭其 Page；Context 没有活动租约时进入短暂空闲期，超时后关闭。后台 Chromium 在整个应用无租约时再关闭。

### 7.5 并发与背压

并行 Agent 数量和浏览器并发数分开控制。模型仍可一次委托多个独立任务，但浏览器调度器必须设置资源上限：

```text
AI_SUBAGENT_MAX_CONCURRENCY = 6
BROWSER_WORKER_PROCESS_LIMIT = 1
BROWSER_WORKER_CONTEXT_LIMIT = 4
BROWSER_WORKER_PAGE_LIMIT = 6
BROWSER_WORKER_PAGES_PER_ORIGIN = 3
```

超过上限的任务保持 `queued`，不提前创建浏览器。队列按会话轮转，避免一个复杂会话占满全部页面；取消会话时同时移除尚未获取租约的任务。前端要区分 `queued / running / completed / failed`，不能把排队显示为正在操作浏览器。

### 7.6 落地边界

- 复用现有共享浏览器能力的进程复用思想，但不要直接让所有子 Agent 共享当前单例 `sharedBrowserState.context`。进程池必须允许在同一 Browser 中创建多个 Context。
- 移除子 Agent 路径的 `isolated: true`；改为显式向池申请 Context/Page 租约。
- 主对话可见浏览器与后台 Worker 可以先保持两个进程：一个负责 Electron 可见页面，一个负责全部子 Agent。这样已经能把进程数从“随子任务线性增长”降到常数，同时不让后台操作抢占用户前台标签。
- 后续如 Electron CDP 允许稳定创建不可见 BrowserContext，再评估合并为一个进程；第一阶段不应为了少一个进程牺牲会话隔离和可见页面稳定性。

需要修改：

- `src/server/browser/browser-session.ts`：支持外部 Page/Context 租约、后台可见性策略、按租约认领 popup，并移除后台路径的 `bringToFront()`。
- 新增 `src/server/browser/browser-process-pool.ts`：管理进程、Context、Page、并发信号量、空闲回收和会话公平队列。
- `src/server/ai/agents/browser-chat.service.ts`：子 Agent 从池申请租约，按任务权限选择共享只读 Context或独立 Context，并在终态释放。
- 会话/子 Agent 类型：持久化 `leaseId` 仅用于运行期追踪；恢复历史会话时不得尝试恢复已经失效的内存租约。

## 8. 前端与持久化要求

本次后端修复不能依赖前端临时状态：

- 子 Agent 批次、任务状态、最终总结和失败部分结果必须持久化。
- 前端只渲染归属于对应 `spawnSubagents` tool call 的批次。
- attempt 重试不能创建第二套重复卡片或把旧 attempt 事件挂到新工具下。
- 会话完成后重新加载页面，仍应从持久化数据还原全部子 Agent 及其工具记录。
- `running`、`passed`、`failed`、`blocked` 必须来自后端终态，不能通过“主消息是否结束”推断。
- 完整结果弹窗读取 `fullResultId` 对应内容；主消息区域只显示子 Agent 自身总结，不重复渲染到主 Agent 文本流。

可能涉及：

- 浏览器聊天事件归并与持久化代码；
- 子 Agent 工具胶囊组件；
- 工具详情弹窗；
- 会话恢复时的日志到视图模型转换。

## 9. 测试方案

不运行 `dev` 或 `build`。实现后使用定向单元测试、类型检查和静态检查。

### 9.1 子 Agent

1. 两个 deferred 子任务：任一未结束时，主 Agent不能进入下一模型步骤。
2. 一个通过、一个失败：兄弟任务继续，聚合结果同时包含通过总结和失败部分内容。
3. 批次运行期间触发 Agent Loop 超时：不得出现第二个活动 attempt，不得执行新的浏览器工具。
4. 相同任务重复委托：第二次调用等待并返回原 Promise 结果。
5. 先完成的第二个任务与后完成的第一个任务：最终结果仍按原任务顺序排列。
6. 聚合内容超过上下文预算：每个分支仍有状态和总结，不允许尾部分支完全消失。
7. 用户中断：所有子 Agent 收到 abort，批次进入终态，旧事件不再写入会话。
8. 连续读取四个 UUID：必须经过四个模型步骤，每一步只产生一条真实 `readSubagent` trace 和一个对应胶囊。
9. 模型在一步中生成多个读取调用：只有第一个真实执行，没有 trace/result 的调用不进入正常工具渲染。
10. 配置建议长度为 40,000，而子 Agent 返回 50,001 字符：后端完整保存并返回 50,001 字符，`summaryTruncated=false`。
11. 一个失败子 Agent 已产生部分总结：单结果读取仍返回其完整有效部分、`status=failed` 和错误信息。

### 9.2 浏览器进程池与后台页面

1. 同时启动六个只读子 Agent：只创建一个后台 Chromium 进程、一个会话 Context 和六个 Page，不出现六个浏览器进程。
2. 同时启动两个写任务：在同一后台 Chromium 中创建两个独立 Context，cookie/localStorage 修改互不影响。
3. 子 Agent 在后台导航和点击时切换主界面会话、前台标签：子 Agent 始终操作原 `pageLease`，不得跳到用户当前可见页。
4. 后台页面打开 popup：只由 opener 对应的租约认领，其他 Agent 的 `tab(list)` 不可见。
5. 页面数达到上限后新任务进入 `queued`；任一 Page 释放后按会话公平策略启动下一个任务。
6. 取消排队任务：不创建 Page；取消运行中任务：关闭 Page 并释放计数，不影响同进程其他 Context。
7. 同 Context 只读任务共享登录态；独立 Context 任务使用同一 `authRevision` 初始化，但运行期状态互不污染。
8. 触发人工校验时仅目标 Page 被临时提升为可见；校验完成后可回到后台，Agent 所有权不变。

### 9.3 快照分页

1. 读取 page 1 后触发无关异步 DOM mutation：page 2 仍可读取冻结内容。
2. 读取 page 1 后发生导航：后续文本仍可读取，但 `uidsUsable=false`。
3. 分页之间调用 `searchSnapshot`：不得消费 mutation queue 或改变 cursor 有效性。
4. 真正使用旧 UID 操作：必须被拒绝并要求新 baseline。
5. 达到元素/字符上限：返回 `truncated=true` 和明确原因。
6. 所有分页结束后：`nextCursor` 为空，页数和总条目一致。

### 9.4 text/full/iframe

1. 视窗外普通文本必须出现在 `text`。
2. 视窗外 iframe 文本必须出现在 `text` 和 `full`。
3. 可读取跨域 iframe 内容必须带 frame 边界返回。
4. 隐藏 iframe 按统一规则跳过并计入覆盖信息。
5. frame 读取失败必须进入 `skippedFrames`，不能静默成功。
6. `text` 和 `full` 来自同一 snapshot id，文本范围一致。
7. 虚拟列表未创建内容不得伪装成已读取；覆盖信息或页面信号要能提示模型可能需要滚动。

### 9.5 提示词

1. 快照工具描述明确 text/full 都是整页已加载 DOM。
2. 提示词明确 cursor 分页与滚动无关。
3. 提示词中不存在把 `overflow` 解释为页面剩余内容的表述。
4. 默认子任务模板不包含“滚动到底部”。
5. 只有提供虚拟列表或懒加载证据时，模型才允许生成 scroll 调用。

## 10. 验收标准

- 子 Agent 运行期间，数据库日志中不存在主 Agent 的后续工具调用。
- 所有子 Agent 终态产生后，恰好生成一次聚合工具结果，并进入发起委托的同一 attempt。
- 四个子 Agent 的结果通过四个后续模型步骤逐个读取；界面不存在“只执行一个却显示四个已读取/执行中卡片”的情况。
- 子 Agent 总结建议长度来自配置，后端不会截断超过建议长度的有效内容。
- 任一分支失败不影响兄弟分支，失败分支的部分结果可被主 Agent读取。
- 重复委托不会得到空结果，也不会创建重复批次。
- 主模型上下文中每个子 Agent 至少保留标题、状态、总结和错误/部分结果标记。
- 普通页面后台 DOM 更新不会使冻结快照的下一页突然失败。
- `searchSnapshot` 调用顺序不影响 cursor。
- `text` 能读取视窗外正文和视窗外 iframe；`full` 与 `text` 覆盖同一已加载页面范围。
- 模型不会再因为 `mutationQueueOverflow` 或存在下一字符页而滚动页面。
- 未消费完 cursor、发生截断或跳过 frame 时，最终回答明确说明内容不完整。
- 需求/PRD 分析只有在页面、关联文档、iframe、图片证据和所有分页均处理完成后，才允许报告“分析完成”。
- 并发子 Agent 数量增加时，后台 Chromium 进程数保持在配置上限；切换会话或可见标签不会改变任何运行中子 Agent 的 Page 目标。

## 11. 实施顺序

1. 修复 attempt 生命周期、abort 传播和重复批次复用，先消除主/子 Agent 真并发。
2. 实现单条 `readSubagent` 逐个读取、配置驱动的模型篇幅建议和完整结果回传，保证结果真正返回主 Agent。
3. 修复前端工具事实渲染和事件归属，禁止 fallback 伪造执行状态，并保证会话恢复后位置不变。
4. 建立后台浏览器进程池、Context/Page 租约和并发背压，再把子 Agent 从 `isolated: true` 迁移到租约路径。
5. 分离冻结快照内容与实时 UID generation，修复 cursor 和 `searchSnapshot`。
6. 统一 `text/full` 整页及 iframe 语义，增加覆盖元数据。
7. 修改工具描述、系统提示词和子任务模板，移除错误滚动策略。
8. 补齐定向测试，并同步更新快照架构文档。

上述步骤必须按顺序实施。第一、二步完成前，不应继续依赖当前子 Agent 结果做自动化测试结论；第五、六步完成前，不应把快照输出称为完整页面内容。
