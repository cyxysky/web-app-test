# CDP DOMSnapshot / Accessibility Tree 改造方案

## 1. 目标

将 DOM 模式的 `getPageState` 从页面 JS 遍历 DOM，改为优先使用 Chrome DevTools Protocol 读取浏览器内部快照，减少页面上下文执行时间。

目标分工：

- 浏览器侧只负责采集原始快照。
- Node 后端负责解析、筛选、生成 `text` / `interactive` observation。
- 工具操作继续由 Node 后端发起，通过保存的节点定位信息回到浏览器执行。

## 2. 当前问题

当前慢点集中在 `readSimplifiedDomTreeMs`：

- `readMainFullDomSnapshotMs` 慢：主页面 DOM 由页面 JS 遍历。
- `readFrameFullDomSnapshotMs` 慢：iframe 逐帧读取成本高。
- 页面侧逻辑包含可见性、交互判断、文本提取、引用映射，采集阶段过重。

第 8 项要解决的是：减少页面 JS evaluate 内的遍历/判断，把更多工作交给 CDP 和 Node。

## 3. 新增数据结构

建议新增服务端类型，例如：

```ts
type CdpDomSnapshotNode = {
  nodeId: string;
  backendNodeId?: number;
  frameId?: string;
  frameUrl?: string;
  parentId?: string;
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  path?: string;
};

type CdpDomSnapshotResult = {
  nodes: CdpDomSnapshotNode[];
  stringsCount: number;
  documentCount: number;
  timings: Record<string, number>;
  skippedFrames?: Array<{ frameId?: string; url?: string; reason: string }>;
};
```

`nodeId` 是对模型暴露的稳定短 ID。`backendNodeId` 用于后续 CDP 解析真实节点。`path` 作为 fallback。

## 4. CDP 采集方案

在 `BrowserSession` 中新增方法：

- `readCdpDomSnapshot(options)`
- `readCdpAccessibilityTree(options)`
- `readCdpPageState(options)`

采集流程：

1. `const cdp = await context.newCDPSession(page)`
2. 调用 `DOMSnapshot.captureSnapshot`
3. 可选调用 `Accessibility.getFullAXTree`
4. Node 后端解码 CDP 返回的字符串表、节点表、属性表
5. 建立 `node_id -> backendNodeId/frameId/path` 映射

优先使用：

```ts
DOMSnapshot.captureSnapshot({
  computedStyles: [],
  includeDOMRects: false,
  includePaintOrder: false,
}
)
```

不要默认请求 computed styles 和 layout rect，避免重新引入重采集成本。

## 5. Node 后端解析方案

新增处理器，例如：

- `src/server/ai/agents/cdp-dom-observation-processor.ts`

职责：

- 将 CDP snapshot 解码成节点数组。
- 生成 `text` view。
- 根据 tag、role、attrs、AX tree 信息生成 `interactive` view。
- 存储 `node_id -> backendNodeId/frameId/path` 到 `BrowserSession`。

交互判断优先级：

1. AX role：button、link、textbox、checkbox、radio、combobox、tab、menuitem。
2. HTML tag：a、button、input、select、textarea、summary、option。
3. 属性：href、role、contenteditable、aria-haspopup、onclick。
4. 文本来源：AX name、aria-label、placeholder、title、textContent。

## 6. 工具操作定位方案

DOM 工具仍然保留：

- `clickDomNode`
- `fillDomNodes`
- `hoverDomNode`
- `doubleClickDomNode`
- `dragDomNode`
- `getDomNodeText`

定位优先级：

1. 使用 CDP `DOM.resolveNode({ backendNodeId })` 获取 objectId。
2. 转成 Playwright `ElementHandle` 后执行点击/输入。
3. 如果 CDP resolve 失败，fallback 到 `path/framePath`。
4. 如果节点 stale，提示模型重新 `getPageState`。

需要在 `BrowserSession` 中维护新的引用表：

```ts
private lastCdpDomNodeReferences = new Map<string, {
  id: string;
  backendNodeId?: number;
  frameId?: string;
  frameUrl?: string;
  path?: string;
  descriptor: string;
}>();
```

## 7. 兼容和降级策略

推荐保留三层降级：

1. 默认：CDP DOMSnapshot。
2. CDP 失败：现有 simplified DOM tree。
3. 极端情况：只读 `innerText`，并禁用 node 操作。

环境变量建议：

```bash
DOM_SNAPSHOT_SOURCE=cdp|runtime|text
CDP_DOM_INCLUDE_AX=true
CDP_DOM_FRAME_LIMIT=0
CDP_DOM_TIMEOUT_MS=3000
```

默认可以先设置：

```bash
DOM_SNAPSHOT_SOURCE=cdp
CDP_DOM_INCLUDE_AX=true
CDP_DOM_FRAME_LIMIT=0
```

即先只读主页面，iframe 后续按需打开。

## 8. 实施步骤

1. 新增 CDP snapshot 读取方法，不替换旧逻辑。
2. 新增 CDP snapshot 解码器和 observation processor。
3. 新增 `lastCdpDomNodeReferences` 引用表。
4. 修改 DOM 模式 `getPageState`：优先 CDP，失败回退旧 simplified DOM。
5. 修改 DOM node 工具：优先 backendNodeId 定位，失败回退 path。
6. 在日志中输出：
   - `readCdpDomSnapshotMs`
   - `decodeCdpSnapshotMs`
   - `readCdpAxTreeMs`
   - `processCdpObservationMs`
   - `resolveCdpNodeMs`
7. 对比同一页面三组耗时：
   - 当前 runtime DOM snapshot
   - CDP DOMSnapshot
   - CDP DOMSnapshot + AX Tree
8. 稳定后再考虑默认关闭 iframe 全量读取，改成按需读取指定 frame。

## 风险

- CDP snapshot 数据结构比 DOM HTML 更底层，解码复杂。
- `backendNodeId` 在页面变化后可能 stale，必须强制模型用 fresh `node_id`。
- AX Tree 对可交互语义更好，但可能缺少普通文本节点。
- 部分跨域 iframe 的节点定位需要单独 frame/session 处理。
- 如果开启 layout / computed styles，可能重新变慢。

## 预期收益

如果只读主 frame 且不采 computed styles，`getPageState` 的 DOM 采集阶段有机会从十几秒降到几秒以内。最大收益来自：

- 避免页面 JS 深度遍历。
- 避免默认读取 iframe。
- 避免浏览器端可见性/交互判断。
- Node 后端集中解析和缓存。
