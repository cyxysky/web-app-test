export type SystemDownloadStatus = 'selecting' | 'pending' | 'downloading' | 'completed' | 'cancelled' | 'failed' | string;

export type SystemDownloadItem = {
  completedAt?: number;
  error?: string;
  fileName?: string;
  id: string;
  path?: string;
  progress?: number;
  receivedBytes?: number;
  startedAt?: number;
  status?: SystemDownloadStatus;
  totalBytes?: number;
  updatedAt?: number;
  url?: string;
};

export function formatDownloadBytes(value?: number) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
  return `${Math.round(bytes / 1024 / 1024 / 102.4) / 10} GB`;
}

export function browserChatDownloadStatusLabel(status?: SystemDownloadStatus) {
  if (status === 'selecting') return '选择保存目录';
  if (status === 'pending') return '准备下载';
  if (status === 'downloading') return '下载中';
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'failed') return '下载失败';
  return '下载';
}

export function browserChatDownloadPercent(download: SystemDownloadItem) {
  if (typeof download.progress === 'number' && Number.isFinite(download.progress)) {
    return Math.max(0, Math.min(100, Math.round(download.progress * 100)));
  }
  if (download.status === 'completed') return 100;
  return undefined;
}
