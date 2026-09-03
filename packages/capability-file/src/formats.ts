export type FileFormatKind =
  | 'archive'
  | 'binary'
  | 'image'
  | 'pdf'
  | 'presentation'
  | 'spreadsheet'
  | 'text'
  | 'word';

export type FileFormat = {
  canGenerate: boolean;
  canPreview: boolean;
  canRead: boolean;
  canUpload: boolean;
  extension: `.${string}`;
  kind: FileFormatKind;
  mimeType: string;
};

type FileFormatDefinition = Omit<
  FileFormat,
  'canGenerate' | 'canPreview' | 'canRead' | 'canUpload'
> & Partial<Pick<FileFormat, 'canGenerate' | 'canPreview' | 'canRead' | 'canUpload'>>;

const text = (
  extensions: string[],
  options: Partial<FileFormatDefinition> = {},
) => extensions.map((extension) => ({
  canGenerate: true,
  canPreview: false,
  canRead: true,
  canUpload: true,
  extension: extension as `.${string}`,
  kind: 'text' as const,
  mimeType: 'text/plain; charset=utf-8',
  ...options,
}));

const formats: FileFormatDefinition[] = [
  ...text(['.c', '.cc', '.cpp', '.cs', '.env', '.go', '.graphql', '.h', '.ini', '.java', '.kt', '.log', '.lua', '.php', '.py', '.rb', '.rs', '.rst', '.sh', '.sql', '.text', '.txt']),
  ...text(['.css'], { mimeType: 'text/css; charset=utf-8' }),
  ...text(['.csv'], { mimeType: 'text/csv; charset=utf-8' }),
  ...text(['.html', '.htm'], { mimeType: 'text/html; charset=utf-8' }),
  ...text(['.js', '.jsx', '.mjs'], { mimeType: 'text/javascript; charset=utf-8' }),
  ...text(['.json'], { mimeType: 'application/json; charset=utf-8' }),
  ...text(['.jsonl', '.ndjson'], { mimeType: 'application/x-ndjson; charset=utf-8' }),
  ...text(['.md', '.mdx'], { mimeType: 'text/markdown; charset=utf-8' }),
  ...text(['.scss'], { mimeType: 'text/x-scss; charset=utf-8' }),
  ...text(['.toml'], { mimeType: 'application/toml; charset=utf-8' }),
  ...text(['.ts', '.tsx'], { mimeType: 'text/plain; charset=utf-8' }),
  ...text(['.tsv'], { mimeType: 'text/tab-separated-values; charset=utf-8' }),
  ...text(['.vue'], { mimeType: 'text/plain; charset=utf-8' }),
  ...text(['.xml'], { mimeType: 'application/xml; charset=utf-8' }),
  ...text(['.yaml', '.yml'], { mimeType: 'application/yaml; charset=utf-8' }),

  { extension: '.pdf', kind: 'pdf', mimeType: 'application/pdf', canGenerate: true, canPreview: true },

  { extension: '.doc', kind: 'word', mimeType: 'application/msword', canGenerate: true, canPreview: true },
  { extension: '.docx', kind: 'word', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', canGenerate: true, canPreview: true },
  { extension: '.odt', kind: 'word', mimeType: 'application/vnd.oasis.opendocument.text', canGenerate: true, canPreview: true },

  { extension: '.xls', kind: 'spreadsheet', mimeType: 'application/vnd.ms-excel', canGenerate: true, canPreview: true },
  { extension: '.xlsx', kind: 'spreadsheet', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', canGenerate: true, canPreview: true },
  { extension: '.xlsb', kind: 'spreadsheet', mimeType: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', canPreview: true },
  { extension: '.xlsm', kind: 'spreadsheet', mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12', canPreview: true },
  { extension: '.ods', kind: 'spreadsheet', mimeType: 'application/vnd.oasis.opendocument.spreadsheet', canGenerate: true, canPreview: true },

  { extension: '.ppt', kind: 'presentation', mimeType: 'application/vnd.ms-powerpoint', canGenerate: true, canPreview: true },
  { extension: '.pptx', kind: 'presentation', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', canGenerate: true, canPreview: true },
  { extension: '.pps', kind: 'presentation', mimeType: 'application/vnd.ms-powerpoint', canPreview: true },
  { extension: '.ppsx', kind: 'presentation', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow', canPreview: true },
  { extension: '.pot', kind: 'presentation', mimeType: 'application/vnd.ms-powerpoint', canPreview: true },
  { extension: '.potx', kind: 'presentation', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.template', canPreview: true },
  { extension: '.odp', kind: 'presentation', mimeType: 'application/vnd.oasis.opendocument.presentation', canGenerate: true, canPreview: true },

  { extension: '.zip', kind: 'archive', mimeType: 'application/zip' },
  { extension: '.jar', kind: 'archive', mimeType: 'application/java-archive' },
  { extension: '.epub', kind: 'archive', mimeType: 'application/epub+zip' },

  { extension: '.apng', kind: 'image', mimeType: 'image/apng', canPreview: true },
  { extension: '.avif', kind: 'image', mimeType: 'image/avif', canPreview: true },
  { extension: '.bmp', kind: 'image', mimeType: 'image/bmp', canPreview: true },
  { extension: '.gif', kind: 'image', mimeType: 'image/gif', canPreview: true },
  { extension: '.ico', kind: 'image', mimeType: 'image/x-icon', canPreview: true },
  { extension: '.jpeg', kind: 'image', mimeType: 'image/jpeg', canPreview: true },
  { extension: '.jpg', kind: 'image', mimeType: 'image/jpeg', canPreview: true },
  { extension: '.png', kind: 'image', mimeType: 'image/png', canPreview: true },
  { extension: '.svg', kind: 'image', mimeType: 'image/svg+xml', canPreview: true },
  { extension: '.tif', kind: 'image', mimeType: 'image/tiff', canPreview: true },
  { extension: '.tiff', kind: 'image', mimeType: 'image/tiff', canPreview: true },
  { extension: '.webp', kind: 'image', mimeType: 'image/webp', canPreview: true },

  { extension: '.bin', kind: 'binary', mimeType: 'application/octet-stream', canRead: false },
];

export const fileFormats: readonly FileFormat[] = Object.freeze(formats.map((format) => Object.freeze({
  canGenerate: format.canGenerate ?? false,
  canPreview: format.canPreview ?? false,
  canRead: format.canRead ?? format.kind !== 'binary',
  canUpload: format.canUpload ?? true,
  extension: format.extension,
  kind: format.kind,
  mimeType: format.mimeType,
})));

const formatsByExtension = new Map<string, FileFormat>(
  fileFormats.map((format) => [format.extension, format]),
);
const formatsByMime = new Map<string, FileFormat>();
for (const format of fileFormats) {
  const mime = format.mimeType.split(';')[0].trim().toLowerCase();
  if (!formatsByMime.has(mime)) formatsByMime.set(mime, format);
}

export function normalizedFileExtension(value: string) {
  const leaf = String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .at(-1) || '';
  const dot = leaf.lastIndexOf('.');
  if (dot < 0) return '';
  // `#` and `?` are valid filename characters on supported local platforms.
  // Treat them as URL suffix delimiters only when they occur after the file
  // extension has started; otherwise names such as "#31471 report.docx" lose
  // their entire basename and are misclassified as extensionless.
  const suffixOffset = leaf.slice(dot).search(/[?#]/);
  const name = suffixOffset > -1 ? leaf.slice(0, dot + suffixOffset) : leaf;
  return name.slice(dot).toLowerCase();
}

export function fileFormatForExtension(extension: string) {
  return formatsByExtension.get(extension.toLowerCase());
}

export function fileFormatForName(fileName: string) {
  return fileFormatForExtension(normalizedFileExtension(fileName));
}

export function fileFormatForMimeType(mimeType: string) {
  return formatsByMime.get(String(mimeType || '').split(';')[0].trim().toLowerCase());
}

export function generatedFileExtensions(kind?: FileFormatKind): Set<string> {
  return new Set(fileFormats
    .filter((format) => format.canGenerate && (!kind || format.kind === kind))
    .map((format) => format.extension));
}

export function readableFileExtensions(kind?: FileFormatKind): Set<string> {
  return new Set(fileFormats
    .filter((format) => format.canRead && (!kind || format.kind === kind))
    .map((format) => format.extension));
}

export function officePreviewExtensions(): Set<string> {
  return new Set(fileFormats
    .filter((format) => (
      format.canPreview
      && ['presentation', 'spreadsheet', 'word'].includes(format.kind)
    ))
    .map((format) => format.extension));
}

export function artifactContentType(fileName: string) {
  return fileFormatForName(fileName)?.mimeType || 'application/octet-stream';
}

export function uploadStorageExtension(fileName: string, mimeType: string) {
  const requested = fileFormatForName(fileName);
  if (requested?.canUpload) return requested.extension;
  const byMime = fileFormatForMimeType(mimeType);
  return byMime?.canUpload ? byMime.extension : '.bin';
}
