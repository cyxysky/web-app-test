'use client';

import { type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Download, Globe, Loader2, X } from 'lucide-react';
import { AppModal } from '@/components/ui/app-modal';
import { AppInput } from '@/components/ui/app-input';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

type BrowserChatPreviewTab = {
  id: string;
  index: number;
  url: string;
  active: boolean;
};

type BrowserChatPreviewFrame = {
  capturedAt: string;
  contentType: 'image/jpeg' | 'image/png';
  imageUrl: string;
  sequence?: number;
  tabs: BrowserChatPreviewTab[];
  url: string;
  viewport: { width: number; height: number };
};

type BrowserChatPreviewServerMetrics = {
  activeCaptures?: number;
  backpressureDrops?: number;
  bitrateKbps?: number;
  captureDurationMs?: number;
  captureDurationMsAverage?: number;
  captureFps?: number;
  height?: number;
  h264Level?: string;
  h264Profile?: string;
  imageFormat?: 'jpeg' | 'png';
  imageQuality?: number;
  maxConcurrentCaptures?: number;
  mimeType?: string;
  pendingClientFrames?: number;
  sendFps?: number;
  targetFps?: number;
  transport?: 'image' | 'video';
  width?: number;
};

type BrowserChatPreviewDisplayMetrics = BrowserChatPreviewServerMetrics & {
  displayedFps: number;
  receivedFps: number;
};

const BROWSER_CHAT_PREVIEW_VIDEO_MIME_TYPE = 'video/mp4; codecs="avc1.42C029"';

type BrowserChatPreviewInput =
  | { kind: 'tab'; tabId: string }
  | { kind: 'move'; xRatio: number; yRatio: number }
  | { kind: 'click'; xRatio: number; yRatio: number; button: 'left' | 'right' | 'middle'; clickCount: number }
  | { kind: 'drag'; xRatio: number; yRatio: number; toXRatio: number; toYRatio: number; button: 'left' | 'right' | 'middle' }
  | { kind: 'scroll'; xRatio: number; yRatio: number; deltaX: number; deltaY: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string }
  | { kind: 'select'; xRatio: number; yRatio: number; value: string }
  | { controlKind: 'datalist' | 'picker'; kind: 'controlValue'; value: string; xRatio: number; yRatio: number }
  | { controlId: string; files: Array<{ mimeType: string; name: string; path: string }>; kind: 'files' }
  | { accept: boolean; dialogId: string; kind: 'dialog'; promptText?: string };

type BrowserChatPreviewNativeControlPosition = {
  label: string;
  openUpwards: boolean;
  targetXRatio: number;
  targetYRatio: number;
  topRatio: number;
  widthRatio: number;
  xRatio: number;
  yRatio: number;
};

type BrowserChatPreviewNativeControl = BrowserChatPreviewNativeControlPosition & ({
  kind: 'select';
  options: Array<{
    disabled: boolean;
    group?: string;
    label: string;
    selected: boolean;
    value: string;
  }>;
  selectedValue: string;
} | {
  kind: 'datalist';
  options: Array<{ label: string; value: string }>;
  value: string;
} | {
  inputType: 'color' | 'date' | 'datetime-local' | 'month' | 'time' | 'week';
  kind: 'picker';
  max?: string;
  min?: string;
  step?: string;
  value: string;
} | {
  accept: string;
  capture?: string;
  controlId: string;
  kind: 'file';
  multiple: boolean;
});

type BrowserChatPreviewDialog = {
  defaultValue: string;
  dialogType: 'alert' | 'beforeunload' | 'confirm' | 'prompt';
  id: string;
  message: string;
};

type BrowserChatPreviewDownload = {
  bytes?: number;
  delivery?: 'pending' | 'started';
  error?: string;
  fileName: string;
  id: string;
  status: 'preparing' | 'ready';
  url?: string;
};

export function BrowserChatWebPreviewModal({
  onClose,
  sessionId,
  userId,
}: {
  onClose: () => void;
  sessionId: string;
  userId: string;
}) {
  const { t } = useI18n();
  const streamRef = useRef<WebSocket | null>(null);
  const reconnectEnabledRef = useRef(true);
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewStageRef = useRef<HTMLDivElement | null>(null);
  const previewFileInputRef = useRef<HTMLInputElement | null>(null);
  const handledPreviewDownloadIdsRef = useRef(new Set<string>());
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const videoChunkQueueRef = useRef<Uint8Array[]>([]);
  const videoObjectUrlRef = useRef('');
  const forceImageTransportRef = useRef(false);
  const pumpVideoChunksRef = useRef<() => void>(() => undefined);
  const pendingFrameRef = useRef<BrowserChatPreviewFrame | null>(null);
  const frameObjectUrlRef = useRef('');
  const staleFrameObjectUrlRef = useRef('');
  const decodingFrameObjectUrlRef = useRef('');
  const frameDecodeActiveRef = useRef(false);
  const framePipelineDisposedRef = useRef(false);
  const frameCountersRef = useRef({
    displayed: 0,
    received: 0,
    sampledAt: Date.now(),
    sampledDisplayed: 0,
    sampledReceived: 0,
  });
  const frameStateRef = useRef<Pick<BrowserChatPreviewFrame, 'tabs' | 'url' | 'viewport'>>({
    tabs: [],
    url: '',
    viewport: { height: 720, width: 1280 },
  });
  const pendingMoveRef = useRef<Extract<BrowserChatPreviewInput, { kind: 'move' }> | null>(null);
  const pointerGestureRef = useRef<{
    button: 'left' | 'middle';
    clickCount: number;
    current: { xRatio: number; yRatio: number };
    dragged: boolean;
    pointerId: number;
    start: { xRatio: number; yRatio: number };
    startClientX: number;
    startClientY: number;
  } | null>(null);
  const moveFlushTimerRef = useRef<number | undefined>(undefined);
  const pendingScrollRef = useRef<Extract<BrowserChatPreviewInput, { kind: 'scroll' }> | null>(null);
  const scrollFlushTimerRef = useRef<number | undefined>(undefined);
  const [frame, setFrame] = useState<BrowserChatPreviewFrame | null>(null);
  const [previewTransport, setPreviewTransport] = useState<'image' | 'video'>('video');
  const [videoObjectUrl, setVideoObjectUrl] = useState('');
  const [videoDisplayReady, setVideoDisplayReady] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'live' | 'reconnecting' | 'unavailable'>('connecting');
  const [streamError, setStreamError] = useState('');
  const [inputError, setInputError] = useState('');
  const [previewMetrics, setPreviewMetrics] = useState<BrowserChatPreviewDisplayMetrics | null>(null);
  const [nativeControl, setNativeControl] = useState<BrowserChatPreviewNativeControl | null>(null);
  const [nativeControlPosition, setNativeControlPosition] = useState<CSSProperties | null>(null);
  const [nativeControlBusy, setNativeControlBusy] = useState(false);
  const [nativePickerValue, setNativePickerValue] = useState('');
  const [nativeDialog, setNativeDialog] = useState<BrowserChatPreviewDialog | null>(null);
  const [nativeDialogPrompt, setNativeDialogPrompt] = useState('');
  const [previewDownload, setPreviewDownload] = useState<BrowserChatPreviewDownload | null>(null);
  const videoPipelineErrorRef = useRef<(message: string) => void>(() => undefined);
  const previewViewportWidth = frame?.viewport.width;
  const previewViewportHeight = frame?.viewport.height;

  useLayoutEffect(() => {
    const stage = previewStageRef.current;
    if (!nativeControl || !previewViewportWidth || !previewViewportHeight || !stage) {
      setNativeControlPosition(null);
      return undefined;
    }
    const updatePosition = () => {
      const stageRect = stage.getBoundingClientRect();
      if (!stageRect.width || !stageRect.height) return;
      const sourceRatio = Math.max(1, previewViewportWidth) / Math.max(1, previewViewportHeight);
      const stageRatio = stageRect.width / stageRect.height;
      const contentWidth = stageRatio > sourceRatio ? stageRect.height * sourceRatio : stageRect.width;
      const contentHeight = stageRatio > sourceRatio ? stageRect.height : stageRect.width / sourceRatio;
      const contentLeft = (stageRect.width - contentWidth) / 2;
      const contentTop = (stageRect.height - contentHeight) / 2;
      const menuWidth = Math.min(
        Math.max(nativeControl.widthRatio * contentWidth, Math.min(220, contentWidth - 16)),
        Math.max(0, contentWidth - 16),
      );
      const desiredLeft = contentLeft + nativeControl.xRatio * contentWidth;
      const left = Math.min(
        Math.max(contentLeft + 8, desiredLeft),
        Math.max(contentLeft + 8, contentLeft + contentWidth - menuWidth - 8),
      );
      setNativeControlPosition({
        left,
        width: menuWidth,
        ...(nativeControl.openUpwards
          ? { bottom: stageRect.height - (contentTop + nativeControl.topRatio * contentHeight) }
          : { top: contentTop + nativeControl.yRatio * contentHeight }),
      });
    };
    updatePosition();
    const resizeObserver = new ResizeObserver(updatePosition);
    resizeObserver.observe(stage);
    return () => resizeObserver.disconnect();
  }, [nativeControl, previewViewportHeight, previewViewportWidth]);

  useEffect(() => {
    setNativePickerValue(nativeControl?.kind === 'picker' ? nativeControl.value : '');
    setNativeControlBusy(false);
  }, [nativeControl]);

  useEffect(() => {
    if (nativeControl?.kind !== 'file') return undefined;
    const animationFrame = window.requestAnimationFrame(() => {
      try {
        previewFileInputRef.current?.click();
      } catch (error) {
        setNativeControl(null);
        setInputError(error instanceof Error ? error.message : '无法打开系统文件选择器');
      }
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [nativeControl]);

  const disposeVideoPipeline = useCallback((updateState = true) => {
    const sourceBuffer = sourceBufferRef.current;
    sourceBufferRef.current = null;
    videoChunkQueueRef.current = [];
    if (sourceBuffer?.updating) {
      try { sourceBuffer.abort(); } catch { /* MediaSource may already be closed. */ }
    }
    const mediaSource = mediaSourceRef.current;
    mediaSourceRef.current = null;
    if (mediaSource?.readyState === 'open') {
      try { mediaSource.endOfStream(); } catch { /* Decoder teardown is best-effort. */ }
    }
    if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
    videoObjectUrlRef.current = '';
    if (updateState) {
      setVideoObjectUrl('');
      setVideoDisplayReady(false);
    }
  }, []);

  const pumpVideoChunks = useCallback(() => {
    const sourceBuffer = sourceBufferRef.current;
    if (!sourceBuffer || sourceBuffer.updating) return;
    const next = videoChunkQueueRef.current.shift();
    if (next) {
      try {
        const copy = new Uint8Array(next.byteLength);
        copy.set(next);
        sourceBuffer.appendBuffer(copy.buffer);
      } catch (error) {
        videoPipelineErrorRef.current(error instanceof Error ? error.message : '视频缓冲区写入失败');
      }
      return;
    }
    const video = previewVideoRef.current;
    if (!video || !sourceBuffer.buffered.length) return;
    const lastRange = sourceBuffer.buffered.length - 1;
    const start = sourceBuffer.buffered.start(0);
    const end = sourceBuffer.buffered.end(lastRange);
    if (end - video.currentTime > 0.6) video.currentTime = Math.max(start, end - 0.12);
    if (end - start > 8) {
      try { sourceBuffer.remove(0, Math.max(0, end - 3)); } catch { /* A later update trims again. */ }
    }
    void video.play().catch(() => undefined);
  }, []);
  pumpVideoChunksRef.current = pumpVideoChunks;

  const beginVideoPipeline = useCallback((contentType: string, initialization: Uint8Array) => {
    disposeVideoPipeline();
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(contentType)) return false;
    setVideoDisplayReady(false);
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    mediaSourceRef.current = mediaSource;
    videoObjectUrlRef.current = objectUrl;
    videoChunkQueueRef.current = [initialization];
    mediaSource.addEventListener('sourceopen', () => {
      if (mediaSourceRef.current !== mediaSource) return;
      try {
        const sourceBuffer = mediaSource.addSourceBuffer(contentType);
        sourceBuffer.mode = 'segments';
        sourceBufferRef.current = sourceBuffer;
        sourceBuffer.addEventListener('updateend', () => {
          if (sourceBufferRef.current === sourceBuffer) pumpVideoChunksRef.current();
        });
        sourceBuffer.addEventListener('error', () => {
          if (sourceBufferRef.current === sourceBuffer) videoPipelineErrorRef.current('H.264 视频解码失败');
        });
        pumpVideoChunksRef.current();
      } catch (error) {
        videoPipelineErrorRef.current(error instanceof Error ? error.message : '无法创建 H.264 视频缓冲区');
      }
    }, { once: true });
    setVideoObjectUrl(objectUrl);
    setPreviewTransport('video');
    return true;
  }, [disposeVideoPipeline]);

  const enqueueVideoChunk = useCallback((chunk: Uint8Array) => {
    if (!mediaSourceRef.current) return;
    if (videoChunkQueueRef.current.length >= 240) {
      videoPipelineErrorRef.current('视频缓冲积压过多，正在回退到图片预览');
      return;
    }
    videoChunkQueueRef.current.push(chunk);
    pumpVideoChunksRef.current();
  }, []);

  const fallbackToImagePreview = useCallback((message: string) => {
    forceImageTransportRef.current = true;
    setPreviewTransport('image');
    disposeVideoPipeline();
    setStreamError(message);
    const stream = streamRef.current;
    if (stream?.readyState === WebSocket.OPEN || stream?.readyState === WebSocket.CONNECTING) stream.close();
  }, [disposeVideoPipeline]);
  videoPipelineErrorRef.current = fallbackToImagePreview;

  const deliverPreviewDownload = useCallback(async (
    download: BrowserChatPreviewDownload,
    options: { repeat?: boolean; userInitiated?: boolean } = {},
  ) => {
    if (!download.url) return;
    const bridge = typeof window === 'undefined' ? undefined : window.webPilotSystem;
    // Chromium blocks repeated downloads started from asynchronous WebSocket
    // callbacks. On the web, wait for the user to click the notice button so
    // anchor.click() runs inside a real user-activation handler.
    if (!bridge?.downloadUrl && !options.userInitiated) return;
    if (!options.repeat && handledPreviewDownloadIdsRef.current.has(download.id)) return;
    handledPreviewDownloadIdsRef.current.add(download.id);
    try {
      const url = withWebPilotBasePath(download.url);
      if (bridge?.downloadUrl) {
        const result = await bridge.downloadUrl({ fileName: download.fileName, url });
        if (!result.ok) throw new Error(result.error || '下载文件失败');
      } else {
        const anchor = document.createElement('a');
        anchor.download = download.fileName;
        anchor.href = url;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
      setPreviewDownload((current) => current?.id === download.id
        ? { ...current, delivery: 'started' }
        : current);
    } catch (error) {
      handledPreviewDownloadIdsRef.current.delete(download.id);
      setInputError(error instanceof Error ? error.message : '下载文件失败');
    }
  }, []);

  useEffect(() => {
    if (!previewDownload) return undefined;
    const timeoutMs = previewDownload.delivery === 'started'
      ? 4_000
      : previewDownload.status === 'ready' ? 15_000 : 20_000;
    const timer = window.setTimeout(() => {
      setPreviewDownload((current) => current?.id === previewDownload.id ? null : current);
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [previewDownload]);

  const commitPendingPreviewFrame = useCallback(async function commitPendingPreviewFrame() {
    if (framePipelineDisposedRef.current || frameDecodeActiveRef.current) return;
    const nextFrame = pendingFrameRef.current;
    if (!nextFrame) return;
    pendingFrameRef.current = null;
    frameDecodeActiveRef.current = true;
    decodingFrameObjectUrlRef.current = nextFrame.imageUrl;
    let committed = false;
    try {
      const decodedImage = new Image();
      decodedImage.decoding = 'async';
      decodedImage.src = nextFrame.imageUrl;
      await decodedImage.decode();
      if (framePipelineDisposedRef.current) return;

      if (staleFrameObjectUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(staleFrameObjectUrlRef.current);
      }
      staleFrameObjectUrlRef.current = frameObjectUrlRef.current;
      frameObjectUrlRef.current = nextFrame.imageUrl;
      decodingFrameObjectUrlRef.current = '';
      committed = true;
      frameCountersRef.current.displayed += 1;
      setFrame(nextFrame);
      setStatus('live');
      setStreamError('');
    } catch {
      // A newer frame remains queued and will be decoded below.
    } finally {
      if (!committed && nextFrame.imageUrl.startsWith('blob:')) {
        URL.revokeObjectURL(nextFrame.imageUrl);
      }
      if (decodingFrameObjectUrlRef.current === nextFrame.imageUrl) {
        decodingFrameObjectUrlRef.current = '';
      }
      frameDecodeActiveRef.current = false;
      if (!framePipelineDisposedRef.current && pendingFrameRef.current) {
        void commitPendingPreviewFrame();
      }
    }
  }, []);

  const queuePreviewFrame = useCallback((nextFrame: BrowserChatPreviewFrame) => {
    if (framePipelineDisposedRef.current) {
      if (nextFrame.imageUrl.startsWith('blob:')) URL.revokeObjectURL(nextFrame.imageUrl);
      return;
    }
    const previousPending = pendingFrameRef.current?.imageUrl;
    if (previousPending?.startsWith('blob:')) URL.revokeObjectURL(previousPending);
    pendingFrameRef.current = nextFrame;
    void commitPendingPreviewFrame();
  }, [commitPendingPreviewFrame]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    reconnectEnabledRef.current = true;
    const connect = async () => {
      try {
        const response = await fetch(
          `${withWebPilotBasePath('/api/browser-chat/preview-stream')}?sessionId=${encodeURIComponent(sessionId)}`,
          { cache: 'no-store', method: 'POST' },
        );
        const data = await response.json() as { error?: string; transport?: 'image' | 'video'; url?: string };
        if (!response.ok || !data.url) throw new Error(data.error || '实时界面连接失败');
        if (disposed) return;
        const videoSupported = typeof MediaSource !== 'undefined'
          && MediaSource.isTypeSupported(BROWSER_CHAT_PREVIEW_VIDEO_MIME_TYPE);
        const requestedTransport = data.transport === 'image' || forceImageTransportRef.current || !videoSupported
          ? 'image'
          : 'video';
        setPreviewTransport(requestedTransport);
        disposeVideoPipeline();
        const url = new URL(data.url);
        url.searchParams.set('sessionId', sessionId);
        url.searchParams.set('transport', requestedTransport);
        const stream = new WebSocket(url);
        stream.binaryType = 'arraybuffer';
        streamRef.current = stream;
        stream.onopen = () => {
          const counters = frameCountersRef.current;
          counters.sampledAt = Date.now();
          counters.sampledDisplayed = counters.displayed;
          counters.sampledReceived = counters.received;
          frameStateRef.current = { tabs: [], url: '', viewport: { height: 720, width: 1280 } };
          setPreviewMetrics(null);
          setStatus('connecting');
          setStreamError('');
        };
        stream.onmessage = (event) => {
          try {
            if (event.data instanceof ArrayBuffer) {
              const bytes = new Uint8Array(event.data);
              if (bytes.byteLength < 4) throw new Error('Invalid binary frame');
              const metadataLength = new DataView(event.data).getUint32(0, false);
              if (metadataLength <= 0 || metadataLength + 4 > bytes.byteLength) throw new Error('Invalid binary metadata');
              const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + metadataLength))) as {
                capturedAt?: string;
                contentType?: string;
                sequence?: number;
                type?: 'frame' | 'videoChunk' | 'videoInit';
              };
              const payload = bytes.slice(4 + metadataLength);
              if (metadata.type === 'videoInit') {
                if (!metadata.contentType || !beginVideoPipeline(metadata.contentType, payload)) {
                  fallbackToImagePreview('当前客户端不支持该 H.264 视频流，正在回退到图片预览');
                }
                return;
              }
              if (metadata.type === 'videoChunk') {
                frameCountersRef.current.received += 1;
                enqueueVideoChunk(payload);
                return;
              }
              if (metadata.type !== 'frame' || (metadata.contentType !== 'image/jpeg' && metadata.contentType !== 'image/png')) {
                throw new Error('Unknown binary preview payload');
              }
              frameCountersRef.current.received += 1;
              const imageUrl = URL.createObjectURL(new Blob(
                [payload],
                { type: metadata.contentType },
              ));
              queuePreviewFrame({
                ...frameStateRef.current,
                capturedAt: metadata.capturedAt || new Date().toISOString(),
                contentType: metadata.contentType,
                imageUrl,
                sequence: metadata.sequence,
              });
              return;
            }
            const message = JSON.parse(String(event.data)) as BrowserChatPreviewFrame & {
              error?: string;
              height?: number;
              metrics?: BrowserChatPreviewServerMetrics;
              control?: BrowserChatPreviewNativeControl;
              dialog?: BrowserChatPreviewDialog;
              dialogId?: string;
              download?: Omit<BrowserChatPreviewDownload, 'status'>;
              transport?: 'image' | 'video';
              type?: string;
              width?: number;
            };
            if (message.type === 'tabsChanged' && Array.isArray(message.tabs)) {
              setNativeControl(null);
              frameStateRef.current = { ...frameStateRef.current, tabs: message.tabs };
              setFrame((current) => current ? { ...current, tabs: message.tabs } : current);
            } else if (message.type === 'navigationChanged' && typeof message.url === 'string') {
              setNativeControl(null);
              frameStateRef.current = { ...frameStateRef.current, url: message.url };
              setFrame((current) => current ? { ...current, url: message.url } : current);
            } else if (message.type === 'viewportChanged' && message.viewport) {
              frameStateRef.current = { ...frameStateRef.current, viewport: message.viewport };
              setFrame((current) => current ? { ...current, viewport: message.viewport } : current);
            } else if (
              message.type === 'videoReady'
              && typeof message.width === 'number'
              && typeof message.height === 'number'
            ) {
              frameStateRef.current = {
                ...frameStateRef.current,
                viewport: { width: message.width, height: message.height },
              };
            } else if (message.type === 'frameHeartbeat' && message.metrics) {
              const counters = frameCountersRef.current;
              const sampledAt = Date.now();
              const sampleSeconds = Math.max(0.001, (sampledAt - counters.sampledAt) / 1_000);
              setPreviewMetrics({
                ...message.metrics,
                displayedFps: (counters.displayed - counters.sampledDisplayed) / sampleSeconds,
                receivedFps: (counters.received - counters.sampledReceived) / sampleSeconds,
              });
              counters.sampledAt = sampledAt;
              counters.sampledDisplayed = counters.displayed;
              counters.sampledReceived = counters.received;
            } else if (message.type === 'transportChanged' && message.transport) {
              setPreviewTransport(message.transport);
              if (message.transport === 'image') {
                forceImageTransportRef.current = true;
                disposeVideoPipeline();
                if (message.error) setStreamError(message.error);
              }
            } else if (message.type === 'activeTabChanged') {
              setNativeControl(null);
              setStatus('reconnecting');
            } else if (message.type === 'nativeControlOpened' && message.control) {
              setNativeControl(message.control);
            } else if (message.type === 'nativeControlClosed') {
              setNativeControl(null);
              setNativeControlBusy(false);
            } else if (message.type === 'nativeDialogOpened' && message.dialog) {
              setNativeDialog(message.dialog);
              setNativeDialogPrompt(message.dialog.defaultValue || '');
            } else if (message.type === 'nativeDialogClosed') {
              setNativeDialog((current) => current?.id === message.dialogId ? null : current);
            } else if (message.type === 'browserDownloadStarted' && message.download) {
              setPreviewDownload({ ...message.download, status: 'preparing' });
            } else if (message.type === 'browserDownloadReady' && message.download?.url) {
              const readyDownload: BrowserChatPreviewDownload = { ...message.download, delivery: 'pending', status: 'ready' };
              setPreviewDownload(readyDownload);
              void deliverPreviewDownload(readyDownload);
            } else if (message.type === 'browserDownloadFailed' && message.download) {
              setPreviewDownload(null);
              setInputError(message.download.error || '测试浏览器文件下载失败');
            } else if (message.type === 'ready') {
              setStatus('live');
              setStreamError('');
            } else if (message.type === 'inputError') {
              setNativeControlBusy(false);
              setInputError(message.error || '实时界面操作失败');
            } else if (message.type === 'unavailable') {
              reconnectEnabledRef.current = false;
              setStatus('unavailable');
              setStreamError(message.error || '当前会话没有运行中的测试浏览器');
            } else if (message.type === 'error') {
              setStreamError(message.error || '实时界面连接失败');
            }
          } catch {
            setStreamError('实时画面数据无效');
          }
        };
        stream.onerror = () => setStreamError((current) => current || '实时界面连接中断，正在重连');
        stream.onclose = () => {
          if (streamRef.current === stream) streamRef.current = null;
          if (disposed || !reconnectEnabledRef.current) return;
          setStatus('reconnecting');
          reconnectTimer = window.setTimeout(() => void connect(), 600);
        };
      } catch (error) {
        if (disposed) return;
        setStatus('reconnecting');
        setStreamError(error instanceof Error ? error.message : '实时界面连接失败');
        reconnectTimer = window.setTimeout(() => void connect(), 600);
      }
    };
    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      const stream = streamRef.current;
      streamRef.current = null;
      stream?.close();
    };
  }, [beginVideoPipeline, deliverPreviewDownload, disposeVideoPipeline, enqueueVideoChunk, fallbackToImagePreview, queuePreviewFrame, sessionId, userId]);

  useEffect(() => {
    // React Strict Mode mounts effects again after a simulated cleanup. Reset
    // this flag on every setup so the remounted preview continues accepting frames.
    framePipelineDisposedRef.current = false;
    return () => {
      framePipelineDisposedRef.current = true;
      if (frameObjectUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(frameObjectUrlRef.current);
      if (staleFrameObjectUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(staleFrameObjectUrlRef.current);
      if (decodingFrameObjectUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(decodingFrameObjectUrlRef.current);
      const pendingUrl = pendingFrameRef.current?.imageUrl;
      if (pendingUrl?.startsWith('blob:')) URL.revokeObjectURL(pendingUrl);
      frameObjectUrlRef.current = '';
      staleFrameObjectUrlRef.current = '';
      decodingFrameObjectUrlRef.current = '';
      pendingFrameRef.current = null;
      pendingMoveRef.current = null;
      pointerGestureRef.current = null;
      if (moveFlushTimerRef.current !== undefined) window.clearTimeout(moveFlushTimerRef.current);
      if (scrollFlushTimerRef.current !== undefined) window.clearTimeout(scrollFlushTimerRef.current);
      disposeVideoPipeline(false);
    };
  }, [disposeVideoPipeline]);

  useEffect(() => {
    const video = previewVideoRef.current;
    if (!videoObjectUrl || !video) return undefined;
    let stopped = false;
    let callbackId = 0;
    const markLive = () => {
      if (stopped) return;
      setStatus('live');
      setStreamError('');
    };
    const frameCallback = () => {
      if (stopped) return;
      frameCountersRef.current.displayed += 1;
      markLive();
      callbackId = video.requestVideoFrameCallback(frameCallback);
    };
    video.addEventListener('playing', markLive);
    callbackId = video.requestVideoFrameCallback(frameCallback);
    void video.play().catch(() => undefined);
    return () => {
      stopped = true;
      video.removeEventListener('playing', markLive);
      if (callbackId) video.cancelVideoFrameCallback(callbackId);
    };
  }, [videoObjectUrl]);

  const postInput = useCallback((input: BrowserChatPreviewInput, reportError: boolean) => {
    const stream = streamRef.current;
    if (!stream || stream.readyState !== WebSocket.OPEN) {
      if (reportError) setInputError('实时界面正在重连，请稍后重试');
      return false;
    }
    stream.send(JSON.stringify({ event: input, type: 'input' }));
    return true;
  }, []);

  const sendInput = useCallback((input: BrowserChatPreviewInput) => {
    setInputError('');
    return postInput(input, true);
  }, [postInput]);

  const relativePoint = useCallback((clientX: number, clientY: number, element: HTMLElement, clamp = false) => {
    if (!frame) return undefined;
    const mediaRect = previewVideoRef.current?.getBoundingClientRect()
      || previewImageRef.current?.getBoundingClientRect()
      || element.getBoundingClientRect();
    if (!mediaRect.width || !mediaRect.height) return undefined;
    const sourceWidth = Math.max(1, frame.viewport.width);
    const sourceHeight = Math.max(1, frame.viewport.height);
    const sourceRatio = sourceWidth / sourceHeight;
    const mediaRatio = mediaRect.width / mediaRect.height;
    const contentWidth = mediaRatio > sourceRatio ? mediaRect.height * sourceRatio : mediaRect.width;
    const contentHeight = mediaRatio > sourceRatio ? mediaRect.height : mediaRect.width / sourceRatio;
    const rect = {
      bottom: mediaRect.top + (mediaRect.height + contentHeight) / 2,
      height: contentHeight,
      left: mediaRect.left + (mediaRect.width - contentWidth) / 2,
      right: mediaRect.left + (mediaRect.width + contentWidth) / 2,
      top: mediaRect.top + (mediaRect.height - contentHeight) / 2,
      width: contentWidth,
    };
    if (!clamp && (
      clientX < rect.left
      || clientX > rect.right
      || clientY < rect.top
      || clientY > rect.bottom
    )) return undefined;
    return {
      xRatio: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      yRatio: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  }, [frame]);

  const beginPreviewPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const point = relativePoint(event.clientX, event.clientY, event.currentTarget);
    if (!point) return;
    setNativeControl(null);
    event.currentTarget.focus();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerGestureRef.current = {
      button: event.button === 1 ? 'middle' : 'left',
      clickCount: Math.min(2, Math.max(1, event.detail || 1)),
      current: point,
      dragged: false,
      pointerId: event.pointerId,
      start: point,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
  }, [relativePoint]);

  const movePreviewPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointerGestureRef.current;
    if (!gesture && event.pointerType === 'touch') return;
    const point = relativePoint(event.clientX, event.clientY, event.currentTarget, Boolean(gesture));
    if (!point) return;
    if (gesture && gesture.pointerId === event.pointerId) {
      gesture.current = point;
      if (Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) >= 4) {
        gesture.dragged = true;
      }
      return;
    }
    pendingMoveRef.current = { kind: 'move', ...point };
    if (moveFlushTimerRef.current !== undefined) return;
    moveFlushTimerRef.current = window.setTimeout(() => {
      moveFlushTimerRef.current = undefined;
      const input = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (input) postInput(input, false);
    }, 16);
  }, [postInput, relativePoint]);

  const endPreviewPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = relativePoint(event.clientX, event.clientY, event.currentTarget, true) || gesture.current;
    pointerGestureRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    if (gesture.dragged) {
      sendInput({
        kind: 'drag',
        ...gesture.start,
        toXRatio: point.xRatio,
        toYRatio: point.yRatio,
        button: gesture.button,
      });
      return;
    }
    sendInput({
      kind: 'click',
      ...point,
      button: gesture.button,
      clickCount: gesture.clickCount,
    });
  }, [relativePoint, sendInput]);

  const cancelPreviewPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerGestureRef.current?.pointerId !== event.pointerId) return;
    pointerGestureRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  }, []);

  const openPreviewContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const point = relativePoint(event.clientX, event.clientY, event.currentTarget);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.focus();
    sendInput({ kind: 'click', ...point, button: 'right', clickCount: 1 });
  }, [relativePoint, sendInput]);

  const scrollPreview = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const point = relativePoint(event.clientX, event.clientY, event.currentTarget);
    if (!point) return;
    event.preventDefault();
    const current = pendingScrollRef.current;
    pendingScrollRef.current = {
      kind: 'scroll',
      ...point,
      deltaX: (current?.deltaX || 0) + event.deltaX,
      deltaY: (current?.deltaY || 0) + event.deltaY,
    };
    if (scrollFlushTimerRef.current !== undefined) return;
    scrollFlushTimerRef.current = window.setTimeout(() => {
      scrollFlushTimerRef.current = undefined;
      const input = pendingScrollRef.current;
      pendingScrollRef.current = null;
      if (input) sendInput(input);
    }, 16);
  }, [relativePoint, sendInput]);

  const pressPreviewKey = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    if (nativeControl && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setNativeControl(null);
      return;
    }
    const modifierShortcut = event.ctrlKey || event.metaKey || event.altKey;
    let key = event.key;
    if (modifierShortcut) {
      const parts = [
        event.ctrlKey ? 'Control' : '',
        event.metaKey ? 'Meta' : '',
        event.altKey ? 'Alt' : '',
        event.shiftKey ? 'Shift' : '',
        key.length === 1 ? key.toUpperCase() : key,
      ].filter(Boolean);
      key = parts.join('+');
    } else if (event.shiftKey && key.length > 1) {
      key = `Shift+${key}`;
    } else if (key === ' ') {
      key = 'Space';
    }
    event.preventDefault();
    event.stopPropagation();
    sendInput({ kind: 'key', key });
  }, [nativeControl, sendInput]);

  const pastePreviewText = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    sendInput({ kind: 'text', text });
  }, [sendInput]);

  const switchPreviewTab = useCallback((tabId: string) => {
    setNativeControl(null);
    setFrame((current) => current ? {
      ...current,
      tabs: current.tabs.map((tab) => ({ ...tab, active: tab.id === tabId })),
    } : current);
    setStatus('reconnecting');
    sendInput({ kind: 'tab', tabId });
  }, [sendInput]);

  const selectPreviewNativeOption = useCallback((value: string) => {
    if (!nativeControl || (nativeControl.kind !== 'select' && nativeControl.kind !== 'datalist')) return;
    setNativeControl(null);
    if (nativeControl.kind === 'select') {
      sendInput({
        kind: 'select',
        value,
        xRatio: nativeControl.targetXRatio,
        yRatio: nativeControl.targetYRatio,
      });
      return;
    }
    sendInput({
      controlKind: 'datalist',
      kind: 'controlValue',
      value,
      xRatio: nativeControl.targetXRatio,
      yRatio: nativeControl.targetYRatio,
    });
  }, [nativeControl, sendInput]);

  const applyPreviewNativePicker = useCallback(() => {
    if (nativeControl?.kind !== 'picker') return;
    setNativeControl(null);
    sendInput({
      controlKind: 'picker',
      kind: 'controlValue',
      value: nativePickerValue,
      xRatio: nativeControl.targetXRatio,
      yRatio: nativeControl.targetYRatio,
    });
  }, [nativeControl, nativePickerValue, sendInput]);

  const uploadPreviewNativeFiles = useCallback(async (files: FileList | null) => {
    if (nativeControl?.kind !== 'file' || !files?.length || nativeControlBusy) return;
    const selected = Array.from(files).slice(0, nativeControl.multiple ? 8 : 1);
    setNativeControlBusy(true);
    setInputError('');
    try {
      const uploaded: Array<{ mimeType: string; name: string; path: string }> = [];
      for (const file of selected) {
        const response = await fetch(withWebPilotBasePath('/api/uploads'), {
          body: file,
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'x-webpilot-file-name': encodeURIComponent(file.name),
            'x-webpilot-upload': 'raw',
          },
          method: 'POST',
        });
        const data = await readApiJson<Record<string, unknown>>(response, '文件上传失败');
        uploaded.push({
          mimeType: String(data.type || file.type || 'application/octet-stream'),
          name: String(data.name || file.name),
          path: String(data.path || ''),
        });
      }
      if (!uploaded.every((file) => file.path)) throw new Error('文件上传结果无效');
      if (!sendInput({ controlId: nativeControl.controlId, files: uploaded, kind: 'files' })) {
        setNativeControlBusy(false);
      }
    } catch (error) {
      setNativeControlBusy(false);
      setInputError(error instanceof Error ? error.message : '文件上传失败');
    } finally {
      if (previewFileInputRef.current) previewFileInputRef.current.value = '';
    }
  }, [nativeControl, nativeControlBusy, sendInput]);

  const respondPreviewNativeDialog = useCallback((accept: boolean) => {
    if (!nativeDialog) return;
    sendInput({
      accept,
      dialogId: nativeDialog.id,
      kind: 'dialog',
      ...(nativeDialog.dialogType === 'prompt' ? { promptText: nativeDialogPrompt } : {}),
    });
  }, [nativeDialog, nativeDialogPrompt, sendInput]);

  const statusLabelSource = status === 'live'
    ? '实时'
    : status === 'reconnecting'
      ? '正在重连'
      : status === 'unavailable'
        ? '浏览器未运行'
        : '正在连接';
  const statusLabel = t(statusLabelSource);
  const previewMetricsLabel = previewMetrics
    ? t('{transport} · 目标 {target} · 截图 {capture} · 发送 {send} · 接收 {received} · 显示 {displayed} FPS', {
        transport: previewTransport === 'video' ? 'H.264' : t('图片'),
        target: Math.round(previewMetrics.targetFps || 0),
        capture: (previewMetrics.captureFps || 0).toFixed(1),
        send: (previewMetrics.sendFps || 0).toFixed(1),
        received: previewMetrics.receivedFps.toFixed(1),
        displayed: previewMetrics.displayedFps.toFixed(1),
      })
    : '';
  const previewMetricsTitle = previewMetrics
    ? [
        previewTransport === 'video'
          ? t('传输：H.264 fragmented MP4')
          : previewMetrics.imageFormat === 'jpeg' ? t('JPEG 质量：{quality}', { quality: previewMetrics.imageQuality ?? '-' }) : 'PNG',
        ...(previewTransport === 'video' ? [
          t('编码：{profile} / Level {level} / {mime}', { profile: previewMetrics.h264Profile || '-', level: previewMetrics.h264Level || '-', mime: previewMetrics.mimeType || '-' }),
          t('视频：{width}×{height} / {bitrate} Kbps', { width: previewMetrics.width || '-', height: previewMetrics.height || '-', bitrate: previewMetrics.bitrateKbps || '-' }),
        ] : []),
        t('最近一次截图耗时：{time} ms', { time: (previewMetrics.captureDurationMs || 0).toFixed(1) }),
        t('平均截图耗时：{time} ms', { time: (previewMetrics.captureDurationMsAverage || 0).toFixed(1) }),
        t('在途截图：{active}/{maximum}', { active: previewMetrics.activeCaptures || 0, maximum: previewMetrics.maxConcurrentCaptures || 1 }),
        t('网络背压丢帧：{count}', { count: previewMetrics.backpressureDrops || 0 }),
        t('待发送客户端帧：{count}', { count: previewMetrics.pendingClientFrames || 0 }),
      ].join('\n')
    : '';
  const hasPreviewVisual = videoDisplayReady || Boolean(frame?.imageUrl);

  return (
    <AppModal
      ariaLabel={t('实时界面')}
      backdropClassName="browser-chat-web-preview-overlay"
      dialogClassName="browser-chat-web-preview-modal"
      onClose={onClose}
      size="full"
    >
        <header className="ui-modal-header browser-chat-web-preview-header">
          <div className="ui-modal-heading">
            <div className="browser-chat-web-preview-title-row">
              <h2 className="ui-modal-title">{t('实时界面')}</h2>
              <span className={`browser-chat-web-preview-status is-${status}`}>
                <span />
                {statusLabel}
              </span>
              {previewMetricsLabel ? (
                <span className="browser-chat-web-preview-metrics" title={previewMetricsTitle}>
                  {previewMetricsLabel}
                </span>
              ) : null}
              <span className="browser-chat-web-preview-url" title={frame?.url || ''}>
                {frame?.url || t('等待会话浏览器启动')}
              </span>
            </div>
          </div>
          <button aria-label={t('关闭实时界面')} className="browser-chat-web-preview-close" onClick={onClose} title={t('关闭')} type="button">
            <X size={18} />
          </button>
        </header>

        {frame?.tabs?.length ? (
          <div className="browser-chat-web-preview-tabs">
            {frame.tabs.map((tab) => (
              <button
                className={tab.active ? 'active' : ''}
                key={tab.id}
                onClick={() => void switchPreviewTab(tab.id)}
                title={tab.url}
                type="button"
              >
                <Globe size={13} />
                <span>{tab.url || t('标签页 {index}', { index: tab.index + 1 })}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="browser-chat-web-preview-body">
          <div
            aria-label={t('可操作的浏览器实时画面')}
            className={hasPreviewVisual ? 'browser-chat-web-preview-stage has-frame' : 'browser-chat-web-preview-stage'}
            onContextMenu={openPreviewContextMenu}
            onKeyDown={pressPreviewKey}
            onPaste={pastePreviewText}
            onPointerCancel={cancelPreviewPointer}
            onPointerDown={beginPreviewPointer}
            onPointerMove={movePreviewPointer}
            onPointerUp={endPreviewPointer}
            onWheel={scrollPreview}
            ref={previewStageRef}
            role="application"
            tabIndex={0}
          >
            {frame?.imageUrl && !videoDisplayReady ? (
              <img
                alt={t('浏览器实时画面')}
                draggable={false}
                height={frame.viewport.height}
                ref={previewImageRef}
                src={frame.imageUrl}
                width={frame.viewport.width}
              />
            ) : null}
            {videoObjectUrl ? (
              <video
                autoPlay
                className={videoDisplayReady ? 'is-ready' : 'is-loading'}
                disablePictureInPicture
                height={frame?.viewport.height || 720}
                muted
                onLoadedData={() => {
                  setVideoDisplayReady(true);
                  setStatus('live');
                  setStreamError('');
                }}
                playsInline
                ref={previewVideoRef}
                src={videoObjectUrl}
                width={frame?.viewport.width || 1280}
              />
            ) : null}
            {nativeControl?.kind === 'file' ? (
              <input
                accept={nativeControl.accept || undefined}
                capture={nativeControl.capture === 'environment' || nativeControl.capture === 'user'
                  ? nativeControl.capture
                  : nativeControl.capture ? true : undefined}
                className="browser-chat-web-preview-native-file-input"
                multiple={nativeControl.multiple}
                onChange={(event) => void uploadPreviewNativeFiles(event.target.files)}
                ref={previewFileInputRef}
                type="file"
              />
            ) : null}
            {nativeControl && nativeControl.kind !== 'file' && nativeControlPosition ? (
              <div
                aria-label={nativeControl.label}
                className={`browser-chat-web-preview-native-select is-${nativeControl.kind}`}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                role={nativeControl.kind === 'select' || nativeControl.kind === 'datalist' ? 'listbox' : 'dialog'}
                style={nativeControlPosition}
              >
                {nativeControl.kind === 'select' || nativeControl.kind === 'datalist' ? (
                  nativeControl.options.map((option, index) => {
                    const selected = nativeControl.kind === 'select'
                      ? option.value === nativeControl.selectedValue
                      : option.value === nativeControl.value;
                    const disabled = 'disabled' in option ? option.disabled : false;
                    const group = 'group' in option ? option.group : undefined;
                    return (
                      <button
                        aria-selected={selected}
                        className={selected ? 'is-selected' : undefined}
                        disabled={disabled}
                        key={`${option.value}:${index}`}
                        onClick={() => selectPreviewNativeOption(option.value)}
                        role="option"
                        type="button"
                      >
                        <span>{option.label}</span>
                        {group ? <small>{group}</small> : null}
                        {selected ? <Check size={15} /> : null}
                      </button>
                    );
                  })
                ) : null}
                {nativeControl.kind === 'picker' ? (
                  <div className="browser-chat-web-preview-native-control-form">
                    <strong>{nativeControl.label}</strong>
                    <input
                      autoFocus
                      max={nativeControl.max}
                      min={nativeControl.min}
                      onChange={(event) => setNativePickerValue(event.target.value)}
                      step={nativeControl.step}
                      type={nativeControl.inputType}
                      value={nativePickerValue}
                    />
                    <div className="browser-chat-web-preview-native-control-actions">
                      <button onClick={() => setNativeControl(null)} type="button">{t('取消')}</button>
                      <button className="is-primary" onClick={applyPreviewNativePicker} type="button">{t('应用')}</button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {nativeDialog ? (
              <div
                className="browser-chat-web-preview-native-dialog-backdrop"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    respondPreviewNativeDialog(false);
                  }
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <section aria-labelledby="browser-chat-native-dialog-title" aria-modal="true" role="dialog">
                  <strong id="browser-chat-native-dialog-title">
                    {nativeDialog.dialogType === 'prompt' ? t('请输入内容') : t('浏览器提示')}
                  </strong>
                  <p>{nativeDialog.message}</p>
                  {nativeDialog.dialogType === 'prompt' ? (
                    <AppInput
                      autoFocus
                      onChange={(event) => setNativeDialogPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') respondPreviewNativeDialog(true);
                      }}
                      value={nativeDialogPrompt}
                    />
                  ) : null}
                  <div className="browser-chat-web-preview-native-dialog-actions">
                    {nativeDialog.dialogType !== 'alert' ? (
                      <button onClick={() => respondPreviewNativeDialog(false)} type="button">
                        {nativeDialog.dialogType === 'beforeunload' ? t('留在此页') : t('取消')}
                      </button>
                    ) : null}
                    <button className="is-primary" onClick={() => respondPreviewNativeDialog(true)} type="button">
                      {nativeDialog.dialogType === 'beforeunload' ? t('离开页面') : t('确定')}
                    </button>
                  </div>
                </section>
              </div>
            ) : null}
            {!hasPreviewVisual ? (
              <div className="browser-chat-web-preview-empty">
                <Loader2 className="spin" size={22} />
                <strong>{streamError ? t(streamError) : t('正在等待浏览器画面')}</strong>
                <span>{t('发送一条需要访问网页的消息后，画面会自动出现。')}</span>
              </div>
            ) : null}
          </div>
          {streamError && hasPreviewVisual ? <div className="browser-chat-web-preview-alert">{t(streamError)}</div> : null}
          {inputError ? <div className="browser-chat-web-preview-alert">{t(inputError)}</div> : null}
          {previewDownload ? (
            <div className="browser-chat-web-preview-download-notice" role="status">
              {previewDownload.status === 'preparing' ? <Loader2 className="spin" size={14} /> : <Download size={14} />}
              <span>{t(previewDownload.status === 'preparing'
                ? '正在识别下载文件'
                : previewDownload.delivery === 'started' ? '已开始下载' : '检测到下载文件')}：{previewDownload.fileName}</span>
              {previewDownload.status === 'ready' ? (
                <button
                  onClick={() => void deliverPreviewDownload(previewDownload, { repeat: true, userInitiated: true })}
                  type="button"
                >{t(previewDownload.delivery === 'started' ? '重新下载' : '下载到本机')}</button>
              ) : null}
              <button
                aria-label={t("关闭下载提示")}
                className="browser-chat-web-preview-download-dismiss"
                onClick={() => setPreviewDownload(null)}
                type="button"
              ><X size={13} /></button>
            </div>
          ) : null}
        </div>

    </AppModal>
  );
}

