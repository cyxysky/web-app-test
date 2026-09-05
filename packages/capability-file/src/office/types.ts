/** Framework-neutral Office document and workflow data contracts. */
export type OfficeCellValue = string | number | boolean | null;

export type OfficeDocumentKind = 'presentation' | 'spreadsheet' | 'word';

export type OfficeThemePreset = 'clean' | 'editorial' | 'executive' | 'signal';

/** Authoring decisions, not a claim that the rendered artifact passed design review. */
export type OfficeDesignBrief = {
  mode: 'template' | 'bespoke';
  audience?: string;
  objective?: string;
  reference?: string;
  directions?: Array<{
    id: string;
    concept: string;
    composition: string;
    typography: string;
    imagery: string;
  }>;
  selectedDirection?: string;
  selectionReason?: string;
  rhythm?: string;
  preserve?: string[];
  avoid?: string[];
};

export type OfficeThemeColors = {
  accent: string;
  background: string;
  border: string;
  muted: string;
  primary: string;
  secondary: string;
  surface: string;
  text: string;
};

export type OfficeThemeFonts = {
  body: string;
  heading: string;
  mono: string;
};

export type OfficeThemeTypography = {
  body: number;
  caption: number;
  heading: number;
  metric: number;
  title: number;
};

/** Versioned design tokens shared by semantic Word, PowerPoint, and Excel generation. */
export type OfficeThemeDefinition = {
  colors?: Partial<OfficeThemeColors>;
  fonts?: Partial<OfficeThemeFonts>;
  preset?: OfficeThemePreset;
  typography?: Partial<OfficeThemeTypography>;
  version?: '1';
};

export type OfficeSemanticTemplate =
  | 'cover'
  | 'section'
  | 'content'
  | 'two-column'
  | 'comparison'
  | 'kpi'
  | 'chart'
  | 'image'
  | 'reference'
  | 'report'
  | 'worksheet';

/** Layout guardrails are enabled by default for semantic generation. */
export type OfficeLayoutPolicy = {
  enabled?: boolean;
  imageFit?: 'contain';
  maxCharactersPerSlide?: number;
  maxContentUnitsPerSlide?: number;
  maxListItemsPerSlide?: number;
  maxTableColumns?: number;
  maxTableRowsPerSlide?: number;
  minPresentationBodyFontSize?: number;
  minSpreadsheetFontSize?: number;
  minWordBodyFontSize?: number;
  mode?: 'repair' | 'strict';
  overflow?: 'error' | 'shrink' | 'split';
  safeMargin?: number;
};

export type OfficeLayoutDiagnostic = {
  blockId?: string;
  code: string;
  message: string;
  pageId?: string;
  repaired?: boolean;
  severity: 'error' | 'info' | 'warning';
};

export type OfficeVisualQaCheckStatus = 'failed' | 'not-applicable' | 'passed';

export type OfficeVisualQaPageChecks = {
  overlap: OfficeVisualQaCheckStatus;
  clipping: OfficeVisualQaCheckStatus;
  alignment: OfficeVisualQaCheckStatus;
  spacing: OfficeVisualQaCheckStatus;
  typography: OfficeVisualQaCheckStatus;
  contrast: OfficeVisualQaCheckStatus;
  visualHierarchy: OfficeVisualQaCheckStatus;
  chartTableLegibility: OfficeVisualQaCheckStatus;
  imageQuality: OfficeVisualQaCheckStatus;
};

export type OfficeVisualQaDeckChecks = {
  templateConsistency: 'failed' | 'passed';
  typographyConsistency: 'failed' | 'passed';
  colorConsistency: 'failed' | 'passed';
  spacingRhythm: 'failed' | 'passed';
  componentConsistency: 'failed' | 'passed';
  /** Required for briefs explicitly planned as bespoke; optional for legacy drafts. */
  designIntent?: 'failed' | 'passed';
  compositionRhythm?: 'failed' | 'passed';
  contentConsistency?: 'failed' | 'passed';
  sourceTraceability?: 'failed' | 'passed';
};

export type OfficeVisualQaIssue = {
  type: string;
  description: string;
  region?: string;
  severity?: 'error' | 'warning';
};

export type OfficeVisualQaDeckReview = {
  status: 'failed' | 'passed';
  observation: string;
  checks: OfficeVisualQaDeckChecks;
  issues: OfficeVisualQaIssue[];
};

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
  subtitle?: string;
  template?: OfficeSemanticTemplate;
  svg?: string;
  text?: string;
  title?: string;
  unoProperties?: Record<string, unknown>;
  unoService?: string;
  [property: string]: unknown;
};

/** Author-facing recursive block. IDs are optional because the semantic compiler assigns stable ones. */
export type OfficeSemanticBlockInput = {
  id?: string;
  type: OfficeBlockType | (string & {});
  alt?: string;
  breakBefore?: 'page';
  caption?: string;
  children?: OfficeSemanticBlockInput[];
  columns?: Array<{ blocks?: OfficeSemanticBlockInput[]; width?: number | string }>;
  data?: unknown;
  items?: unknown[];
  language?: string;
  level?: number;
  markdown?: string;
  name?: string;
  rows?: OfficeCellValue[][];
  source?: string;
  style?: OfficeBlockStyle;
  subtitle?: string;
  template?: OfficeSemanticTemplate;
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
  /** Semantic document contract version. Omitted values use the current stable version. */
  schemaVersion?: '1.0';
  /** Versioned preset or a preset with scoped token overrides. */
  theme?: OfficeThemePreset | OfficeThemeDefinition;
  /** Deterministic layout constraints; enabled with repair mode by default. */
  layout?: OfficeLayoutPolicy;
};

/** Compact create input; fileName and documentType may be supplied by an existing plan. */
export type OfficeSemanticDocumentInput = Omit<OfficeDocumentSpec, 'blocks' | 'document' | 'documentType' | 'fileName'> & {
  blocks: OfficeSemanticBlockInput[];
  document?: OfficeDocumentSettings;
  documentType?: OfficeDocumentKind;
  fileName?: string;
};

/** A planned document plus its executable draft; semantic create specs compile into the same source workflow. */
export type OfficeDocumentDraft = {
  createdAt: string;
  documentId: string;
  documentType: OfficeDocumentKind;
  fileName: string;
  intent?: string;
  design?: OfficeDesignBrief;
  /** Create a new file or modify a user-supplied Office document in place. */
  operation?: 'create' | 'modify';
  /** Program runtime selected when the workspace is planned. Existing-file modification always uses UNO. */
  generator?: 'javascript' | 'uno';
  /** Metadata for a compact semantic spec compiled into the ordinary executable draft pipeline. */
  semantic?: {
    diagnostics: OfficeLayoutDiagnostic[];
    layout: Required<OfficeLayoutPolicy>;
    schemaVersion: '1.0';
    theme: OfficeThemeDefinition & {
      colors: OfficeThemeColors;
      fonts: OfficeThemeFonts;
      preset: OfficeThemePreset;
      typography: OfficeThemeTypography;
      version: '1';
    };
  };
  /** Digest of the most recently delivered executable facade module. */
  unoApiCatalogDigest?: string;
  /** First module delivery time. */
  unoApiCatalogLoadedAt?: string;
  /** Module query -> installed-catalog digest, used to recognize repeated lookups. */
  unoApiModuleDigests?: Record<string, string>;
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
  /** Receipt committed with source bytes. Only the identical latest edit at this resulting revision is replayable. */
  lastSourceEdit?: {
    requestDigest: string;
    beforeDigest: string;
    afterDigest: string;
    totalHunks: number;
  };
  /** Digest of the current source after static analysis, execution, reopen, and structural validation pass. */
  validatedSourceDigest?: string;
  validationStatus?: 'failed' | 'pending' | 'passed';
  /** Failed validations in this repair sequence; may have different causes and source versions. Not a bridge retry count. */
  validationFailureCount?: number;
  /** Source/worker revision actually checked, not the time the draft was last read or saved. */
  validationEvidence?: {
    sourceDigest: string;
    workerDigest: string | null;
    checkedAt: string;
    scope: 'document' | 'source-unit';
    sourceUnitPath?: string;
    stage: 'static-analysis' | 'execution' | 'artifact-validation' | 'complete';
  };
  validationDiagnostics?: Array<{
    code?: string;
    column?: number;
    elementId?: string;
    elementIds?: string[];
    line?: number;
    locator?: Record<string, unknown>;
    message: string;
    page?: number;
    severity?: 'error' | 'warning';
    shapes?: number[];
    sourceExcerpt?: string;
    target?: string;
    unitPath?: string;
  }>;
  /** Stable source-to-artifact identity records emitted by the active authoring runtime. */
  elementMap?: Array<{
    artifactName?: string;
    column?: number;
    elementId: string;
    kind: string;
    line?: number;
    locator?: Record<string, unknown>;
    unitPath?: string;
  }>;
  /** Deterministic LibreOffice renderer validation for the validated source. */
  rendererValidation?: Record<string, unknown>;
  /** Logical page/section units from explicit markers or inferred presentation slide blocks. */
  sourceUnits?: Array<{
    path: string;
    sourceDigest: string;
    validatedDigest?: string;
    status: 'failed' | 'pending' | 'passed';
  }>;
  workflow?: {
    state: 'authoring' | 'completed' | 'failed' | 'planned' | 'qa-pending' | 'render-ready' | 'rendering' | 'validating';
    checkpointAt: string;
    error?: string;
    recoveredFrom?: 'rendering' | 'validating';
    renderedDigest?: string;
  };
  /** Artifact identity of the last published source. A later edit makes this stale. */
  renderedArtifactId?: string;
  /** Current published source digest. */
  renderedDigest?: string;
  renderedFileName?: string;
  /** Version-bound, server-recorded complete visual inspection state. */
  visualQaArtifactId?: string;
  visualQaDigest?: string;
  visualQaPageCount?: number;
  visualQaSeenPages?: number[];
  visualQaReviews?: Array<{
    pageNumber: number;
    status: 'failed' | 'passed';
    observation: string;
    checks: OfficeVisualQaPageChecks;
    issues: OfficeVisualQaIssue[];
  }>;
  /** Required cross-page consistency judgment for the exact rendered artifact. */
  visualQaDeckReview?: OfficeVisualQaDeckReview;
  /** Exact rendered screenshot hashes used to safely reuse passed reviews across published outputs. */
  visualQaPageDigests?: Array<{ pageNumber: number; screenshotDigest: string }>;
  visualQaReviewCache?: Array<{
    screenshotDigest: string;
    status: 'failed' | 'passed';
    observation: string;
    checks: OfficeVisualQaPageChecks;
    issues: OfficeVisualQaIssue[];
  }>;
  updatedAt: string;
};
