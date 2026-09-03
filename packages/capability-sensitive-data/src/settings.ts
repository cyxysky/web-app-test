import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';
import {
  defaultGlinerOpenLabelModel,
  defaultLiquidPiiModel,
} from './config.js';

const booleanOptions = [
  { label: '开启', value: 'true' },
  { label: '关闭', value: 'false' },
] as const;

export const sensitiveDataCapabilitySettings = [
  { key: 'AI_SENSITIVE_DATA_FILTER_ENABLED', label: 'AI 敏感数据过滤', description: '在模型请求发出前过滤系统、消息与工具文本中的敏感数据。', section: 'sensitive-data', group: '脱敏策略', defaultValue: 'false', control: 'boolean', applyMode: 'runtime', options: booleanOptions },
  { key: 'GLINER_RUNTIME_MODE', label: 'GLiNER 运行模式', description: 'auto 使用包内托管运行时；external 连接主应用指定的可信服务。', section: 'sensitive-data', group: '推理服务', defaultValue: 'auto', control: 'select', applyMode: 'startup', options: [{ label: '包内托管', value: 'auto' }, { label: '外部服务', value: 'external' }] },
  { key: 'GLINER_SERVICE_URL', label: 'GLiNER 服务地址', description: '内置或可信内网敏感实体识别服务地址。', section: 'sensitive-data', group: '推理服务', defaultValue: 'http://127.0.0.1:18001', control: 'text', applyMode: 'startup' },
  { key: 'GLINER_SERVICE_API_KEY', label: 'GLiNER 服务密钥', description: '连接外部敏感实体识别服务时使用的访问密钥。', section: 'sensitive-data', group: '推理服务', defaultValue: '', control: 'secret', applyMode: 'runtime', secret: true },
  { key: 'AI_SENSITIVE_DATA_FILTER_FAILURE_MODE', label: '敏感数据过滤故障策略', description: 'closed 会阻止未完成脱敏的模型请求；open 会继续发送原文。', section: 'sensitive-data', group: '脱敏策略', defaultValue: 'closed', control: 'select', applyMode: 'runtime', options: [{ label: '关闭模式（阻止请求）', value: 'closed' }, { label: '开放模式（继续请求）', value: 'open' }] },
  { key: 'AI_SENSITIVE_DATA_FILTER_TIMEOUT_MS', label: '敏感数据过滤超时', description: '等待本地模型完成单次脱敏的最长时间，单位毫秒。', section: 'sensitive-data', group: '脱敏策略', defaultValue: '60000', control: 'number', applyMode: 'runtime', min: 1000, max: 600000, step: 1000 },
  { key: 'AI_SENSITIVE_DATA_FILTER_THRESHOLD', label: 'GLiNER2.5 识别阈值', description: '开放标签识别置信度阈值。', section: 'sensitive-data', group: '脱敏策略', defaultValue: '0.5', control: 'number', applyMode: 'runtime', min: 0.05, max: 1, step: 0.05 },
  { key: 'AI_SENSITIVE_DATA_FILTER_LABELS', label: 'GLiNER2.5 敏感实体标签', description: '逗号或换行分隔的开放实体标签；留空使用服务内置标签。', section: 'sensitive-data', group: '脱敏策略', defaultValue: '', control: 'textarea', applyMode: 'runtime' },
  { key: 'GLINER_MODEL', label: 'GLiNER2.5 开放标签模型', description: 'GLiNER2.5/GLiNER2 AutoExtractor 检查点。', section: 'sensitive-data', group: '脱敏模型', defaultValue: defaultGlinerOpenLabelModel, control: 'text', applyMode: 'startup', emptyUsesDefault: true, valueAliases: { 'urchade/gliner_multi-v2.1': defaultGlinerOpenLabelModel } },
  { key: 'GLINER_PII_MODEL', label: 'LiquidAI 固定 PII 模型', description: '用于补充固定类别 PII 检测的模型。', section: 'sensitive-data', group: '脱敏模型', defaultValue: defaultLiquidPiiModel, control: 'text', applyMode: 'startup' },
  { key: 'GLINER_DEVICE', label: 'GLiNER 运行设备', description: '选择 CPU 或 CUDA 推理。', section: 'sensitive-data', group: '推理服务', defaultValue: 'cpu', control: 'select', applyMode: 'startup', options: [{ label: 'CPU', value: 'cpu' }, { label: 'CUDA', value: 'cuda' }] },
  { key: 'GLINER_BATCH_SIZE', label: 'GLiNER 批量大小', description: '单次推理批量大小；较高数值会占用更多内存。', section: 'sensitive-data', group: '推理服务', defaultValue: '8', control: 'number', applyMode: 'startup', min: 1, max: 128, step: 1 },
] as const satisfies readonly CapabilitySettingDefinition[];
