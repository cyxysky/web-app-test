import type { CapabilitySettingDefinition } from '@webpilot/capability-sdk';

const booleanOptions = [
  { label: '开启', value: 'true' },
  { label: '关闭', value: 'false' },
] as const;

export const browserCapabilitySettings = [
  { key: 'BROWSER_PREVIEW_FPS', label: '实时预览帧率', description: '实时预览轮询截图并发送的目标帧率。', section: 'browser', group: '实时预览', defaultValue: '20', control: 'number', applyMode: 'runtime', min: 1, max: 60, step: 1 },
  { key: 'BROWSER_OUTPUT_PIXEL_RATIO', label: '截图输出像素倍率', description: '提高系统截图的输出像素密度，不改变网页 CSS 视口。', section: 'browser', group: '实时预览', defaultValue: '1.5', control: 'number', applyMode: 'runtime', min: 1, max: 2, step: 0.25 },
  { key: 'BROWSER_SCREENCAST_FORMAT', label: '实时预览图片格式', description: 'JPEG 体积较小；PNG 无损但编码和传输开销更高。', section: 'browser', group: '实时预览', defaultValue: 'jpeg', control: 'select', applyMode: 'runtime', options: [{ label: 'JPEG', value: 'jpeg' }, { label: 'PNG', value: 'png' }] },
  { key: 'BROWSER_SCREENCAST_QUALITY', label: '实时预览 JPEG 质量', description: '仅对 JPEG 生效。数值越高画质越好，开销也越高。', section: 'browser', group: '实时预览', defaultValue: '90', control: 'number', applyMode: 'runtime', min: 40, max: 100, step: 1 },
  { key: 'BROWSER_PREVIEW_TRANSPORT', label: '实时预览传输模式', description: '使用 H.264 视频流或独立图片帧传输实时预览。', section: 'browser', group: '实时预览', defaultValue: 'video', control: 'select', applyMode: 'runtime', options: [{ label: 'H.264 视频流', value: 'video' }, { label: 'JPEG/PNG 图片帧', value: 'image' }] },
  { key: 'BROWSER_PREVIEW_VIDEO_BITRATE_KBPS', label: '视频流码率', description: 'H.264 视频目标码率，留空时按分辨率和帧率自动估算。', section: 'browser', group: '实时预览', defaultValue: '', control: 'number', applyMode: 'runtime', min: 500, step: 250 },
  { key: 'BROWSER_PREVIEW_VIDEO_SOURCE_FORMAT', label: '视频编码源格式', description: '选择送入 H.264 编码器的源图片格式。', section: 'browser', group: '实时预览', defaultValue: 'png', control: 'select', applyMode: 'runtime', options: [{ label: 'PNG', value: 'png' }, { label: 'JPEG', value: 'jpeg' }] },
  { key: 'BROWSER_PREVIEW_VIDEO_MAX_WIDTH', label: '视频流最大宽度', description: '视频编码宽度上限，只进行等比缩小。', section: 'browser', group: '实时预览', defaultValue: '1920', control: 'number', applyMode: 'runtime', min: 320, max: 4096, step: 2 },
  { key: 'BROWSER_PREVIEW_VIDEO_MAX_HEIGHT', label: '视频流最大高度', description: '视频编码高度上限，只进行等比缩小。', section: 'browser', group: '实时预览', defaultValue: '1080', control: 'number', applyMode: 'runtime', min: 240, max: 2160, step: 2 },
  { key: 'BROWSER_PREVIEW_VIDEO_KEYFRAME_INTERVAL', label: '视频关键帧间隔', description: 'H.264 关键帧间隔，单位为帧。', section: 'browser', group: '实时预览', defaultValue: '15', control: 'number', applyMode: 'runtime', min: 1, max: 120, step: 1 },
  { key: 'BROWSER_PROFILE_CLEAR_CACHE_ON_CLOSE', label: '关闭后清理浏览器缓存', description: '浏览器进程完全关闭后清理缓存并保留登录态及站点数据。', section: 'browser', group: '浏览器实例', defaultValue: 'true', control: 'boolean', applyMode: 'startup', options: booleanOptions },
  { key: 'BROWSER_USER_BROWSER_IDLE_TIMEOUT_MS', label: '用户浏览器空闲回收时间', description: '没有运行中的对话和实时预览后，等待该时长关闭测试浏览器。', section: 'browser', group: '浏览器实例', defaultValue: '180000', control: 'number', applyMode: 'runtime', min: 60000, max: 86400000, step: 60000 },
  { key: 'ELECTRON_EMBEDDED_BROWSER', label: '嵌入式 Electron 浏览器', description: '桌面端对话使用 Electron 原生浏览器视图。', section: 'browser', group: '浏览器实例', defaultValue: 'false', control: 'boolean', applyMode: 'startup', options: booleanOptions },
  { key: 'HEADLESS_BROWSER', label: '无头浏览器', description: '是否隐藏浏览器窗口运行。', section: 'browser', group: '浏览器实例', defaultValue: 'false', control: 'boolean', applyMode: 'startup', options: booleanOptions },
  { key: 'BROWSER_VIEWPORT_MODE', label: '视口模式', description: '自动跟随真实窗口，或使用固定视口尺寸。', section: 'browser', group: '浏览器实例', defaultValue: 'auto', control: 'select', applyMode: 'startup', options: [{ label: '自动跟随窗口', value: 'auto' }, { label: '固定宽高', value: 'fixed' }] },
  { key: 'BROWSER_VIEWPORT_WIDTH', label: '视口宽度', description: '固定视口模式下的浏览器宽度。', section: 'browser', group: '浏览器实例', defaultValue: '', control: 'number', applyMode: 'startup', min: 1, step: 1 },
  { key: 'BROWSER_VIEWPORT_HEIGHT', label: '视口高度', description: '固定视口模式下的浏览器高度。', section: 'browser', group: '浏览器实例', defaultValue: '', control: 'number', applyMode: 'startup', min: 1, step: 1 },
  { key: 'BROWSER_NAVIGATION_DOM_QUIET_MS', label: '导航后 DOM 静默窗口', description: '导航提交后 DOM 连续保持不变达到该时长即生成语义快照。', section: 'browser', group: '导航与诊断', defaultValue: '250', control: 'number', applyMode: 'runtime' },
  { key: 'BROWSER_NAVIGATION_DOM_STABILITY_TIMEOUT_MS', label: '导航后 DOM 稳定上限', description: '等待导航后 DOM 稳定的最长时间。', section: 'browser', group: '导航与诊断', defaultValue: '1000', control: 'number', applyMode: 'runtime' },
  { key: 'BROWSER_IGNORE_HTTPS_ERRORS', label: '忽略 HTTPS 错误', description: '测试环境证书异常时允许继续打开页面。', section: 'browser', group: '导航与诊断', defaultValue: 'true', control: 'boolean', applyMode: 'startup', options: booleanOptions },
  { key: 'BROWSER_HTTP_REQUEST_HISTORY_LIMIT', label: 'HTTP 请求历史上限', description: '每个标签页保留的 HTTP 请求记录数。', section: 'browser', group: '导航与诊断', defaultValue: '400', control: 'number', applyMode: 'runtime' },
  { key: 'AI_HTTP_REQUEST_TOOL_LIMIT', label: 'HTTP 请求工具返回条数', description: '浏览器工具单次返回的最近 HTTP 请求条数。', section: 'browser', group: '导航与诊断', defaultValue: '80', control: 'number', applyMode: 'runtime' },
  { key: 'SCREENSHOT_TIMEOUT_MS', label: '截图超时', description: 'Playwright 截图等待上限，单位毫秒。', section: 'browser', group: '导航与诊断', defaultValue: '15000', control: 'number', applyMode: 'runtime' },
  { key: 'MANUAL_VERIFICATION_TIMEOUT_MS', label: '人工验证等待时间', description: '验证码、登录或设备验证的最长等待时间。', section: 'runtime', group: '浏览器 Agent', defaultValue: '180000', control: 'number', applyMode: 'runtime' },
  { key: 'BROWSER_CHAT_KEEP_BROWSER_OPEN_AFTER_TURN', label: '对话完成保留浏览器', description: '每轮对话完成后保留浏览器，以便后续对话复用。', section: 'runtime', group: '浏览器 Agent', defaultValue: 'true', control: 'boolean', applyMode: 'runtime', options: booleanOptions },
  { key: 'BROWSER_CHAT_ACTION_FRAME_LIMIT', label: '对话动作 Frame 上限', description: '每次动作参与交互校验与 DOM 增量采集的 frame 数量。', section: 'runtime', group: '浏览器 Agent', defaultValue: '24', control: 'number', applyMode: 'runtime' },
  { key: 'BROWSER_CHAT_SHOW_REASONING', label: '对话展示思维链', description: '是否在对话模式中展示模型返回的推理内容。', section: 'runtime', group: '浏览器 Agent', defaultValue: 'false', control: 'boolean', applyMode: 'runtime', options: booleanOptions },
  { key: 'BROWSER_CHAT_LOG_LIMIT', label: '对话日志保留上限', description: '每个浏览器对话最多保留的执行日志条数。', section: 'runtime', group: '浏览器 Agent', defaultValue: '2000', control: 'number', applyMode: 'runtime' },
  { key: 'AI_VISUAL_HISTORY_LIMIT', label: '视觉历史上限', description: 'Visual Context Manager 保留的历史图片数量。', section: 'runtime', group: '浏览器 Agent', defaultValue: '6', control: 'number', applyMode: 'runtime' },
  { key: 'AI_COMPLETION_VERIFY', label: '完成结果二次校验', description: 'Agent 声明完成后是否再进行一次完成校验。', section: 'debug', group: '浏览器调试', defaultValue: 'true', control: 'boolean', applyMode: 'runtime', options: booleanOptions },
  { key: 'PLAYWRIGHT_TRACE', label: 'Playwright Trace', description: '是否保存 Playwright trace。', section: 'debug', group: '浏览器调试', defaultValue: 'true', control: 'boolean', applyMode: 'startup', options: booleanOptions },
] as const satisfies readonly CapabilitySettingDefinition[];

