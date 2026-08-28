import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { planFileArtifact, generateUnoFileArtifact, renderFileArtifact } from '../../src/server/ai/agents/file-artifact-tools';

type ActionResult = { ok: boolean; actual?: string; referenceImagePaths?: string[] };

const validationRoot = path.resolve('validation', 'uno-stress');
const artifactsRoot = path.join(validationRoot, 'artifacts');
const imagePath = path.join(validationRoot, 'office-image-fixture.png');
const runId = `uno_stress_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;

process.env.ARTIFACTS_DIR = artifactsRoot;
process.env.OFFICE_GENERATION_MODE = 'uno';
process.env.MICROSOFT_OFFICE_VALIDATION ||= 'required';

function payload(result: ActionResult) {
  try { return JSON.parse(result.actual || '{}') as Record<string, unknown>; }
  catch { return { raw: result.actual || '' }; }
}

async function runCase(input: {
  documentId: string;
  documentType: 'presentation' | 'word';
  fileName: string;
  sourceFile: string;
}) {
  const attachmentBindings = [{ name: 'office-image-fixture.png', path: imagePath, ref: 'stress-image' }];
  const progress: Array<{ phase: string; message: string }> = [];
  const onProgress = (item: { phase: string; message: string }) => {
    progress.push(item);
    process.stdout.write(`[${input.documentId}] ${item.phase}: ${item.message}\n`);
  };
  const planned = await planFileArtifact({
    runId,
    documentId: input.documentId,
    documentType: input.documentType,
    fileName: input.fileName,
    intent: 'Broad deterministic UNO stress validation fixture',
    operation: 'create',
    attachmentBindings,
  });
  const plannedPayload = payload(planned);
  if (!planned.ok) return { input, planned, progress };
  const assets = Array.isArray(plannedPayload.availableAssets) ? plannedPayload.availableAssets as Array<Record<string, unknown>> : [];
  const imageAsset = assets.find((asset) => asset.ref === 'stress-image');
  if (!imageAsset?.assetName) throw new Error(`${input.documentId}: mounted image asset was not returned by action=plan`);
  const sourceTemplate = await readFile(path.join(validationRoot, input.sourceFile), 'utf8');
  const program = sourceTemplate.replaceAll('__ASSET__', String(imageAsset.assetName));
  const generated = await generateUnoFileArtifact({
    runId,
    documentId: input.documentId,
    program,
    includeVisualVerification: true,
    attachmentBindings,
    onProgress,
  });
  if (!generated.ok) return { input, planned: plannedPayload, generated: payload(generated), progress };
  const rendered = await renderFileArtifact({
    runId,
    documentId: input.documentId,
    includeVisualVerification: true,
    attachmentBindings,
    onProgress,
  });
  const renderedPayload = payload(rendered);
  const artifactId = typeof renderedPayload.artifactId === 'string' ? renderedPayload.artifactId : undefined;
  return {
    input,
    planned: plannedPayload,
    generated: payload(generated),
    rendered: renderedPayload,
    outputPath: artifactId ? path.join(artifactsRoot, ...artifactId.split('/')) : undefined,
    previewImages: rendered.referenceImagePaths || [],
    progress,
  };
}

async function main() {
  await mkdir(artifactsRoot, { recursive: true });
  const cases = [];
  const requestedTypes = new Set(process.argv.slice(2).map((value) => value.toLowerCase()));
  const inputs = [
    { documentId: 'uno-stress-presentation', documentType: 'presentation' as const, fileName: 'uno-stress-presentation.pptx', sourceFile: 'presentation.py' },
    { documentId: 'uno-stress-word', documentType: 'word' as const, fileName: 'uno-stress-word.docx', sourceFile: 'word.py' },
  ].filter((input) => !requestedTypes.size || requestedTypes.has(input.documentType));
  for (const input of inputs) {
    try { cases.push(await runCase(input)); }
    catch (error) { cases.push({ input, fatalError: error instanceof Error ? error.stack || error.message : String(error) }); }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    environment: {
      officeGenerationMode: process.env.OFFICE_GENERATION_MODE,
      microsoftOfficeValidation: process.env.MICROSOFT_OFFICE_VALIDATION,
    },
    cases,
  };
  const reportPath = path.join(validationRoot, `report-${runId}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify({ reportPath, cases: cases.map((item) => ({
    documentId: item.input.documentId,
    fatalError: 'fatalError' in item ? item.fatalError : undefined,
    outputPath: 'outputPath' in item ? item.outputPath : undefined,
    previewImages: 'previewImages' in item ? item.previewImages.length : 0,
    generated: 'generated' in item ? item.generated : undefined,
    rendered: 'rendered' in item ? item.rendered : undefined,
  })) }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
