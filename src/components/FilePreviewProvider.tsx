'use client';

import dynamic from 'next/dynamic';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { FileText, X } from 'lucide-react';
import type { PreviewSource } from '@open-file-viewer/core';
import { BeautifulLoadingState } from '@/components/BeautifulLoadingState';
import { useI18n } from '@/i18n/I18nProvider';
import { useTheme } from '@/theme/ThemeProvider';
import { AppModal } from '@/components/ui/app-modal';

function FilePreviewModuleLoading() {
  const { t } = useI18n();
  return <BeautifulLoadingState label={t('正在加载文件预览')} />;
}

const OpenFileViewerSurface = dynamic(
  () => import('@/components/OpenFileViewerSurface').then((module) => module.OpenFileViewerSurface),
  {
    loading: () => <FilePreviewModuleLoading />,
    ssr: false,
  },
);

const FILE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf', 'odt',
  'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv',
  'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'odp', 'ofd', 'epub', 'xps', 'oxps',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'jxl', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif',
  'mp4', 'webm', 'mov', 'mkv', 'avi', 'm3u8', 'flv', 'm2ts', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'midi', 'mid',
  'txt', 'md', 'markdown', 'json', 'jsonc', 'json5', 'ipynb', 'yaml', 'yml', 'toml', 'ini', 'xml', 'lrc',
  'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'css', 'scss', 'less', 'py', 'go', 'rs', 'rb', 'swift', 'kt', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'sql', 'proto', 'hcl', 'tex', 'gv', 'http',
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'eml', 'msg', 'mbox',
  'apk', 'bin', 'deb', 'dmg', 'exe', 'ipa', 'msi', 'pkg', 'rpm',
  'dxf', 'dwg', 'dwf', 'step', 'stp', 'ifc', 'gds', 'gdsii', 'oas', 'oasis',
  'gltf', 'glb', 'obj', 'stl', 'fbx', 'dae', '3mf', 'usdz',
  'geojson', 'topojson', 'kml', 'kmz', 'gpx', 'shp', 'drawio', 'excalidraw', 'xmind',
  'ttf', 'otf', 'woff', 'woff2', 'psd', 'psb', 'ai', 'eps', 'sqlite', 'sqlite3', 'db', 'wasm', 'parquet', 'avro', 'webarchive',
]);

export type FilePreviewRequest = {
  fileName: string;
  mimeType?: string;
  source: PreviewSource | (() => Promise<PreviewSource>);
};

type FilePreviewContextValue = {
  closeFilePreview: () => void;
  filePreviewOpen: boolean;
  openFilePreview: (request: FilePreviewRequest) => void;
};

const FilePreviewContext = createContext<FilePreviewContextValue | undefined>(undefined);

export function fileNameFromPreviewUrl(value: string) {
  try {
    const parsed = new URL(value, typeof window === 'undefined' ? 'http://127.0.0.1/' : window.location.href);
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) || 'file');
    return name || 'file';
  } catch {
    return value.split(/[?#]/, 1)[0]?.split('/').filter(Boolean).at(-1) || 'file';
  }
}

export function isFilePreviewHref(href?: string, fileName?: string) {
  const rawHref = String(href || '').trim();
  if (!rawHref || rawHref.startsWith('#') || /^(javascript|mailto|tel):/i.test(rawHref)) return false;
  const candidateName = String(fileName || fileNameFromPreviewUrl(rawHref)).trim();
  const extension = candidateName.match(/\.([a-z0-9]{1,12})(?:$|[?#])/i)?.[1]?.toLowerCase();
  if (extension && FILE_EXTENSIONS.has(extension)) return true;
  try {
    const url = new URL(rawHref, typeof window === 'undefined' ? 'http://127.0.0.1/' : window.location.href);
    return url.pathname.includes('/api/artifacts/') || url.pathname.includes('/api/tutorial/sample/');
  } catch {
    return false;
  }
}

export function FilePreviewProvider({ children }: { children: ReactNode }) {
  const { language, t } = useI18n();
  const { mode } = useTheme();
  const titleId = useId();
  const [request, setRequest] = useState<FilePreviewRequest | null>(null);
  const [resolvedSource, setResolvedSource] = useState<PreviewSource | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [error, setError] = useState('');

  const closeFilePreview = useCallback(() => {
    setRequest(null);
    setResolvedSource(null);
    setLoadingSource(false);
    setError('');
  }, []);
  const openFilePreview = useCallback((nextRequest: FilePreviewRequest) => {
    setRequest(nextRequest);
    setResolvedSource(typeof nextRequest.source === 'function' ? null : nextRequest.source);
    setLoadingSource(typeof nextRequest.source === 'function');
    setError('');
  }, []);

  useEffect(() => {
    if (!request || typeof request.source !== 'function') return undefined;
    let active = true;
    request.source()
      .then((source) => {
        if (!active) return;
        setResolvedSource(source);
        setLoadingSource(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : t('文件预览加载失败'));
        setLoadingSource(false);
      });
    return () => {
      active = false;
    };
  }, [request, t]);

  useEffect(() => {
    function handleFileLinkClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('.file-preview-dialog')) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.dataset.filePreview === 'false') return;
      const href = anchor.getAttribute('href') || '';
      if (anchor.hasAttribute('download')) return;
      try {
        const url = new URL(href, window.location.href);
        const download = url.searchParams.get('download');
        if (download !== null && !/^(0|false|no)$/i.test(download)) return;
      } catch {
        // Invalid links are ignored by the preview check below.
      }
      const fileName = anchor.dataset.fileName || fileNameFromPreviewUrl(href);
      if (!isFilePreviewHref(href, fileName)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openFilePreview({
        fileName,
        mimeType: anchor.dataset.fileType,
        source: anchor.href,
      });
    }
    document.addEventListener('click', handleFileLinkClick, true);
    return () => document.removeEventListener('click', handleFileLinkClick, true);
  }, [openFilePreview]);

  const contextValue = useMemo<FilePreviewContextValue>(() => ({
    closeFilePreview,
    filePreviewOpen: Boolean(request),
    openFilePreview,
  }), [closeFilePreview, openFilePreview, request]);

  const dialog = request ? (
    <AppModal
      ariaLabelledBy={titleId}
      dialogClassName="file-preview-dialog"
      onClose={closeFilePreview}
      size="preview"
    >
      <header className="ui-modal-header file-preview-header">
        <span aria-hidden="true" className="file-preview-heading-icon"><FileText size={18} /></span>
        <div className="file-preview-heading-copy">
          <h2 id={titleId}>{request.fileName}</h2>
          <p>{t('文件预览')}</p>
        </div>
        <button aria-label={t('关闭')} autoFocus className="ui-icon-button ui-modal-close" onClick={closeFilePreview} type="button">
          <X size={18} />
        </button>
      </header>
      <div className="ui-modal-body file-preview-stage">
        {loadingSource ? <BeautifulLoadingState label={t('正在读取文件')} /> : null}
        {!loadingSource && error ? (
          <div className="file-preview-error" role="alert">
            <FileText size={24} />
            <strong>{t('无法预览此文件')}</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {!loadingSource && !error && resolvedSource !== null ? (
          <OpenFileViewerSurface
            fileName={request.fileName}
            locale={language === 'en' ? 'en-US' : 'zh-CN'}
            mimeType={request.mimeType}
            onError={(reason) => setError(reason.message)}
            source={resolvedSource}
            theme={mode}
          />
        ) : null}
      </div>
    </AppModal>
  ) : null;

  return (
    <FilePreviewContext.Provider value={contextValue}>
      {children}
      {dialog}
    </FilePreviewContext.Provider>
  );
}

export function useFilePreview() {
  const context = useContext(FilePreviewContext);
  if (!context) throw new Error('useFilePreview must be used inside FilePreviewProvider');
  return context;
}
