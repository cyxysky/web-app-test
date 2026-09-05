# File 包工具链复盘（2026-09-05）

## 结论与范围

这次失败不是源码又坏了，也不是 LibreOffice 又无法渲染：模型把文件名 UNO 中的字母 O 写成了数字 0。工具正确拒绝了错误文件身份，却错误地解释成“源码版本过期”。

更大的问题是：参数约束、实际执行、返回摘要、图片传输、检查状态和最终交付之间还没有一份共同的、可验证的契约。只增加提示词不能解决状态丢失、错误分类错误和校验缺口。

本轮覆盖全部 14 个对外 action：list、readSource、readContent、download、convert、plan、generate、edit、unoApi、jsApi、render、visualIndex、visualRead、visualReport；并检查 schema、传输归一化、应用适配器、源码编辑、渲染缓存、视觉证据与模型结果摘要。另检查 read 兼容别名。

依据是当前工作树源码、目标对话的只读数据库记录、实际浏览器页面，以及无网络、无原稿写入的内存复现。不是所有 UNO 方法、导出格式与 Office 版本组合的穷举认证；下文明确区分“已复现”“记录证实”和“代码风险”。

本轮没有中断原对话，没有修改它的草稿，没有发送模型请求，没有运行 dev/build，没有新增持久化测试代码；仅新增本报告。先前已经完成的修复与本轮发现的待修问题分别列出。

## 一、截图中的失败：准确原因

对话：chat_4234b3b309b2，数据库 step_index=3，工具调用 49（数组下标 48）。

| 项目 | 实际值 |
| --- | --- |
| 正确文件名 | UNO 全能力视觉叙事.pptx |
| 调用 49 传入的文件名 | UN0 全能力视觉叙事.pptx |
| 不同字符 | O：U+004F；0：U+0030 |
| 两个路径中的源码 digest | 相同，85ef1c60…fd3c4a8 |
| 正确文件 | 本地存在 |
| 错误文件 | 本地不存在 |

workspace.ts:3827 的条件是：源码 digest 不同 **或者** 完整 artifactId 不同，就统一返回 stale-file-visual-artifact。它只展示两个相同的 digest，却不展示 expectedArtifactId，因此看起来像工具自相矛盾。

正确行为应是保留拒绝，但返回 ARTIFACT_ID_MISMATCH，说明“源版本相同，文件名不匹配”，并附上来自当前草稿记录的确切 expectedArtifactId 和可直接重试的参数。不能忽略文件名，也不能仅凭 digest 相同就接受任意路径。

此外，这次失败之前，调用 45–48 已经读完当前版本的 14 页；调用 49 本身也是重复读取。随后调用 50 首次提交完整报告，visualQa.complete 已为 true；仍继续调用 51 再提交、52–53 再读取、54 第三次提交。不是因为第一次报告没有落盘。

## 二、当前交付状态不能等同于“用户要求全部满足”

浏览器显示该轮已完成，当前元数据也是 14 页已读、14 页 passed、deckReview passed。但实际保存的 plan.intent 明确要求所有十种图表家族、形状动画、母版应用、自定义放映、标题至少 30pt、正文至少 17pt。

最终渲染记录显示：

| 要求/指标 | 当前证据 | 含义 |
| --- | --- | --- |
| 动画 | formatChecks.presentation.animationCount=0 | 未交付所要求的动画 |
| 自定义放映 | customShowCount=0 | 未交付自定义放映 |
| 母版应用 | 模型明确删除 14 处 apply_master；无对应 authored feature count | masterCount=1 只说明包里有一个母版，不等于完成了要求的母版应用 |
| 十种图表家族 | nativeChart=9；最终清单为九种，缺 scatter | 总数与家族覆盖不能混为一谈 |
| 字号下限 | 最终 deckReview 自述“正文≥12、标题≥17”仍 passed | 与 plan 的 17/30pt 要求冲突；报告被接受不证明实际字号满足要求 |
| 页码/备注/转场 | 不同计数分别来自作者调用、XML 与重开检查 | 不能将计数单位不同的数字当成同一个业务指标 |

因此，“能够打开、无已知几何错误、报告字段完整”不等于“全能力交付”。不能靠删除用户要求的功能或降低字号来获得完全通过。

## 三、问题清单与修正建议

优先级：P0＝错误写入或错误交付结论的风险；P1＝常见失败、误导或循环；P2＝一致性、可观测性与效率。不是安全漏洞等级。

### F01 · P1 · 文件身份错误被报成版本过期【记录证实】

位置：packages/capability-file/src/node/workspace.ts:3810–3843。

问题：完整路径不匹配和 source digest 过期共用一种错误。截图中的 O/0 错误因此被解释成源码变更。

建议：分别返回 ARTIFACT_ID_MISMATCH、SOURCE_REVISION_MISMATCH、ARTIFACT_NOT_FOUND、PUBLICATION_NOT_CURRENT；同时返回 supplied/expected identity、sourceRevisionMatches 和 nextAction。错误信息必须说出真正失败的条件。

验收：同 digest、不同文件名时绝不提示“源码过期”；正确 ID 仍可读；真正旧 digest 仍不能用于当前源码验收。

### F02 · P1 · 恢复入口没有完整的文件与 QA 身份【代码确认】

位置：workspace.ts:1150–1237（list），846–919（模型摘要），3263 附近（render 原始结果）。

问题：list 有 documentId、摘要和状态，却没有当前 renderedArtifactId/downloadUrl、完整未读/待评页面集合。render 的模型摘要又丢掉 documentId、sourceRead、workflow 等字段。模型只能从长路径和旧历史中重新抄写身份。

建议：list 返回 currentArtifact 的确切 ID、下载链接、只读恢复动作和 QA 缺口；为模型提供短的会话内 artifactRef，服务端绑定完整路径、文件字节与版本。兼容现有 artifactId，但不得用模糊文件名静默选文件。

### F03 · P1 · 精确 UNO 模块查询变成宽泛查询【46 个模块实测】

位置：runtime/python/libreoffice-program-worker.py:6523–6537。

问题：query 用正则拆词后，presentation.professional@1 被拆成模块名和数字 1。选择条件是“精确匹配 OR 任意词出现在说明中”，数字 1 会匹配大量其他模块。当前 16 个 presentation、15 个 writer、15 个 calc 的带版本精确 ID 都过度匹配。

实测：presentation.professional@1 返回 11 个模块、39 个 API 引用、12 组示例；原始 cookbook JSON 为 28,512 字符。这里是去除 moduleIndex/rules 之前的长度，不是模型 token 数。去掉版本号查询 presentation.professional 才只匹配一个模块。

建议：精确版本 ID 优先且立即结束匹配；其次匹配无版本 ID；最后才进入显式搜索模式，搜索只返回候选索引，不返回所有候选正文。版本数字不可作为搜索关键词。语法正确但版本不存在时，应返回 AVAILABLE_VERSIONS，不自动降级为全文搜索。

验收：46 个精确模块 ID 均只返回各自一个模块。此前 17 万 token 的完整增量仍需对应请求的文本、工具定义、图片和重复序列化分项核算，不能只凭这个缺陷认定全部来源。

### F04 · P1 · 已加载 API 仍重复全文返回；分页字段没有实际作用【代码确认】

位置：workspace.ts:2211–2277；worker.py:6543–6577。

问题：alreadyLoaded 只是布尔提示，仍返回完整正文；返回完整 documentType 的 valueSchemas；workspace 调用固定 limit=120，没有传入用户 offset/limit。jsApi 也不消费 query。大量无关正文继续占用上下文。

建议：按模块版本缓存，只返回当前方法依赖的 value schema；区分“服务器加载过”与“当前模型上下文仍持有”。提供明确的刷新/恢复方式，不能简单把 alreadyLoaded=true 的正文永远省掉，否则压缩后无法恢复。未支持的 query/offset/limit 应拒绝或不公开。

### F05 · P0 · 面向模型的摘要删掉执行真相【内存复现】

位置：workspace.ts:846–919；src/server/ai/agents/browser-chat-executor.agent.ts:490–537。

问题：原始结构化结果并不是模型最终收到的内容。formatFileArtifactResult 会把 plan/generate/edit/render 改成自然语言。

已复现：一个 validation=passed、editStatus=partial-patch-applied、第二个 hunk 冲突的结果，摘要只剩“Office source validated”。外层 ok=false 仍在，但 failedHunks、patchBaseDigest、具体冲突和恢复动作丢失，模型面对的是“失败 + 校验成功”的矛盾。plan 的 semanticGeneration/sourceDocument/instruction/reused 丢失；render 的 featureCounts/workflow/validationEvidence 也未被保留。

建议：UI 短摘要与模型结果分开。模型接收有预算的 JSON，但始终保留 identity、ok、saved、changed、editStatus、validation、scope、failedHunks、evidence、nextAction、requirementsCoverage。裁剪堆栈和重复示例，不裁剪决策字段。

### F06 · P1 · 错误结构、分类与展示仍有多套口径【代码确认】

位置：src/node/capability.ts:49–113；workspace.ts:4106–4154；src/server/capabilities/browser-chat-result.ts:40–68；runtime-skill.ts:32–45。

问题：有的 actual 是文本，有的是 JSON 文本；有的错误详情在 error.details，有的在 actual 中。structuredFileOperationResult 只识别顶层 code，许多真实错误只有 kind/diagnostics，于是只剩 file-edit-failed 这种动作级类别。失败适配还会把 message 作为主要返回，详情的结构没有稳定保证。

建议：统一版本化结果信封。error.code 表达原因，stage 表达失败阶段，retryable 表达能否原样重试；保留 data 与 evidence。仅在最终传输边界序列化一次。UI 的 JSON 标签不能代替真正的结构化数据。不要再要求模型递归解析 actual/summary/data。

### F07 · P1 · 源码路径失效时，读取会切换坐标空间【代码确认】

位置：workspace.ts:2092–2144、2170–2203。

问题：未知 path 配合 startLine/endLine，会忽略 path、改读全稿全局行号。调用方原本以为读的是某页内部第 1 行，实际读到全稿第 1 行。endLine 超出 EOF 可以合理裁剪，但 startLine 超出 EOF 也被压到最后一行。无显式范围的 unit 读又返回全局坐标，显式范围返回 unit 坐标。

建议：失效 path 返回 SOURCE_UNIT_NOT_FOUND 和候选路径，禁止自动切换作用域；startLine 越界明确拒绝；局部范围始终局部坐标，同时另给全局坐标。返回 requestedRange/returnedRange 和裁剪原因。

### F08 · P2 · 80 行上限不是 payload/token 上限【代码确认】

位置：workspace.ts:2133–2204；src/node/read.ts:165–220。

问题：超长单行代码、大数组以及无分页的 sourceUnits 索引仍能很大。readContent 每次先提取完整内容再截取文本窗口，分页并不一定减少解析成本。源码还没有直接按诊断/符号搜索的轻量入口。

建议：同时限制行数与字符预算，避免截断半个用于 patch 的字符串；长行提供明确的超预算提示或结构化数据单元导航。sourceUnits 分页；源码索引支持符号/elementId 定位；文本抽取按文件字节摘要缓存。结果说明是“未返回正文”还是“文件没有正文”。

### F09 · P1 · patch 的宽松匹配会改错重复位置【内存复现】

位置：workspace.ts:1798–1864、1952、2013、3584。

问题：patch 查找顺序是 exact、trimEnd、trim、Unicode-normalized，取第一个命中；没有唯一命中保证。实测两个函数含同一行 title='old'，缺少上下文的 patch 被接受并修改第一个函数。相同场景的 replacements 正确拒绝 OLD_TEXT_AMBIGUOUS。

此外，stale baseDigest 可进入自动 rebase，但 patch 路径仍可能使用宽松匹配；提示词却描述成“exact-context 安全重放”。

建议：源码编辑默认唯一精确匹配；Python 缩进修改使用 replacements。若保留模糊匹配，必须报告 matchMode、匹配位置、候选数，不能在旧 digest 上默默使用它。可控重放需匹配明确作用域和前后置内容。

### F10 · P1 · “保存、修改、验证、发布”没有统一的结果状态【记录与代码确认】

位置：workspace.ts:2871–2959、2964–3158、3670–3805；runtime-skill.ts:553–567。

问题：edit 可能只保存部分 hunk，可能保存完整源码但校验失败，也可能局部单元校验通过而全稿 pending。ok 一个布尔值无法表达这些区别；no-change 遇到已有失败状态也会是失败。模型容易重放已保存的 patch，或把局部成功当全稿成功。

建议：保留部分保存能力，但明确 operationStatus、mutationStatus、validationStatus、validationScope、publicationStatus。返回每个 hunk 的状态及“哪些已写入，不能重放”。源码变更默认不要触发每一次完整文档执行；提供明确的静态/单元/全文验证策略和依赖范围，最终发布前必须全文验证。

### F11 · P1 · API 示例与真实签名、参数语义仍需同源【历史确认；部分已修】

位置：worker.py:1956、2058、2635、4648、4665、6107、6151；src/runtime-skill.ts。

历史事实：示例使用 apply_master(index=0)、自定义放映 [0]、不存在的第四行 merge；animate 收到字符串后暴露 dict(string) 的底层 ValueError；模型继而删除本来支持的功能。set_text(value, style=None) 又被当作接收 font_size 关键字。

前几项已在先前修改中纠正，不应再次当成当前未修代码。剩余系统性问题是：签名、值域、示例、索引基准和错误修复提示散落多处。

建议：建立方法级契约，包含 receiver、参数类型、单位、索引基准、返回类型、supported/preserve-only/unsupported、导出边界、最小可运行示例。由同一契约生成索引、schema、说明与错误建议。不能把运行期 bad argument 解释成方法不存在。

### F12 · P1 · 错误归因应由运行时明确提供，不依赖模型读堆栈【部分已修；剩余风险】

位置：worker.py 的 document_attribute_error/main；src/node/office/program-analysis.ts；workspace.ts:720。

已修：字体属性信息 None 不再被直接当桥启动失败；新增 worker/source 归因和常见表格、动画、母版错误提示。

剩余：通用 ValueError/TypeError/导出错误等仍可能落入大类 UNO_RUNTIME_ERROR；worker 本身错误和作者参数错误不应只靠错误文本关键词分类。先解决启动故障，也不能据此保证后续 837 行源码正确。

建议：worker 返回 machine-readable origin=source|worker|bridge|export|validation、sourceLocation、methodContract、expected/received、retryPolicy。原始堆栈保留在详情，不混进“请修改源程序”通用建议。相同错误按 source+runtime+errorCode 记录已尝试的恢复，禁止无变化循环。

### F13 · P0 · 查询 API 会无锁重写整份草稿【代码风险；未对活跃文档触发竞态】

位置：workspace.ts:2211–2256、1239–1275；对比 4041–4096 的加锁操作。

问题：getUnoApi 为保存“模块已读”状态，loadDraft 后直接 saveDraft；saveDraft 实际重写 .py 和 JSON。这个入口没有 withDraftLock。若查询与其他入口的编辑/渲染交错，它可能把旧快照写回，覆盖新源码或发布/QA 状态。当前浏览器串行队列降低出现概率，但包还有其他宿主和调用入口。

建议：API 查询不写源码。模块阅读状态分离存储，或在同一锁内只合并小块元数据并做 revision CAS。还要注意 loadDraft:1129–1145 会把 rendering/validating 状态视作中断恢复并写盘；无锁的查询/列表入口不能在另一个操作仍执行时触发这种恢复。列目录也不应默默吞掉坏 sidecar：应报告不可用条目，防止模型以为文档消失后重新创建。

### F14 · P1 · 产物身份只包含源码 digest，不包含实际渲染版本【代码风险】

位置：workspace.ts:2644–2737、3185–3256、3810–3843。

问题：候选缓存正确考虑素材与运行时 fingerprint，但发布路径仍仅使用源码 digest。同一源码在素材/字体/worker 变化后可能产生不同字节，并覆盖同一个 artifactId。运行时会清除活动 QA，但历史工具结果、URL 与模型上下文中的身份仍相同。

建议：sourceRevision 与 artifactRevision 分开；产物使用不可变 publicationId 或字节 digest，关联 source/runtime/assets fingerprint。版本校验比较真正的发布版本；不要让同一链接在后台变成另一份内容。视觉读之前的检查与 QA 写盘不是一个事务，写盘锁内也必须重新核对当前源码版本，不能只检查 renderedArtifactId/renderedDigest，防止中间发生编辑后录入旧页面证据。

### F15 · P0 · 用户功能与设计要求没有完整的硬性验收【当前交付记录证实】

位置：workspace.ts:2577–2616、2798、3990–4004；目标对话的 plan/render/visualReport。

问题：硬性语义检查只覆盖 intent 中少数英文形状名称；没有覆盖所有 chart 家族、动画、自定义放映、必需内容、用户字号下限。视觉通过状态由模型填报。因此删除要求、降低标准后仍可完成。

建议：plan 固化 requirements：必需功能、数量/家族、数据不变量、内容范围、字号/颜色/页面规则、允许的兼容性降级。render 返回逐项 coverage，finalize 分别核对结构、功能、设计、视觉证据。未满足的要求只能显式报告未满足，不能以“布局好看”抵消。用户批准需求变更必须有单独记录。

### F16 · P0 · “已读页面”与“已给模型看见”并不等价【代码确认；有确定路径】

位置：workspace.ts:3901–3929；src/server/ai/agents/browser-chat-executor.agent.ts:2342–2369、2635–2675。

问题有三层：

1. 文件工具返回截图时，QA 就把页面记为 seen，早于模型图片读取和请求构造。
2. readScreenshotForAi 失败会 catch 后忽略，工具仍已成功、页面仍 seen。
3. queuedReferenceImageKeys 在整轮内永久去重，而旧图片消息每个后续请求又会被移除。再次 visualRead 同一路径时可能完全不附图，却继续返回“下一请求已附加截图”。

这不是节省图片 token 的正确边界。未复现外部模型实际接收失败，但代码路径足以证明“工具已读”不能当成“当前请求已有图片”。

建议：分别记录 previewGenerated、imageLoaded、imageAttachedToRequest、reviewed；以实际 requestId + artifactRevision + screenshotDigest 关联证据。去重依据当前待发送/保留的模型上下文，而不是整轮永久集合；失去图片上下文后的明确重读应重新附图。附图失败必须可见，不能标记看过。

### F17 · P1 · 图片消息缺少逐图页码与内容身份【代码确认；对话出现错页描述】

位置：executor.agent.ts:1475–1486、2359–2369、2635–2647；src/node/read.ts:369–397。

问题：虽然入队 source 曾带 screenshotId，最终图片消息只保留一段通用“latest visualRead”提示，再跟一组图片；没有给每张图插入对应 artifact/page/screenshotId 标签。多个工具批次可合并到同一段通用提示。该对话把第 10 页 Diamond 多次说成第 8 页，最终 deckReview 也保留错页描述。

建议：每张图片前附不可混淆的短标签：artifactRef、revision、screenshotId、pageNumber、标题/工作表名；工具结果与图片消息来自同一映射。页面标题是导航信息，不能代替实际看图。归因不能武断地说所有错页都由传输导致，模型自身也可能读错。

### F18 · P1 · 完成状态与下一步指令相互冲突，诱发重复循环【记录证实】

位置：src/node/read.ts:310–326；workspace.ts:4007–4025；目标调用 50–54。

问题：完整视觉报告已 complete=true，结果仍带“继续读取/报告，最后提交 deckReview”。recordOfficeVisualQaProgress 原样保留下层 instruction。重复 visualReport/visualRead 没有操作级幂等反馈，也没有明确的终止动作。

建议：汇总状态后生成唯一 nextAction；完成时为 finalize，missingReads/missingReviews/failedPages 均为空。相同报告返回 unchanged=true 而不重复完整正文。相同页重读应说明原因，并与 F16 的当前图片上下文状态协调；不能简单一律屏蔽重读。

### F19 · P0 · 非版本化文件绕过完整视觉证据校验【无写入实测】

位置：workspace.ts:3818、3846–3865；src/node/read.ts:268–326；src/node/convert.ts。

问题：来自 download/convert 的文件不是 generated/documentId/sourceDigest/name 结构，recordOfficeVisualQaProgress 直接返回原结果，不检查当前 artifact 的已读页面、页数和完整覆盖。

实测：对本地既有样本 PDF，仅提交 screenshot-9999 的 passed 报告，没有先看图，也没有该页面；readFileVisuals 和非版本化记录入口均接受，且没有生成 visualQa 状态。本测试未写任何用户文件。

建议：视觉验收注册表应面向所有 artifact 的字节版本，不依赖路径结构是否像草稿。提交报告必须验证页面存在、证据绑定和已看记录；来源文件可以没有 documentId，但不能没有 artifactRevision。

### F20 · P2 · 中文字体验证与“美观”判定仍有边界【代码审查】

位置：src/node/office/validation.ts:31–65、505–510；src/node/office/semantic.ts:30–64；Python 字体与文本测量逻辑。

已完成的中文字体空指针/亚洲字体赋值修复应保留。剩余：Node 字体清单主要靠系统字体目录文件名与少量别名，未完整识别每用户字体及字体内部 family；FONT_NOT_FOUND 是建议性 warning。主题默认字体、UNO 选用字体、导出字形和目标 Office 的替换行为不是同一个证据。

建议：统一实际字体 family 解析与 CJK fallback，并返回 requested/resolved/exported 字体及验证环境。将标题/正文/标签等语义角色绑定用户最小字号，优先重排、加页、扩容，不能默认靠缩字通过。美学评估与结构校验分开，不作“任何 Office 环境都绝对一致”的保证。

### F21 · P1 · download 宣称支持本地路径，但实现只走 fetch【注入 fetch 实测】

位置：schema.ts 的 path/urlOrPath 描述；src/node/download.ts:108–119、280–306。

问题：说明写“real local path”，实现没有本地文件复制分支。实测 C:/temp/example.png 被传给 fetch（测试替身阻止了网络）。没有 sourcePageUrl 时又提示提供页面 URL，错误方向完全不同。

建议：当前只支持 HTTP(S) 就明确限制协议并改掉本地路径承诺；如需支持本地文件，应新增受控、授权、限根目录的导入操作，不把本地路径当 URL。MIME 导致扩展名变化时返回 requestedType/actualType/reason；URL 缓存需要内容摘要/新鲜度语义，不能将“同 URL 命中过”视作永久同文件。

### F22 · P1 · convert 的承诺、验证与重试结果不完整【代码审查】

位置：src/node/convert.ts:130–260。

问题：当前仅支持 Office→PDF，但通用工具摘要说“changes file format”；转换结果直接填 structural=true，实际主要依据返回了非空字节，并未走与作者路径相同的 PDF/Office 验证。输出文件先写入，之后预览失败会整体报错，但不返回已经生成的 artifact 身份；重试又产生另一个文件名。转换没有内容级复用。

建议：公开 sourceFormats/targetFormats，验证 PDF 可解析、页数与必要内容；按输入字节+转换配置+运行时缓存。分开 conversionStatus 与 previewStatus，明确保存状态、已有 artifact 和恢复动作，避免重复生成孤立文件。并补齐 F19 的视觉 QA。

### F23 · P1 · schema、动作说明与实际处理不完全一致【schema 内存实测】

位置：src/schema.ts:137、153、189、300–328；src/action-guidance.ts；src/node/workspace.ts:2280、3353–3410。

已复现被接受的参数：readSource 的拼错字段 statLine、readSource 附带无效 patch、jsApi 附带不消费的 query、非法 documentId='../x' 在 schema 层被接受。这里不表示非法路径能越过后续工作区校验，而是错误被延迟或参数被忽略。

其他不一致：schema/说明支持某些字段但操作未使用；重新 plan 已有源码时静默保留原 fileName/intent/operation，却返回成功，用户新要求并没有更新；“复用已有 modify 不需附件”的实现注释与上层必填约束并不一致。

建议：按 action 使用独立严格契约，拒绝多余字段，并给拼写建议。共享适配映射与注册表，避免应用 override 漏传参数。重新 plan 区分 resumed 与 requirementsUpdated，显式列出 ignored/conflicting fields；不能以成功掩盖用户请求未生效。

### F24 · P2 · 历史诊断、运行版本、计数与手册仍需统一来源【部分已修；代码确认】

位置：src/node/office/validation-evidence.ts；workspace.ts:1234、2813；src/node/read.ts:107；src/runtime-skill.ts:553；两套 browser-chat-file/node-capability 适配器。

已修：新增 source/worker/时间/阶段证据；失败结果落盘；validationFailureCount 不再解释成桥重试数。

剩余：catalog 对 unknown 的通用“重新 render”建议仍比 evidence 的 worker-version-unavailable 处理更宽；缓存验证也产生新的 checkedAt，需区分复用执行和新执行。字体/素材变化不由仅 worker 的版本证据完整表示。部分附件 metadata 仍教模型使用兼容 action=read。手册前文只说 edit 接受 patch，后文才补 replacements；新旧用法与示例分散。

计数也需明确单位：作者 slideTransition=14，而 XML transitionCount=28，不能直接对用户说有 28 个独立转场；speakerNotes 调用数与实际 notes 页数也不是同一指标。

建议：统一 runtimeContractVersion、schemaVersion、workerRevision；返回 executionPerformed/cacheReused、validatedAt/executedAt；只有相关环境变化才使证据失效。统一文档与已公开工具示例，兼容别名只留在传输层。每个 count 带指标定义和来源。

## 四、全部工具的修正重点

| 工具 | 应让模型明确知道 | 主要待修项 |
| --- | --- | --- |
| list | 当前草稿、当前已发布文件、尚缺什么 | 返回完整 currentArtifact/QA 缺口；坏条目显式报告（F02/F13） |
| readSource | 只读确切源码作用域，不执行验证 | 不自动换坐标；字符预算；版本化诊断（F07/F08/F24） |
| readContent | 解析数据，不是源程序，也不等于视觉已读 | 淘汰公开 read 别名；抽取缓存；页码语义一致（F08/F24） |
| download | 获取真实远程文件并注册素材，不负责生成内容 | 协议/本地路径、类型变化、缓存新鲜度（F21） |
| convert | 当前仅 Office→PDF | 实际验证、部分完成返回、转换缓存、QA（F19/F22） |
| plan | 创建/恢复工作区并固定需求，不生成文件 | 保留语义模式指导；冲突显式；需求可验证（F05/F15/F23） |
| generate | 保存初始源码并验证，不代表已发布 | mutation/validation 分离；返回预算与恢复动作（F05/F10） |
| edit | 精确修改同一草稿；失败也可能已保存 | 唯一匹配、部分保存、scope、摘要不丢冲突（F05/F09/F10） |
| unoApi | 查询一个真实模块，不执行文档 | 精确优先、按需正文、无源码写入（F03/F04/F11/F13） |
| jsApi | 描述当前计划引擎的实际 API | 不消费的 query 必须拒绝/支持；同源方法契约（F04/F11/F23） |
| render | 发布当前源版本对应的不可变产物 | 源/产物版本分离、覆盖验收、结构化状态（F05/F14/F15） |
| visualIndex | 列出当前产物的页面与缺失检查 | 精确文件身份、页标题、待读集合（F01/F02/F17） |
| visualRead | 获取指定图，并确认实际附图状态 | 请求级去重、逐图身份、加载失败显式（F16/F17） |
| visualReport | 提交证据，不修改源文件 | 所有文件统一 gate；完成后终止；需求另验（F15/F18/F19） |

## 五、建议的统一结果契约

下面是设计建议，不是当前已实现字段。各 action 只返回相关字段，避免再次膨胀上下文。

    {
      "schemaVersion": "2",
      "action": "edit",
      "ok": false,
      "identity": { "documentId": "...", "sourceRevision": "..." },
      "mutation": {
        "status": "partial",
        "saved": true,
        "appliedHunks": [1],
        "failedHunks": [{ "index": 2, "code": "OLD_TEXT_NOT_FOUND" }]
      },
      "validation": { "status": "passed", "scope": "document" },
      "error": {
        "code": "PARTIAL_EDIT",
        "origin": "source-edit",
        "message": "第 1 处已保存；第 2 处未匹配。不要重放第 1 处。",
        "retryableUnchanged": false
      },
      "nextAction": { "action": "readSource", "documentId": "...", "path": "..." }
    }

文件身份、变更状态、校验范围、证据与下一步是不可裁剪字段。完整 traceback、所有 API 示例、重复元素列表是按需展开字段。

视觉结果建议返回 missingReadPages、missingReviewPages、failedPages、requirementsUnmet；complete=true 时唯一默认 nextAction 为 finalize，而不是继续看图或重报。

## 六、实施顺序与验收

### 第一批：先消除错误引导和伪完成

1. 修复 F01 的 ID/版本分类，输出服务端确切身份。
2. 修复 F05，确保模型获得的精简 JSON 保留失败原因、已保存状态和下一步。
3. 修复 F03 的精确模块匹配，同时限制 F04 的重复正文。
4. 修复 F16/F17 的截图请求绑定与去重生命周期。
5. 修复 F18：完成即停止；修复 F19：非版本化文件也必须校验视觉证据。

### 第二批：稳定源码修改和需求验收

1. F09/F10：唯一匹配、显式部分保存、局部与全文验证区分。
2. F13/F14：查询不写源码；发布版本不可变。
3. F15：固定需求清单，阻止用删功能、降字号冒充完成。
4. F07/F23：严格 action 契约与作用域，不吞未知参数。

### 第三批：统一手册、字体与外围操作

1. 同源生成 schema、方法文档、错误建议和示例。
2. 补齐 download/convert/readContent 的能力边界、部分状态及缓存。
3. 完善字体解析、语义字号约束、诊断来源与计数定义。

验收不要只看单元函数能跑。至少验证“原始工具返回 → 应用适配 → 模型真正收到的 JSON/图片 → 下一工具选择 → 最终声明”整条链：

- O/0 错误能直接恢复正确 ID，不重新 render。
- 46 个模块精确查询都不带入无关模块。
- 部分 patch 失败时，模型能明确说出哪处已保存、哪处没执行。
- 同页在图片上下文已移除后重读，确实重新附图；附图失败不能记为看过。
- PDF 转换文件不能报告不存在、未看的页面。
- 动画/自定义放映缺失或标题低于用户下限时，不能宣称全部满足。
- 完整 QA 后默认交付，不再连续提交同一报告。

## 七、本轮实际验证与未验证边界

已完成：浏览器只读核对；目标对话逐 action 统计与关键调用核对；O/0 字符及文件存在性核对；46 个模块查询；严格参数缺口复现；原始结果→模型摘要丢字段复现；重复源码片段 patch/replacements 对比；非版本化 PDF 未看页面报告复现；本地路径 download 的 fetch 替身验证。

未做：对原对话发消息、修改其源码、重启服务、发送外部模型诊断请求、运行 dev/build、重新生成完整用户文档、逐页重新审美评定、所有 UNO 方法与平台组合穷举。

所以本报告能证明以上具体问题和风险，但不能保证“修完后模型绝不再犯错”。合理目标是：错误更早被阻止，原因准确可恢复，状态不丢失，证据可追溯，不能把未实现的需求说成成功。

## 八、用户下载的 PPTX 与网页预览对照复盘

用户补充：白底、重叠和截断发生在**网页预览**。本节是收到这一信息后的追加检查，不是对上一节“未验证边界”的追溯改写。

### 样本与实际验证

- 原文件：`C:\Users\18367\Downloads\UNO 全能力视觉叙事.pptx`，128337 bytes。
- SHA256：`0ad3467823d49b9222b223574197abcacd468b05184adb60b9ef939999d24d45`，与该对话最终发布文件逐字节一致。
- 源码版本：`85ef1c60ec25544fdaf11859ddf60a70f878cf6780f0fe6c6efb38ef9fd3c4a8`。
- 从下载的 PPTX 重新执行现有 `renderFilePreview`，得到 LibreOffice→PDF→PNG；不是只复用之前的 QA 结论。
- 新建隔离的无头 Edge 页面，打开同一对话的实际“打开文件”预览，截取第 4、5、6、8、12、13 页。这六页覆盖文件中的全部九张原生图表。
- 读取 PPTX 内九份图表 XML、网页 DOM 样式以及当前安装的预览组件代码。未修改原 PPT、对话草稿、生产代码或 node_modules；未发送模型请求、重启服务或运行 dev/build。没有新增持久化测试脚本。

浏览器截图位于 `tmp/pptx-delivery-review-20260905/browser-page-XXXX.png`。本次 LibreOffice 截图位于该目录的 `8ba25c3deec46cd839d7386c0f75e8077728f25faa4ec00bb4d91ef1d1cc3e5d/page-XXXX.png`。

### F25 · P1 · 网页预览把图表内部容器误当成幻灯片，强制刷白【实测＋代码定位】

文件的九个 `chartSpace` 根节点均有：

```xml
<c:spPr><a:noFill/><a:ln w="0"><a:noFill/></a:ln></c:spPr>
```

重新用 LibreOffice 渲染时，九张图的背景均与页面融合；网页里九张图都有白色矩形。浏览器 DOM 进一步显示：白色不是作者设置在 chart 外层的背景，而是图表 canvas 的父 div 被写入 `background-color: rgb(255, 255, 255)`。

确切代码路径：

- `src/components/FilePreviewProvider.tsx:205` 将原始 PPTX 交给 `OpenFileViewerSurface`。
- `src/components/OpenFileViewerSurface.tsx:46` 启用 officePlugin。
- 当前安装 `@open-file-viewer/core@0.1.42`，内部使用 `@aiden0z/pptx-renderer@1.2.4` 重绘。
- `node_modules/@open-file-viewer/core/dist/index.js:13996` 的 `normalizePptxLayout` 对 `findPptxSlideCanvases` 命中的、未设置背景的元素一律设置白色。
- 同文件 `:14395` 在每页所有后代 div 中搜索；`:14406` 的 `isPptxSlideCanvas` 只要求 `position:relative` 且宽高大于 0。ECharts 内层 canvas 容器恰好满足这个条件，因而被误判。

这不是 UNO 忘记设置透明，也不是 ECharts 必然要有白底；是预览归一化的 DOM 识别范围错误。

修正建议：只识别明确的幻灯片根画布，排除图表、媒体和嵌套组件内部容器；不要给所有相对定位元素补背景。优先在可维护的依赖补丁或适配层修正，不直接手改 node_modules。也不要用“所有图表背景强制透明”的全局 CSS 掩盖问题——用户明确设置的白色/彩色图表背景应被保留。

### F26 · P1 · 网页重绘改变图表布局、标签和图例语义【六页实测】

| 页码 | 网页实际缺陷 | 对照与影响 |
| --- | --- | --- |
| 4、5 | 纵轴标题被挤到图表左边界，部分文字截断 | LibreOffice 对照没有同样的左边界裁切 |
| 6 | 雷达标题紧贴并挤入顶部标签；右侧条形图纵轴标题与“加速情景”重叠；部分数值标记位置不合理 | 不是“图表对象在页面内”就能保证文字在图表内 |
| 8 | 饼/环左侧 22% 标签越界丢失；图例显示绿色/蓝绿色，而扇区为钴蓝/琥珀/灰蓝/浅蓝 | 图例错误会使读者误读类别，不仅是难看 |
| 12 | 气泡显著放大、互相遮挡，最左气泡被截断；轴标题缺失/裁切 | 同时存在 F27 的源数据角色问题 |
| 13 | 表头“基线 / 2026”两行过紧；股票图图例/颜色与 LibreOffice 对照不同 | 需要表格行距和股票图族的单独兼容检查 |

局部代码证据（不是所有缺陷都已经归因到单一语句）：

- `@aiden0z/pptx-renderer/dist/aiden0z-pptx-renderer.es.js:9927` 给轴标题使用固定 nameGap，不能保证不同方向、字体和实际分类标签宽度下均不碰撞。
- 同文件 `:12006` 的图表容器以及内部绘图区使用 `overflow:hidden`。应修正内部布局预算，而不是取消页面裁切让文字泄漏到其他区域。
- `:10674` 的自定义图例按 series/radar 项选择颜色，没有对应查找 pie/donut `series.data` 中的单点颜色；缺失时退回 `#2f6f8f`。与第 8 页错误色标一致。
- `:11524` 的 bubble 重绘使用固定尺寸系数和另算的边界，非数值 X 缺失时退回数组下标；不是对 Office 画面的忠实保留。

修正建议：按图表族测量标题、轴标题、刻度、数据标签、图例所需空间，再分配绘图区；横向图按真实屏幕方向放置标签；圆图图例从数据点颜色取值；气泡大小及边界按画布与数据角色计算。对不完整或不支持的输入明确降级/警告，不能静默绘出一个貌似正常的图。

### F27 · P0 · 气泡图的数据角色已在源文件中错位【源码＋XML 确认】

第 12 页的意图是：X=优先级、Y=回报、气泡大小=投入规模。但当前源码第 631 行将三个指标当成普通 `series`，将六个项目的中文名称当成 `categories`。通用 Chart1 数据装填没有将这三个角色显式绑定。

`ppt/charts/chart8.xml` 的实际结果：

| 角色 | 作者原意 | 导出内容 |
| --- | --- | --- |
| X | 82、78、90、64、70、58 | 中文项目名称的 strCache；不是数值 X |
| Y | 85、72、88、60、74、62 | 82、78、90、64、70、58，即优先级 |
| 气泡大小 | 55、60、35、70、45、50 | 85、72、88、60、74、62，即回报 |
| 投入规模 | 一个气泡系列的 size 数据 | 形成额外系列，但没有 yVal |

网页随后将非数值 X 回退成 0…5；LibreOffice 显示的是 1…6。两种视图都不能代表用户所要求的优先级散布。仅修白底、缩小气泡或重启 UNO 都不会修好数据含义。

相关实现：`libreoffice-program-worker.py:4004` `_add_native_chart` 将所有系列统一传给 `setData`、`setRowDescriptions`、`setColumnDescriptions`；`:4215` 对所有图表族共用 `categories/series`；`:4366` 的 bubble helper 也未显式暴露 X/Y/size 角色。`:7265` 的 `verify_presentation_charts` 主要检查重开后的对象、尺寸和模型存在性，不验证数据角色。

修正建议：为 bubble/scatter/stock 提供分族的明确数据结构。Bubble 至少要求 `xValues`、`yValues`、`sizes`、可选 `pointLabels`，长度一致、X/Y 有限数值、大小符合约束；导出后核对角色对应的 OOXML 缓存与输入一致。缺失角色直接返回 `CHART_DATA_ROLE_INVALID` 并给出该族的最小正确示例，禁止用猜测的序号补出一张“成功”的图。同步更改 schema、unoApi 示例、错误提示和能力声明。

### F28 · P0 · 模型验收和用户预览不是同一渲染结果【调用路径确认】

模型 `visualRead` 获得的是 LibreOffice/PDF 截图；用户网页获得的是 PPTX→浏览器 DOM/ECharts 的重绘。原文件摘要相同并不能证明这两种图像一致。当前 visual QA 通过状态没有对网页预览建立对应的渲染证据。

这解释了为什么模型能声称“14 页通过”，但用户看到明显白底、重叠、裁切和错误图例。之前的附图去重、证据缺失等 F16/F17 问题是另外的风险，不应用它们替代本次已复现的渲染器差异。

修正建议：

1. 默认“保真预览”直接使用与 QA 相同的、绑定 artifact digest 和 renderer fingerprint 的 PDF/PNG；下载仍提供原始可编辑 PPTX。复用现有预览缓存，不要求每次打开都重转。
2. 如需可交互的原生重绘，保留单独入口并标注“兼容预览”；明确静态预览不能验证动画、转场和交互。
3. 视觉证据记录 artifactDigest、renderer/version、page、实际附图结果；最终文案说明通过的是哪一种视图，不把单一渲染器的通过等同于所有软件兼容。
4. 若原生网页预览继续作为默认，发布前必须额外检查该网页渲染结果，而不是只改提示词要求模型“认真检查”。

### F29 · P1 · 版式与信息设计确实普通，不能全归因于网页组件【视觉对照＋需求核对】

即使采用正确的 LibreOffice 画面，也不能认定这份 PPT 达到了原始审美目标：

- 六个图表页几乎重复同一组页头、英文副标和装饰短线，章节与关键结论缺少视觉节奏。
- 第 4 页将收入绝对量与平台指数放在同一数值轴，指数曲线被压到基线附近；句子强调 2024 拐点，图中却缺少明确的对照/注释。
- 第 8 页饼图和环图重复展示同一数据；副标仍声称存在 SCATTER，实际已删除。展示 API 能力与清晰讲述结论混在一起。
- 第 12 页图表只占左半区，右半区几乎完全空置；六个气泡没有清楚映射到六个项目，下方四项行动与图缺乏可验证关联。
- 图例经常占用相当大的绘图区；大量细小的轴文字、普通网格和冗余标题削弱重点。图表标题/轴标题有 Arial 9pt，而其他图表文字使用 Microsoft YaHei UI 12pt，样式角色不统一。
- 模型曾通过降低 Diamond 字号、删除功能来消除报错。完整要求和字号底线应继续按 F15 验收，不能因为画面“不再报错”就通过。

修正建议不是增加“世界级”几个形容词，而是将设计要求落成可执行约束：

1. `plan` 固定叙事目标、受众、每页一句结论、字号下限、配色角色和必须保留的功能；不得在修错过程中悄悄降级。
2. 提供相互区分的可编辑原生版式：结论＋关键证据、大图单结论、图表＋解释侧栏、对比/矩阵、章节页、技术附录。让内容选择版式，不是所有页强套同一模板。
3. 图表主题统一字体、颜色、轴线、网格、标签密度和图例策略；布局按实际文本测量。不同量纲先做有说明的指数化、分面或合适的独立坐标，不能任由大数压平小数。
4. “全部功能展示”可放入结构清楚的能力附录，主叙事保持重点；不擅自删掉用户要求的功能。
5. 技术校验、数据语义校验、需求覆盖、视觉缺陷和整体设计分别记录结论。`render passed` 不等于 `design passed`，更不等于“世界先进水平”。

### 本次追加结论与优先级

第一优先：修正网页画布误判与 F27 数据角色，并让默认预览与模型 QA 同源。第二优先：修复原生网页图表标签/图例兼容性，建立独立的图表语义验证。第三优先：将需求、字体层级、图表主题及叙事版式落实到生成契约。

本次只追加复盘与截图证据；以上 F25–F29 是待修建议，尚未修改生产实现或重做用户 PPT，也未对全部 14 页作新的完整美学认证。

## 九、后续实施：内容驱动的文件设计

用户随后明确要求不处理网页预览，仅按内容驱动设计方向修改生成端。本批已落地：

- 初始 plan 的 `design` 简报：受众、目标、不同构图/字体/图像方向、选择理由、内容节奏及保留/避免事项；验证并保存，不只是口头计划。
- 区分模板能力 `available` 与推荐路径 `recommended`。高设计任务推荐自定义 program，普通文件保持 semantic 快速路径；明确允许空白内容页和自定义设计 token，不再要求使用品牌给定的覆盖值。
- 修复 plan 的模型摘要丢失路由信息，保留 design、designGuidance、semanticGeneration 及原文件引用。完整简报不在每次局部源码读取中重放。
- 显式 bespoke 计划的最终 deckReview 需要 designIntent、compositionRhythm；新检查中的失败不能与总体 passed 并存。旧草稿不因关键词匹配被新增硬门槛拦住。
- 提示词要求先推演代表构图、首个有效渲染优先检查代表页，再检查全篇；不为原型绕开完整功能校验，不重复生成多份完整替代稿，不用布局数量或随机配色冒充设计。

验证：隔离工作区内的真实 plan/持久化/模型摘要链路、schema 与 JSON 传输、普通三种 Office 文档路由、错误设计引用、旧调用兼容和矛盾设计检查拒绝均通过。另通过 createNodeFileCapability 的完整工具入口验证 design 没有被 Node 适配器丢弃。全项目类型检查得到 195 条诊断，本批涉及的十一个 TypeScript 文件为 0 条；没有声称全项目类型检查通过。未执行 dev/build、外部模型请求或完整文件重生成，未新增测试脚本。网页预览 F25/F26、气泡数据角色 F27 等不是本批修复范围。

这为模型提供并约束设计决策流程，但不自动生成审美评分，也不意味着原交付 PPT 已经重新设计或达到世界级水平。

## 十、后续实施：原子源码编辑与精确 API 查询

本批针对进一步优化请求，先落实编辑可靠性和 API 读取准确性；不改网页预览或现有用户文档。

- 补丁仅接受唯一、精确的源码匹配，取消忽略缩进和标点的模糊应用；重复代码报明确冲突，不选择第一个位置。Python 函数/类锚点不越过其块边界。
- 所有 hunks 在同一个原始快照定位，再倒序应用实际改动区间；允许共享未修改上下文，拒绝重叠修改。replacements 同样整批原子应用。任何冲突都不保存其他项，并分别返回 failed、blocked。
- 不再根据“新文本在其他位置出现”猜测已应用。源码事务同时保存最新请求指纹、前后版本和数量；只有相同请求且当前源码仍等于回执的结果版本时，才返回 EDIT_REPLAY_CONFIRMED，不再次执行验证。过期版本不自动 rebase。
- 编辑的模型摘要保留结构化 editStatus、saved、changed、patchHunks、patchBaseDigest、validation、诊断及基础设施恢复字段。兼容展示历史 partial-patch-applied，不再将其压成一句成功提示。保存失败不报告候选源码已持久化。
- schema、工具描述、readSource 返回指导与 runtime skill 同步新规则；修复“公共函数和调用方应一起修改”与“一次只能读一个窗口”的冲突，允许同版本下读取少量相关位置后一次提交。
- UNO API 精确版本/模块优先匹配；不存在的版本返回索引，数字版本不参与关键词搜索。关键词要求全部匹配。缓存绑定 worker 摘要，避免安装代码更新后继续读旧接口。
- getUnoApi 元数据写回与 edit/render 共用文档锁，避免并发 API 读取覆盖较新的源码和编辑回执。

验证：12 个内存断言通过；更新现有回归用例并运行其中 9 个相关用例，全部通过。实际本机 UNO API 查询验证 presentation.professional@1、无版本同名查询、错误 @999、presentation.chart@2、calc.sheet@2、writer.table@2，共 6 种情况均符合精确匹配。隔离工作区并发查询 API 与源码编辑、失败验证后的相同请求去重、原子冲突不写入及过期版本拒绝均通过。未执行 dev/build、外部模型请求或用户文档重生成；没有新增测试脚本文件。

本批不包含结构化元素编辑、字体真实度量、按图表家族重做数据契约；这些仍是下一阶段建议，不能将本次可靠性修复称为整体排版系统或全部图表语义已经完成。

## 十一、真实界面回归：chat_860ebf418033（2026-09-05）

通过 Edge 界面、当前默认 MiniMax-M3，新建 `compute-editorial-all-charts`，要求 15–16 页、全图表、原生可编辑、中文编辑设计。首轮实际发现：

- plan 一次 JSON 引号未转义，界面保留失败，模型自行纠正；未出现首包无限等待。
- `unoApi` 精确命中单模块、结果为 JSON 对象；但 chart 模块的 donut 示例同时打开三种标签，模型照用后被自身校验拒绝。示例已改成图例＋百分比单标签，且无图例默认不再同时启用分类与百分比。
- 局部修改实际保存成功，后续是源码校验失败，并非 patch 匹配失败。模型给 scatter/bubble 提交二维点数组，通用分类图解析器调用 float(list) 失败，随后尝试把 X/Y/大小摊成无关系列。测试人员暂停了新测试，保留同一草稿后修复接口；未中断旧用户对话或覆盖旧草稿。
- Python 堆栈裁剪只留开头，恰好裁掉最末端的异常原因。已改成首尾保留；新增 `CHART_DATA_ROLE_INVALID` 的简短源码诊断。

生成端修复：scatter 接受每系列 x/y；bubble 接受 x/y/sizes；stock 接受 open/high/low/close。明确校验有限数值、角色数组等长、气泡正大小与 OHLC 关系。兼容 scatter [x,y]、bubble [x,y,size] 点数组，但不接受混用角色字段。通过 Chart2 显式绑定数据角色，避免将语义标签作为数值 X；每系列不同长度保留缺值，不补虚假零。分类图仍使用原有接口。API 新增三种精确示例与数据形状，运行规范同步说明；格式检查新增基于实际 OOXML 的 chartTypeCounts（含 column/bar 和 radar/filled-radar 区分）。

验证证据：本机真实 UNO 导出的 `tmp/chart-roles-50dii9fr/roles.pptx` 包含两系列散点、两系列气泡、一组 OHLC。解包逐值核对数值 X/Y、bubbleSize 与四组股价均正确，不同系列点数保持；非法角色/长度/大小/OHLC 均被拒绝。真实包格式验证 issues=[]，类型计数 scatter=1、bubble=1、stock=1。技术实现核对 [LibreOffice BubbleChartType](https://raw.githubusercontent.com/LibreOffice/core/master/chart2/source/model/template/BubbleChartType.cxx) 的 values-size 标签角色及 [CandleStickChartType](https://raw.githubusercontent.com/LibreOffice/core/master/chart2/source/model/template/CandleStickChartType.cxx) 的 OHLC 属性。

同一 UI 对话已恢复，并确认模型获取了更新后的接口。最终整稿生成、逐页视觉检查与用户要求的设计质量仍待该流程完成，不能用三页数据角色验证替代整稿验收。没有执行 dev/build，没有新增测试脚本文件。

### 整稿实测追加

第一份有效整稿 `a533068a…`：15 页，11 个原生图表，column/bar/line/area/pie/donut/scatter/bubble/radar/stock/filled-radar 各一个。模型通过批量 edit 将 27 项布局诊断收敛，再修正附录标签碰撞和封面竖线的负坐标/零高度导出问题，完成 render、两批 15 页 visualRead。补丁保存与后续执行/布局校验失败应分开计数，本轮没有复现 no-op 缩进补丁循环。

独立逐页检查发现自动结构通过仍不等于视觉通过：5/12 页数据标签拥挤，6 页面积大系列遮挡小系列，8 页黑色扇区黑色标签低对比，9 页环图缺地区图例，11 页气泡覆盖坐标原点。3 页摘要与 4/6 页数据不一致，封面仍写十种但实际十一种，15 页统一口径/多客户端可编辑声明过度。原始自选三种字体未匹配本机字体库存。4–9 页仍有明显重复页头与侧栏版式，不能据结构通过称为世界级设计。

模型只识别部分缺陷，并将 Lite 气泡 sizes 从 200/150 改为 110/85、x 从 1/3 改为 2/4，随后还计划继续缩小/移动。测试人员暂停并要求恢复首次有效文件数据。工具新增 x_axis_min/x_axis_max/y_axis_min/y_axis_max 范围控制；视觉修复须扩展轴范围/布局，不得篡改样本或相对尺寸。散点 Chart1 行索引着色偏移另已修成 Chart2 按最终系列着色（含符号）；真实导出 `tmp/axis-colors-l053lm5e/axes.pptx` 逐值验证颜色 B84A2E/2F5C72 和 X/Y 轴界，格式验证 issues=[]。参考 [ChartAxis 的 Min/Max/AutoMin/AutoMax](https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1chart_1_1ChartAxis.html)。

最后定向复核还暴露了未解决的恢复效率问题：模型错误选择 jsApi，并收到 `RUNTIME_SKILL_CONTENT_RETURNED`（返回必需 Skill 内容，未执行原 file 请求）；随后大量读取页面及重复窗口，虽单次读取已受限，仍重构了接近整份源码。需要后续对恢复状态、按引擎约束工具和已读窗口去重做专门改造，不能声称提示词已彻底防止误用。Windows 实际字体库存确认 Microsoft YaHei、SimSun、Consolas 存在，已在 UI 要求模型仅用已安装字体并重新全稿复核。

### 最终界面结果与独立验收

本次界面流程已结束。最终源程序/渲染版本为 `7e5aa3d25caa04eee976cae61d4f150995d327fb9528a65d002ca30f49141a1f`，产物为 `runtime/artifacts/chat_860ebf418033/generated/compute-editorial-all-charts/7e5aa3d25caa04eee976cae61d4f150995d327fb9528a65d002ca30f49141a1f/未来算力·全图表视觉叙事.pptx`（79300 bytes）。文件 SHA256 为 `b7ce7192e4b897f86fe1c18a2313003360e42acc17d3f712acc4d407a361e0c9`。

- 实际包校验：15 页、11 个原生图表，各图表族各一；`issues=[]`、`missingFonts=[]`。这不是“全部 UNO 功能”验收，也没有验证 PowerPoint/Keynote/WPS 的原生编辑体验。
- 解包逐值确认原始三组气泡 X/Y/sizes 已恢复，未通过修改数据消除重叠；轴界为 X -200…1200、Y -20000…100000。散点两系列实际颜色为 B84A2E/2F5C72，修正后的 Chart2 数据角色及配色已进入最终文件。
- 通过界面完成 plan、API 查询、generate、多次局部 edit、render、15 页 visualRead、visualReport 与最终文件卡片。实际点击下载，服务端记录该精确 URL 返回 HTTP 200；未确认浏览器落盘位置，不声称已核对 Downloads 中的副本。直接可用的产物仍在上述工作区路径。
- 最终元数据保存 15 页已读和 15 页报告，其中第 11 页 failed；不存在已通过全稿的 `visualQaDigest`。模型最终如实列出气泡遮挡，但错误地将其他 14 页都认定通过，并把“保持原数据”理解成用户接受轴标签遮挡。

独立逐张检查最终 15 张 LibreOffice 文件渲染图（`attachment-previews/355d4e0cadad776e57ebe530fb341caafad9939666adb8489c624da742f64c4e/page-XXXX.png`）后，**严格验收不通过，不能称为世界级设计**：

| 页 | 尚存问题 | 后续修正方向 |
| --- | --- | --- |
| 3 | 英文副标题在渲染图中止于 “Three numbers frame th”；源码及 PPTX 文本仍是完整句子 | 区分源文本完整、对象几何合法和实际绘制完整；定位字体/文本渲染问题，不能将 missingFonts=[] 当作排版保证 |
| 5 | 训练成本下降曲线仍标注“反 / inverted”，与曲线语义不一致；大数系列压缩小数系列 | 按数据实际含义修正文案，必要时采用清楚标明尺度的分面 |
| 6 | 模型为显露小系列改用 stacked=True，将两个独立指数累加，虽两色可见但引入没有业务意义的累计值 | 非加总关系不得用堆叠掩盖遮挡；采用合适绘制顺序、真实透明度或可比较的独立原生图 |
| 7 | 横向条形图将“能效指数”放在类别轴，“算力形态”放在数值轴 | 明确 UNO 逻辑轴与横向图物理轴对应，验证最终轴标题 |
| 11 | 气泡不再越过绘图边界，但零点内部交叉轴的刻度文字仍被大气泡遮住，Mid 系列被覆盖 | 增加/验证轴交叉位置与标签位置控制；轴范围扩大不等于标签自动移至外侧。数据点相互重叠与遮住坐标标签必须分开处理 |
| 12 | 标题“五类算力形态”但实际只有四条系列 | 结构/语义计数与标题、图例交叉校验 |
| 14 | 填充雷达数值标签仍密集；说明声称“半透明填充”，画面为不透明叠放 | 根据真实导出透明度更正文案或实现；标签密度检查也应覆盖 filled-radar |
| 全稿 | 4–9 等页仍多次使用相同页头、英文副标、横线与侧栏；设计方向与数据表达尚未充分结合 | 将内容选择构图与跨页节奏独立验收，不能把换字体、统一配色或布局种数当作世界级设计 |

技术链路本次未复现首包无限等待、源码无差别 40000-token 全量回读或 no-op 缩进补丁无限循环；但效率仍不达标。第三轮用时约 11 分 43 秒，终态 UI 上下文估算 185070 tokens，不是一次 API 查询的返回量。重复源码窗口、两次全稿图片复检，以及多次重新生成整份视觉报告均增加上下文；该估算不等于供应商计费 token。

### 视觉报告错误恢复的追加修正

最后复现连续三次 visualReport schema 拒绝：先将 check 写成 warning，再提交 passed+issues，随后 failed deckReview 却全是 passed checks。模型一度提出删掉 issues、把缺陷塞进 observation 来获得通过，这是恢复策略错误，不应放松校验帮助它通过。

已追加到 schema 与运行规范：

- 明确 warning 只属于问题严重度，不是检查状态；未解决的问题保留 issues、对应 check=failed、status=failed。
- 矛盾状态的错误信息给出正确修正方向，明确禁止删问题、藏进 observation 或把 failed 改成 passed 来满足格式。
- 通常每 2–4 页提交一次报告，同版本已成功的批次不重发；格式拒绝没有保存该批，修正并重发该未提交批次即可。
- 保持数据不等于接受遮住坐标；不得捏造用户接受。保持数值也不等于保持语义，独立指数不能为避免遮挡被改成堆叠。

5 个针对实际误用的内存 schema 断言通过，`git diff --check` 通过。没有新增测试脚本，没有执行 dev/build。最后这批纠错文案未再启动第四轮模型生成，因此只能说契约校验通过，不能声称模型行为已被新的界面回归验证。剩余字体绘制完整性、物理轴语义、视觉报告漏检与读取/附图去重仍需后续实现，而不是继续无限重做同一份 PPT。

## XII. 原生客户端截图反馈后的修复

本轮保持原会话和原稿不变，使用同一 file workspace 实际接口创建隔离修订文档 `file_refinement_20260905 / compute-editorial-refined`。交付与逐页记录见 `output/compute-refined/README.md`；不是让外部模型再次进行无限全稿生成。未执行 dev/build，未重启服务，未新增独立测试脚本。

### 根因与代码修正

1. 气泡尺寸标签有独立 OOXML 开关：原文件 showVal=0，但缺少 showBubbleSize；现在对本次创建的图表显式写入值，不能让客户端默认值覆盖作者意图。
2. Chart1 的模板操作及属性 getter 有副作用：访问未启用的 Title 会生成自动标题；AUTO 符号会覆盖颜色。最终样式在模板操作后施加，只读取启用标题，散点使用显式符号/颜色/尺寸。股票所有序列显式 marker=none，雷达默认不加标记，密集图表默认关闭逐点数值。
3. 原生图表新增物理轴边界、外侧轴/标签、scatter/bubble 对数轴、系列透明度、字体/颜色/线宽/网格控制。横向条形图的 UNO 逻辑轴映射到物理 x/y。对数轴严格验证正值并要求可见披露，不能篡改数据。接口精确签名与 valueSchemas、运行规范同步。
4. 生成图表缺少内嵌工作簿：只在本轮作者图表、没有 externalData 的情况下，从已知完整 literal cache 创建 XLSX 并绑定单元格范围；已有工作簿/外部链接不替换。不同长度系列只清理不存在的尾部缓存占位，不删真实点或内部缺值。
5. 包装过程中暴露 OPC 兼容问题：将 Types/Relationships 重序列化为 ns0 前缀会导致本机 LibreOffice 拒绝重开。保留原默认命名空间写法后对照重开 15 页成功。新增 OFFICE_ARTIFACT_REOPEN_FAILED 优先于前序 DisposedException，明确“已保存但重开失败”不能直接推断成启动故障，不能让模型猜改源码。
6. 可选源码分段标记写错会同时阻塞读和编辑：现在全局窗口读取返回 sourceIndexError 与恢复方向；全局精确编辑不依赖损坏的索引。严格验证仍保留，按 path 编辑仍要求有效单元。实际修订流程中已经通过全局补丁修复坏标记。
7. readSource 明确 returnedLineCount、requestedRangeTruncated、nextRead；lineCount 是总行数，不是本次返回量。jsApi 引擎不符返回带原 query 的 unoApi nextCall。下载明确只支持 HTTP(S)/页面相对 URL，本地路径必须来自上传/宿主绑定，不再建议通过 sourcePageUrl 重试。
8. 设计规范要求公共风格函数与独立页面段，不要求同一页面模板反复复制。此次 950 行旧稿改成 218 行源码，采用分面、满幅图、侧注、深色重点和摄影封面；这只是减少重复作者代码的实证，不宣称已量化模型错误率。

### 验证与边界

- 真实 UNO 全 11 图表族探针运行通过；最终真实 workspace 源码验证/渲染通过。修复过程中有索引格式、无效局部修改和导出包重开失败，均保留诊断后修复，不宣称零失败首轮成功。
- 读取 1—120 行实际只返回 80 行，nextRead 精确指向 81—120；错误引擎 nextCall 保留 query；Windows/UNC/file: 路径在网络调用前拒绝。以内存断言验证，无新增测试文件。
- 最终 15 页、14 原生图表、11 类；独立包结构检查 finding_count=0。native quantitative chart gate 对所有图表页 4—14 全部通过，14 个内嵌工作簿缓存与引用匹配。26 组原始数值逐值不变。
- 每页实际像素已检查；最终补齐工作簿后生成 15 张新 PNG，与此前已检查版本逐字节相等，因此复用了同像素证据，没有再次把全部图片附到上下文。
- 最终 SHA256：`e511e67ca8dd1349126213a348744a2a829446980dd9e2ddcf9615f0be8e72ac`。实际文件 `output/compute-refined/未来算力-修订版.pptx`；原文件未修改。
- 没有执行 PowerPoint/WPS 图形界面的编辑、保存、重开验证；没有重新验证外部模型的长轮生成行为。不能把本轮原生结构与 LibreOffice 结果等同于所有客户端无缺陷或“世界级”主观审美认证。旧 SimSun 斜体拉丁文本绘制截断的通用根因也未据此宣称完全解决。

实现参考：[LibreOffice Chart2 Axis](https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1chart2_1_1Axis.html)、[DataPointProperties](https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1chart2_1_1DataPointProperties.html)、[ScaleData](https://api.libreoffice.org/docs/idl/ref/structcom_1_1sun_1_1star_1_1chart2_1_1ScaleData.html)、[Microsoft ExternalData](https://learn.microsoft.com/zh-cn/dotnet/api/documentformat.openxml.drawing.charts.externaldata?view=openxml-3.0.1)、[SpreadsheetML structure](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document)。

## XIII. 真实浏览器模型生成复测（进行中，不等于手工修订稿）

会话 `chat_d4c5ba7ec423`，Edge 新标签，默认 MiniMax-M3。题目为《英伟达 FY2025 经营复盘与算力采购决策》，18–22 页、11 类原生图表、真实财报/行情、实质决策分析与定制编辑设计。所有草稿生成和修改均由应用内模型调用 file 执行；测试人员只读检查草稿/日志、反馈问题、修改通用工具代码，没有代写该草稿或 PPTX。

已实测发现并修正的通用问题：

- research.fetch 将 CFO PDF 原始字节作为成功正文返回。增加媒体类型/魔数守卫，明确转到 download → readContent；搜索未配置时不再在当前 schema 宣称 search 可用。401/403、二进制文档和短验证拦截页给出非原样重试的恢复方向。长正文明确 truncated 与返回字符数，避免把 JSON 前缀当完整数据。
- 暂停长工具循环后，已完成的工具证据没有在循环内持久化，恢复只剩用户消息和部分正文。增加下一模型请求前的 activeMessages 检查点，去掉临时运行元数据；新一轮数据库已观察到真实 tool 结果持续保存。中断后恢复验证仍需完成。
- 模型输出 `[Tool call: skill]` 加 JSON 普通文本，框架误标正常结束。将整段匹配的伪工具协议纳入现有有限纠正/重试逻辑，不从正文执行工具。原有 4 项回复格式测试及针对该格式的内存断言通过。
- 每个 UNO 模块重复完整 valueSchemas。按实际公开方法保留相关图表/形状/时间线契约；文本模块少约 3,763 字符，真实 worker cookbook 检查确认图表/形状需要的定义仍完整。
- `add_timeline(gap=...)` 静态校验只建议重新查询。错误现在直接提供从安装代码提取的准确签名；实际 Python 预检验证非法 gap 被定位，合规调用通过。
- 编辑结果重复 diagnostics/error/workflow.error，使长 JSON 在实时界面截断后丢失“已保存、校验失败”语义。简化给模型/实时视图的回执，只去掉重复堆栈，全部诊断与原始详情仍保留。七条独立诊断的内存断言通过。
- 设计指导明确质量形容词不是视觉参考；分析页需要证据、解释和决策含义。下载图片增加一次实际像素身份核对指引；本轮 `gpu-chip.jpg` 实际是 Windows 标志，不能据文件名认定 GPU 图片。

恢复验证：下一次真实中断后，界面上下文保留约 117,921 Token，数据库仍保存已完成的结构化 tool 消息，而不是退回仅用户/助手正文。缺陷回执/静态校验恢复提示进一步明确：不能通过 allow_overlap、重新标记装饰层或高透明水印掩盖需要独立阅读的内容冲突。

尚未通过的验收项：模型初稿曾编造未取得的 OHLC、遗漏承诺图片、重复页壳；Yahoo 月度接口返回 13 个完整自然月，边界月需要用财年范围内日线重新聚合，已反馈模型通过真实工具补取。标题溢出/新增图片与标题框重叠被校验拦截，属于有效缺陷，不应关闭检查或通过 allow_overlap 掩盖。当前未宣称最终稿事实、全页视觉或全流程验收通过。未运行 dev/build，未增加一次性测试文件。

### 实测追加：图片证据与布局恢复

- `readContent(includeVisuals=true)` 原来显式排除了 image 类型；preview 也没有独立图片分支。读取 JPG 成功实际只表示读到尺寸，模型据此猜素材身份。现从同一原始字节快照生成定向、限尺寸、按内容缓存的 PNG 并传递 referenceImagePaths；失败明确说明没有像素，不能声称已经目视检查。默认不附图，重复读取复用缓存，原件哈希不变。
- 已在第六轮真实界面验证五个 JPG 的回执包含实际 preview 路径，模型随后识别出 `server-room-alt.jpg` 为机器人手、`chip-circuit.jpg` 为 GTX 1080 显卡。不是依据文件名验证。继续补齐并行附图的每图 artifactId/screenshotId 标签，避免完成顺序与调用顺序不一致时错配；标签补丁尚待下一次模型请求回归。
- 并行工具的上下文增量实际来自两次模型请求，之前每项都写“本次调用增加”容易误导。界面现在标为“请求间上下文增加/减少”，并解释同批共享、不能逐项相加；当前页面已显示新文案。
- timeline 原先逐个绘制、遇第一个高度不足才报泛化错误。现在先计算全部事件，失败时给出覆盖所有事件的最小高度（英寸/毫米），并提醒每行数同时影响宽度和总行数。以本会话真实 5 事件输入做内存断言：2.10 英寸提前拒绝且没有绘制，建议 2.19 英寸通过全部事件。没有代写或渲染测试 PPT。
- 中断恢复后同版本隐藏 Skill 的完整 tool 证据可复用；只认当前全文，不认模型自述或旧版本。压缩掉后仍须重新读取。当前第六轮未重新读取 file Skill，直到正常上下文压缩 226466→46215 后继续局部 readSource（2920 Token），未重读整稿。

### 实测追加：原样源码、补丁引擎与标题保真

- 第六轮出现四次引号转义冲突：模型将 JSON 中的显示转义当成 Python 源码字符。新增 file 专用 `toModelOutput`，保持 trace/UI 原始结果，模型侧只解析结构化 actual 一层；readSource 将元数据与原样代码段分开传递，保留真实引号、反斜杠、缩进和行数。内存断言通过；第七轮检查点已观察到 10 条 file tool text 结果包含原样源码段，不是仅改了提示词。
- 精确替换冲突增加最多三段、每段最多 12 行/1800 字符的真实源码恢复窗口。窗口仅来自唯一完全相同的锚点，绝不作为模糊匹配自动写入；整个批次依然全成功或全拒绝。可直接利用窗口时不再强制返回一次 readSource nextAction。转义冲突、整批回滚、无锚点不猜测、合法替换的内存断言通过。
- 运行现有补丁测试时发现历史代码把 `OFFICE_ARTIFACT_REOPEN_FAILED` 提示分支误放在 `seekCodexPatchSequence`，引用未定义的 codes/hints，导致合法 Codex patch 也失败。移至 `validationRepairHints` 后，选定的 8 项真实补丁回归测试全部通过；未新增测试文件。
- 第六轮真实 render 成功生成 20 页、14 个图表（11 类）、4 张图片、2 个表格，模型通过五批 visualRead 读取全部 20 页。但图片和页面检查成功不等于事实通过，当前稿仍有财年/季度增长率、市场平台收入等错误，已在第七轮要求用官方表逐项核对、共享数据推导，不能交付为已验收成品。
- 本次 PPTX 原生 chart XML 与真实页面均确认 `main-title`：最终再次设置 HasMainTitle 会重建占位标题，丢失此前文本和颜色。改为最后启用→恢复标题文本→应用字体颜色，不再在其后切换标志；记录作者标题并在导出重开后通过 Chart2 XTitle 比对，发现标题变化时归为运行时保真失败，不指示模型删标题或降级为矢量图。守卫的正确/空标题及占位不匹配内存断言通过。第七轮实际导出的 `eef31a2a320bfc54e6a1dd1328cdb0108983c00c35184def943a1291d1858885` PPTX 已核对：14 个原生图表、0 个 main-title，14 个预期标题均对应；不是手工修订文件。[XTitle 接口](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1chart2_1_1XTitle.html)

### 实测追加：证据提取与批量约束

- 原研究工具将 HTML 单元格、行边界压平；原始 HTML 上限仅为正文上限的 4 倍，官方新闻稿约 400,224 字符，在提取正文前被截断，仅向模型提供约 13.5k 字符片段。现在分别限制原始 HTML（1–4M 字符边界）与模型正文，保留行与单元格分隔及 colspan/rowspan 提示，不猜测合并表头含义。真实公开页面内存验证得到 38,757 字符正文，包含费用及自由现金流行；超过调用 maxChars 时仍明确标记截断，不能声称已读取完整来源。第八轮界面要求模型重新使用此通用读取链路核验。
- 第七轮先报甜甜圈过窄，修宽后才报相邻条形图过窄。静态分析此前只检查饼/环图宽度；现在同时检查所有显式原生图表 box 的基本宽高约束，并按图例、标题分支对齐运行时最低尺寸。实际分析器内存验证可在一次检查里同时指出 4.4 英寸带图例环图与 3 英寸条形图；不把无图例小环图误判为必须 125mm 宽。此为基础尺寸预检，不冒充最终文本密度/视觉检查。
- 当前仍不能认定内容或设计验收通过：第七轮只修正了一部分财务数据，费用、现金流及摘要仍有未同步数字，部分条形图物理轴标题与数据错配，多个页面仍复用同一左右结构。已在实际界面发起针对相关页面的核验与局部修订，禁止手改草稿、重查所有 API、凭记忆补数或将仅视觉通过当成事实通过。
- 第八轮真实 research.fetch 检查点已确认新解析器生效：返回 30,000 字符、明确 truncated=true，保留 R&D、SG&A、OCF、FCF 的实际行列与数字，非原先 13.5k 字符的压平片段。该正文包含本次需核验的主要财务行，但不代表全文未截断。当前模型改用相关页面 source unit 局部读取，并出现真正的并行读取，不再顺序翻完约 1,300 行全稿。重跑原有 8 项补丁回归通过；worker Python 语法及修改文件空白检查通过，未运行 dev/build。
- 第八轮批量精确替换成功保存，随后准确拦截新增长文案溢出；真实耗时显示该次模型请求约 5 分 20 秒、含验证的编辑工具约 14.8 秒。不能把这类长推理与补丁失败混淆，也不能声称生成延迟已全部解决。
- 顺着新溢出检查发现 `add_text` 高度估算没有传入调用者 line_spacing，可能低估多行文字高度。现传入实际行距，并在错误中提供保持当前字号的建议英寸/mm 高度，提醒同时给邻近内容重新分配空间。用真实方法的内存夹具验证：1.15 行距可容纳、3.0 行距同框被拦截、增高后通过；不关闭溢出检查，不新增测试文件。
- 第八轮实际再次导出 `dfd10c018accc8ab71b62500192ab738f566934f6e32f119e1eb73d57fb561e2`：20 页、14 张原生图表、覆盖 11 类（bar/column 与 radar/filled-radar 在 OOXML 中分别共享大类）、0 个 main-title；render 复用验证结果约 2.55 秒。模型通过 8+8+4 三批读取全部 20 页，随后自行发现回购比率和图表数量的遗漏并继续修正。
- 独立验收仍为不通过：第 7 页图中 FY24/FY25 R&D 为 8.68/12.91，旁文仍称年增 17%，明显未从图表数据派生；第 7/8/13/15 页重复相同标题—左图—右栏—底部结论壳。第 13 页气泡图标题为价格 ±10%、利用率 30–80%，实际显示价格指数 70–110、利用率仅 30/60，公式/文字/数据仍需一致性复核。图表背景、标题和轴标签修复已真实生效，但不能宣称全文事实或高级设计验收通过。这些是模型仍未遵守数据单一来源与内容驱动构图约定的反例，不应归咎于补丁引擎，也不能靠关闭检查或手工改 PPT 伪装流程成功。
- 测试停止时最新 source/rendered digest 均为 `c9c9aeab6130f31c7cd5feaa9c3f7fba999c1dfb6830c327634f44b79864f9b1`，模型已完成第 14/19 页局部修正并发布；已有上一版本全 20 页读取记录，不能据此宣称最终版本全页 QA 已完成。本轮在界面中止，产物、源码与检查点保留，未修改用户的旧测试会话。最终结论：通用链路缺陷已按上述证据修复，端到端审美与事实一致性验收仍未通过，不将此 PPT 标为合格交付。
