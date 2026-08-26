# GLiNER 敏感数据过滤

## 工作方式

所有通过 `getModel()` 发起的 AI 请求都会先经过统一脱敏层，包括主 Agent、子 Agent、上下文摘要、技能生成、记忆提炼和多语言检索查询。脱敏层会把 system、user、assistant、tool 消息中的文本、推理文本、工具参数/结果以及内联文本文件替换为不包含原值的占位符：

```text
张三的邮箱是 zhangsan@example.com
→ [SENSITIVE_PERSON_1]的邮箱是[SENSITIVE_EMAIL_ADDRESS_1]
```

占位符不会在模型响应中自动还原，避免原值通过模型输出、工具调用、日志或下游系统再次暴露。图片、音频和二进制附件目前不执行 OCR 或多模态 DLP。

```text
AI SDK prompt
  → sensitive-data-filter.ts
  → 本机 GLiNER2.5 开放标签识别
  → 中文 RoBERTa 校正 company/organization 边界
  → 重叠裁决与最终脱敏
  → 占位符 prompt
  → 外部模型提供商
```

## 开箱即用的交付方式

三个正式交付物都包含 sidecar、Python、Python 依赖、`fastino/gliner2.5-multi-v1` 多语言开放标签模型和 `uer/roberta-base-finetuned-cluener2020-chinese` 中文边界模型。运行端不需要安装 Python、执行 pip、下载模型或单独启动 sidecar。

| 交付物 | 用户启动方式 | 内置内容与行为 |
| --- | --- | --- |
| 单 Docker 镜像 | `docker compose up -d` | 一个镜像、一个容器；WebPilot 按需启动镜像内部的 GLiNER 进程 |
| 服务端安装 EXE | 安装后启动 Windows 服务 | 内置 Node.js、Chromium、LibreOffice、Python、GLiNER 和模型 |
| Electron 安装包 | 安装并打开 WebPilot | Electron 自动启动内置服务端和 GLiNER，无外部运行时 |

GLiNER 仍以独立的本机子进程运行，这样模型推理与 Node.js 服务隔离，但它是应用内部实现，不是用户需要安装或维护的第二个产品。正式产物强制使用回环地址 `127.0.0.1:18001`，默认启用过滤，并使用 `closed` 故障策略。

### 构建 Windows 安装包

仅构建机器需要准备 Python 和下载依赖/模型。首次构建前执行：

```bash
npm run gliner:install
```

随后使用原有打包命令：

```bash
npm run server:installer
npm run desktop:installer
```

两个命令会自动执行 `gliner:bundle`，生成同一份 `dist-gliner-runtime/win32-x64` 自包含运行时并复制到各自产物。若依赖、模型、Python 版本和 sidecar 源码未变化，会复用已有运行时。构建机需使用 64 位 Windows Python 3.10 及以上版本；可用 `GLINER_BUNDLE_PYTHON_PATH` 指定构建用 Python。

自包含运行时包含完整 CPython、`site-packages` 和两个模型，因此安装包体积会明显增加。这是运行端完全离线、无需 Python 环境的代价。

### 构建 Docker 镜像

```bash
docker compose up -d --build
```

Dockerfile 在构建阶段安装 Linux Python 运行时和依赖并下载模型，最终只产生 `webpilot-qa:latest` 一个镜像。Compose 不再创建独立的 `webpilot-gliner` 镜像、容器或模型缓存卷。

Windows 上的 `dockerDesktopLinuxEngine` 或 `failed to connect to the docker API` 表示 Docker Desktop 的 Linux Engine 没有运行。只有构建/运行 Docker 版本时才需要 Docker；服务端 EXE、Electron 安装包和源码本地模式均不依赖 Docker。

## 源码本地开发

源码开发不把大型运行时提交到仓库，第一次在开发机执行：

```bash
npm run gliner:install
npm run dev
```

当 `.env` 中启用过滤且使用 `auto` 或 `local` 模式时，第一次脱敏测试或 AI 请求会自动启动 `.venv-gliner` 中的服务。首次使用可能从 Hugging Face 下载 GLiNER2.5 和中文 RoBERTa 两个模型。也可用 `npm run gliner:start` 手动启动以查看日志。

`npm run dev` 不会执行安装命令，因为自动 pip 安装会让普通前端启动变慢且不可预测；它会在运行时按需启动已经安装好的本机 GLiNER。

## 设置界面

过滤配置、单条测试和评测集位于独立的“设置 → 敏感数据过滤”页面，不在运行设置中。

- 单条测试会显示脱敏文本，以及每个“原文 → 占位符 → 实体标签”的替换明细；它不会调用外部 AI 模型，也不会持久化输入和结果。
- 评测集支持新增、删除和持久化用例。每个用例由测试文本及预期敏感原文组成，批量运行后显示通过数、精确率、召回率、漏检和误报。
- 评测集会保存到本地配置数据库，只应使用合成数据，不能把真实密码、令牌或个人隐私作为长期评测样本。

## 用户可配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AI_SENSITIVE_DATA_FILTER_ENABLED` | 源码本地 `false`；正式产物 `true` | 是否启用过滤 |
| `GLINER_SERVICE_URL` | `http://127.0.0.1:18001` | 私有服务地址；正式产物已自动配置 |
| `AI_SENSITIVE_DATA_FILTER_FAILURE_MODE` | `closed` | `closed` 阻止未脱敏请求；`open` 放行原文 |
| `AI_SENSITIVE_DATA_FILTER_TIMEOUT_MS` | `15000` | 单次脱敏超时，单位毫秒 |
| `AI_SENSITIVE_DATA_FILTER_THRESHOLD` | `0.5` | GLiNER2.5 第一阶段开放标签识别阈值 |
| `AI_SENSITIVE_DATA_FILTER_LABELS` | 空 | 逗号/换行分隔开放标签；空值使用 sidecar 默认 PII 标签；company/organization 类标签自动进入第二阶段校正 |
| `GLINER_MODEL` | `fastino/gliner2.5-multi-v1` | GLiNER2.5 多语言开放标签模型；正式产物已内置 |
| `GLINER_DEVICE` | `cpu` | `cuda` 需要使用带 CUDA 的 Python/PyTorch 重新制作运行时或镜像 |
| `GLINER_BATCH_SIZE` | `8` | 单次模型推理批量大小，按 CPU/GPU 内存调节 |

`GLINER_CHINESE_NER_MODEL` 默认使用 `uer/roberta-base-finetuned-cluener2020-chinese`，仅负责中文 company/organization 边界。`GLINER_RUNTIME_MODE`、`GLINER_PYTHON_PATH`、`GLINER_SERVICE_DIR`、`GLINER_MODEL_BUNDLE_DIR` 和 `GLINER_CHINESE_NER_MODEL_BUNDLE_DIR` 是打包/开发内部参数，不在普通设置页面暴露。正式产物会自动设置它们。

修改 `GLINER_MODEL` 或 `GLINER_DEVICE` 后需要重启应用。内置模型之外的模型需要在构建时重新打包；不要依赖终端用户首次运行时联网下载。

## 安全与已知边界

- 生产环境应保持 `closed`。只有明确接受原文外发风险的临时排障窗口才可使用 `open`。
- `/redact` 不记录请求体、响应体或实体原文。可以监控耗时、失败率和命中数，但不能把原值写入日志或指标标签。
- NER 是概率识别，不能承诺零漏报。sidecar 同时使用确定性规则补充邮箱、中国手机号/身份证号、IP、Luhn 校验后的银行卡号、常见 API token 和私钥等格式化秘密。
- 对中文 company/organization，第二阶段 CLUENER RoBERTa 的字符区间会替换与之重叠的 GLiNER2.5 粗边界；只有 RoBERTa 漏报时才使用企业后缀/关系词规则保守兜底。例如“甲有限公司向乙有限公司提供”应只脱敏两个公司，而不吞掉中间关系描述。
- 多语言模型不代表所有语言和业务实体准确率相同。应使用真实业务结构的合成数据维护评测集，并根据漏报/误报调整阈值和标签。
- 如果未来必须恢复占位符，只能在本地受控执行器中维护请求级短期映射；禁止把映射发送给模型或写入持久日志。

GLiNER2.5：<https://github.com/fastino-ai/GLiNER2>；中文边界模型：<https://huggingface.co/uer/roberta-base-finetuned-cluener2020-chinese>。
