进行修改
1.进入 Agent Loop
每一步循环：
AI 看到当前视觉上下文
AI 选择一个工具操作
工具执行浏览器动作
系统等待页面稳定
系统自动截取新图并重新编号
Visual Context Manager 判断新图是 replace、append、保留 before/after，还是清空旧图
保存完整步骤记录
更新 working memory
进入下一步
2.增加 Visual Context Manager
新增一个核心模块：Visual Context Manager。
它负责管理当前给 AI 看的图片，而不是让 AI SDK 默认把所有图片历史都累积进 messages。
它内部维护几类图片：
current：
当前可操作截图。
这是唯一允许 AI 使用编号进行点击、输入、滚动定位的截图。
history：
历史截图，只能参考，不能操作。
3.所有操作工具增加 visualAfter 参数
每个工具都允许 AI 声明操作后的截图处理方式。
visualAfter 可以包含：
capture：
auto
viewport
fullPage
region
none
retention：
auto
replace
append
appendScrollSequence
keepBeforeAfter
clearAndReplace
pinEvidence
例如点击普通按钮：
visualAfter.retention = replace
例如滚动长页面：
visualAfter.retention = appendScrollSequence
例如点击展开按钮：
visualAfter.retention = keepBeforeAfter
例如进入新页面：
visualAfter.retention = clearAndReplace
例如发现关键证据：
visualAfter.retention = pinEvidence
4.新增 manageVisualContext 工具
可以增加一个低频工具：
manageVisualContext。
用途：
清理历史图片
只保留最新图片
固定当前图为证据
压缩滚动序列
5.使用 AI SDK 的 agent loop。

可以用：

streamText 或 generateText
tools
stopWhen
prepareStep
onStepFinish

整体结构：

初始化第一张截图

把 currentFrame 放入 Visual Context Manager

进入 streamText / generateText

每一步：

prepareStep 重新构建 messages

AI 调用工具

工具执行后自动截图

Visual Context Manager 更新图片上下文

onStepFinish 记录步骤并更新 memory

继续下一步

prepareStep 的职责

prepareStep 是上下文控制的关键。

它不要直接沿用完整历史 messages。

每一步都重新构造模型上下文。

包含：

system prompt
用户任务目标
当前 working memory
最近 3 到 5 步文字摘要
当前 Visual Context Manager 渲染出的图片上下文
当前工具规则
6.工作记忆 Working Memory

不要把每一步完整过程都传给 AI。

维护一个短 working memory。

内容包括：

任务目标
当前阶段
已完成事项
重要发现
阻塞点
最近一次动作
最近一次结果
当前页面理解
滚动阅读摘要
用户限制条件

例如：

当前阶段：

正在查看搜索结果列表。

已完成：

已经打开目标网页，输入关键词并提交搜索。

重要发现：

列表中前 3 项没有符合条件的结果。

滚动摘要：

已查看页面顶部和第一屏结果，当前位于结果列表中段。

下一步：

继续向下滚动，查找目标按钮。
7.最终报告生成

最终报告不要只依赖 agent 最后一轮。

应该基于完整 trace store 生成。

报告内容：

用户目标
执行结果
关键步骤
成功路径
失败点
页面变化
关键截图
AI 判断依据
工具调用记录
建议优化
下次执行策略
基于这些点进行修改

ai loop时进行上下文检测，超过70，将历史上下文内容压缩，并新开一个对话轮次


已完成
已按你的架构方向做了一版可运行改造，核心链路现在变成：

prepareStep 重建上下文 -> AI 调一个工具 -> 工具执行 -> 系统等待稳定 -> 自动截图并重新编号 -> Visual Context Manager 更新 current/history -> 更新 working memory -> 下一轮继续

主要改动：

新增 VisualContextManager

维护 current 和 history
current 是唯一允许 AI 使用编号操作的截图
history 只作为参考
支持 replace / append / appendScrollSequence / keepBeforeAfter / clearAndReplace / pinEvidence
所有工具参数增加 visualAfter

工具执行后会自动截图
自动调用 takeScreenshot(..., visual-N)
visual-N 截图会重新生成候选编号
截图路径写入工具 trace，前端和报告都能展示
新增 manageVisualContext 工具

clearHistory
keepLatestOnly
pinCurrent
compressScrollSequence
runtime loop 改成 prepareStep 模式

不再把完整 messages 历史一直塞给模型
每轮重新构建上下文
包含任务目标、working memory、最近工具摘要、VCM 图片上下文
图片由 VCM 控制，现读现传
新增 workingMemory

保存阶段、已完成、发现、阻塞、最近动作、最近结果、页面理解、滚动摘要、下一步等
每次工具调用后根据 tool input/result 更新
步骤记录扩展

visualContext
workingMemory
tool.visualAfter
tool.screenshots
前端运行页更新

工具调用下面展示自动截图缩略图
点击可放大查看
图片总览也会包含工具截图
报告生成更新

工具调用会输出 visualAfter
工具自动截图会进入最终报告
验证：npm run typecheck 通过。没有跑 npm run build。

一个注意点：visualAfter.capture 目前 schema 支持 auto / viewport / fullPage / region / none，但实际第一版执行里 auto/viewport/fullPage/region 都先按 viewport 截图处理；fullPage/region 后面可以继续扩展到真实全页/区域截图。