# AI 自动化 Web 测试应用任务文档

## 任务目标

在 `web-app-test` 目录下生成一个 Node.js 测试应用。应用需要覆盖 Dashboard、AI 对话生成测试用例、图片上传、测试执行、浏览器自动化、测试报告输出等完整流程。

## 用户流程要求

- [x] 用户进入 Dashboard 页面。
- [x] Dashboard 展示历史测试用例列表。
- [x] 用户可以新建测试用例。
- [x] 新建流程通过 AI 对话完成。
- [x] 用户可以上传图片作为 AI 生成测试用例的上下文。
- [x] AI 生成完整测试用例流程。
- [x] 用户选择或新建测试用例后可进入测试阶段。
- [x] 测试阶段由 AI/Agent 调用浏览器执行测试。
- [x] 测试完成后输出详细测试文档。
- [x] 用户在整个流程中只需要提供提示词、文本和图片。

## 技术要求

- [x] 使用 Node.js 应用结构。
- [x] 使用 Next.js 作为 Web 应用框架。
- [x] 使用 AI SDK 作为 AI 框架。
- [x] 使用 Playwright 作为浏览器自动化执行层。
- [x] 使用 Zod 定义 AI 结构化输出。
- [x] 预留 Prisma 数据模型。
- [x] 支持无 API Key 的本地 fallback，便于本地启动体验。

## Agent 任务拆分

- [x] 创建测试用例生成 Agent：`TestCaseGeneratorAgent`。
- [x] 创建测试执行 Agent：`TestExecutorAgent`。
- [x] 创建报告生成 Agent：`ReportWriterAgent`。
- [x] 创建浏览器执行封装：`BrowserSession`。
- [x] 创建安全域名校验与执行拦截。

## 页面任务

- [x] 创建首页重定向到 Dashboard。
- [x] 创建 Dashboard 页面。
- [x] 创建测试用例详情页。
- [x] 创建测试运行报告页。
- [x] 创建图片上传与提示词输入表单。
- [x] 创建测试执行入口。

## API 任务

- [x] `GET /api/test-cases`：获取测试用例列表。
- [x] `POST /api/test-cases/generate`：基于提示词和图片生成测试用例。
- [x] `POST /api/test-cases/:id/run`：执行指定测试用例。
- [x] `GET /api/runs/:runId`：获取测试运行状态。
- [x] `GET /api/runs/:runId/report`：获取测试报告。
- [x] `POST /api/uploads`：接收图片上传。

## 数据模型任务

- [x] 设计 `User` 模型。
- [x] 设计 `TestCase` 模型。
- [x] 设计 `TestRun` 模型。
- [x] 设计 `Artifact` 模型。
- [x] 设计 JSON 字段保存结构化测试用例、执行结果和报告。

## 安全要求

- [x] 域名白名单校验。
- [x] 高风险操作标记。
- [x] 报告输出中避免暴露敏感凭据。
- [x] 执行层集中封装，避免 Agent 直接访问任意系统能力。

## 已完成产物

- [x] 项目配置文件：`package.json`、`tsconfig.json`、`next.config.ts`。
- [x] 应用页面：`src/app`。
- [x] API 路由：`src/app/api`。
- [x] AI Agent：`src/server/ai/agents`。
- [x] 浏览器执行封装：`src/server/browser`。
- [x] 报告生成模块：`src/server/reports`。
- [x] 数据库设计：`prisma/schema.prisma`。
- [x] 任务文档：`docs/TASKS.md`。

## 后续可增强任务

- [ ] 接入真实 PostgreSQL 持久化，替换内存存储。
- [ ] 增加 BullMQ 队列与 Worker 进程。
- [ ] 增加 WebSocket 或 SSE 实时执行日志。
- [ ] 增加 PDF 导出。
- [ ] 增加 Playwright trace viewer。
- [ ] 增加多浏览器并发执行。
- [ ] 增加团队、项目、权限管理。
- [ ] 增加 CI/CD 集成入口。
