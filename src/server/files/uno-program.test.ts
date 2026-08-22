import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { generateUnoProgramDocument, inspectUnoApi, resolveUnoProgramWorker } from './uno-program';
import { resolveLibreOfficeExecutable } from './libreoffice';

test('UNO verification reopens generated Office files read-only', async () => {
  const worker = await resolveUnoProgramWorker();
  assert.ok(worker, 'LibreOffice UNO worker must exist');
  const source = await readFile(worker, 'utf8');
  const verificationStart = source.indexOf('def verify_and_preview');
  const verificationEnd = source.indexOf('\ndef verify_embedded_images', verificationStart);
  assert.ok(verificationStart >= 0 && verificationEnd > verificationStart);
  const verificationSource = source.slice(verificationStart, verificationEnd);
  assert.match(verificationSource, /property_value\('ReadOnly', True\)/);
  assert.doesNotMatch(verificationSource, /component\.store\(\)/);
});

test('aborts a stalled UNO worker without waiting for its program to finish', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(new Error('test abort')), 500);
  try {
    await assert.rejects(generateUnoProgramDocument({
      abortSignal: controller.signal,
      documentType: 'presentation',
      fileName: 'stalled-worker.pptx',
      sourceCode: `
def create_document(job):
    while True:
        pass
`,
    }), /test abort/);
    assert.ok(Date.now() - startedAt < 8_000, 'aborted worker should settle promptly');
  } finally {
    clearTimeout(timer);
  }
});

test('UNO program worker creates, reopens, and previews a DOCX', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const generated = await generateUnoProgramDocument({
    documentType: 'word',
    fileName: 'worker-smoke.docx',
    sourceCode: `
def create_document(job):
    document = job.new_document('word')
    cursor = document.Text.createTextCursor()
    document.Text.insertString(cursor, 'UNO worker smoke test', False)
    document.storeAsURL(job.output_url, (job.property('FilterName', 'Office Open XML Text'),))
    job.close(document)
`,
  });
  assert.ok(generated.buffer.byteLength > 64);
  assert.ok(generated.previewPdf && generated.previewPdf.byteLength > 64);
  assert.equal(generated.report.renderer, 'libreoffice-uno');
});

test('accepts LibreOffice factory aliases such as impress', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'alias-smoke.pptx',
    sourceCode: `
def create_document(job):
    document = job.new_document('impress')
    page = document.DrawPages.getByIndex(0)
    shape = document.createInstance('com.sun.star.drawing.TextShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X, position.Y = 1000, 1000
    size = uno.createUnoStruct('com.sun.star.awt.Size')
    size.Width, size.Height = 12000, 2000
    shape.Position, shape.Size = position, size
    page.add(shape)
    shape.String = 'Impress alias works'
    document.storeAsURL(job.output_url, (job.property('FilterName', 'Impress MS PowerPoint 2007 XML'),))
    job.close(document)
`,
  });
  assert.ok(generated.buffer.byteLength > 64);
  assert.equal((generated.report.verification as { pages?: number }).pages, 1);
  const text = (generated.report.verification as { text?: { textCharacters?: number } }).text;
  assert.ok((text?.textCharacters || 0) > 0, JSON.stringify(generated.report.verification));
});

test('rejects Impress text assigned before the TextShape is attached', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  await assert.rejects(generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'detached-text.pptx',
    sourceCode: `
def create_document(job):
    document = job.new_document('impress')
    page = document.DrawPages.getByIndex(0)
    shape = document.createInstance('com.sun.star.drawing.TextShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X, position.Y = 1000, 1000
    size = uno.createUnoStruct('com.sun.star.awt.Size')
    size.Width, size.Height = 12000, 2000
    shape.Position, shape.Size = position, size
    shape.String = 'This is lost when assigned before page.add'
    page.add(shape)
    document.storeAsURL(job.output_url, (job.property('FilterName', 'Impress MS PowerPoint 2007 XML'),))
    job.close(document)
`,
  }), /must be attached before its text is assigned/);
});

test('reflects the actual Impress page API for document authors', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const api = await inspectUnoApi({ documentType: 'presentation', target: 'page', query: 'Width', limit: 10 });
  assert.equal(api.renderer, 'libreoffice-uno-api');
  assert.equal(api.target, 'page');
  assert.ok((api.properties as Array<{ name: string }>).some((property) => property.name === 'Width'));
  assert.ok((api.pagination as { propertyCount?: number }).propertyCount && (api.pagination as { propertyCount: number }).propertyCount >= 1);
  assert.ok(typeof api.example === 'string' && api.example.includes("job.new_document('impress')"));
});

test('returns the complete installed API for every valid presentation target', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const api = await inspectUnoApi({ documentType: 'presentation', target: 'all' });
  assert.equal(api.complete, true);
  const targets = api.targets as Record<string, { pagination?: { complete?: boolean }; properties?: unknown[] }>;
  for (const target of ['document', 'page', 'shape']) {
    assert.equal(targets[target]?.pagination?.complete, true);
    assert.ok(targets[target]?.properties?.length);
  }
});

test('returns executable cookbooks for Writer, Calc, and Impress authoring', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const cases = [
    {
      documentType: 'word' as const,
      fileName: 'writer-cookbook.pdf',
      operations: ['bounds', 'appendParagraph', 'pageBreak', 'image', 'table', 'pageStyleAndHeader', 'save'],
    },
    {
      documentType: 'spreadsheet' as const,
      fileName: 'calc-cookbook.xlsx',
      operations: ['bounds', 'cellsAndFormula', 'mergeAndFreeze', 'image', 'secondSheet', 'save'],
    },
    {
      documentType: 'presentation' as const,
      fileName: 'impress-cookbook.pptx',
      operations: ['bounds', 'textShape', 'image', 'shape', 'newSlide', 'save'],
    },
  ];
  for (const item of cases) {
    const api = await inspectUnoApi({ documentType: item.documentType, target: 'document', limit: 1 });
    const cookbook = api.cookbook as {
      completeDocument?: string;
      coverage?: string[];
      operations?: Record<string, string>;
      rules?: string[];
    };
    assert.ok(cookbook.completeDocument?.includes('def create_document(job):'));
    assert.ok(cookbook.coverage?.length);
    assert.ok(cookbook.rules?.some((rule) => rule.includes('Never substitute guessed integers')));
    for (const operation of item.operations) assert.ok(cookbook.operations?.[operation], `${item.documentType} cookbook is missing ${operation}`);

    const generated = await generateUnoProgramDocument({
      documentType: item.documentType,
      fileName: item.fileName,
      sourceCode: cookbook.completeDocument!,
    });
    assert.ok(generated.buffer.byteLength > 64);
    assert.ok(generated.previewPdf && generated.previewPdf.byteLength > 64);
    if (item.documentType === 'presentation') {
      const text = (generated.report.verification as { text?: { textCharacters?: number } }).text;
      assert.ok((text?.textCharacters || 0) > 0, 'Impress cookbook must persist text after reopening');
    }
    if (item.documentType === 'word') {
      const pdf = await getDocument({ data: new Uint8Array(generated.previewPdf!) }).promise;
      try {
        assert.ok(pdf.numPages >= 2, 'Writer cookbook page-break pattern must produce a second page');
      } finally {
        await pdf.cleanup();
      }
      assert.match(cookbook.operations!.image, /uno\.Enum\('com\.sun\.star\.text\.TextContentAnchorType', 'AS_CHARACTER'\)/);
      assert.match(cookbook.operations!.pageBreak, /BreakType/);
      assert.doesNotMatch(cookbook.operations!.pageBreak, /insertControlCharacter\([^\n]*,\s*2\s*,/);
    }
  }
});
