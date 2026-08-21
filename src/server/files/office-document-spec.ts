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
  width?: number | string;
  x?: number | string;
  y?: number | string;
  [property: string]: unknown;
};

export type OfficeBlock = {
  id: string;
  type: OfficeBlockType | (string & {});
  alt?: string;
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

export type OfficeDocumentOutlineItem = {
  id: string;
  title: string;
  purpose?: string;
  suggestedBlocks?: string[];
};

export type OfficeDocumentDraft = OfficeDocumentSpec & {
  createdAt: string;
  documentId: string;
  intent?: string;
  outline?: OfficeDocumentOutlineItem[];
  updatedAt: string;
};

export type OfficeDocumentEditOperation = {
  op: 'add' | 'move' | 'remove' | 'replace' | 'setDocument' | 'update';
  afterId?: string;
  beforeId?: string;
  block?: OfficeBlock;
  blockId?: string;
  blockIds?: string[];
  blocks?: OfficeBlock[];
  parentId?: string;
  patch?: Record<string, unknown>;
};
