const english = {
  '新建标签页': 'New tab',
  '新建标签组': 'New tab group',
  '选择下载位置': 'Choose download location',
  '复制标签页': 'Duplicate tab',
  '取消固定标签页': 'Unpin tab',
  '固定标签页': 'Pin tab',
  '关闭其他标签页': 'Close other tabs',
  '移动到分组': 'Move to group',
  '标签组 {id}': 'Tab group {id}',
  '智能浏览器测试工作区': 'AI browser workspace',
  '正在初始化工作区…': 'Initializing workspace…',
  '首次启动可能需要更长时间，请稍候。': 'The first launch may take longer. Please wait.',
  '启动失败': 'Startup failed',
  '重新启动': 'Restart',
  '查看日志': 'View logs',
  '退出': 'Quit',
  '未能完成启动': 'Startup could not be completed',
  '启动失败，请重试或查看日志。': 'Startup failed. Try again or view the logs.',
  '正在恢复浏览器工作区…': 'Restoring browser workspace…',
  '服务仍在启动，请稍候…': 'The service is still starting. Please wait…',
  '正在连接本地服务…': 'Connecting to the local service…',
  '正在启动本地服务…': 'Starting the local service…',
  '服务已就绪，正在加载界面…': 'Service ready. Loading the interface…',
  '工作区已准备完成': 'Workspace ready',
};

function translateDesktopText(language, text, params = {}) {
  const value = language === 'en' ? english[text] || text : text;
  return value.replace(/\{(\w+)\}/g, (match, key) => params[key] === undefined ? match : String(params[key]));
}

module.exports = { translateDesktopText };
