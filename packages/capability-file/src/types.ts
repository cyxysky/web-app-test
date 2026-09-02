import type {
  CapabilityExecutionContext,
  CapabilityHealth,
  CapabilityResult,
} from '@webpilot/capability-sdk';
import type {
  OfficeDocumentKind,
  OfficeVisualQaCheckStatus,
  OfficeVisualQaDeckChecks,
  OfficeVisualQaIssue,
  OfficeVisualQaPageChecks,
} from './office/types.js';

export const fileActions = [
  'list',
  'read',
  'download',
  'convert',
  'plan',
  'generate',
  'edit',
  'unoApi',
  'jsApi',
  'render',
] as const;

export const fileVisualToolActions = [
  'visualIndex',
  'visualRead',
  'visualReport',
] as const;

export type FileAction = typeof fileActions[number];
export type FileVisualToolAction = typeof fileVisualToolActions[number];
export type FileDocumentType = OfficeDocumentKind;
export type FileOperation = 'create' | 'modify';

export type FileToolInput = {
  reason?: string;
  action?: string;
  attachmentId?: string;
  artifactId?: string;
  sourceArtifactId?: string;
  documentId?: string;
  fileName?: string;
  fileType?: string;
  documentType?: FileDocumentType;
  operation?: FileOperation;
  sourceAttachmentId?: string;
  intent?: string;
  url?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  urlOrPath?: string;
  program?: string;
  baseDigest?: string;
  replaceExisting?: boolean;
  patch?: string;
  render?: boolean;
  includeVisuals?: boolean;
  offset?: number;
  limit?: number;
  pages?: number[];
  query?: string;
  screenshotIds?: string[];
  reviews?: FileVisualReview[];
  deckReview?: FileVisualDeckReview;
  [key: string]: unknown;
};

export type FileReadInput = Pick<
  FileToolInput,
  'attachmentId' | 'artifactId' | 'includeVisuals' | 'limit' | 'offset' | 'pages'
>;

export type FileAttachmentBinding = {
  name: string;
  path: string;
  ref: string;
};

export type FileArtifactOperationResult = {
  ok: boolean;
  actual: string;
  referenceImagePaths?: string[];
};

export type FileVisualCheckStatus = OfficeVisualQaCheckStatus;
export type FileVisualPageChecks = OfficeVisualQaPageChecks;
export type FileVisualDeckChecks = OfficeVisualQaDeckChecks;
export type FileVisualIssue = OfficeVisualQaIssue;

export type FileVisualReview = {
  screenshotId: string;
  status: 'failed' | 'passed';
  observation: string;
  checks: FileVisualPageChecks;
  issues?: FileVisualIssue[];
};

export type FileVisualDeckReview = {
  status: 'failed' | 'passed';
  observation: string;
  checks: FileVisualDeckChecks;
  issues?: FileVisualIssue[];
};

export const fileVisualActions = ['index', 'read', 'report'] as const;
export type FileVisualAction = typeof fileVisualActions[number];

export type FileVisualToolInput = {
  reason?: string;
  action: FileVisualAction;
  artifactId: string;
  screenshotIds?: string[];
  reviews?: FileVisualReview[];
  deckReview?: FileVisualDeckReview;
  offset?: number;
  limit?: number;
};

export type FileActionInput<TAction extends FileAction> = FileToolInput & {
  action: TAction;
};

export type FileActionHandler<TAction extends FileAction> = (
  input: FileActionInput<TAction>,
  context: CapabilityExecutionContext,
) => Promise<CapabilityResult>;

export type FileCapabilityOperations = {
  [TAction in FileAction]?: FileActionHandler<TAction>;
};

export type FileVisualActionHandler<TAction extends FileVisualAction> = (
  input: FileVisualToolInput & { action: TAction },
  context: CapabilityExecutionContext,
) => Promise<CapabilityResult>;

export type FileVisualCapabilityOperations = {
  [TAction in FileVisualAction]?: FileVisualActionHandler<TAction>;
};

export type FileCapabilityRuntimeOperations = {
  file: FileCapabilityOperations;
  visual?: FileVisualCapabilityOperations;
  health?: () => Promise<CapabilityHealth>;
  dispose?: () => Promise<void>;
};
