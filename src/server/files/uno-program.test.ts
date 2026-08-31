import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import JSZip from 'jszip';
import {
  generateUnoProgramDocument,
  inspectUnoApi,
  isTransientUnoBridgeError,
  resolveUnoProgramWorker,
} from './uno-program';
import { resolveLibreOfficeExecutable } from './libreoffice';
import { validateOfficeArtifact } from './office-artifact-validator';

test('forces UTF-8 for UNO worker diagnostics on Windows and other hosts', async () => {
  const source = await readFile(new URL('./uno-program.ts', import.meta.url), 'utf8');
  assert.match(source, /PYTHONIOENCODING:\s*'utf-8'/);
  assert.match(source, /PYTHONUTF8:\s*'1'/);
});

test('recognizes only disposed UNO bridge failures as isolated-worker retry candidates', () => {
  assert.equal(isTransientUnoBridgeError(new Error('com.sun.star.lang.DisposedException: Binary URP bridge disposed during call')), true);
  assert.equal(isTransientUnoBridgeError(new Error("NameError: name 'slide2' is not defined")), false);
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

test('UNO runtime deterministically disambiguates duplicate requested element IDs', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'duplicate-id-disambiguation.pptx',
    sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_text('slide-01/title', page, 'First', 1000, 1000, 6000, 1000)
    deck.add_text('slide-01/title', page, 'Second', 1000, 2500, 6000, 1000)
    deck.add_connector('slide-01/flow', page, 9000, 1200, 14000, 2200, color=0x2563EB, end_arrow=True)
    deck.save()
    deck.close()
`,
  });
  const elements = generated.report.elementMap as Array<{
    duplicateIndex?: number;
    elementId?: string;
    requestedElementId?: string;
  }>;
  assert.equal(elements.some((entry) => entry.elementId === 'slide-01/title'), true);
  assert.equal(elements.some((entry) => entry.elementId === 'slide-01/title-2'
    && entry.requestedElementId === 'slide-01/title'
    && entry.duplicateIndex === 2), true);
  assert.equal(elements.some((entry) => entry.elementId === 'slide-01/flow'), true);
  const runtimeDiagnostics = generated.report.runtimeDiagnostics as Array<{ code?: string; severity?: string }>;
  assert.equal(runtimeDiagnostics.some((entry) => entry.code === 'ELEMENT_ID_AUTO_DISAMBIGUATED'
    && entry.severity === 'warning'), true);
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

test('presentation element maps report the real helper line and preserve its outer callsite', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const sourceCode = [
    'def create_document(job):',
    "    deck = job.presentation('deck')",
    "    page = deck.add_slide('slide-01')",
    '    def add_label(element_id, text, y):',
    '        return deck.add_text(element_id, page, text, 1000, y, 9000, 1400, font_size=24)',
    "    add_label('slide-01/title', 'Concrete callsite', 1200)",
    '    deck.save()',
    '    deck.close()',
    '',
  ].join('\n');
  const helperLine = sourceCode.split('\n').findIndex((line) => line.includes('return deck.add_text')) + 1;
  const callLine = sourceCode.split('\n').findIndex((line) => line.includes("add_label('slide-01/title'")) + 1;
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'concrete-callsite.pptx',
    sourceCode,
  });
  const element = (generated.report.elementMap as Array<{ callLine?: number; elementId?: string; line?: number }>)
    .find((entry) => entry.elementId === 'slide-01/title');
  assert.equal(element?.line, helperLine);
  assert.equal(element?.callLine, callLine);
});

test('presentation high-level units and components support multi-slide expansion', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'high-level-presentation-layout.pptx',
    sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    bounds = deck.bounds()
    for index in range(1, 8):
        sid = f'slide-{index:02d}'
        page = deck.add_slide(sid)
        deck.add_shape(f'{sid}/background', page, 0, 0, bounds['width'], bounds['height'], fill=0xF8FAFC, layout_role='background')
        card = deck.content_box(margins={'left': deck.mm(16), 'right': deck.mm(16), 'top': deck.mm(22), 'bottom': deck.mm(18)})
        deck.add_card(f'{sid}/card', page, card, f'Card {index}', 'Measured body copy.', fill=0xFFFFFF, line=0xCBD5E1, accent=0x2563EB, title_size=22, body_size=14)
        deck.add_footer(f'{sid}/footer', page, left='UNO', center='High-level layout', right=f'{index:02d}', font_size=10)
    deck.save()
    deck.close()
`,
  });
  assert.equal((generated.report.verification as { pages?: number }).pages, 7);
  const elements = generated.report.elementMap as Array<{ elementId?: string }>;
  assert.equal(elements.some((entry) => entry.elementId === 'slide-07/card/title'), true);
  assert.equal(elements.some((entry) => entry.elementId === 'slide-07/footer/right'), true);
});

test('presentation facade serializes external and internal text hyperlinks and reports vector charts separately', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'facade-links-and-charts.pptx',
    sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_text_link('slide-01/external', page, 'Official website',
        {'x': deck.mm(16), 'y': deck.mm(24), 'width': deck.mm(90), 'height': deck.mm(12)},
        url='https://example.com/', font_size=16)
    deck.add_text_link('slide-01/internal', page, 'Jump to details',
        {'x': deck.mm(16), 'y': deck.mm(42), 'width': deck.mm(90), 'height': deck.mm(12)},
        target_slide_id='slide-02', font_size=16)
    deck.add_bar_chart('slide-01/bar', page,
        {'x': deck.mm(118), 'y': deck.mm(24), 'width': deck.mm(140), 'height': deck.mm(90)},
        ['A', 'B', 'C'], [20, 45, 70])
    page = deck.add_slide('slide-02')
    deck.add_text('slide-02/title', page, 'Details', deck.mm(16), deck.mm(24), deck.mm(120), deck.mm(16), font_size=24)
    deck.save()
    deck.close()
`,
  });
  const features = generated.report.featureCounts as Record<string, number>;
  assert.equal(features.externalHyperlink, 1);
  assert.equal(features.internalSlideHyperlink, 1);
  assert.equal(features.vectorChart, 1);
  assert.equal(features.vectorBarChart, 1);
  const archive = await JSZip.loadAsync(generated.buffer);
  const slideXml = await archive.file('ppt/slides/slide1.xml')!.async('text');
  assert.ok((slideXml.match(/<a:hlinkClick\b/g) || []).length >= 2, 'both links must survive PPTX serialization');
  assert.match(slideXml, /ppaction:\/\/hlinksldjump/, 'the internal text link must serialize as a slide jump action');
  const slideRelationships = await archive.file('ppt/slides/_rels/slide1.xml.rels')!.async('text');
  assert.match(slideRelationships, /Target="https:\/\/example\.com\/"[^>]*TargetMode="External"/);
  assert.match(slideRelationships, /Type="[^"]+\/slide" Target="slide2\.xml"/);
  const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-links-and-charts-'));
  try {
    const target = path.join(directory, 'facade-links-and-charts.pptx');
    await writeFile(target, generated.buffer);
    const validation = await validateOfficeArtifact({
      absolutePath: target,
      extension: '.pptx',
      featureCounts: features,
    });
    const presentationChecks = (validation.formatChecks as { presentation?: Record<string, number> } | undefined)?.presentation;
    assert.deepEqual(presentationChecks, {
      chartCount: 0,
      nativeChartCount: 0,
      vectorChartCount: 1,
      totalChartCount: 1,
      vectorBarChartCount: 1,
      vectorLineChartCount: 0,
      vectorDonutChartCount: 0,
      authoredExternalHyperlinkCount: 1,
      authoredInternalSlideHyperlinkCount: 1,
      serializedHyperlinkCount: 2,
      imageCount: 0,
      slideCount: 2,
      tableCount: 0,
    });
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

test('raw expert shapes default to decoration and explicit semantic shapes remain collision checked', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'expert-shape-layout-intent.pptx',
    sourceCode: `
def create_document(job):
    expert = job.expert('Create raw Impress shapes with explicit layout intent.')
    document = expert.new_document('impress')
    deck = job.presentation('deck', component=document)
    page = deck.add_slide('slide-01')

    card = document.createInstance('com.sun.star.drawing.RectangleShape')
    card_position = uno.createUnoStruct('com.sun.star.awt.Point')
    card_position.X, card_position.Y = 1000, 1000
    card_size = uno.createUnoStruct('com.sun.star.awt.Size')
    card_size.Width, card_size.Height = 8000, 3200
    card.Position, card.Size = card_position, card_size
    page.add(card)
    expert.tag(card, 'slide-01/card', 'shape')
    deck.add_text('slide-01/card/title', page, 'Contained title', 1400, 1400, 7200, 1200, font_size=20)

    data_mark = document.createInstance('com.sun.star.drawing.RectangleShape')
    mark_position = uno.createUnoStruct('com.sun.star.awt.Point')
    mark_position.X, mark_position.Y = 11000, 1000
    mark_size = uno.createUnoStruct('com.sun.star.awt.Size')
    mark_size.Width, mark_size.Height = 8000, 3200
    data_mark.Position, data_mark.Size = mark_position, mark_size
    page.add(data_mark)
    expert.tag(data_mark, 'slide-01/data-mark', 'shape', layout_role='content', allow_overlap=False)
    deck.add_text('slide-01/data-label', page, 'Semantic collision', 11400, 1400, 7200, 1200, font_size=20)

    deck.save()
    deck.close()
`,
  });
  const verification = generated.report.verification as {
    layout?: { issues?: Array<{ elementIds?: string[]; type?: string }> };
  };
  const issues = verification.layout?.issues || [];
  assert.equal(issues.some((issue) => issue.elementIds?.includes('slide-01/card')), false);
  assert.equal(issues.some((issue) => issue.type === 'content_overlap'
    && issue.elementIds?.includes('slide-01/data-mark')
    && issue.elementIds?.includes('slide-01/data-label')), true);
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
      operations: ['openExisting', 'bounds', 'autoLayout', 'connector', 'nativeTable', 'dataCharts', 'donutAndTimeline', 'imageContain', 'textShape', 'image', 'shape', 'newSlide', 'save'],
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
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith('deck.add_connector(')));
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith('deck.add_native_table(')));
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith('deck.add_bar_chart(')));
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith('deck.add_line_chart(')));
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith('deck.add_donut_chart(')));
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith('deck.add_timeline(')));
      assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith('deck.add_image_contain(')));
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
