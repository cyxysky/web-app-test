import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import JSZip from 'jszip';
import { generateUnoProgramDocument, inspectUnoApi, resolveUnoProgramWorker } from './uno-program';
import { resolveLibreOfficeExecutable } from './libreoffice';
import { validateOfficeArtifact } from './office-artifact-validator';

test('forces UTF-8 for UNO worker diagnostics on Windows and other hosts', async () => {
  const source = await readFile(new URL('./uno-program.ts', import.meta.url), 'utf8');
  assert.match(source, /PYTHONIOENCODING:\s*'utf-8'/);
  assert.match(source, /PYTHONUTF8:\s*'1'/);
});

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
    document = job.writer('document')
    document.add_paragraph('body', 'UNO worker smoke test')
    document.save()
    document.close()
`,
  });
  assert.ok(generated.buffer.byteLength > 64);
  assert.ok(generated.previewPdf && generated.previewPdf.byteLength > 64);
  assert.equal(generated.report.renderer, 'libreoffice-uno');
  const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-writer-markers-'));
  try {
    const target = path.join(directory, 'worker-smoke.docx');
    await writeFile(target, generated.buffer);
    const validation = await validateOfficeArtifact({
      absolutePath: target,
      elementMap: generated.report.elementMap as Array<{ artifactName?: string; elementId: string; kind: string; locator?: Record<string, unknown> }>,
      extension: '.docx',
      requireElementIds: true,
      validationProfile: 'uno-strict',
    });
    assert.equal(validation.issues.some((issue) => issue.code === 'ELEMENT_MAPPING_NOT_EMBEDDED'), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('Writer page-break markers do not hide or collapse the following inline image', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-writer-image-flow-'));
  try {
    await writeFile(
      path.join(directory, 'square.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=', 'base64'),
    );
    const generated = await generateUnoProgramDocument({
      assetsPath: directory,
      documentType: 'word',
      fileName: 'writer-image-after-break.docx',
      sourceCode: `
def create_document(job):
    document = job.writer('document')
    document.add_paragraph('intro', 'First page')
    document.add_page_break('page-02')
    document.add_inline_image('body/image', 'square.png', width=8000)
    document.save()
    document.close()
`,
    });
    const archive = await JSZip.loadAsync(generated.buffer);
    const documentXml = await archive.file('word/document.xml')!.async('text');
    const imageExtent = [...documentXml.matchAll(/<wp:inline[\s\S]*?<\/wp:inline>/g)]
      .map((match) => match[0])
      .find((block) => block.includes('name="wp_body_image"'));
    assert.ok(imageExtent, 'the image element marker must survive DOCX export');
    const height = Number(/<wp:extent[^>]+cy="(\d+)"/.exec(imageExtent)?.[1] || 0);
    assert.ok(height > 1_000_000, `inline image height collapsed after a page break: ${height}`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('presentation facade locks text bounds and rejects high-confidence text overlap', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'fixed-text-bounds.pptx',
    sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    bounds = deck.bounds()
    page = deck.add_slide('slide-01')
    deck.add_text('slide-01/footer', page, 'Footer', 800, bounds['height'] - 1200, 6000, 1200, font_size=11)
    deck.add_text('slide-01/overlap-a', page, 'Alpha', 1200, 2000, 8000, 1800, font_size=20)
    deck.add_text('slide-01/overlap-b', page, 'Beta', 1200, 2000, 8000, 1800, font_size=20)
    deck.save()
    deck.close()
`,
  });
  const verification = generated.report.verification as { issues?: Array<{ elementIds?: string[]; severity?: string; type?: string }> };
  const overlap = verification.issues?.find((issue) => issue.type === 'text_overlap');
  assert.equal(overlap?.severity, 'error');
  assert.deepEqual(overlap?.elementIds, ['slide-01/overlap-a', 'slide-01/overlap-b']);

  const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-fixed-text-bounds-'));
  try {
    const target = path.join(directory, 'fixed-text-bounds.pptx');
    await writeFile(target, generated.buffer);
    const validation = await validateOfficeArtifact({
      absolutePath: target,
      elementMap: generated.report.elementMap as Array<{ artifactName?: string; elementId: string; kind: string; locator?: Record<string, unknown> }>,
      extension: '.pptx',
      validationProfile: 'uno-strict',
    });
    assert.equal(validation.issues.some((issue) => issue.code === 'PPTX_OBJECT_OUT_OF_BOUNDS'), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('presentation auto-layout keeps cells separate and diagnoses semantic shape collisions', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'auto-layout-collision.pptx',
    sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    bounds = deck.bounds()
    page = deck.add_slide('slide-01')
    deck.add_shape('slide-01/background', page, 0, 0, bounds['width'], bounds['height'], fill=0xF8FAFC, layout_role='background')
    cells = deck.grid(2, 1, box=deck.content_box(margins=(1400, 1400, 1400, 1400)), gap=800)
    deck.add_shape('slide-01/data-mark', page, **cells[0], fill=0x2563EB, layout_role='content', allow_overlap=False)
    deck.add_text('slide-01/data-label', page, 'Semantic label', **cells[0], font_size=20)
    deck.add_text('slide-01/separate-copy', page, 'Separate cell', **cells[1], font_size=20)
    deck.save()
    deck.close()
`,
  });
  const verification = generated.report.verification as {
    layout?: {
      checkedContentShapes?: number;
      issues?: Array<{ elementIds?: string[]; severity?: string; type?: string }>;
      pageOccupancy?: Array<{ contentBoxes?: number }>;
    };
  };
  const collision = verification.layout?.issues?.find((issue) => issue.type === 'content_overlap');
  assert.equal(collision?.severity, 'error');
  assert.deepEqual(collision?.elementIds, ['slide-01/data-mark', 'slide-01/data-label']);
  assert.equal(verification.layout?.checkedContentShapes, 3);
  assert.equal(verification.layout?.pageOccupancy?.[0]?.contentBoxes, 3);
  assert.equal(verification.layout?.issues?.some((issue) => issue.elementIds?.includes('slide-01/background')), false);
});

test('presentation layout maps reopened shapes by stable artifact name before mutable shape index', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'stable-shape-name-mapping.pptx',
    sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_text('slide-01/left', page, 'Left', 1000, 1000, 5000, 1200, font_size=18)
    deck.add_shape('slide-01/export-sensitive', page, 9000, 1000, 2000, 1200,
                   service='com.sun.star.drawing.CaptionShape', line=0x2563EB,
                   layout_role='decoration', allow_overlap=True)
    deck.add_text('slide-01/right', page, 'Right', 16000, 1000, 5000, 1200, font_size=18)
    deck.save()
    deck.close()
`,
  });
  const verification = generated.report.verification as {
    layout?: { issues?: Array<{ elementIds?: string[]; type?: string }> };
  };
  assert.equal(verification.layout?.issues?.some((issue) => issue.type === 'text_overlap'), false);
  assert.equal(verification.layout?.issues?.some((issue) => issue.elementIds?.includes('slide-01/right')), false);
});

test('resolves a unique downloaded asset suffix and allows an image-only slide', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-asset-alias-'));
  try {
    await writeFile(
      path.join(directory, 'download-diagram.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=', 'base64'),
    );
    const generated = await generateUnoProgramDocument({
      assetsPath: directory,
      documentType: 'presentation',
      fileName: 'asset-alias.pptx',
      sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_image('slide-01/image', page, 'diagram.png', 1000, 1000, 8000, 5000)
    deck.save()
    deck.close()
`,
    });
    assert.ok(generated.buffer.byteLength > 64);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
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
    expert = job.expert('Verify a raw Impress TextShape creation pattern.')
    document = expert.new_document('impress')
    page = document.DrawPages.getByIndex(0)
    shape = document.createInstance('com.sun.star.drawing.TextShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X, position.Y = 1000, 1000
    size = uno.createUnoStruct('com.sun.star.awt.Size')
    size.Width, size.Height = 12000, 2000
    shape.Position, shape.Size = position, size
    page.add(shape)
    shape.String = 'Impress alias works'
    expert.tag(shape, 'slide-01/title', 'text', {'slide': 1, 'shape': 1})
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
    expert = job.expert('Exercise the intentionally invalid detached text pattern.')
    document = expert.new_document('impress')
    page = document.DrawPages.getByIndex(0)
    shape = document.createInstance('com.sun.star.drawing.TextShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X, position.Y = 1000, 1000
    size = uno.createUnoStruct('com.sun.star.awt.Size')
    size.Width, size.Height = 12000, 2000
    shape.Position, shape.Size = position, size
    shape.String = 'This is lost when assigned before page.add'
    page.add(shape)
    expert.tag(shape, 'slide-01/title', 'text', {'slide': 1, 'shape': 1})
    document.storeAsURL(job.output_url, (job.property('FilterName', 'Impress MS PowerPoint 2007 XML'),))
    job.close(document)
`,
  }), /must be attached before its text is assigned/);
});

test('reflects the complete actual Impress API for document authors', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const api = await inspectUnoApi({ documentType: 'presentation', query: 'Width', limit: 10 });
  assert.equal(api.renderer, 'libreoffice-uno-api');
  assert.equal(api.target, 'all');
  const targets = api.targets as Record<string, { properties?: Array<{ name: string }> }>;
  assert.ok(targets.page?.properties?.some((property) => property.name === 'Width'));
  assert.ok(typeof api.example === 'string' && api.example.includes("job.presentation('deck')"));
});

test('returns the complete installed API for every valid presentation target', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const api = await inspectUnoApi({ documentType: 'presentation' });
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
      fileName: 'writer-cookbook.docx',
      operations: ['flowLayout', 'openExisting', 'bounds', 'appendParagraph', 'pageBreak', 'image', 'table', 'pageStyleAndHeader', 'save'],
    },
    {
      documentType: 'spreadsheet' as const,
      fileName: 'calc-cookbook.xlsx',
      operations: ['openExisting', 'bounds', 'cellsAndFormula', 'mergeAndFreeze', 'image', 'secondSheet', 'save'],
    },
    {
      documentType: 'presentation' as const,
      fileName: 'impress-cookbook.pptx',
      operations: ['openExisting', 'bounds', 'textShape', 'image', 'shape', 'newSlide', 'save'],
    },
  ];
  for (const item of cases) {
    const api = await inspectUnoApi({ documentType: item.documentType, limit: 1 });
    const cookbook = api.cookbook as {
      completeDocument?: string;
      completeExistingDocumentModification?: string;
      coverage?: string[];
      facadeSignatures?: string[];
      operations?: Record<string, string>;
      rules?: string[];
    };
    assert.ok(cookbook.completeDocument?.includes('def create_document(job):'));
    assert.ok(cookbook.completeExistingDocumentModification?.includes('job.expert'));
    assert.ok(cookbook.coverage?.length);
    assert.ok(cookbook.rules?.some((rule) => rule.includes('Never substitute guessed integers')));
    assert.ok(cookbook.rules?.some((rule) => rule.includes('CharHeight is always measured in typographic points')));
    assert.ok(cookbook.rules?.some((rule) => rule.includes('never append create_document(None)')));
    assert.doesNotMatch(cookbook.operations!.save, /store(?:To|As)URL/);
    assert.doesNotMatch(cookbook.completeExistingDocumentModification || '', /store(?:To|As)URL/);
    if (item.documentType === 'word') {
      assert.ok(cookbook.rules?.some((rule) => rule.includes('job.expert')));
      assert.match(cookbook.operations!.flowLayout, /layout = job\.writer\('document'\)/);
      assert.doesNotMatch(cookbook.operations!.flowLayout, /layout\.raw/);
    }
    for (const operation of item.operations) assert.ok(cookbook.operations?.[operation], `${item.documentType} cookbook is missing ${operation}`);

    const generated = await generateUnoProgramDocument({
      documentType: item.documentType,
      fileName: item.fileName,
      sourceCode: cookbook.completeDocument!,
    });
    assert.ok(generated.buffer.byteLength > 64);
    assert.ok(generated.previewPdf && generated.previewPdf.byteLength > 64);
    assert.ok(Array.isArray(generated.report.elementMap));
    if (item.documentType === 'presentation') {
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith('deck.bounds()')));
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith('deck.grid(')));
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith('deck.stack(')));
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.includes('add_text') && signature.includes('bold=False')));
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.includes('add_shape') && signature.includes('fill=None')));
      assert.match(cookbook.operations!.autoLayout, /deck\.grid\(/);
      assert.match(cookbook.operations!.autoLayout, /deck\.stack\(/);
      assert.match(cookbook.completeDocument || '', /add_text\([^\n]+bold=True/);
      assert.match(cookbook.completeDocument || '', /add_shape\([^\n]+fill=0x2563EB/);
      assert.match(cookbook.completeDocument || '', /bounds = deck\.bounds\(\)/);
      const textShape = cookbook.operations!.textShape;
      assert.ok(textShape.indexOf('page.add(shape)') < textShape.indexOf("shape.String = 'Slide title'"));
      assert.ok(textShape.indexOf("shape.String = 'Slide title'") < textShape.indexOf('shape.CharHeight'));
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
      const content = (generated.report.verification as { content?: { layout?: { tables?: number; issues?: unknown[] } } }).content;
      assert.equal(content?.layout?.tables, 1);
      assert.deepEqual(content?.layout?.issues, []);
    }
  }
});
