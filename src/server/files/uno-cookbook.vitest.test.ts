import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { generateUnoProgramDocument, inspectUnoApi, resolveLibreOfficeExecutable } from '@webpilot/capability-file/node';

describe('UNO cookbook ownership boundaries', () => {
  it('registers at least one complete installed example for every facade module', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    for (const documentType of ['presentation', 'word', 'spreadsheet'] as const) {
      const api = await inspectUnoApi({ documentType, query: '', limit: 1 });
      const modules = (api as unknown as {
        moduleIndex?: Array<{ exampleGroups?: string[]; query?: string }>;
      }).moduleIndex || [];
      expect(modules.length).toBeGreaterThan(0);
      expect(modules.filter((module) => !module.exampleGroups?.length)).toEqual([]);
    }
  }, 120_000);

  it('exposes only the queried presentation module with exact installed signatures and examples', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const api = await inspectUnoApi({ documentType: 'presentation', query: 'presentation.professional', limit: 1 });
    const cookbook = api as unknown as {
      facadeSignatures?: string[];
      examples?: Record<string, string>;
      matchedModules?: string[];
      rules?: string[];
    };
    expect(api.target).toBe('facade');
    expect(api.nativeReflectionExposed).toBe(false);
    expect(cookbook.rules?.some((rule) => rule.includes('Never import'))).toBe(true);
    expect(cookbook.matchedModules).toContain('presentation.professional@1');
    expect(JSON.stringify(cookbook.examples)).not.toMatch(/store(?:To|As)URL|createInstance|com\.sun\.star/);
    expect(cookbook.examples?.backgroundTransitionAndNotes).toContain("slide.set_notes('speaker-notes',");
    expect(cookbook.examples?.professionalFeatures).toContain('deck.add_custom_show');
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('slide.set_notes'))).toBe(true);
    expect(cookbook.facadeSignatures?.some((signature) => signature.includes('deck.add_custom_show'))).toBe(true);
  }, 60_000);

  it('returns one complete example covering every specialized presentation shape capability', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const api = await inspectUnoApi({ documentType: 'presentation', query: 'presentation.shape', limit: 1 });
    const cookbook = api as unknown as { examples?: Record<string, string>; rules?: string[] };
    const example = cookbook.examples?.specializedShapeCapabilities || '';
    for (const capability of [
      'RectangleShape', 'EllipseShape', 'CustomShape', 'CaptionShape', 'ConnectorShape',
      'LineShape', 'MeasureShape', 'TextShape', 'GraphicObject',
    ]) {
      expect(example).toContain(capability);
    }
    expect(example).toContain("shape_type='caption'");
    expect(example).toContain("shape_type='measure'");
    expect(example).toContain("slide.connect('connector-shape'");
    expect(cookbook.rules?.some((rule) => rule.includes('featureCounts'))).toBe(true);
  }, 60_000);

  it('publishes the complete timeline color and layout contract without a catch-all signature', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const api = await inspectUnoApi({ documentType: 'presentation', query: 'presentation.timeline', limit: 1 });
    const cookbook = api as unknown as { examples?: Record<string, string> };
    expect(cookbook.examples?.timeline).toContain("text_color='#CBD5E1'");
    expect(JSON.stringify(api)).toContain('text_color=0x334155');
    expect(JSON.stringify(api)).not.toContain('max_items_per_row=6, **options');
  }, 60_000);

  it('executes the compact high-level presentation blueprint without raw UNO', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const sourceCode = `def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('overview', layout='title-two-column', title='Quarterly overview')
    slide.add_text('summary', 'Revenue and delivery remained on plan.', slot='left', style={'font_size': 20, 'min_font_size': 16, 'color': 0x334155})
    slide.add_chart('revenue', 'column', ['Q1', 'Q2', 'Q3', 'Q4'], slot='right', values=[120, 145, 168, 190], series_name='Revenue', title='Quarterly revenue', x_axis_title='Quarter', y_axis_title='Revenue', show_legend=True)
    slide.set_transition('fade', speed='medium')
    grid_slide = deck.slide('grid', layout='title-content', title='Allocated layout')
    grid_slide.add_header('header', left='Layout', accent='#F59E0B')
    grid_slide.add_footer('footer', left='UNO', center='Allocated', right='02')
    left, right = grid_slide.grid(2, 1, slot='body', gap=0.3)
    grid_slide.add_text('left', 'Unit-tagged grid cell', box={'x': left['x'], 'y': left['y'], 'w': left['w'], 'h': left['h'], '_unit': left['_unit']}, style={'font_size': 18, 'min_font_size': 16})
    grid_slide.add_text('right', 'No double inch conversion', box=right, style={'font_size': 18, 'min_font_size': 16})
    auto_slide = deck.slide('auto-text', layout='blank')
    auto_slide.set_background('linear', '#020617', '#1E3A8A', 135)
    auto_slide.add_text('headline', 'Large auto-height title', box={'x': 0.8, 'y': 0.7, 'w': 11.7}, auto_height=True,
                        style={'font_size': 78, 'min_font_size': 72, 'padding': 0})
    auto_slide.add_link('overview-link', 'Back to overview', box=(0.8, 5.8, 3.2, 0.7), target_slide_id='overview',
                        style={'font_size': 18, 'background': 0xE2E8F0, 'border': {'color': 0x64748B, 'width': 0.75}, 'padding': 0.12})
    deck.save()
    deck.close()`;
    const generated = await generateUnoProgramDocument({
      documentType: 'presentation',
      fileName: 'proven-high-level-blueprint.pptx',
      sourceCode,
    });
    expect((generated.report.verification as { pages?: number }).pages).toBe(3);
    const elements = generated.report.elementMap as Array<{ elementId?: string; kind?: string }>;
    expect(elements.some((entry) => entry.elementId === 'overview/title' && entry.kind === 'text')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'overview/summary' && entry.kind === 'text')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'overview/revenue' && entry.kind === 'chart')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'overview/transition' && entry.kind === 'slide-transition')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'auto-text/overview-link' && entry.kind === 'text')).toBe(true);
    const gridLeft = (generated.report.elementMap as Array<{
      elementId?: string; layout?: { x?: number; width?: number };
    }>).find((entry) => entry.elementId === 'grid/left');
    expect(gridLeft?.layout?.x).toBeGreaterThan(0);
    expect(gridLeft?.layout?.width).toBeLessThan(20_000);
    const archive = await JSZip.loadAsync(generated.buffer);
    expect(Object.keys(archive.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/i.test(name))).toHaveLength(1);
    const chartXml = await archive.file('ppt/charts/chart1.xml')?.async('string');
    const slideXml = await archive.file('ppt/slides/slide1.xml')?.async('string');
    expect(chartXml?.match(/<c:ser>/g)).toHaveLength(1);
    expect(chartXml).toContain('<c:cat>');
    expect(chartXml).toMatch(/<c:tx>.*?<c:v>Revenue<\/c:v>.*?<\/c:tx>/);
    expect(chartXml).toMatch(/<c:cat>.*?<c:v>Q1<\/c:v>.*?<c:v>Q4<\/c:v>.*?<\/c:cat>/);
    expect(chartXml).toContain('<a:t>Quarterly revenue</a:t>');
    expect(chartXml).toContain('<a:t>Quarter</a:t>');
    expect(chartXml).toContain('<a:t>Revenue</a:t>');
    expect(chartXml).toMatch(/<c:barDir val="col"\/>/);
    expect(chartXml).toMatch(/<c:showVal val="1"\/>/);
    expect(chartXml).toMatch(/<c:legend(?:\s|>)/);
    expect(chartXml).not.toContain('D9D9D9');
    expect(slideXml).toContain('<p:transition');
    const issues = ((generated.report.verification as {
      layout?: { issues?: Array<{ severity?: string }> };
    }).layout?.issues || []);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  }, 180_000);

  it('executes the Writer flow facade as a native editable DOCX', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const sourceCode = `def create_document(job):
    document = job.writer('report')
    document.feature('writer.page-style@1', 'page', width=document.mm(210), height=document.mm(297), margins=(document.mm(20), document.mm(20), document.mm(18), document.mm(18)))
    document.feature('writer.header-footer@1', 'chrome', header='Quarterly report', footer='Confidential')
    document.add_title('title', 'Quarterly report')
    document.add_paragraph('summary', 'Body content remains in native Writer flow.')
    document.add_numbered_list('actions', ['Confirm scope', 'Publish result'])
    document.add_table('metrics', [['Metric', 'Value'], ['Revenue', '190']], column_widths=[55, 45])
    document.save()
    document.close()`;

    const generated = await generateUnoProgramDocument({
      documentType: 'word',
      fileName: 'proven-writer-facade.docx',
      sourceCode,
    });
    expect((generated.report.verification as { format?: string }).format).toBe('word');
    const elements = generated.report.elementMap as Array<{ elementId?: string; kind?: string }>;
    expect(elements.some((entry) => entry.elementId === 'title' && entry.kind === 'paragraph')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'actions/1' && entry.kind === 'numbered-list-item')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'metrics' && entry.kind === 'table')).toBe(true);
    const archive = await JSZip.loadAsync(generated.buffer);
    const documentXml = await archive.file('word/document.xml')?.async('string');
    expect(documentXml).toContain('Quarterly report');
    expect(documentXml).toContain('Revenue');
  }, 180_000);

  it('executes the Calc A1 facade as a native editable XLSX', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const sourceCode = `def create_document(job):
    workbook = job.spreadsheet('workbook')
    sheet = workbook.sheet('summary', 'Summary')
    sheet.add_table('metrics', 'A1', [['Metric', 'Actual', 'Forecast'], ['Revenue', 1200, '=B2*1.2']])
    sheet.column_width('metric-width', 'A', workbook.mm(42))
    sheet.format('amounts', 'B2:C2', horizontal='RIGHT')
    sheet.freeze(rows=1)
    workbook.save()
    workbook.close()`;

    const generated = await generateUnoProgramDocument({
      documentType: 'spreadsheet',
      fileName: 'proven-calc-facade.xlsx',
      sourceCode,
    });
    expect((generated.report.verification as { format?: string }).format).toBe('spreadsheet');
    const elements = generated.report.elementMap as Array<{ elementId?: string; kind?: string }>;
    expect(elements.some((entry) => entry.elementId === 'summary' && entry.kind === 'worksheet')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'summary/metrics' && entry.kind === 'range')).toBe(true);
    expect(elements.some((entry) => entry.elementId === 'summary/freeze-panes' && entry.kind === 'freeze-panes')).toBe(true);
    expect((generated.report.featureCounts as { freezePanes?: number }).freezePanes).toBe(1);
    const archive = await JSZip.loadAsync(generated.buffer);
    const workbookXml = await archive.file('xl/workbook.xml')?.async('string');
    const sheetXml = await archive.file('xl/worksheets/sheet1.xml')?.async('string');
    expect(workbookXml).toContain('Summary');
    expect(sheetXml).toMatch(/<f(?:\s[^>]*)?>B2\*1\.2<\/f>/);
  }, 180_000);

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

  it('records exact non-zero feature counts for every specialized presentation shape capability', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-shape-capabilities-'));
    try {
      await writeFile(
        path.join(directory, 'sample.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#2563eb"/></svg>',
        'utf8',
      );
      const generated = await generateUnoProgramDocument({
        assetsPath: directory,
        documentType: 'presentation',
        fileName: 'specialized-shape-capabilities.pptx',
        sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('capabilities', layout='blank')
    slide.add_shape('rectangle', box=(0.6, 0.6, 1.3, 0.7), shape_type='rectangle', fill='#DBEAFE')
    slide.add_shape('ellipse', box=(2.1, 0.6, 1.3, 0.7), shape_type='ellipse', fill='#DCFCE7')
    slide.add_shape('custom', box=(3.6, 0.6, 1.3, 0.7), shape_type='diamond', fill='#FEF3C7')
    caption = slide.add_shape('caption', box=(5.1, 0.5, 2.0, 0.9), shape_type='caption', fill='#FCE7F3')
    caption.set_text('Caption', {'font_size': 14, 'valign': 'CENTER'})
    slide.add_shape('measure', box=(7.5, 0.8, 1.8, 0.25), shape_type='measure', line='#7C3AED', line_width=2)
    slide.add_shape('line', box=(9.8, 0.8, 1.8, 0.1), shape_type='line', line='#475569', line_width=2)
    slide.add_text('text', 'Text shape', box=(0.6, 2.0, 2.0, 0.6), style={'font_size': 16, 'min_font_size': 16})
    slide.add_image('image', 'sample.svg', box=(3.0, 1.8, 2.2, 1.1), contain=True)
    slide.add_shape('source', box=(6.0, 2.0, 1.5, 0.7), shape_type='round-rectangle', fill='#E0E7FF')
    slide.add_shape('target', box=(9.0, 2.0, 1.5, 0.7), shape_type='round-rectangle', fill='#E0E7FF')
    slide.connect('connector', 'source', 'target', color='#4F46E5', width=2, endArrow='triangle')
    deck.save()
    deck.close()
`,
      });
      const features = generated.report.featureCounts as Record<string, number>;
      for (const capability of [
        'RectangleShape', 'EllipseShape', 'CustomShape', 'CaptionShape', 'ConnectorShape',
        'LineShape', 'MeasureShape', 'TextShape', 'GraphicObject',
      ]) {
        expect(features[capability], capability).toBeGreaterThan(0);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 120_000);

  it('keeps crop and accessibility metadata on the default contained-image path', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-image-metadata-'));
    try {
      await writeFile(path.join(directory, 'wide.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="#2563eb"/></svg>', 'utf8');
      const generated = await generateUnoProgramDocument({
        assetsPath: directory,
        documentType: 'presentation',
        fileName: 'image-metadata.pptx',
        sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('image', layout='blank')
    slide.add_image('planet', 'wide.svg', box={'x': 1, 'y': 1, 'w': 8, 'h': 4},
        crop={'left': 100, 'right': 200}, rotation=5, transparency=12,
        title='Planet photograph', alt_text='A blue planet on a dark background',
        source='https://example.com/planet')
    deck.save()
    deck.close()
`,
      });
      const archive = await JSZip.loadAsync(generated.buffer);
      const slideXml = await archive.file('ppt/slides/slide1.xml')?.async('string');
      expect(slideXml).toContain('descr="Planet photograph&#10;A blue planet on a dark background&#10;Source: https://example.com/planet"');
      expect(slideXml).toMatch(/<a:srcRect[^>]+l="\d+"[^>]+r="\d+"/);
      expect(slideXml).toMatch(/rot="300000"/);
      expect(slideXml).toMatch(/<a:alphaModFix amt="88000"\/>/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 120_000);

  it('accepts PptxGenJS-like inch boxes, w/h aliases, cover layouts, and text backgrounds', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const generated = await generateUnoProgramDocument({
      documentType: 'presentation',
      fileName: 'inch-box-contract.pptx',
      sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    deck.set_doc_info(title='Inch contract')
    slide = deck.slide('cover', layout='title-cover')
    slide.set_background(0x0F172A)
    slide.add_text('headline', 'Stable high-level layout', box={'x': 0.7, 'y': 0.5, 'w': 12, 'h': 0.8}, style={'font_size': 30, 'min_font_size': 24, 'color': 0xFFFFFF, 'background': 0x1E293B, 'underline': True})
    slide.set_transition('wipe')
    layered = deck.slide('layered', layout='title-content', title='Title stays above background')
    layered.set_background(0xF8FAFC)
    cells = layered.grid(2, 1, slot='body', gap=0.3)
    layered.add_text('cell', 'Arithmetic-safe grid', box=(cells[0]['x'] + 0.15, cells[0]['y'] + 0.15, cells[0]['w'] - 0.3, 0.6), style={'font_size': 18})
    section = deck.slide('章节页', layout='title-section', title='Native section layout')
    section.add_text('中文标识', 'Unicode element IDs are supported', box={'x': 1, 'y': 4.8, 'w': 5, 'h': 0.7}, style={'fontSize': 18, 'fontColor': 0xFFFFFF, 'backgroundColor': 0x2563EB, 'borderColor': 0x93C5FD, 'borderWidth': 0.04})
    deck.save()
    deck.close()
`,
    });
    const headline = (generated.report.elementMap as Array<{
      elementId?: string; layout?: { width?: number; height?: number };
    }>).find((entry) => entry.elementId === 'cover/headline');
    expect(headline?.layout?.width).toBe(30480);
    expect(headline?.layout?.height).toBe(2032);
    expect((generated.report.featureCounts as { slideTransition?: number }).slideTransition).toBe(1);
    const gridCell = (generated.report.elementMap as Array<{
      elementId?: string; layout?: { x?: number; width?: number };
    }>).find((entry) => entry.elementId === 'layered/cell');
    expect(gridCell?.layout?.x).toBeLessThan(33866);
    expect(gridCell?.layout?.width).toBeGreaterThan(1000);
    expect((generated.report.elementMap as Array<{ elementId?: string }>).some((entry) => entry.elementId === '章节页/中文标识')).toBe(true);
    const archive = await JSZip.loadAsync(generated.buffer);
    const layeredXml = await archive.file('ppt/slides/slide2.xml')?.async('string') || '';
    expect(layeredXml).toContain('Title stays above background');
    expect(layeredXml.indexOf('background')).toBeLessThan(layeredXml.indexOf('Title stays above background'));
    const sectionXml = await archive.file('ppt/slides/slide3.xml')?.async('string');
    expect(sectionXml).toContain('Unicode element IDs are supported');
  }, 60_000);

  it('lays out timelines with more than six events without exhausting grid gaps', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const generated = await generateUnoProgramDocument({
      documentType: 'presentation',
      fileName: 'dense-timeline.pptx',
      sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('history', layout='title-only', title='Exploration history')
    events = [
        {'title': f'Phase {index + 1}', 'body': f'Milestone {index + 1}'}
        for index in range(9)
    ]
    slide.add_timeline('timeline', events, box={'x': 0.7, 'y': 1.5, 'w': 12, 'h': 5.2})
    deck.save()
    deck.close()
`,
    });
    expect((generated.report.verification as { pages?: number }).pages).toBe(1);
    const elements = generated.report.elementMap as Array<{ elementId?: string }>;
    expect(elements.some((entry) => entry.elementId === 'history/timeline/event-9/title')).toBe(true);
    const issues = ((generated.report.verification as { layout?: { issues?: Array<{ severity?: string }> } }).layout?.issues || []);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  }, 120_000);

  it('collects every unintended text overlap before rejecting at save', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    let failure = '';
    try {
      await generateUnoProgramDocument({
        documentType: 'presentation',
        fileName: 'batched-overlap.pptx',
        sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('slide-01', layout='blank')
    box = {'x': 1, 'y': 1, 'w': 5, 'h': 1}
    slide.add_text('first', 'First label', box=box)
    slide.add_text('second', 'Second label', box=box)
    slide.add_text('third', 'Third label', box=box)
    deck.save()
    deck.close()
`,
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain("slide-01/second' overlaps existing 'slide-01/first");
    expect(failure).toContain("slide-01/third' overlaps existing 'slide-01/first");
    expect(failure).toContain("slide-01/third' overlaps existing 'slide-01/second");
  }, 60_000);

  it('executes representative advanced Writer facade features', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const generated = await generateUnoProgramDocument({
      documentType: 'word',
      fileName: 'advanced-writer-facade.docx',
      sourceCode: `
def create_document(job):
    document = job.writer('document')
    document.set_doc_info(title='Advanced Writer')
    document.define_paragraph_style('body-style', 'WebPilot Body', font_size=11, space_after=160)
    document.add_rich_paragraph('rich', [
        {'text': 'Native ', 'bold': True, 'color': 0x1F4E78},
        {'text': 'rich text', 'italic': True, 'underline': True},
    ], paragraph_style='WebPilot Body')
    document.add_hyperlink('link', 'OpenAI', 'https://openai.com')
    document.add_table('table', [['A', 'B'], ['1', '2']], column_widths=[50, 50])
    document.merge_table_cells('table-merge', 'table', 'A2', 'B2')
    document.add_note('footnote', 'Native footnote text', kind='footnote')
    document.add_comment('comment', 'Review note', author='User')
    document.add_field('page-number', 'page-number', text_before='Page ')
    document.save()
    document.close()
`,
    });
    const features = generated.report.featureCounts as Record<string, number>;
    expect(features.footnote).toBe(1);
    expect(features.comment).toBe(1);
    expect(features.field).toBe(1);
    const archive = await JSZip.loadAsync(generated.buffer);
    const names = Object.keys(archive.files);
    const documentXml = await archive.file('word/document.xml')?.async('string');
    const relationshipsXml = await archive.file('word/_rels/document.xml.rels')?.async('string');
    expect(documentXml).toMatch(/<w:hyperlink\b/);
    expect(documentXml).toMatch(/<w:footnoteReference\b/);
    expect(documentXml).toMatch(/<w:commentRangeStart\b|<w:commentReference\b/);
    expect(documentXml).toMatch(/<w:fldChar\b|<w:instrText\b/);
    expect(documentXml).toMatch(/<w:gridSpan w:val="2"\/>/);
    expect(relationshipsXml).toContain('https://openai.com');
    expect(names).toContain('word/footnotes.xml');
    expect(names).toContain('word/comments.xml');
  }, 60_000);

  it('serializes Writer charts with semantic categories, one series, and the requested column direction', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const generated = await generateUnoProgramDocument({
      documentType: 'word',
      fileName: 'writer-chart-contract.docx',
      sourceCode: `
def create_document(job):
    document = job.writer('document')
    document.add_chart('chart', ['Mercury', 'Venus', 'Earth'], [3.3, 4.9, 6.0],
        chart_type='column', series_name='Mass', title='Planet mass',
        x_axis_title='Planet', y_axis_title='Mass', show_legend=True, show_values=True)
    document.save()
    document.close()
`,
    });
    const archive = await JSZip.loadAsync(generated.buffer);
    const chartName = Object.keys(archive.files).find((name) => /^word\/charts\/chart\d+\.xml$/i.test(name));
    expect(chartName).toBeTruthy();
    const chartXml = await archive.file(chartName!)?.async('string');
    expect(chartXml?.match(/<c:ser>/g)).toHaveLength(1);
    expect(chartXml).toMatch(/<c:cat>.*?<c:v>Mercury<\/c:v>.*?<c:v>Earth<\/c:v>.*?<\/c:cat>/);
    expect(chartXml).toMatch(/<c:tx>.*?<c:v>Mass<\/c:v>.*?<\/c:tx>/);
    expect(chartXml).toMatch(/<c:barDir val="col"\/>/);
    expect(chartXml).toMatch(/<c:showVal val="1"\/>/);
    expect(chartXml).toContain('Planet mass');
  }, 120_000);

  it('executes representative advanced Calc facade features', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const generated = await generateUnoProgramDocument({
      documentType: 'spreadsheet',
      fileName: 'advanced-calc-facade.xlsx',
      sourceCode: `
def create_document(job):
    workbook = job.spreadsheet('workbook')
    sheet = workbook.sheet('data', 'Data')
    sheet.set_range('values', 'A1', [['Category', 'Value'], ['A', 10], ['B', 20], ['C', 30]])
    sheet.format('numbers', 'B2:B4', number_format='#,##0.00', top_border=0x94A3B8, bottom_border=0x94A3B8)
    sheet.data_validation('validation', 'B2:B20', 'decimal', operator='greater-equal', formula1='0')
    sheet.conditional_format('conditional', 'B2:B20', 'greater', '15', background=0xDCFCE7)
    sheet.auto_filter('filter', 'A1:B4')
    sheet.named_range('named', 'MetricValues', 'B2:B4')
    sheet.add_comment('comment', 'B2', 'Verified value')
    sheet.add_chart('chart', 'A1:B4', {'x': 3.2, 'y': 0.5, 'w': 5.2, 'h': 3.2}, chart_type='column', title='Values')
    sheet.freeze(rows=1)
    workbook.save()
    workbook.close()
`,
    });
    const features = generated.report.featureCounts as Record<string, number>;
    expect(features.dataValidation).toBe(1);
    expect(features.conditionalFormat).toBe(1);
    expect(features.autoFilter).toBe(1);
    expect(features.nativeChart).toBe(1);
    const archive = await JSZip.loadAsync(generated.buffer);
    const names = Object.keys(archive.files);
    const sheetXml = await archive.file('xl/worksheets/sheet1.xml')?.async('string');
    const workbookXml = await archive.file('xl/workbook.xml')?.async('string');
    expect(sheetXml).toMatch(/<dataValidations\b/);
    expect(sheetXml).toMatch(/<conditionalFormatting\b/);
    expect(sheetXml).toMatch(/<pane\b[^>]*state="frozen"/);
    expect(workbookXml).toContain('MetricValues');
    expect(names.some((name) => /^xl\/comments\d+\.xml$/i.test(name))).toBe(true);
    expect(names.some((name) => /^xl\/drawings\/drawing\d+\.xml$/i.test(name))).toBe(true);
    const databaseTableName = names.find((name) => /^xl\/tables\/table\d+\.xml$/i.test(name));
    expect(databaseTableName).toBeTruthy();
    const databaseTableXml = await archive.file(databaseTableName!)?.async('string');
    expect(databaseTableXml).toMatch(/<autoFilter\b/);
    const chartName = names.find((name) => /^xl\/charts\/chart\d+\.xml$/i.test(name));
    expect(chartName).toBeTruthy();
    const chartXml = await archive.file(chartName!)?.async('string');
    expect(chartXml).toMatch(/<c:barDir val="col"\/>/);
    expect(chartXml).toMatch(/<c:cat>.*?<c:v>A<\/c:v>.*?<c:v>C<\/c:v>.*?<\/c:cat>/);
  }, 60_000);

  it('rejects raw shape tags because UNO objects are worker-owned', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    await expect(generateUnoProgramDocument({
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
    })).rejects.toThrow(/job\.expert\(\) is not model-facing|raw UNO imports are worker-owned/);
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
