import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  generateUnoProgramDocument,
  inspectUnoApi,
  isUnoBridgeStartupError,
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

test('recognizes startup and disposed UNO bridge failures as isolated-worker retry candidates', () => {
  assert.equal(isTransientUnoBridgeError(new Error('com.sun.star.lang.DisposedException: Binary URP bridge disposed during call')), true);
  assert.equal(isTransientUnoBridgeError(new Error("Unable to connect to LibreOffice UNO: Connector : couldn't connect to pipe \"webpilot_deadbeef\": 1")), true);
  assert.equal(isUnoBridgeStartupError(new Error("Unable to connect to LibreOffice UNO: Connector : couldn't connect to pipe \"webpilot_deadbeef\": 1")), true);
  assert.equal(isUnoBridgeStartupError(new Error('com.sun.star.lang.DisposedException: Binary URP bridge disposed during call')), false);
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
  const sourcePrefix = `
def create_document(job):
    deck = job.presentation('deck')
    bounds = deck.bounds()
    page = deck.add_slide('slide-01')
    deck.add_text('slide-01/footer', page, 'Footer', 800, bounds['height'] - 1200, 6000, 1200, font_size=11)
    deck.add_text('slide-01/overlap-a', page, 'Alpha', 1200, 2000, 8000, 1800, font_size=20)
`;
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'fixed-text-bounds.pptx',
    sourceCode: `${sourcePrefix}
    deck.save()
    deck.close()
`,
  });
  await assert.rejects(generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'rejected-text-overlap.pptx',
    sourceCode: `${sourcePrefix}
    deck.add_text('slide-01/overlap-b', page, 'Beta', 1200, 2000, 8000, 1800, font_size=20)
    deck.add_text('slide-01/overlap-c', page, 'Gamma', 1200, 2000, 8000, 1800, font_size=20)
    deck.save()
    deck.close()
`,
  }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const encoded = message.match(/__WEBPILOT_LAYOUT_DIAGNOSTICS__(\[[^\r\n]*\])/)?.[1];
    assert.ok(encoded, message);
    const overlaps = (JSON.parse(encoded) as Array<{ code?: string; elementIds?: string[] }>)
      .filter((issue) => issue.code === 'PRESENTATION_OVERLAP');
    assert.equal(overlaps.length, 3, message);
    assert.ok(overlaps.some((issue) => issue.elementIds?.includes('slide-01/overlap-c')));
    return true;
  });

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

test('presentation facade serializes hyperlinks and native editable charts', async (context) => {
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
  assert.equal(features.nativeChart, 1);
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
    assert.deepEqual(presentationChecks && {
      chartCount: presentationChecks.chartCount,
      nativeChartCount: presentationChecks.nativeChartCount,
      authoredExternalHyperlinkCount: presentationChecks.authoredExternalHyperlinkCount,
      authoredInternalSlideHyperlinkCount: presentationChecks.authoredInternalSlideHyperlinkCount,
      serializedHyperlinkCount: presentationChecks.serializedHyperlinkCount,
      imageCount: presentationChecks.imageCount,
      slideCount: presentationChecks.slideCount,
      tableCount: presentationChecks.tableCount,
    }, {
      chartCount: 1,
      nativeChartCount: 1,
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

test('presentation facade serializes every UNO chart family as native PPTX charts', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'all-native-chart-families.pptx',
    sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    chart_types = ['area', 'bar', 'bubble', 'donut', 'filled-radar', 'line', 'radar', 'pie', 'stock', 'scatter']
    categories = ['A', 'B', 'C', 'D']
    standard_series = [
        {'name': 'Series 1', 'values': [12, 24, 18, 32]},
        {'name': 'Series 2', 'values': [8, 18, 27, 21]},
    ]
    for index, chart_type in enumerate(chart_types):
        sid = f'slide-{index + 1:02d}'
        page = deck.add_slide(sid)
        box = {'x': deck.mm(18), 'y': deck.mm(12), 'width': deck.mm(250), 'height': deck.mm(135)}
        if chart_type in ('donut', 'pie'):
            deck.add_chart(f'{sid}/chart', page, box, chart_type, categories, values=[12, 24, 18, 32])
        elif chart_type == 'stock':
            deck.add_chart(f'{sid}/chart', page, box, chart_type, categories, series=[
                {'name': 'Open', 'values': [20, 22, 21, 25]},
                {'name': 'High', 'values': [25, 26, 28, 30]},
                {'name': 'Low', 'values': [17, 19, 18, 22]},
                {'name': 'Close', 'values': [23, 21, 26, 28]},
            ])
        elif chart_type == 'bubble':
            deck.add_chart(f'{sid}/chart', page, box, chart_type, categories, series=[
                {'name': 'X', 'values': [1, 2, 3, 4]},
                {'name': 'Y', 'values': [3, 5, 4, 7]},
                {'name': 'Size', 'values': [10, 18, 14, 24]},
            ])
        else:
            deck.add_chart(f'{sid}/chart', page, box, chart_type, categories, series=standard_series)
    deck.save()
    deck.close()
`,
  });
  const features = generated.report.featureCounts as Record<string, number>;
  assert.equal(features.nativeChart, 10);
  assert.equal((generated.report.verification as { pages?: number }).pages, 10);
  const archive = await JSZip.loadAsync(generated.buffer);
  const chartFiles = Object.keys(archive.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  assert.equal(chartFiles.length, 10);
  const chartXml = (await Promise.all(chartFiles.map((name) => archive.file(name)!.async('text')))).join('\n');
  for (const tag of ['areaChart', 'barChart', 'bubbleChart', 'doughnutChart', 'lineChart', 'pieChart', 'stockChart', 'scatterChart']) {
    assert.match(chartXml, new RegExp(`<c:${tag}\\b`), `${tag} must be serialized as native chart XML`);
  }
  assert.ok((chartXml.match(/<c:radarChart\b/g) || []).length >= 2, 'regular and filled radar charts must both serialize natively');
});

test('presentation auto-layout keeps cells separate and diagnoses semantic shape collisions', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const sourcePrefix = `
def create_document(job):
    deck = job.presentation('deck')
    bounds = deck.bounds()
    page = deck.add_slide('slide-01')
    deck.add_shape('slide-01/background', page, 0, 0, bounds['width'], bounds['height'], fill=0xF8FAFC, layout_role='background')
    cells = deck.grid(2, 1, box=deck.content_box(margins=(1400, 1400, 1400, 1400)), gap=800)
    deck.add_shape('slide-01/data-mark', page, **cells[0], fill=0x2563EB, layout_role='content', allow_overlap=False)
`;
  const generated = await generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'auto-layout-collision.pptx',
    sourceCode: `${sourcePrefix}
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
  assert.equal(verification.layout?.checkedContentShapes, 2);
  assert.equal(verification.layout?.pageOccupancy?.[0]?.contentBoxes, 2);
  assert.equal(verification.layout?.issues?.some((issue) => issue.elementIds?.includes('slide-01/background')), false);
  await assert.rejects(generateUnoProgramDocument({
    documentType: 'presentation',
    fileName: 'rejected-semantic-collision.pptx',
    sourceCode: `${sourcePrefix}
    deck.add_text('slide-01/data-label', page, 'Semantic label', **cells[0], font_size=20)
    deck.save()
    deck.close()
`,
  }), /PRESENTATION_OVERLAP[\s\S]*slide-01\/data-mark[\s\S]*slide-01\/data-label/);
});

test('rejects raw expert shapes before LibreOffice execution', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  await assert.rejects(generateUnoProgramDocument({
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
  }), /job\.expert\(\) is not model-facing|raw UNO imports are worker-owned/);
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

test('rejects model-authored LibreOffice factory aliases and raw TextShape creation', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  await assert.rejects(generateUnoProgramDocument({
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
  }), /job\.expert\(\) is not model-facing|raw UNO imports are worker-owned/);
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
  }), /job\.expert\(\) is not model-facing|raw UNO imports are worker-owned/);
});

test('returns only matching model-facing presentation capabilities', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const api = await inspectUnoApi({ documentType: 'presentation', query: 'chart', limit: 10 });
  assert.equal(api.renderer, 'libreoffice-uno-facade');
  assert.equal(api.target, 'facade');
  assert.equal(api.nativeReflectionExposed, false);
  const capabilities = api.capabilities as Array<{ id?: string }>;
  assert.ok(capabilities.some((capability) => capability.id === 'presentation.chart@2'));
  assert.equal('targets' in api, false);
});

test('returns a compact facade module index instead of all APIs at once', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const api = await inspectUnoApi({ documentType: 'presentation' });
  assert.equal(api.target, 'facade');
  assert.equal(api.nativeReflectionExposed, false);
  assert.equal('targets' in api, false);
  const cookbook = api as unknown as { delivery?: string; moduleIndex?: unknown[]; capabilities?: unknown[] };
  assert.equal(cookbook.delivery, 'module-index');
  assert.ok((cookbook.moduleIndex || []).length > 0);
  assert.equal(cookbook.capabilities, undefined);
});

test('returns exact signatures and all registered examples for a queried facade module', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const cases = [
    {
      documentType: 'word' as const,
      query: 'writer.table',
      expectedModule: 'writer.table@2',
      expectedExample: 'tableAndMerge',
      expectedMethod: 'document.add_table(',
    },
    {
      documentType: 'spreadsheet' as const,
      query: 'calc.cell-range',
      expectedModule: 'calc.cell-range@2',
      expectedExample: 'cellsRangesAndFormatting',
      expectedMethod: 'sheet.set_cell(',
    },
    {
      documentType: 'presentation' as const,
      query: 'presentation.professional',
      expectedModule: 'presentation.professional@1',
      expectedExample: 'professionalFeatures',
      expectedMethod: 'slide.set_notes(',
    },
  ];
  for (const item of cases) {
    const api = await inspectUnoApi({ documentType: item.documentType, query: item.query, limit: 1 });
    const cookbook = api as unknown as {
      delivery?: string;
      matchedModules?: string[];
      facadeSignatures?: string[];
      examples?: Record<string, string>;
      rules?: string[];
    };
    assert.equal(cookbook.delivery, 'module-executable-cookbook');
    assert.ok(cookbook.matchedModules?.includes(item.expectedModule));
    assert.ok(cookbook.rules?.some((rule) => rule.includes('high-level facade')));
    assert.ok(cookbook.rules?.some((rule) => rule.includes('Never import')));
    assert.ok(cookbook.facadeSignatures?.some((signature) => signature.startsWith(item.expectedMethod)));
    assert.ok(cookbook.examples?.[item.expectedExample]);
    assert.doesNotMatch(JSON.stringify(cookbook.examples), /store(?:To|As)URL|createInstance|com\.sun\.star/);
  }
});
