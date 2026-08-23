export type OfficeCellValue = string | number | boolean | null;

export type OfficeDocumentKind = 'presentation' | 'spreadsheet' | 'word';

export type OfficeBlockType =
  | 'page'
  | 'sheet'
  | 'text'
  | 'heading'
  | 'list'
  | 'quote'
  | 'code'
  | 'image'
  | 'svg'
  | 'chart'
  | 'table'
  | 'card'
  | 'columns'
  | 'metric'
  | 'timeline'
  | 'shape'
  | 'divider'
  | 'spacer'
  | 'pageBreak';

export type OfficeBlockStyle = {
  align?: 'center' | 'justify' | 'left' | 'right';
  backgroundColor?: string;
  borderColor?: string;
  borderRadius?: number;
  borderWidth?: number;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontStyle?: 'italic' | 'normal';
  fontWeight?: number | string;
  gap?: number;
  height?: number | string;
  lineHeight?: number;
  margin?: number | number[];
  opacity?: number;
  padding?: number | number[];
  rotation?: number;
  shadow?: boolean | Record<string, unknown>;
  unit?: 'cm' | 'in' | 'mm' | 'pt' | 'px';
  width?: number | string;
  x?: number | string;
  y?: number | string;
  [property: string]: unknown;
};

export type OfficeBlock = {
  id: string;
  type: OfficeBlockType | (string & {});
  alt?: string;
  /** Semantic Writer pagination; do not emulate this through blank text or raw UNO properties. */
  breakBefore?: 'page';
  caption?: string;
  children?: OfficeBlock[];
  columns?: Array<{ blocks?: OfficeBlock[]; width?: number | string }>;
  data?: unknown;
  items?: unknown[];
  language?: string;
  level?: number;
  markdown?: string;
  name?: string;
  rows?: OfficeCellValue[][];
  source?: string;
  style?: OfficeBlockStyle;
  svg?: string;
  text?: string;
  title?: string;
  unoProperties?: Record<string, unknown>;
  unoService?: string;
  [property: string]: unknown;
};

export type OfficeDocumentSettings = {
  author?: string;
  defaultStyle?: OfficeBlockStyle;
  description?: string;
  language?: string;
  metadata?: Record<string, unknown>;
  page?: {
    backgroundColor?: string;
    footer?: string;
    header?: string;
    height?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
    marginTop?: number;
    orientation?: 'landscape' | 'portrait';
    showPageNumber?: boolean;
    unit?: 'cm' | 'in' | 'mm' | 'pt' | 'px';
    width?: number;
    [property: string]: unknown;
  };
  title?: string;
  [property: string]: unknown;
};

export type OfficeDocumentSpec = {
  blocks: OfficeBlock[];
  document: OfficeDocumentSettings;
  documentType: OfficeDocumentKind;
  fileName: string;
};

/** A semantic plan plus the model-owned, executable UNO draft. No block tree is rendered from this type. */
export type OfficeDocumentDraft = {
  createdAt: string;
  documentId: string;
  documentType: OfficeDocumentKind;
  fileName: string;
  intent?: string;
  /** Create a new file or modify a user-supplied Office document in place. */
  operation?: 'create' | 'modify';
  /** Program runtime selected when the workspace is planned. Existing-file modification always uses UNO. */
  generator?: 'javascript' | 'uno';
  /** Bound source file for a real existing-document modification workspace. */
  sourceDocument?: {
    assetName: string;
    attachmentId: string;
    bytes: number;
    fileName: string;
    sha256: string;
  };
  /** Complete Python source run verbatim by the LibreOffice UNO worker. */
  program?: string;
  /** SHA-256 of the workspace draft.py content, used to detect split-brain metadata. */
  sourceDigest?: string;
  /** Artifact identity of the last published source. A later edit makes this stale. */
  renderedArtifactId?: string;
  /** Current published source digest. Kept alongside renderedSourceDigest for legacy metadata compatibility. */
  renderedDigest?: string;
  renderedFileName?: string;
  renderedSourceDigest?: string;
  /** Version-bound, server-recorded complete visual inspection state. */
  visualQaArtifactId?: string;
  visualQaDigest?: string;
  visualQaPageCount?: number;
  visualQaSeenPages?: number[];
  updatedAt: string;
};
