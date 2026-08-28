import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { planFileArtifact, generateUnoFileArtifact, renderFileArtifact } from '../../src/server/ai/agents/file-artifact-tools';
import { renderBrowserChatAttachmentVisuals } from '../../src/server/ai/agents/browser-chat-attachment-visuals';

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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type FullVisualRenderer = {
  outputPath: string;
  pageCount: number;
  imagePaths: string[];
  renderedPages: number[];
  automaticChecks: unknown[];
};

async function renderEveryValidatedPage(documentId: string, generated: Record<string, unknown>) {
  const validation = record(generated.automaticValidation);
  const rendererMatrix = record(validation.rendererMatrix);
  const renderers = record(rendererMatrix.renderers);
  const results: Partial<Record<'libreOffice' | 'microsoftOffice', FullVisualRenderer>> = {};
  for (const rendererName of ['libreOffice', 'microsoftOffice'] as const) {
    const renderer = record(renderers[rendererName]);
    const outputPath = typeof renderer.outputPath === 'string' ? renderer.outputPath : '';
    const pageCount = Number(record(renderer.summary).pages || 0);
    if (!outputPath || !Number.isInteger(pageCount) || pageCount < 1) continue;
    const batches = [];
    for (let start = 1; start <= pageCount; start += 6) {
      const pages = Array.from({ length: Math.min(6, pageCount - start + 1) }, (_, index) => start + index);
      batches.push(await renderBrowserChatAttachmentVisuals({
        absolutePath: outputPath,
        cacheKey: `${runId}:${documentId}:${rendererName}`,
        extension: '.pdf',
        name: `${documentId}-${rendererName}.pdf`,
        pages,
        previewRoot: path.join(validationRoot, 'full-renders', runId, documentId, rendererName),
      }));
    }
    results[rendererName] = {
      outputPath,
      pageCount,
      imagePaths: batches.flatMap((batch) => batch.imagePaths),
      renderedPages: batches.flatMap((batch) => batch.renderedPages),
      automaticChecks: batches.flatMap((batch) => batch.automaticChecks || []),
    };
  }
  return results;
}

async function compareRenderedPage(leftPath: string, rightPath: string) {
  const [left, right] = await Promise.all([
    sharp(leftPath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(rightPath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (left.info.width !== right.info.width || left.info.height !== right.info.height || left.info.channels !== right.info.channels) {
    return { dimensionsMatch: false, left: left.info, right: right.info, materialDifference: true };
  }
  let absoluteDifference = 0;
  let changedPixels = 0;
  const channels = left.info.channels;
  for (let offset = 0; offset < left.data.length; offset += channels) {
    let largestChannelDifference = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const difference = Math.abs(left.data[offset + channel] - right.data[offset + channel]);
      absoluteDifference += difference;
      largestChannelDifference = Math.max(largestChannelDifference, difference);
    }
    if (largestChannelDifference > 32) changedPixels += 1;
  }
  const pixelCount = left.info.width * left.info.height;
  const meanAbsoluteDifference = absoluteDifference / left.data.length / 255;
  const changedPixelRatio = changedPixels / pixelCount;
  return {
    dimensionsMatch: true,
    width: left.info.width,
    height: left.info.height,
    meanAbsoluteDifference,
    changedPixelRatio,
    materialDifference: meanAbsoluteDifference >= 0.03 || changedPixelRatio >= 0.05,
  };
}

async function compareRendererVisuals(visuals: Awaited<ReturnType<typeof renderEveryValidatedPage>>) {
  const libreOffice = visuals.libreOffice;
  const microsoftOffice = visuals.microsoftOffice;
  if (!libreOffice || !microsoftOffice) return { available: false, pages: [] };
  const pageCount = Math.min(libreOffice.imagePaths.length, microsoftOffice.imagePaths.length);
  const pages = [];
  for (let index = 0; index < pageCount; index += 1) {
    pages.push({
      pageNumber: index + 1,
      ...await compareRenderedPage(libreOffice.imagePaths[index], microsoftOffice.imagePaths[index]),
    });
  }
  return {
    available: true,
    comparedPages: pageCount,
    materialDifferencePages: pages.filter((page) => page.materialDifference).map((page) => page.pageNumber),
    pages,
  };
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
  const generatedPayload = payload(generated);
  if (!generated.ok) return { input, planned: plannedPayload, generated: generatedPayload, progress };
  const rendered = await renderFileArtifact({
    runId,
    documentId: input.documentId,
    includeVisualVerification: true,
    attachmentBindings,
    onProgress,
  });
  const renderedPayload = payload(rendered);
  const artifactId = typeof renderedPayload.artifactId === 'string' ? renderedPayload.artifactId : undefined;
  const fullVisuals = await renderEveryValidatedPage(input.documentId, generatedPayload);
  const crossRendererVisualComparison = await compareRendererVisuals(fullVisuals);
  return {
    input,
    planned: plannedPayload,
    generated: generatedPayload,
    rendered: renderedPayload,
    outputPath: artifactId ? path.join(artifactsRoot, ...artifactId.split('/')) : undefined,
    previewImages: rendered.referenceImagePaths || [],
    fullVisuals,
    crossRendererVisualComparison,
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
    previewImages: 'previewImages' in item ? item.previewImages?.length || 0 : 0,
    fullVisuals: 'fullVisuals' in item ? item.fullVisuals : undefined,
    crossRendererVisualComparison: 'crossRendererVisualComparison' in item ? item.crossRendererVisualComparison : undefined,
    generated: 'generated' in item ? item.generated : undefined,
    rendered: 'rendered' in item ? item.rendered : undefined,
  })) }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
