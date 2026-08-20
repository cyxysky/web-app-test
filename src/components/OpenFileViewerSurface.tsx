'use client';

import { memo } from 'react';
import { FileViewer } from '@open-file-viewer/react';
import {
  archivePlugin,
  assetPlugin,
  audioPlugin,
  cadPlugin,
  drawingPlugin,
  emailPlugin,
  epubPlugin,
  fallbackPlugin,
  gisPlugin,
  imagePlugin,
  model3dPlugin,
  officePlugin,
  ofdPlugin,
  pdfPlugin,
  textPlugin,
  videoPlugin,
  xmindPlugin,
  xpsPlugin,
  type PreviewLocale,
  type PreviewSource,
  type PreviewTheme,
} from '@open-file-viewer/core';

const previewPlugins = [
  imagePlugin(),
  videoPlugin(),
  audioPlugin(),
  textPlugin(),
  pdfPlugin(),
  officePlugin(),
  ofdPlugin(),
  epubPlugin(),
  xpsPlugin(),
  archivePlugin(),
  emailPlugin(),
  drawingPlugin(),
  xmindPlugin(),
  cadPlugin(),
  model3dPlugin(),
  gisPlugin(),
  assetPlugin(),
  fallbackPlugin(),
];

export const OpenFileViewerSurface = memo(function OpenFileViewerSurface({
  fileName,
  locale,
  mimeType,
  onError,
  source,
  theme,
}: {
  fileName: string;
  locale: PreviewLocale;
  mimeType?: string;
  onError: (error: Error) => void;
  source: PreviewSource;
  theme: PreviewTheme;
}) {
  return (
    <FileViewer
      fallback="inline"
      file={source}
      fileName={fileName}
      fit="contain"
      height="100%"
      locale={locale}
      mimeType={mimeType}
      onError={onError}
      plugins={previewPlugins}
      theme={theme}
      toolbar
      width="100%"
    />
  );
});
