export type OfficeThemePreset = 'professional' | 'minimal' | 'executive' | 'warm';

export type OfficeTheme = {
  preset?: OfficeThemePreset;
  primaryColor?: string;
  accentColor?: string;
  bodyColor?: string;
  backgroundColor?: string;
  fontFamily?: string;
};

export type OfficeCellValue = string | number | boolean | null;

export type OfficeSheetColumn = {
  format?: string;
  index: number;
  width?: number;
};

export type OfficeSheetFormula = {
  cell: string;
  formula: string;
};

export type OfficeSheetRangeStyle = {
  backgroundColor?: string;
  bold?: boolean;
  color?: string;
  horizontal?: 'center' | 'left' | 'right';
  numberFormat?: string;
  range: string;
};

export type OfficeSheetChart = {
  range: string;
  title?: string;
  type: 'area' | 'bar' | 'column' | 'line' | 'pie';
};

export type OfficeSheetSpec = {
  autoFilter?: boolean;
  charts?: OfficeSheetChart[];
  columns?: OfficeSheetColumn[];
  formulas?: OfficeSheetFormula[];
  freezeColumns?: number;
  freezeRows?: number;
  headerRows?: number;
  landscape?: boolean;
  merges?: string[];
  name?: string;
  rows: OfficeCellValue[][];
  styles?: OfficeSheetRangeStyle[];
};

export type OfficeSlideSpec = {
  bullets?: string[];
  content?: string;
  subtitle?: string;
  title?: string;
};

export type OfficeDocumentSpec = {
  content?: string | null;
  documentType?: 'presentation' | 'spreadsheet' | 'word';
  fileName: string;
  sheets?: OfficeSheetSpec[];
  slides?: OfficeSlideSpec[];
  subtitle?: string | null;
  theme?: OfficeTheme;
  title?: string | null;
};
