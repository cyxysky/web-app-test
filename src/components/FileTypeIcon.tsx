type FileTypeIconProps = {
  className?: string;
  fileName: string;
  mimeType?: string;
  size?: number;
};

type FileIconKind =
  | 'archive'
  | 'audio'
  | 'code'
  | 'document'
  | 'file'
  | 'image'
  | 'json'
  | 'pdf'
  | 'presentation'
  | 'spreadsheet'
  | 'video';

type FileIconStyle = {
  color: string;
  foldColor: string;
  label: string;
};

const archiveExtensions = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']);
const audioExtensions = new Set(['aac', 'aiff', 'alac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'wma']);
const codeExtensions = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx', 'kt', 'less',
  'php', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'swift', 'ts', 'tsx', 'vue',
]);
const documentExtensions = new Set(['doc', 'docx', 'md', 'odt', 'pages', 'rtf', 'tex', 'txt']);
const imageExtensions = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']);
const jsonExtensions = new Set(['json', 'jsonl', 'toml', 'xml', 'yaml', 'yml']);
const presentationExtensions = new Set(['key', 'odp', 'ppt', 'pptx']);
const spreadsheetExtensions = new Set(['csv', 'numbers', 'ods', 'tsv', 'xls', 'xlsb', 'xlsm', 'xlsx']);
const videoExtensions = new Set(['3gp', 'avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm', 'wmv']);
const wordExtensions = new Set(['doc', 'docx', 'odt', 'rtf']);

function fileExtension(fileName: string) {
  return fileName.trim().toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] || '';
}

function fileIconKind(fileName: string, mimeType = ''): FileIconKind {
  const extension = fileExtension(fileName);
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (normalizedMimeType.startsWith('video/') || videoExtensions.has(extension)) return 'video';
  if (normalizedMimeType.startsWith('audio/') || audioExtensions.has(extension)) return 'audio';
  if (normalizedMimeType.startsWith('image/') || imageExtensions.has(extension)) return 'image';
  if (normalizedMimeType === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (archiveExtensions.has(extension)) return 'archive';
  if (spreadsheetExtensions.has(extension)) return 'spreadsheet';
  if (presentationExtensions.has(extension)) return 'presentation';
  if (jsonExtensions.has(extension)) return 'json';
  if (codeExtensions.has(extension)) return 'code';
  if (normalizedMimeType.startsWith('text/') || documentExtensions.has(extension)) return 'document';
  return 'file';
}

function compactFileLabel(extension: string, kind: FileIconKind) {
  if (kind === 'pdf') return 'PDF';
  if (kind === 'presentation') return 'PPT';
  if (kind === 'spreadsheet') return 'XLS';
  if (kind === 'document' && wordExtensions.has(extension)) return 'DOC';
  if (extension === 'jpeg') return 'JPG';
  if (extension && extension.length <= 4) return extension.toUpperCase();
  return {
    archive: 'ZIP',
    audio: 'MP3',
    code: 'CODE',
    document: 'TXT',
    file: 'FILE',
    image: 'IMG',
    json: 'JSON',
    pdf: 'PDF',
    presentation: 'PPT',
    spreadsheet: 'XLS',
    video: 'MP4',
  }[kind];
}

function fileIconStyle(fileName: string, mimeType = ''): FileIconStyle {
  const extension = fileExtension(fileName);
  const kind = fileIconKind(fileName, mimeType);
  const colors: Record<FileIconKind, Pick<FileIconStyle, 'color' | 'foldColor'>> = {
    archive: { color: '#F0A51A', foldColor: '#FFD06A' },
    audio: { color: '#E64E9B', foldColor: '#F49BC7' },
    code: { color: '#2888D8', foldColor: '#82BCEC' },
    document: { color: '#5472A5', foldColor: '#9FB1CF' },
    file: { color: '#7B8494', foldColor: '#B8BEC8' },
    image: { color: '#FF6D00', foldColor: '#FFB35B' },
    json: { color: '#D99316', foldColor: '#F4C569' },
    pdf: { color: '#ED3F55', foldColor: '#F58C99' },
    presentation: { color: '#E95B2D', foldColor: '#F5A181' },
    spreadsheet: { color: '#20A464', foldColor: '#78CF9F' },
    video: { color: '#7657D5', foldColor: '#B1A0EA' },
  };
  return { ...colors[kind], label: compactFileLabel(extension, kind) };
}

export function FileTypeIcon({ className, fileName, mimeType, size = 16 }: FileTypeIconProps) {
  const icon = fileIconStyle(fileName, mimeType);
  const fontSize = icon.label.length >= 4 ? 10 : icon.label.length === 3 ? 12 : 13;
  return (
    <span
      aria-hidden="true"
      className={`file-type-icon${className ? ` ${className}` : ''}`}
      style={{ display: 'inline-flex', flex: '0 0 auto', height: size, width: size }}
    >
      <svg
        focusable="false"
        height="100%"
        viewBox="0 0 48 56"
        width="100%"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M9 1h22l16 16v32a6 6 0 0 1-6 6H9a8 8 0 0 1-8-8V9a8 8 0 0 1 8-8Z"
          fill={icon.color}
        />
        <path d="M31 1v11a5 5 0 0 0 5 5h11L31 1Z" fill={icon.foldColor} />
        <text
          fill="#FFFFFF"
          fontFamily="Arial, Helvetica, sans-serif"
          fontSize={fontSize}
          fontWeight="700"
          textAnchor="middle"
          x="24"
          y="42"
        >
          {icon.label}
        </text>
      </svg>
    </span>
  );
}
