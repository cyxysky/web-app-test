import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  generateFileBuffer,
  readFileVisuals as readBrowserChatFileVisuals,
  renderFilePreview as renderBrowserChatAttachmentVisuals,
  resolveLibreOfficeExecutable,
  resolveLibreOfficePythonExecutable,
  resolveUnoProgramWorker,
} from '@webpilot/capability-file/node';

const passedPageVisualChecks = {
  overlap: 'passed', clipping: 'passed', alignment: 'passed', spacing: 'passed',
  typography: 'passed', contrast: 'passed', visualHierarchy: 'passed',
  chartTableLegibility: 'not-applicable', imageQuality: 'not-applicable',
} as const;

async function officeGenerationAvailable() {
  const executable = await resolveLibreOfficeExecutable();
  return Boolean(executable && await resolveLibreOfficePythonExecutable(executable) && await resolveUnoProgramWorker());
}

test('renders selected PDF pages into model-ready PNG files', async (context) => {
  if (!await officeGenerationAvailable()) return context.skip('LibreOffice UNO generation is not available in this environment.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'webpilot-attachment-visual-'));
  const sourcePath = path.join(root, 'source.pdf');
  const generated = await generateFileBuffer({
    document: { title: 'Attachment visual pages' }, documentType: 'word', fileName: 'source.pdf', generator: 'uno',
    program: `
def create_document(job):
    document = job.writer('document')
    for index in range(140):
        document.add_paragraph(f'paragraph-{index + 1}', f'Paragraph {index + 1}: enough content to verify exact PDF page selection.')
    document.save()
    document.close()
`,
  });
  await writeFile(sourcePath, generated.buffer);
  try {
    const result = await renderBrowserChatAttachmentVisuals({ absolutePath: sourcePath, buffer: generated.buffer, extension: '.pdf', name: 'source.pdf', pages: [2], previewRoot: path.join(root, 'previews') });
    assert.equal(result.renderer, 'pdf');
    assert.ok((result.pageCount ?? 0) >= 2);
    assert.deepEqual(result.renderedPages, [2]);
    assert.equal((await readFile(result.imagePaths[0])).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

    await renderBrowserChatAttachmentVisuals({ absolutePath: sourcePath, buffer: generated.buffer, extension: '.pdf', name: 'source.pdf', pages: [1], previewRoot: path.join(root, 'previews') });
    const cachedSecondPage = await renderBrowserChatAttachmentVisuals({ absolutePath: sourcePath, buffer: generated.buffer, extension: '.pdf', name: 'source.pdf', pages: [2], previewRoot: path.join(root, 'previews') });
    assert.deepEqual(cachedSecondPage.automaticChecks?.map((check) => check.pageNumber), [2]);

    const attachment = {
      id: 'artifact-1',
      kind: 'file' as const,
      name: 'source.pdf',
      path: 'generated/source.pdf',
      type: 'application/pdf',
      url: '/artifacts/generated/source.pdf',
    };
    const indexResult = await readBrowserChatFileVisuals({
      attachment,
      absolutePath: sourcePath,
      request: { action: 'index', artifactId: 'generated/source.pdf', limit: 2 },
      previewRoot: path.join(root, 'previews'),
    });
    assert.equal(indexResult.ok, true, indexResult.actual);
    const index = JSON.parse(indexResult.actual) as {
      screenshotCount: number;
      screenshots: Array<{ screenshotId: string; pageNumber: number }>;
    };
    assert.ok(index.screenshotCount >= 2);
    assert.deepEqual(index.screenshots.slice(0, 2), [
      { screenshotId: 'screenshot-0001', pageNumber: 1 },
      { screenshotId: 'screenshot-0002', pageNumber: 2 },
    ]);
    assert.equal(indexResult.referenceImagePaths, undefined);

    const readResult = await readBrowserChatFileVisuals({
      attachment,
      absolutePath: sourcePath,
      request: { action: 'read', artifactId: 'generated/source.pdf', screenshotIds: ['screenshot-0002', 'screenshot-0001'] },
      previewRoot: path.join(root, 'previews'),
    });
    assert.equal(readResult.ok, true, readResult.actual);
    assert.equal(readResult.referenceImagePaths?.length, 2);
    const readPayload = JSON.parse(readResult.actual) as { screenshots: Array<{ screenshotDigest?: string }> };
    assert.ok(readPayload.screenshots.every((screenshot) => /^[a-f0-9]{64}$/.test(screenshot.screenshotDigest || '')));
    assert.match(readResult.referenceImagePaths?.[0] || '', /page-0002\.png$/);
    assert.match(readResult.referenceImagePaths?.[1] || '', /page-0001\.png$/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('renders a LibreOffice-generated DOCX into visual pages without detaching the source', async (context) => {
  if (!await officeGenerationAvailable()) return context.skip('LibreOffice UNO generation is not available in this environment.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'webpilot-docx-visual-'));
  const sourcePath = path.join(root, 'template.docx');
  const generated = await generateFileBuffer({
    document: { title: '研发部员工年中工作总结报告' }, documentType: 'word', fileName: 'template.docx', generator: 'uno',
    program: `
def create_document(job):
    document = job.writer('document')
    document.add_title('title', '研发部员工年中工作总结报告')
    document.add_paragraph('summary', '本年度研发工作按计划推进。')
    document.save()
    document.close()
`,
  });
  await writeFile(sourcePath, generated.buffer);
  try {
    const result = await renderBrowserChatAttachmentVisuals({ absolutePath: sourcePath, buffer: generated.buffer, extension: '.docx', name: 'template.docx', pages: [1], previewRoot: path.join(root, 'previews') });
    assert.ok(result.renderer === 'html-preview' || result.renderer === 'libreoffice-pdf', result.warning);
    assert.deepEqual(result.renderedPages, [1]);
    assert.equal((await readFile(result.imagePaths[0])).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    if (result.renderer === 'libreoffice-pdf') {
      await rm(sourcePath, { force: true });
      const cached = await renderBrowserChatAttachmentVisuals({ absolutePath: sourcePath, buffer: generated.buffer, extension: '.docx', name: 'template.docx', pages: [1], previewRoot: path.join(root, 'previews') });
      assert.equal(cached.renderer, 'libreoffice-pdf');
      assert.deepEqual(cached.renderedPages, [1]);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('fileVisual records explicit structured page reviews separately from screenshot reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webpilot-file-visual-report-'));
  const artifactPath = path.join(root, 'report.pptx');
  await writeFile(artifactPath, Buffer.from('saved-office-artifact'));
  try {
    const result = await readBrowserChatFileVisuals({
      absolutePath: artifactPath,
      attachment: {
        id: 'generated/report.pptx',
        kind: 'file',
        name: 'report.pptx',
        path: 'generated/report.pptx',
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        url: '',
      },
      request: {
        action: 'report',
        artifactId: 'generated/report.pptx',
        reviews: [{
          screenshotId: 'screenshot-0001',
          status: 'passed',
          observation: 'The page title, content region, and footer are visibly separated with consistent margins and readable type.',
          checks: passedPageVisualChecks,
          issues: [],
        }],
      },
    });
    assert.equal(result.ok, true, result.actual);
    assert.match(result.actual, /file-visual-report/);
    assert.match(result.actual, /"status":"passed"/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('fileVisual rejects a bare pass without visual evidence and rubric checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webpilot-file-visual-bare-pass-'));
  const artifactPath = path.join(root, 'report.pptx');
  await writeFile(artifactPath, Buffer.from('saved-office-artifact'));
  try {
    const result = await readBrowserChatFileVisuals({
      absolutePath: artifactPath,
      attachment: {
        id: 'generated/report.pptx',
        kind: 'file',
        name: 'report.pptx',
        path: 'generated/report.pptx',
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        url: '',
      },
      request: {
        action: 'report',
        artifactId: 'generated/report.pptx',
        reviews: [{ screenshotId: 'screenshot-0001', status: 'passed', issues: [] }],
      } as never,
    });
    assert.equal(result.ok, false);
    assert.match(result.actual, /concrete visual observation|visual-quality checks/i);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
