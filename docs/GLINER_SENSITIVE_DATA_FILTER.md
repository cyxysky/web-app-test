# 当前项目敏感数据过滤方案

> 核查日期：2026-08-28。本文以当前代码为准，描述 WebPilot 在调用 AI 模型前实际执行的敏感数据过滤链路。

## 1. 方案结论

当前项目采用“统一模型出口拦截 + 本地混合实体识别 + 不可逆占位符替换”的方案：

```text
AI SDK 原始 prompt
  -> getModel() 的统一模型包装器
  -> sensitive-data-filter.ts 收集所有模型可见文本
  -> 本机/可信内网 GLiNER sidecar
       -> 确定性规则
       -> LiquidAI 固定 PII 检测
       -> GLiNER2.5 开放标签检测
       -> 中文 RoBERTa 人名/公司/组织边界修正
       -> 重叠候选裁决
       -> [SENSITIVE_<LABEL>_<N>] 占位符替换
  -> 只把脱敏后的 prompt 发送给模型提供商
```

过滤不是“发现敏感内容后拒绝整条请求”。正常情况下，请求继续执行，但命中的原文会被占位符替换。只有过滤服务失败且故障策略为 `closed` 时，AI 请求才会被阻止。

当前实现不维护恢复原文的映射，模型响应中的占位符也不会自动还原。这可以避免原值经模型输出、工具调用或后续日志再次暴露。

## 2. 生效边界

统一入口位于 `src/server/ai/model.ts`。所有由 `getModel()` 创建的提供商模型，其 `doGenerate` 和 `doStream` 都在真正调用提供商前执行 `filterSensitiveData()`。因此，现有主 Agent、子 Agent、技能生成、个人记忆提炼和检索查询等使用 `getModel()` 的路径共用同一层过滤，不依赖某一个浏览器工具单独处理。

当且仅当 `AI_SENSITIVE_DATA_FILTER_ENABLED` 严格等于字符串 `true` 时，模型出口过滤生效。

### 2.1 会过滤的内容

- system 消息文本；
- user、assistant、tool 消息中的普通文本和 reasoning 文本；
- tool-call 的字符串参数，包括嵌套数组和普通 JSON 对象；
- tool-result 的 `text`、`error-text`、`json`、`error-json`、`execution-denied.reason` 和 content 文本；
- 文件名；
- AI SDK 内联 `type: text` 文件的正文；
- tool approval response 的原因文本。

收集阶段会按完整字符串去重。同一批 prompt 中完全相同的文本只提交 sidecar 一次，再映射回原位置。

### 2.2 不会过滤的内容

- role、content part type、tool name、tool-call ID 等协议字段；
- 图片、音频、视频和二进制附件；
- 图片内文字，当前没有 OCR 或多模态 DLP；
- 非普通对象实例中的字符串；
- 未通过 `getModel()` 发送的其他网络请求；
- 模型返回内容。当前方案只处理“发送给模型之前”的 prompt。

## 3. 检测管线

sidecar 会在同一份原文上分别收集候选区间，最后统一裁决并替换，不会让前一层先改写原文后再交给后一层识别。

### 3.1 确定性规则

确定性规则优先级最高，用于模型不应承担或可以精确判断的格式化数据与业务字段：

| 类别 | 当前规则 |
| --- | --- |
| 凭据 | PEM 私钥；带 `api key`、`access token`、`password`、`passwd`、`pwd`、`密码` 前缀的值；`sk-`、`rk-`、`pk-`、GitHub token、Slack token |
| 联系方式 | 邮箱、中国大陆手机号、带区号的座机/国际电话 |
| 身份与金融 | 中国身份证号；通过 Luhn 校验的 13 至 19 位银行卡号；合法 IPv4 |
| 金额 | 带币种符号/名称的金额，以及在金额、报价、预算、成本、合同额、薪资、付款、利润等上下文中的数值；会排除用户数、订单数、里程、时长等明显计数 |
| DOMP/业务字段 | 项目负责人、联系人、审批人、合同编号、项目编号、员工编号/工号、用户名、客户名称、产品、职位、岗位、出生日期、银行账号和地址等“字段名 + 字段值”结构 |

### 3.2 LiquidAI 固定 PII 模型

模型：`LiquidAI/LFM2.5-Encoder-350M-PII-Detector`。

它提供固定类别的 token classification，当前映射覆盖：

- 地址、邮箱、IP、电话、邮编；
- API key、连接串、JWT、密码、私钥、登录凭据；
- device ID、IMEI、MAC 地址；
- 金额、银行账号、银行卡、加密钱包、IBAN、SWIFT/BIC；
- 医疗状况、医保编号、病历号、药物；
- 出生日期、驾照、身份证件、护照、人名、SSN、税号；
- 案件编号、GPS 坐标、URL、用户名、公司名；
- 健康、性取向、政治倾向和宗教等特殊类别。

LiquidAI 的原始标签会映射为项目统一标签，再进入统一候选裁决。

### 3.3 GLiNER2.5 开放标签模型

模型：`fastino/gliner2.5-multi-v1`。

GLiNER2.5 用于识别开放业务实体。默认标签包括：人名、各种电话、地址、邮编、护照、邮箱、银行卡及有效期、银行账号、IBAN、CVV、出生日期、驾照、身份证/国家 ID/税号、医保/病历号、IP、用户名、公司、组织、金额、合同编号、职位、岗位、薪资、产品、客户名称、项目编号和员工编号。

`AI_SENSITIVE_DATA_FILTER_LABELS` 可覆盖这组开放标签。该配置只影响 GLiNER2.5；确定性规则、LiquidAI 固定 PII 和中文边界模型仍会运行。

### 3.4 中文 RoBERTa 边界修正

模型：`uer/roberta-base-finetuned-cluener2020-chinese`，阈值默认为 `0.35`。

它不承担全部敏感数据发现，而是修正中文人名、公司和组织的字符边界。与 GLiNER2.5 或 LiquidAI 候选重叠时，RoBERTa 的精确边界优先；RoBERTa 漏报时，公司后缀和关系词规则会对已经识别出的公司候选做保守拆分，避免把“甲有限公司向乙有限公司提供”整体替换成一个实体。

## 4. 候选裁决与占位符

候选优先级为：

```text
确定性规则（100-130）
  > 中文 RoBERTa 边界（60）
  > LiquidAI 固定 PII（50）
  > GLiNER2.5 开放标签（10）
```

所有候选按“优先级、置信度、区间长度、起始位置”排序。已经与更高优先级候选重叠的区间会被丢弃，最终只保留互不重叠的候选。

占位符格式为：

```text
[SENSITIVE_<规范化标签>_<序号>]
```

例如：

```text
张三的邮箱是 zhangsan@example.com，预算为人民币10万元。
-> [SENSITIVE_PERSON_1]的邮箱是 [SENSITIVE_EMAIL_ADDRESS_1]，预算为[SENSITIVE_MONEY_1]。
```

同一次 sidecar 请求内：

- 相同原文忽略大小写后复用同一个占位符；
- 等价阿拉伯数字金额会按币种和数值规范化后复用占位符，例如 `10 万元` 与 `100000 元`；
- 已存在的合法 `[SENSITIVE_..._N]` 区间不会被再次识别或覆盖；
- 替换按区间从后向前执行，避免前一次替换改变后续字符偏移；
- sidecar 会向设置测试接口返回标签、原始起止位置和占位符元数据，但不会返回或保存一份可供运行时反向恢复的 vault。

## 5. 长文本、并发与服务限制

| 项目 | 当前默认值 |
| --- | --- |
| GLiNER2.5 分块 | 900 字符，重叠 120 字符 |
| LiquidAI 分块 | 1600 字符，重叠 160 字符 |
| 中文 RoBERTa 分块 | 400 字符，重叠 64 字符 |
| 推理 batch size | 8 |
| 单次 `/redact` 最大文本项数 | 20000 |
| 单次 `/redact` 最大总字符数 | 4000000 |
| Node 侧过滤超时 | 默认/设置页 60000 ms，上限 600000 ms |

sidecar 使用进程内锁串行执行一次完整推理，避免多个请求同时操作三套模型。LiquidAI 和中文 RoBERTa 的候选如果触及非首尾 chunk 的外缘会被舍弃，由重叠区域中的完整候选补回。

当前 `.env.example` 仍写为 `15000 ms`，与 TypeScript 默认值及设置页默认值 `60000 ms` 不一致；实际值以运行时环境变量或持久化设置为准。

## 6. 故障与安全策略

### 6.1 故障模式

| 模式 | 行为 |
| --- | --- |
| `closed` | sidecar 缺失、启动失败、超时、HTTP 非 2xx 或响应结构错误时，抛出通用错误并阻止 AI 请求 |
| `open` | 过滤失败时直接返回原始 prompt，AI 请求继续；控制台最多每 30 秒记录一次只含错误类型的警告 |

正式环境应保持 `closed`。`open` 会造成原文外发，只适合明确接受该风险的短时排障。

### 6.2 sidecar 访问控制

- `local` 托管模式只允许 `http://localhost`、`127.0.0.1` 或 `::1`；
- `auto` 在回环地址且本地服务源码存在时托管启动，否则把地址视为外部服务；
- `external` 不启动本地进程，直接请求配置的服务地址；
- 可通过 `GLINER_SERVICE_API_KEY` 为 `/redact` 增加 `x-api-key` 校验；
- uvicorn 关闭 access log；推理异常日志只记录异常类型，不记录请求体、响应体或实体原文；
- 健康检查会校验固定 pipeline 名称；托管本地进程还会校验四个 sidecar 源文件的 SHA-256 revision，避免复用旧进程。

## 7. 配置与当前启用状态

### 7.1 用户可配置项

| 环境变量 | 当前默认值 | 说明 |
| --- | --- | --- |
| `AI_SENSITIVE_DATA_FILTER_ENABLED` | `false` | 源码运行时是否启用模型出口过滤 |
| `AI_SENSITIVE_DATA_FILTER_FAILURE_MODE` | `closed` | 过滤失败时阻止请求或放行原文 |
| `AI_SENSITIVE_DATA_FILTER_TIMEOUT_MS` | `60000` | Node 等待单次过滤的超时，上限 600000 ms |
| `AI_SENSITIVE_DATA_FILTER_THRESHOLD` | `0.5` | GLiNER2.5 开放标签阈值 |
| `AI_SENSITIVE_DATA_FILTER_LABELS` | 空 | 自定义 GLiNER2.5 标签；空值使用 sidecar 默认标签 |
| `GLINER_SERVICE_URL` | `http://127.0.0.1:18001` | sidecar 地址 |
| `GLINER_MODEL` | `fastino/gliner2.5-multi-v1` | 开放标签模型 |
| `GLINER_PII_MODEL` | `LiquidAI/LFM2.5-Encoder-350M-PII-Detector` | 固定 PII 模型 |
| `GLINER_DEVICE` | `cpu` | `cpu` 或重新打包后的 CUDA 环境 |
| `GLINER_BATCH_SIZE` | `8` | 三套模型的批处理大小 |

`GLINER_CHINESE_NER_MODEL`、`GLINER_RUNTIME_MODE`、`GLINER_PYTHON_PATH`、`GLINER_SERVICE_DIR`、三个模型 bundle 路径及各种分块参数属于打包/开发内部配置，不在普通设置项中完整暴露。

### 7.2 不同交付方式的默认状态

| 场景 | 默认启用 | 故障模式 | sidecar |
| --- | --- | --- | --- |
| 源码开发 | 否 | `closed` | `auto`，首次实际调用时按需启动已安装的 `.venv-gliner` |
| Docker 镜像 | 是 | `closed` | 容器内本地进程，三个模型在构建阶段写入镜像 |
| Windows 服务端安装包 | 是 | `closed` | 安装包内自包含 Python、sidecar 和三个模型 |
| Electron 安装包 | 是 | `closed` | 应用内自包含 Python、sidecar 和三个模型 |

本次核查时，工作区 `.env` 没有设置 `AI_SENSITIVE_DATA_FILTER_ENABLED`，SQLite 的 `app_config.runtime_env_json` 也没有敏感过滤覆盖项。因此在没有进程级额外环境变量注入的前提下，当前源码工作区按默认值处于“未启用”状态；正式交付脚本会显式改为 `true + closed`。

## 8. 设置页测试与评测

“设置 -> 敏感数据过滤”仅管理员可访问，提供两类工具：

- 单条测试：直接调用 sidecar，显示脱敏文本与“原文、标签、占位符、起止位置”，不调用外部 AI，也不持久化测试输入和结果；
- 评测集：保存文本与预期命中值，批量计算通过数、precision、recall、漏检和误报。评测用例会持久化到 SQLite，应只使用合成数据，不能保存真实密码、token 或个人隐私。

测试接口会直接调用 `redactSensitiveTexts()`，不受 `AI_SENSITIVE_DATA_FILTER_ENABLED` 开关限制，因此可以在正式启用模型出口过滤之前验证识别效果。

## 9. 已知边界

- NER 和开放标签识别具有概率性，不能保证零漏报；确定性规则也只覆盖已经定义的格式和业务字段。
- 当前没有 OCR、多模态 DLP、二进制附件内容扫描或模型输出侧过滤。
- 当前没有可逆 `PlaceholderVault`。如果业务要求模型使用占位符驱动内部工具操作，需要另行设计会话隔离、TTL、权限校验和防伪造机制，不能把映射交给外部模型。
- `AI_SENSITIVE_DATA_FILTER_LABELS` 只改变 GLiNER2.5 的标签，不会关闭 LiquidAI、确定性规则或中文边界修正。
- `external` 模式允许非回环地址，必须由部署方保证 TLS、网络隔离和 API key；否则原始待脱敏文本会先暴露给不可信 sidecar。
- 已经进入应用日志、数据库、截图或文件的敏感信息不由本方案追溯清除；本方案的安全边界是“AI provider 调用前的模型可见文本”。

## 10. 关键代码位置

| 位置 | 职责 |
| --- | --- |
| `src/server/ai/model.ts` | 为所有模型提供商统一包装 `doGenerate` / `doStream` |
| `src/server/ai/sensitive-data-filter.ts` | 收集模型可见文本、调用 sidecar、处理 fail-open/fail-closed、重建 prompt |
| `src/server/ai/gliner-local-runtime.ts` | 管理本地 sidecar、模型目录、健康检查和进程生命周期 |
| `services/gliner/app.py` | 三模型加载、候选汇总、占位符替换及 `/health`、`/redact` API |
| `services/gliner/deterministic_spans.py` | 金额和 DOMP/业务上下文字段规则 |
| `services/gliner/candidate_resolution.py` | 中文边界修正及重叠候选裁决 |
| `services/gliner/entity_boundaries.py` | 人名/公司/组织标签归类和中文公司边界拆分 |
| `src/app/api/settings/sensitive-data-test/route.ts` | 管理员单条测试 API |
| `src/app/api/settings/sensitive-data-evaluation/route.ts` | 评测集保存和 precision/recall 计算 |
| `scripts/prepare-gliner-runtime.js`、`Dockerfile` | Windows/Electron/Docker 的三模型离线打包 |


1.报错：
2.为什么有这个报错：{
"ok": false,
"result": null,
"error": "The requested credential reference is unavailable for this browserCode execution.",
"aborted": false,
"elapsedMs": 4,
"finalPage": {
"url": "[https://domp.shterm.com/login](https://domp.shterm.com/login)",
"title": "Login to DOMP"
},
"images": [],
"imageErrors": [],
"failureCategory": "unknown"
}


rror: agent.state.set input must be an object.
    at inputRecord (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:20:15)
    at executeBrowserCodeRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:123:19)
    at runtimeState (webpack-internal:///(rsc)/./src/server/browser/browser-session.ts:4049:155)
    at BrowserCodeKernel.handleRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:3006:30)
    at BrowserCodeKernel.handleMessage (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2935:18)    at ChildProcess.eval (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2841:45)
⨯ uncaughtException: Error: agent.state.set input must be an object.
    at inputRecord (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:20:15)
    at executeBrowserCodeRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:123:19)
    at runtimeState (webpack-internal:///(rsc)/./src/server/browser/browser-session.ts:4049:155)
    at BrowserCodeKernel.handleRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:3006:30)
    at BrowserCodeKernel.handleMessage (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2935:18)    at ChildProcess.eval (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2841:45)
⨯ uncaughtException:  Error: agent.state.set input must be an object.
    at inputRecord (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:20:15)
    at executeBrowserCodeRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:123:19)
    at runtimeState (webpack-internal:///(rsc)/./src/server/browser/browser-session.ts:4049:155)
    at BrowserCodeKernel.handleRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:3006:30)
    at BrowserCodeKernel.handleMessage (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2935:18)    at ChildProcess.eval (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2841:45)
Error: agent.state.set input must be an object.
    at inputRecord (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:20:15)
    at executeBrowserCodeRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:123:19)
    at runtimeState (webpack-internal:///(rsc)/./src/server/browser/browser-session.ts:4049:155)
    at BrowserCodeKernel.handleRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:3006:30)
    at BrowserCodeKernel.handleMessage (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2935:18)    at ChildProcess.eval (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2841:45)
⨯ uncaughtException: Error: agent.state.set input must be an object.
    at inputRecord (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:20:15)
    at executeBrowserCodeRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:123:19)
    at runtimeState (webpack-internal:///(rsc)/./src/server/browser/browser-session.ts:4049:155)
    at BrowserCodeKernel.handleRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:3006:30)
    at BrowserCodeKernel.handleMessage (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2935:18)    at ChildProcess.eval (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2841:45)
⨯ uncaughtException:  Error: agent.state.set input must be an object.
    at inputRecord (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:20:15)
    at executeBrowserCodeRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:123:19)
    at runtimeState (webpack-internal:///(rsc)/./src/server/browser/browser-session.ts:4049:155)
    at BrowserCodeKernel.handleRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:3006:30)
    at BrowserCodeKernel.handleMessage (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2935:18)    at ChildProcess.eval (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2841:45)
Error: agent.state.set input must be an object.
    at inputRecord (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:20:15)
    at executeBrowserCodeRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:123:19)
    at runtimeState (webpack-internal:///(rsc)/./src/server/browser/browser-session.ts:4049:155)
    at BrowserCodeKernel.handleRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:3006:30)
    at BrowserCodeKernel.handleMessage (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2935:18)    at ChildProcess.eval (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2841:45)
⨯ uncaughtException: Error: agent.state.set input must be an object.
    at inputRecord (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:20:15)
    at executeBrowserCodeRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:123:19)
    at runtimeState (webpack-internal:///(rsc)/./src/server/browser/browser-session.ts:4049:155)
    at BrowserCodeKernel.handleRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:3006:30)
    at BrowserCodeKernel.handleMessage (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2935:18)    at ChildProcess.eval (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2841:45)
⨯ uncaughtException:  Error: agent.state.set input must be an object.
    at inputRecord (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:20:15)
    at executeBrowserCodeRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/storage/browser-code-runtime-state.ts:123:19)
    at runtimeState (webpack-internal:///(rsc)/./src/server/browser/browser-session.ts:4049:155)
    at BrowserCodeKernel.handleRuntimeStateOperation (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:3006:30)
    at BrowserCodeKernel.handleMessage (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2935:18)    at ChildProcess.eval (webpack-internal:///(rsc)/./src/server/browser/browser-code-runner.ts:2841:45)
{"time":"2026-08-28T07:53:48.794Z","level":"info","event":"ai.runtime.request.attempt_succeeded","operationId":"msg_3ae0d4728d5a","attemptId":"msg_3ae0d4728d5a:step:2:attempt:1","attemptNumber":1,"attemptLimit":3,"provider":"openai-compatible","model":"minimax-m3","finishReason":"stop","responseFinished":true,"responseStatus":"passed"}
 GET /api/browser-chat/chat_9db47175df02/logs?limit=200&messageId=msg_3ae0d4728d5a 200 in 139ms (next.js: 16ms, application-code: 123ms)

 1.我要你自己验证一下，你自己调用现在的uno流程生成一套ppt和docx的文件，要求覆盖所有会出现的情况，内容是所有ppt，docx里面会有的任何内容，你看看这套逻辑有没有什么漏洞以及问题
2.折叠时的加载状态可以参照消息hover删除的样式，在右上角有个绿或者主题色的三角形，里面有个旋转的加载图标