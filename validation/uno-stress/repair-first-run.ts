import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { editUnoFileArtifact, renderFileArtifact } from '../../src/server/ai/agents/file-artifact-tools';

const validationRoot = path.resolve('validation', 'uno-stress');
const artifactsRoot = path.join(validationRoot, 'artifacts');
const runId = 'uno_stress_20260828080042';
const attachmentBindings = [{
  name: 'office-image-fixture.png',
  path: path.join(validationRoot, 'office-image-fixture.png'),
  ref: 'stress-image',
}];

process.env.ARTIFACTS_DIR = artifactsRoot;
process.env.OFFICE_GENERATION_MODE = 'uno';
process.env.MICROSOFT_OFFICE_VALIDATION ||= 'required';

function payload(actual?: string) {
  try { return JSON.parse(actual || '{}') as Record<string, unknown>; }
  catch { return { raw: actual || '' }; }
}

async function main() {
  const cases = [];
  for (const item of [
    {
      documentId: 'uno-stress-presentation',
      oldText: "    link_cursor.HyperLinkURL = 'https://example.com/uno-validation'\n    link_cursor.CharColor = 0x1565C0\n    link_cursor.CharUnderline = 1",
      newText: "    link_cursor.CharColor = 0x1565C0\n    link_cursor.CharUnderline = 1",
    },
    {
      documentId: 'uno-stress-word',
      oldText: '以下对象位于独立页面，避免与流式正文发生非预期重叠。',
      newText: '本页对象位于独立页面，避免与流式正文发生非预期重叠。',
    },
  ]) {
    const progress: Array<{ phase: string; message: string }> = [];
    const onProgress = (entry: { phase: string; message: string }) => {
      progress.push(entry);
      process.stdout.write(`[${item.documentId}] ${entry.phase}: ${entry.message}\n`);
    };
    const edited = await editUnoFileArtifact({
      runId,
      documentId: item.documentId,
      edits: [{ kind: 'replaceText', oldText: item.oldText, newText: item.newText }],
      includeVisualVerification: true,
      attachmentBindings,
      onProgress,
    });
    let rendered;
    if (edited.ok) {
      const result = await renderFileArtifact({
        runId,
        documentId: item.documentId,
        includeVisualVerification: true,
        attachmentBindings,
        onProgress,
      });
      rendered = { ok: result.ok, payload: payload(result.actual), referenceImagePaths: result.referenceImagePaths || [] };
    }
    cases.push({ documentId: item.documentId, edited: { ok: edited.ok, payload: payload(edited.actual) }, rendered, progress });
  }
  const reportPath = path.join(validationRoot, `repair-report-${runId}.json`);
  await writeFile(reportPath, JSON.stringify({ runId, cases }, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify({ reportPath, cases }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
