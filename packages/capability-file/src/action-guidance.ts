import type { FileToolInput } from './types.js';

/** Shared by the model schema and direct execution; prevent silent misrouting. */
export function fileActionInputIssues(input: FileToolInput) {
  const issues: Array<{ field: string; message: string }> = [];
  const action = input.action;
  const has = (key: string) => input[key] !== undefined && input[key] !== null
    && (typeof input[key] !== 'string' || Boolean((input[key] as string).trim()));
  const requireField = (field: string, message: string) => {
    if (!has(field)) issues.push({ field, message });
  };
  const forbid = (fields: string[], message: string) => {
    for (const field of fields) if (has(field)) issues.push({ field, message });
  };
  if (action !== 'readSource') forbid(['includeDiagnostics'], 'includeDiagnostics is only supported by readSource. It reads saved validation details, not file content or page images.');
  if (action !== 'edit') forbid(['replacements'], 'replacements is only supported by edit.');
  if (action !== 'plan') forbid(['design'], 'design is the initial plan brief, not an edit operation or a visual review. Preserve that brief when authoring and repairing the source.');
  if (action === 'readSource') {
    requireField('documentId', 'readSource requires the draft documentId returned by plan/list/render. An artifactId identifies a finished file, not its source.');
    forbid(['artifactId', 'attachmentId', 'sourceArtifactId', 'sourceAttachmentId'],
      'readSource accepts only documentId. To inspect a finished file, use readContent with artifactId or attachmentId.');
    forbid(['offset', 'limit', 'pages', 'includeVisuals', 'screenshotIds'],
      'readSource reads code without screenshots. Use startLine/endLine (one-based, inclusive; at most 80 lines) or a returned source-unit path, not limit/offset/pages.');
    if (input.startLine !== undefined && input.endLine !== undefined && input.endLine < input.startLine) {
      issues.push({ field: 'endLine', message: 'endLine must be greater than or equal to startLine.' });
    }
  }
  if (action === 'readContent') {
    if (Number(has('artifactId')) + Number(has('attachmentId')) !== 1) {
      issues.push({ field: 'artifactId', message: 'readContent requires exactly one of artifactId (generated/downloaded file) or attachmentId (uploaded file). Use readSource + documentId for Python/JavaScript source.' });
    }
    forbid(['documentId', 'path', 'startLine', 'endLine', 'baseDigest', 'sourceArtifactId', 'sourceAttachmentId'],
      'readContent returns parsed file text/data, NOT the generation source. Use readSource + documentId + startLine/endLine to locate code for edit.');
    forbid(['screenshotIds'], 'Use visualRead + artifactId + screenshotIds for indexed page images, not readContent.');
    if (has('pages') && input.includeVisuals !== true) {
      issues.push({ field: 'pages', message: 'readContent pages requires includeVisuals=true. Omit both for text-only reading; prefer visualIndex/visualRead for visual QA.' });
    }
  }
  if (['plan', 'generate', 'edit', 'render', 'unoApi', 'jsApi'].includes(action || '')) {
    // edit retains its existing unique-baseDigest recovery for legacy clients.
    if (action !== 'edit' || !has('baseDigest')) requireField('documentId', `${action} requires documentId. Use list to recover the current draft identity; do not pass a finished-file artifactId.`);
    forbid(['artifactId', 'attachmentId'], `${action} operates on a draft documentId. For plan(operation=modify), identify the uploaded original with sourceAttachmentId.`);
  }
  if (action === 'plan') {
    requireField('fileName', 'plan requires fileName including its output extension.');
    requireField('documentType', 'plan requires documentType=word|spreadsheet|presentation.');
    if (input.operation === 'modify') requireField('sourceAttachmentId', 'plan(operation=modify) requires sourceAttachmentId of the uploaded original; readContent does not create editable generation source.');
    else forbid(['sourceAttachmentId'], 'sourceAttachmentId is only valid for plan(operation=modify).');
  }
  if (action === 'edit') {
    requireField('baseDigest', 'edit requires baseDigest copied from the latest readSource.patchBaseDigest, not sourceDigest/renderedDigest/an artifactId.');
    if (Number(has('patch')) + Number(has('replacements')) !== 1) {
      issues.push({ field: 'patch', message: 'edit requires exactly one of replacements (exact oldText/newText pairs, preferred for indentation) or patch (Codex diff). Read source first, preserve every space, and use the latest baseDigest.' });
    }
    forbid(['program', 'spec'], 'edit accepts patch, not replacement program/spec. Use a focused source patch.');
  }
  if (action === 'render') {
    forbid(['program', 'spec', 'patch', 'render'], 'render publishes the current draft; it does not author source. Use generate/edit first, then render once after validation.');
  }
  if (action === 'convert') {
    requireField('sourceArtifactId', 'convert requires sourceArtifactId of the existing file; this is format conversion, not draft generation or editing.');
    forbid(['artifactId', 'attachmentId', 'documentId'], 'convert uses sourceArtifactId, not artifactId/attachmentId/documentId.');
  }
  if (action === 'download') {
    if (['urlOrPath', 'url', 'path'].filter(has).length !== 1) {
      issues.push({ field: 'urlOrPath', message: 'download requires exactly one HTTP(S) URL or page-relative URL path in urlOrPath, url, or path, plus fileType without a dot. OS paths are not downloadable; local assets must be uploaded or host-bound.' });
    }
    requireField('fileType', 'download requires fileType without a dot, such as png or pdf.');
  }
  if (['visualIndex', 'visualRead', 'visualReport'].includes(action || '')) {
    forbid(['documentId', 'attachmentId', 'startLine', 'endLine', 'pages'],
      'Visual actions inspect a rendered artifactId, not source or worksheet IDs. visualIndex returns screenshotIds; visualRead uses those exact IDs.');
  }
  return issues;
}
