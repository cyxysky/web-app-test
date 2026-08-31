import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { resolveLibreOfficeExecutable } from './libreoffice';
import { generateUnoProgramDocument, inspectUnoApi } from './uno-program';

describe('UNO cookbook ownership boundaries', () => {
  it('keeps entrypoint invocation and low-level output storage worker-owned', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const api = await inspectUnoApi({ documentType: 'presentation', limit: 1 });
    const cookbook = api.cookbook as {
      completeExistingDocumentModification?: string;
      facadeSignatures?: string[];
      operations?: Record<string, string>;
      rules?: string[];
    };
    expect(cookbook.rules?.some((rule) => rule.includes('never append create_document(None)'))).toBe(true);
    expect(cookbook.operations?.save).not.toMatch(/store(?:To|As)URL/);
    expect(cookbook.completeExistingDocumentModification).not.toMatch(/store(?:To|As)URL/);
    expect(cookbook.completeExistingDocumentModification).toContain('layout.save()');
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.add_card'))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.text_height'))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.add_native_table'))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.add_bar_chart'))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.add_line_chart'))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.add_donut_chart'))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.add_timeline'))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.add_image_contain'))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.add_text_link'))).toBe(true);
    expect(cookbook.operations?.hyperlinks).toContain("target_slide_id='slide-06-science'");
    expect(cookbook.rules?.some((rule) => rule.includes('conversation workspace asset paths'))).toBe(true);
    expect(cookbook.rules?.some((rule) => rule.includes('editable native Impress TableShape'))).toBe(true);
    expect(cookbook.rules?.some((rule) => rule.includes('vectorChartCount separately'))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes("margins={'left':"))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.add_connector_between'))).toBe(true);
    expect(cookbook.rules?.some((rule) => rule.includes('Only import uno'))).toBe(true);
    expect(cookbook.operations?.expertFromFacade).toContain('expert.component(layout)');
  }, 60_000);

  it('executes the proven high-level presentation blueprint without layout defects', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const api = await inspectUnoApi({ documentType: 'presentation', limit: 1 });
    const cookbook = api.cookbook as { completeDocument?: string };
    expect(cookbook.completeDocument).toContain('deck.add_native_table');
    expect(cookbook.completeDocument).toContain('deck.add_bar_chart');
    expect(cookbook.completeDocument).toContain('deck.add_line_chart');
    expect(cookbook.completeDocument).toContain('deck.add_donut_chart');
    expect(cookbook.completeDocument).toContain('deck.add_timeline');
    const generated = await generateUnoProgramDocument({
      documentType: 'presentation',
      fileName: 'proven-high-level-blueprint.pptx',
      sourceCode: cookbook.completeDocument!,
    });
    expect((generated.report.verification as { pages?: number }).pages).toBe(5);
    const elements = generated.report.elementMap as Array<{ elementId?: string; kind?: string }>;
    expect(elements.some((entry) => entry.elementId === 'slide-03/table' && entry.kind === 'table')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'slide-04/bar/bar-4')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'slide-04/line/point-5')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'slide-05/donut/sector-3')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'slide-05/timeline/event-4/title')).toBe(true);
    const archive = await JSZip.loadAsync(generated.buffer);
    const slideXml = await archive.file('ppt/slides/slide4.xml')!.async('text');
    const serializedShape = (artifactName: string) => {
      const start = slideXml.indexOf(`name="${artifactName}"`);
      return start < 0 ? '' : slideXml.slice(start, slideXml.indexOf('</p:sp>', start) + 7);
    };
    expect(serializedShape('wp_slide_04_line_segment_1')).toContain('flipV="1"');
    expect(serializedShape('wp_slide_04_line_segment_2')).not.toContain('flipV="1"');
    const issues = ((generated.report.verification as {
      layout?: { issues?: Array<{ severity?: string }> };
    }).layout?.issues || []);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  }, 60_000);

  it('contains wide images inside their authored box without distortion', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-image-contain-'));
    try {
      await writeFile(path.join(directory, 'wide.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100"><rect width="400" height="100" fill="#2563eb"/></svg>', 'utf8');
      const generated = await generateUnoProgramDocument({
        assetsPath: directory,
        documentType: 'presentation',
        fileName: 'aspect-ratio-contain.pptx',
        sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_image_contain('slide-01/image', page, 'wide.svg', {
        'x': 1000, 'y': 1000, 'width': 10000, 'height': 10000,
    })
    deck.save()
    deck.close()
`,
      });
      const image = (generated.report.elementMap as Array<{
        elementId?: string;
        layout?: { height?: number; width?: number; x?: number; y?: number };
      }>).find((entry) => entry.elementId === 'slide-01/image');
      expect(image?.layout).toMatchObject({ x: 1000, y: 4750, width: 10000, height: 2500 });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it('derives connector endpoints from bounded layout boxes', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const generated = await generateUnoProgramDocument({
      documentType: 'presentation',
      fileName: 'bounded-connector-between.pptx',
      sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    content = deck.content_box(margins={'left': deck.mm(20), 'right': deck.mm(20), 'top': deck.mm(30), 'bottom': deck.mm(24)})
    source, target = deck.grid(2, 1, box=content, gap=deck.mm(18))
    deck.add_shape('slide-01/source', page, **source, fill=0xDBEAFE, layout_role='container')
    deck.add_shape('slide-01/target', page, **target, fill=0xD1FAE5, layout_role='container')
    deck.add_connector_between('slide-01/flow', page, source, target, color=0x2563EB, end_arrow=True)
    deck.save()
    deck.close()
`,
    });
    const connector = (generated.report.elementMap as Array<{
      elementId?: string;
      layout?: { height?: number; width?: number; x?: number; y?: number };
    }>).find((entry) => entry.elementId === 'slide-01/flow');
    expect(connector?.layout?.x).toBeGreaterThanOrEqual(0);
    expect(connector?.layout?.y).toBeGreaterThanOrEqual(0);
    expect(connector?.layout?.width).toBeGreaterThan(0);
    expect(connector?.layout?.height).toBeGreaterThan(0);
    const issues = ((generated.report.verification as {
      layout?: { issues?: Array<{ type?: string }> };
    }).layout?.issues || []);
    expect(issues.some((issue) => issue.type === 'geometry_invalid')).toBe(false);
  }, 60_000);

  it('treats raw shape tags as decoration unless semantic content is explicit', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const generated = await generateUnoProgramDocument({
      documentType: 'presentation',
      fileName: 'expert-shape-layout-intent.pptx',
      sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    expert = job.expert('Create raw Impress shapes with explicit layout intent.')
    document = expert.component(deck)
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
    expect(issues.some((issue) => issue.elementIds?.includes('slide-01/card'))).toBe(false);
    expect(issues.some((issue) => issue.type === 'content_overlap'
      && issue.elementIds?.includes('slide-01/data-mark')
      && issue.elementIds?.includes('slide-01/data-label'))).toBe(true);
  }, 60_000);

  it('uses high-level units and components across a multi-slide deck', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const sourceCode = [
      'def create_document(job):',
      "    deck = job.presentation('deck')",
      '    bounds = deck.bounds()',
      '    def add_card_slide(sid, index):',
      '        page = deck.add_slide(sid)',
      "        deck.add_shape(f'{sid}/background', page, 0, 0, bounds['width'], bounds['height'], fill=0xF8FAFC, layout_role='background')",
      "        deck.add_text(f'{sid}/micro-label', page, 'A', deck.mm(16), deck.mm(3), deck.mm(20), deck.mm(4.5), font_size=10, min_font_size=10)",
      "        card = deck.content_box(margins=(deck.mm(16), deck.mm(16), deck.mm(22), deck.mm(18)))",
      "        deck.add_card(f'{sid}/card', page, card, f'Card {index}', 'Measured body copy.', fill=0xFFFFFF, line=0xCBD5E1, accent=0x2563EB, title_size=22, body_size=14)",
      "        deck.add_footer(f'{sid}/footer', page, left='UNO', center='High-level layout', right=f'{index:02d}', font_size=10)",
      '    for index in range(1, 8):',
      "        add_card_slide(f'slide-{index:02d}', index)",
      '    deck.save()',
      '    deck.close()',
      '',
    ].join('\n');
    const helperLine = sourceCode.split('\n').findIndex((line) => line.includes('deck.add_card')) + 1;
    const outerCallLine = sourceCode.split('\n').findIndex((line) => line.includes('add_card_slide(') && !line.includes('def ')) + 1;
    const generated = await generateUnoProgramDocument({
      documentType: 'presentation',
      fileName: 'high-level-presentation-layout.pptx',
      sourceCode,
    });
    expect((generated.report.verification as { pages?: number }).pages).toBe(7);
    const elements = generated.report.elementMap as Array<{ callLine?: number; elementId?: string; line?: number }>;
    const title = elements.find((entry) => entry.elementId === 'slide-07/card/title');
    expect(title?.line).toBe(helperLine);
    expect(title?.callLine).toBe(outerCallLine);
    expect(elements.some((entry) => entry.elementId === 'slide-07/footer/right')).toBe(true);
  }, 60_000);

});
