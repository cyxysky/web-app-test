# Office 文件生成对话异常诊断与修改方案

## 1. 检查范围

本次重点检查了以下两个对话在数据库中的消息、模型步骤与工具调用：

- `chat_e26d2b322fed`
- `chat_cd13c4a14938`

数据来源包括：

- `runtime/.data/webpilot.db`
- 对话对应的文档草稿工作区与 revision 记录
- 文件工具调用结果、模型上下文快照和失败日志

检查时两个对话仍可能处于运行状态，因此调用总数等统计是检查时刻的快照，不代表最终值。

## 2. 上一轮异常结束后能否恢复草稿

### 结论

草稿文件通常仍然存在，但下一轮 AI **不一定知道应该继续哪个草稿**。

具体情况如下：

1. 同一对话中，已经完成的 `generate` 或 `edit` 会持久化到：
   - `runtime/artifacts/<sessionId>/document-drafts/<documentId>.json`
   - 对应的 `draft.mjs` 或 `draft.py`
   - revision 历史目录
2. 用户在 AI 思考阶段终止请求时，之前已经成功提交的草稿仍然保留。
3. 后端在验证或渲染过程中强制重启时，虽然存在 journal 恢复机制，但目前仍不能完全保证候选源码与最后一次已提交 revision 被严格区分。
4. 新建对话后，旧对话草稿受 session 隔离，不会自动成为新对话可编辑的草稿。

### 实际发现

在 `chat_cd13c4a14938` 中：

- 原草稿 ID 是 `ancient_egypt_ppt`，并且已有约 19 个 revision。
- 上一轮因供应商返回 `AccountQuotaExceeded`（HTTP 429）失败。
- 用户下一轮发送“继续”后，模型猜测草稿 ID 为 `egypt_history_ppt`。
- 读取失败后，模型又创建了新的 `egypt_ppt`，没有继续原草稿。
- 对应的 `modelContext.transcript` 快照为空。

### 根因

- `read` 必须提供准确的 `documentId`，但文件工具没有草稿列表入口。
- 每轮请求没有自动向模型注入当前 session 的草稿目录。
- 部分失败路径会使用空的 `result.modelMessages` 覆盖原有非空模型上下文。
- “继续”类请求没有可靠的任务恢复摘要，只能依赖模型自行回忆或猜测。

### 修改方案

1. 新增 `action=list`，返回当前 session 的草稿目录：
   - `documentId`
   - `documentType`
   - `fileName`
   - `revision`
   - `sourceDigest`
   - `renderedDigest`
   - `visualQaDigest`
   - 当前状态与最近操作时间
2. 每轮 AI 请求前自动注入精简版草稿目录，不依赖模型先调用 `list`。
3. 禁止用空的 `result.modelMessages` 覆盖已有上下文；持续保存最后一次有效的 `onModelMessages` checkpoint。
4. 每轮结束或异常终止时保存 continuation summary，至少包括：
   - 当前任务目标
   - 正在处理的 `documentId`
   - 当前 revision
   - 已完成内容
   - 未完成内容
   - 推荐的下一步工具调用
5. 将编辑过程区分为 `candidate source` 和 `committed source`：
   - 编辑先写入 candidate。
   - 语法检查、执行和必要验证通过后再提交 revision。
   - 中断或重启后丢弃未提交 candidate，恢复最后一次 committed source。

## 3. MiniMax 工具调用协议被直接显示

### 现象

界面中出现了类似以下原始内容：

```text
]<]minimax[>[<tool_call>...<action>plan</action>...
```

### 根因

该对话使用的是自定义 OpenAI 兼容供应商和 `MiniMax-M3` 模型。当前通用 OpenAI-compatible 适配器只识别标准 `tool_calls` 字段；当模型返回 MiniMax 私有文本工具协议时，适配器没有解析它，而是将其作为普通 assistant text 流式发送到了前端。

内置 MiniMax 适配逻辑只会在供应商类型明确为 `minimax` 时启用，自定义 OpenAI-compatible 供应商不会自动进入这条分支。

### 修改方案

1. 根据模型名、供应商配置或 base URL 识别 MiniMax，并让自定义兼容供应商复用 MiniMax 协议适配器。
2. 增加流式状态机解析器：
   - 识别 MiniMax 工具调用起始标记。
   - 在工具调用结构完整前只缓存，不向用户输出。
   - 将完整私有协议转换为系统内部的标准 tool call。
3. 私有协议不完整或解析失败时：
   - 不把原始标签展示给用户。
   - 记录结构化协议错误。
   - 自动发起一次“仅使用标准工具调用格式”的协议纠正重试。
4. 在渲染层增加最后一道保护，过滤 `<tool_call>`、`]<]minimax[>` 等协议片段。
5. 转换后的工具参数必须继续经过既有 Zod schema 校验，不能直接执行解析出的任意参数。

## 4. 两个对话中发现的主要文件工具问题

| 问题 | 现场表现 | 根因 | 修改方向 |
| --- | --- | --- | --- |
| 异常后找不到原草稿 | 模型猜错 `documentId` 后新建文件 | 没有草稿目录与恢复摘要 | 增加 `action=list`、自动注入草稿目录与 continuation summary |
| 图片下载失败风暴 | 单个对话出现大量成功与失败下载，主要为 429 | 每个调用独立重试，没有域名级冷却 | 增加共享域名限流器，遵守 `Retry-After`，首次 429 后暂停该域名 |
| 图片尺寸逐个读取 | 为大量素材分别调用读取工具 | `plan/listAssets` 未批量返回尺寸和宽高比，格式化器丢弃细节 | 在资产清单中批量返回宽、高、比例、格式和体积 |
| 编辑失败级联 | 两个对话均出现多次连续编辑失败 | 失败编辑曾污染当前 draft，后续继续基于坏源码编辑 | 使用事务式 candidate/commit/rollback；失败不得推进 revision |
| 失败调用显示成功文案 | 旧日志中失败结果仍显示“Office source validated” | 结果格式化使用固定成功文案 | 根据真实状态生成标题、摘要和颜色 |
| JS cookbook 信息不足 | 模型反复写错 URL 编码资源、表格、二进制与形状常量 | 示例未覆盖真实高频场景 | 补全 `ShapeType`、图片、表格、分页、PDF、二进制输入示例 |
| `ArrayBuffer` 写入失败 | `writeOutput` 无法处理部分 JS 库返回值 | worker 只接受有限二进制类型 | 统一规范化 `Buffer`、`ArrayBuffer`、`TypedArray` |
| 反复整份重建 | 模型在已有草稿时仍创建新文件或完整替换 | 恢复时没有注入当前草稿状态 | 默认继续 `read/edit/restore`，仅明确新建时调用 `generate` |
| 截图版本过期 | visual QA 基于旧 render，被后续编辑作废 | source、render 和 QA digest 未统一约束 | 返回最新 artifact 状态，并提示立即 render；旧 QA 不得用于成功结论 |
| 多个 artifact 的 QA 状态混淆 | PPT、DOC、PDF 的页数与 QA 结果交叉 | 状态没有按 document/artifact/digest 隔离 | QA 状态按三者建立复合键，新 render 清空旧 QA |
| PDF 修改链路不明确 | 生成的 DOCX 不能直接作为 `sourceAttachment` 修改 PDF | “修改源文件”和“格式转换”混为一套 plan | 增加 `action=convert` 或 `sourceArtifactId`，避免重新创作内容 |
| 上下文快速增长 | 重复读取整份源码、堆栈和素材元数据 | 工具结果过长且缺少批量接口 | 压缩工具结果、批量返回素材信息、按范围读取源码 |

## 5. 为什么会在已经输出“最终交付”后继续执行

这不是正常的“最终文本之后继续补充”，而是运行状态机没有把 assistant 的终结文本视为不可逆的终止边界。

常见触发链路为：

1. 模型输出了看似最终交付的文字。
2. 同一个 agent run 中仍存在未完成的 QA gate、queued tool call 或自动续跑条件。
3. 后端继续推进下一模型步骤。
4. 后续工具又发现问题，于是出现“已经交付，但还在修改”的矛盾状态。

### 修改方案

1. 区分 `progress text` 和 `final response`，只有状态机进入 terminal state 后才能发布最终回答。
2. 最终回答发送前统一检查：
   - 没有 running/queued tool call。
   - 没有未完成的文档任务。
   - 当前源码已成功 render。
   - `visualQaDigest === renderedDigest`。
   - 必须检查的页面均已读取。
3. 一旦 final response 已提交，服务端必须拒绝同一 run 再启动新模型步骤。
4. 如果最终门控失败，只允许输出进度说明，不能输出“全部完成”“最终交付”等终结措辞。
5. 用户主动终止后，将 run 标记为 `cancelled`，清理队列并持久化 continuation summary，下一轮由新 run 恢复。

## 6. 工具并发限制问题

旧逻辑只允许一个浏览器工具在同一模型步骤执行，因此会出现：

```text
Ignored: only one browser tool can execute in model step ...
```

建议移除“整步只能有一个浏览器工具”的硬限制，替换为更细的调度规则：

- 只读、互不依赖的浏览器调用允许并发。
- 会改变当前页面状态的调用按照 tab/session 串行化。
- 同一 tab 的 `navigate`、`click`、`type` 等保持顺序执行。
- 不同 tab 的只读提取和截图允许并发。
- 不再静默忽略工具；无法并发时排队，并向模型返回实际排队状态。

## 7. 当前修复状态

此前已经完成或已进入代码的改动包括：

- 编辑验证失败时事务回滚，不再保留失败源码。
- 文件工具失败时显示准确的失败文案。
- 新源码产生后使旧 visual QA 失效。
- 统一使用 `previewPages` 等明确字段表达预览页。
- 扩展 JS cookbook，覆盖素材、图片、表格、分页和 PDF 场景。
- 增加单次运行内的下载缓存、去重和重试。
- 修复执行中工具条目的额外 padding。

仍建议继续完成以下内容。

### P0：必须优先处理

1. 草稿目录 `action=list` 与每轮自动注入。
2. 空模型结果不得覆盖有效上下文。
3. continuation summary 持久化与恢复。
4. MiniMax 私有工具协议解析和前端过滤。
5. candidate/committed source 的持久化隔离。
6. final response 的服务端终止门控。

### P1：高价值优化

1. 下载域名级限流和 `Retry-After` 冷却。
2. 素材尺寸与宽高比批量读取。
3. JS worker 二进制类型统一规范化。
4. 增加明确的 `convert` 流程。
5. stale screenshot 失败时直接返回最新 artifact 和下一步提示。
6. QA 状态按 document、artifact 和 digest 隔离。

### P2：进一步增强

1. UNO/JS 统一 AST 静态检查器。
2. 字体可用性预检与替代字体建议。
3. 图片解码、格式、体积和色彩空间预处理。
4. 页面级增量生成和单页验证。
5. QA 面板明确显示已检查页、未检查页及对应 digest。

## 8. 验收标准

完成修复后，应至少满足以下条件：

1. 用户中止或后端重启后，下一轮能列出并读取同一 `documentId` 的最后一次已提交 revision。
2. 页面中永远不会显示 MiniMax 私有工具标签或半截工具调用协议。
3. 编辑检查失败时，revision、当前源码和 rendered artifact 均不发生变化。
4. 同一下载域名首次返回 429 后立即进入共享冷却，不再产生连续失败风暴。
5. 新 render 会使旧 QA 明确失效；只有当前 digest 的所有必检页完成后才允许声明通过。
6. 最终回答发出后，同一 run 不得继续请求模型或执行工具。
7. DOCX/PPTX 到 PDF 的需求通过转换动作完成，不要求模型重新生成一份内容。
8. 恢复任务时默认继续已有草稿，不因读取 ID 失败而擅自新建替代文档。

## 9. 涉及的主要代码区域

后续实现与复核时，应重点关注以下模块：

- `src/server/ai/agents/file-artifact-tools.ts`
- AI run 状态机与模型上下文持久化模块
- OpenAI-compatible 与 MiniMax provider adapter
- 文件工具结果格式化与聊天时间线渲染模块
- JS/UNO 文档 worker 与 visual QA 状态管理模块
- 下载工具的缓存、去重、重试和域名限流模块

