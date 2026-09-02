import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { generateUnoProgramDocument, inspectUnoApi, resolveLibreOfficeExecutable } from '@webpilot/capability-file/node';

type Capability = { id: string; support: string };

const serializedFullContracts: Record<string, string[]> = {
  presentation: [
    'presentation.document@2',
    'presentation.slide@2',
    'presentation.existing-slide@1',
    'presentation.existing-shape@1',
    'presentation.text@2',
    'presentation.image@2',
    'presentation.shape@2',
    'presentation.table@1',
    'presentation.chart@2',
    'presentation.transition@1',
    'presentation.timeline@2',
  ],
  word: [
    'writer.flow@2',
    'writer.styles@1',
    'writer.list@1',
    'writer.table@2',
    'writer.image-frame@1',
    'writer.page-style@1',
    'writer.header-footer@1',
    'writer.fields-navigation@1',
    'writer.notes-review@1',
  ],
  spreadsheet: [
    'calc.sheet@2',
    'calc.cell-range@2',
    'calc.table@2',
    'calc.format@2',
    'calc.freeze-merge@1',
    'calc.validation-conditional@1',
    'calc.sort-filter-names-outline@1',
    'calc.chart-image@1',
    'calc.comments-links@1',
    'calc.print-protection@1',
  ],
};

const serializedPartialContracts: Record<string, string[]> = {
  presentation: ['presentation.professional@1'],
  word: ['writer.content-control@1', 'writer.objects@1', 'writer.mail-merge-protection@1'],
  spreadsheet: ['calc-pivot-scenario-goalseek@1'],
};

const preservationContracts: Record<string, string[]> = {
  presentation: ['presentation.smartart@1', 'presentation.morph@1', 'presentation.activex-ole@1'],
  word: ['writer.tracked-changes@1', 'writer.complex-ole@1'],
  spreadsheet: ['calc.structured-table@1', 'calc.slicer-timeline-modern-chart@1', 'calc.activex-external-link@1'],
};

const explicitRejectionContracts: Record<string, string[]> = {
  presentation: ['presentation.smartart-morph-vba-security-authoring@1'],
  word: ['writer.vba-digital-signature-irm-authoring@1'],
  spreadsheet: ['calc.slicer-vba-signature-irm-authoring@1'],
};

describe('Office native capability serialization contracts', () => {
  it('requires every full facade capability to have a real package contract', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    for (const documentType of ['presentation', 'word', 'spreadsheet'] as const) {
      const api = await inspectUnoApi({ documentType, query: documentType === 'word' ? 'writer' : documentType === 'spreadsheet' ? 'calc' : 'presentation', limit: 1 }) as unknown as { capabilities?: Capability[] };
      const declared = (api.capabilities || [])
        .filter((capability) => capability.support === 'full')
        .map((capability) => capability.id)
        .sort();
      expect(declared, `${documentType} has an uncontracted full capability`).toEqual(
        [...serializedFullContracts[documentType]].sort(),
      );
      for (const [support, contracts] of [
        ['partial', serializedPartialContracts],
        ['preserve-only', preservationContracts],
        ['unsupported', explicitRejectionContracts],
      ] as const) {
        expect((api.capabilities || [])
          .filter((capability) => capability.support === support)
          .map((capability) => capability.id)
          .sort(), `${documentType} has an uncontracted ${support} capability`).toEqual(
          [...contracts[documentType]].sort(),
        );
      }
    }
  }, 120_000);

  it('serializes the complete full PowerPoint surface into native PPTX structures', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-pptx-contract-'));
    try {
      await writeFile(path.join(directory, 'asset.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#1d4ed8"/></svg>', 'utf8');
      const generated = await generateUnoProgramDocument({
        assetsPath: directory,
        documentType: 'presentation',
        fileName: 'complete-presentation-contract.pptx',
        sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    deck.set_doc_info(title='Native contract', author='WebPilot', keywords=['office', 'native'])

    text = deck.slide('text', layout='blank')
    text.add_rich_text('rich', [
        {'text': 'Bold', 'bold': True, 'color': 0x1D4ED8},
        {'text': ' linked', 'italic': True, 'underline': True, 'link': 'https://example.com/rich'},
    ], box={'x': 0.7, 'y': 0.5, 'w': 5.5, 'h': 0.8}, style={'font_size': 20})
    text.add_bullets('bullets', ['First', 'Second'], box={'x': 0.7, 'y': 1.7, 'w': 5.5, 'h': 1.4}, style={'font_size': 18})
    text.add_link('link', 'External source', box={'x': 0.7, 'y': 3.5, 'w': 3.0, 'h': 0.6}, url='https://example.com/source')
    text.set_transition('wipe', speed='fast')

    visual = deck.slide('visual', layout='blank')
    visual.add_captioned_image('figure', 'asset.svg', 'Blue asset illustration', box={'x': 0.7, 'y': 0.5, 'w': 4.5, 'h': 3.25},
        crop={'left': 120, 'right': 120}, rotation=8, transparency=10,
        alt_text='Blue rectangular illustration', source='https://example.com/asset')
    left = visual.add_shape('left', box={'x': 0.8, 'y': 4.0, 'w': 2.0, 'h': 1.1},
        gradient={'start_color': 0xDBEAFE, 'end_color': 0x2563EB, 'angle': 45})
    right = visual.add_shape('right', box={'x': 3.2, 'y': 4.0, 'w': 2.0, 'h': 1.1},
        shape_type='rounded-rectangle', fill=0xD1FAE5, rotation=6)
    visual.connect('flow', {'x': 0.8, 'y': 4.0, 'w': 2.0, 'h': 1.1}, {'x': 3.2, 'y': 4.0, 'w': 2.0, 'h': 1.1}, end_arrow=True)
    visual.group('group', [left, right])

    table = deck.slide('table', layout='title-only', title='Native table')
    matrix = table.add_table('matrix', [['Metric', 'Value'], ['Revenue', '190']], box={'x': 0.8, 'y': 1.8, 'w': 5.0, 'h': 2.2})
    matrix.set_cell(1, 1, '190 verified', bold=True, color=0x047857)
    matrix.merge('A2', 'B2')

    chart = deck.slide('chart', layout='title-only', title='Native chart')
    chart.add_chart('series', 'column', ['Q1', 'Q2', 'Q3'], box={'x': 0.8, 'y': 1.6, 'w': 7.2, 'h': 4.8},
        series=[{'name': 'Actual', 'values': [10, 20, 30]}, {'name': 'Plan', 'values': [12, 19, 28]}],
        title='Quarterly values', x_axis_title='Quarter', y_axis_title='Value',
        show_legend=True, show_values=True)

    timeline = deck.slide('timeline', layout='title-only', title='Timeline')
    timeline.add_timeline('events', [{'title': f'P{i}', 'body': f'M{i}'} for i in range(1, 9)],
        box={'x': 0.6, 'y': 1.5, 'w': 12.1, 'h': 5.3})

    edit = deck.slide('edit', layout='blank')
    edit.add_text('original', 'Original text', box={'x': 1, 'y': 1, 'w': 4, 'h': 1})
    selected = edit.select_shape('selected', text='Original text')
    selected.set_text('Edited text', style={'font_size': 22, 'bold': True})
    selected.set_box({'x': 1.2, 'y': 1.1, 'w': 4.2, 'h': 1.1})
    selected.set_style(color=0xDC2626)
    selected.bring_to_front().send_to_back()
    removable = edit.add_shape('removable', box={'x': 1, 'y': 3, 'w': 2, 'h': 1}, fill=0x94A3B8)
    removable.remove()
    deck.duplicate_slide('duplicate', 6)
    deck.move_slide(7, 1)
    temporary = deck.slide('temporary', layout='blank')
    temporary.add_text('remove-me', 'remove me', box={'x': 1, 'y': 1, 'w': 3, 'h': 1})
    deck.remove_slide(8)
    deck.save()
    deck.close()
`,
      });
      const archive = await JSZip.loadAsync(generated.buffer);
      const names = Object.keys(archive.files);
      expect(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))).toHaveLength(7);
      const allSlides = (await Promise.all(names
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .map((name) => archive.file(name)!.async('string')))).join('\n');
      const relationships = (await Promise.all(names
        .filter((name) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/i.test(name))
        .map((name) => archive.file(name)!.async('string')))).join('\n');
      const chartName = names.find((name) => /^ppt\/charts\/chart\d+\.xml$/i.test(name));
      const chartXml = await archive.file(chartName!)?.async('string');
      const presentationXml = await archive.file('ppt/presentation.xml')?.async('string');
      expect(allSlides).toContain('Edited text');
      expect(allSlides).not.toContain('Original text');
      expect(allSlides).not.toContain('remove me');
      expect(allSlides).not.toContain('wp_edit_removable');
      expect(allSlides).toMatch(/<a:rPr[^>]*(?:b="1"|i="1")/);
      expect(allSlides).toMatch(/<a:buChar\b|<a:buAutoNum\b/);
      expect(allSlides).toMatch(/<a:gradFill\b/);
      expect(allSlides).toMatch(/<p:grpSp\b/);
      expect(allSlides).toMatch(/<a:tbl\b/);
      expect(allSlides).toContain('190 verified');
      expect(allSlides).toMatch(/gridSpan="2"/);
      expect(allSlides).toMatch(/<p:transition\b/);
      expect(allSlides).toContain('Blue rectangular illustration');
      expect(allSlides).toContain('Blue asset illustration');
      expect(allSlides).toContain('Source: https://example.com/asset');
      expect(allSlides).toMatch(/<a:srcRect\b/);
      expect(relationships).toContain('https://example.com/source');
      expect(relationships).toContain('https://example.com/rich');
      expect(chartXml?.match(/<c:ser>/g)).toHaveLength(2);
      expect(chartXml).toMatch(/<c:cat>.*?<c:v>Q1<\/c:v>.*?<c:v>Q3<\/c:v>.*?<\/c:cat>/);
      expect(chartXml).toContain('Actual');
      expect(chartXml).toContain('Plan');
      expect(chartXml).toMatch(/<c:barDir val="col"\/>/);
      expect(chartXml).toMatch(/<c:showVal val="1"\/>/);
      const firstSlideRelationshipId = presentationXml?.match(/<p:sldIdLst>\s*<p:sldId\b[^>]*r:id="([^"]+)"/)?.[1];
      const presentationRelationships = await archive.file('ppt/_rels/presentation.xml.rels')?.async('string');
      const firstSlideTarget = presentationRelationships?.match(
        new RegExp(`<Relationship\\b(?=[^>]*\\bId="${firstSlideRelationshipId}")(?=[^>]*\\bTarget="([^"]+)")[^>]*/>`),
      )?.[1];
      expect(firstSlideTarget).toMatch(/^slides\/slide\d+\.xml$/);
      const firstSlideXml = await archive.file(`ppt/${firstSlideTarget}`)?.async('string');
      expect(firstSlideXml).toContain('Edited text');
      const core = await archive.file('docProps/core.xml')?.async('string');
      expect(core).toContain('Native contract');
      expect(core).toContain('WebPilot');
      const issues = ((generated.report.verification as { layout?: { issues?: Array<{ severity?: string }> } }).layout?.issues || []);
      expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 180_000);

  it('serializes the complete full Word surface into native DOCX structures', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-docx-contract-'));
    try {
      await writeFile(path.join(directory, 'asset.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#16a34a"/></svg>', 'utf8');
      const generated = await generateUnoProgramDocument({
        assetsPath: directory,
        documentType: 'word',
        fileName: 'complete-writer-contract.docx',
        sourceCode: `
def create_document(job):
    document = job.writer('document')
    document.set_doc_info(title='Writer contract', author='WebPilot')
    document.feature('writer.page-style@1', 'page', width=document.mm(210), height=document.mm(297), margins=(document.mm(18), document.mm(18), document.mm(16), document.mm(16)))
    document.feature('writer.header-footer@1', 'chrome', header='Native header', footer='Native footer')
    document.define_paragraph_style('style', 'Contract Body', font_size=11, color=0x334155, space_after=140)
    document.add_title('title', 'Writer native contract')
    document.add_rich_paragraph('rich', [
        {'text': 'Bold ', 'bold': True, 'color': 0x1D4ED8},
        {'text': 'link', 'italic': True, 'underline': True, 'link': 'https://example.com/rich'},
    ], paragraph_style='Contract Body')
    document.add_bullets('bullets', ['Alpha', 'Beta'])
    document.add_numbered_list('numbers', ['One', 'Two'])
    document.add_table('table', [['A', 'B'], ['1', '2']], column_widths=[40, 60])
    document.merge_table_cells('merge', 'table', 'A2', 'B2')
    document.add_inline_image('image', 'asset.svg', width=document.mm(70))
    document.add_text_frame('frame', 'Native frame', document.mm(55), document.mm(18), background=0xE2E8F0)
    document.add_bookmark('bookmark', 'contract-bookmark', text='Bookmark target')
    document.add_cross_reference('crossref', 'contract-bookmark', part='text')
    document.add_hyperlink('link', 'External source', 'https://example.com/source')
    document.add_field('field', 'page-number', text_before='Page ')
    document.add_toc('toc', title='Contents')
    document.add_index('index', title='Index')
    document.add_note('footnote', 'Footnote contract', kind='footnote')
    document.add_note('endnote', 'Endnote contract', kind='endnote')
    document.add_comment('comment', 'Comment contract', author='Reviewer')
    document.add_section('section', 'Two columns', columns=2)
    document.add_page_break('page-break')
    document.add_paragraph('closing', 'Closing paragraph', paragraph_style='Contract Body')
    document.replace_text('replace', 'Closing paragraph', 'Closing paragraph updated', replace_all=False)
    document.save()
    document.close()
`,
      });
      const archive = await JSZip.loadAsync(generated.buffer);
      const names = Object.keys(archive.files);
      const documentXml = await archive.file('word/document.xml')?.async('string');
      const stylesXml = await archive.file('word/styles.xml')?.async('string');
      const numberingXml = await archive.file('word/numbering.xml')?.async('string');
      const relationships = await archive.file('word/_rels/document.xml.rels')?.async('string');
      expect(documentXml).toContain('Writer native contract');
      expect(documentXml).toContain('Closing paragraph updated');
      expect(documentXml).toMatch(/<w:tbl\b/);
      expect(documentXml).toMatch(/<w:gridSpan w:val="2"\/>/);
      expect(documentXml).toMatch(/<w:drawing\b|<w:pict\b/);
      expect(documentXml).toMatch(/<w:txbxContent\b/);
      expect(documentXml).toMatch(/<w:bookmarkStart\b[^>]*w:name="contract-bookmark"/);
      expect(documentXml).toMatch(/<w:hyperlink\b/);
      expect(documentXml).toMatch(/TOC/);
      expect(documentXml).toMatch(/INDEX/);
      expect(documentXml).toMatch(/<w:br w:type="page"\/>|<w:pageBreakBefore\/>/);
      expect(documentXml).toMatch(/<w:cols\b[^>]*w:num="2"/);
      expect(stylesXml).toContain('Contract Body');
      expect(numberingXml).toMatch(/<w:abstractNum\b/);
      expect(relationships).toContain('https://example.com/source');
      expect(relationships).toContain('https://example.com/rich');
      expect(names.some((name) => /^word\/header\d+\.xml$/i.test(name))).toBe(true);
      expect(names.some((name) => /^word\/footer\d+\.xml$/i.test(name))).toBe(true);
      expect(names).toContain('word/footnotes.xml');
      expect(names).toContain('word/endnotes.xml');
      expect(names).toContain('word/comments.xml');
      expect(names.some((name) => /^word\/media\//i.test(name))).toBe(true);
      const headers = (await Promise.all(names
        .filter((name) => /^word\/header\d+\.xml$/i.test(name))
        .map((name) => archive.file(name)!.async('string')))).join('\n');
      const footers = (await Promise.all(names
        .filter((name) => /^word\/footer\d+\.xml$/i.test(name))
        .map((name) => archive.file(name)!.async('string')))).join('\n');
      expect(headers).toContain('Native header');
      expect(footers).toContain('Native footer');
      const core = await archive.file('docProps/core.xml')?.async('string');
      expect(core).toContain('Writer contract');
      expect(core).toContain('WebPilot');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 180_000);

  it('serializes the complete full Excel surface into native XLSX structures', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-xlsx-contract-'));
    try {
      await writeFile(path.join(directory, 'asset.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#f59e0b"/></svg>', 'utf8');
      const generated = await generateUnoProgramDocument({
        assetsPath: directory,
        documentType: 'spreadsheet',
        fileName: 'complete-calc-contract.xlsx',
        sourceCode: `
def create_document(job):
    workbook = job.spreadsheet('workbook')
    data = workbook.sheet('data', 'Data')
    data.set_range('values', 'A1', [['Category', 'Value', 'Formula'], ['B', 20, '=B2*2'], ['A', 10, '=B3*2'], ['C', 30, '=B4*2']])
    data.format('header', 'A1:C1', bold=True, color=0xFFFFFF, background=0x1F4E78, horizontal='CENTER', wrap=True)
    data.format('numbers', 'B2:C4', number_format='#,##0.00', top_border=0x94A3B8, bottom_border=0x94A3B8, rotation=15, shrink_to_fit=True)
    data.column_width('width', 'A', workbook.mm(36))
    data.row_height('height', 1, workbook.mm(8))
    data.merge('merged', 'E1:F1')
    data.freeze('freeze', rows=1, columns=1)
    data.data_validation('validation', 'B2:B20', 'decimal', operator='greater-equal', formula1='0')
    data.conditional_format('conditional', 'B2:B20', 'greater', '15', background=0xDCFCE7, bold=True)
    data.add_database_table('database', 'H1', [['Name', 'Score'], ['A', 1], ['B', 2]], auto_filter=True)
    data.sort('sort', 'A1:C4', key=1, ascending=True, contains_header=True)
    data.named_range('name', 'MetricValues', 'B2:B4')
    data.group('group', '2:4', orientation='rows', collapsed=True)
    data.add_comment('comment', 'B2', 'Verified value', author='Reviewer')
    data.add_hyperlink('link', 'D2', 'External source', 'https://example.com/source')
    data.add_chart('chart', 'A1:B4', {'x': 8.0, 'y': 4.0, 'w': 5.0, 'h': 3.0}, chart_type='column', title='Values')
    data.add_image('image', 'asset.svg', {'x': 8.0, 'y': 0.5, 'w': 3.0, 'h': 1.5})
    data.print_setup('print', orientation='landscape', margins={'left': 1200, 'right': 1200, 'top': 1000, 'bottom': 1000}, repeat_rows='A1:C1', print_area='A1:J20', fit_to_pages=1)
    data.protect('secret')

    subtotal = workbook.sheet('subtotal', 'Subtotal')
    subtotal.set_range('values', 'A1', [['Group', 'Value'], ['A', 10], ['A', 20], ['B', 30]])
    subtotal.subtotals('totals', 'A1:B4', group_column=1, value_columns=[2])
    archive = workbook.copy_sheet('archive', 'Data', 'Archive')
    archive.hide(True)
    workbook.move_sheet('Subtotal', 1)
    workbook.save()
    workbook.close()
`,
      });
      const archive = await JSZip.loadAsync(generated.buffer);
      const names = Object.keys(archive.files);
      const workbookXml = await archive.file('xl/workbook.xml')?.async('string');
      const stylesXml = await archive.file('xl/styles.xml')?.async('string');
      const sheets = await Promise.all(names
        .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
        .map((name) => archive.file(name)!.async('string')));
      const allSheets = sheets.join('\n');
      expect(workbookXml).toMatch(/name="Subtotal" sheetId="1"/);
      expect(workbookXml).toMatch(/name="Archive"[^>]*state="hidden"/);
      expect(workbookXml).toContain('MetricValues');
      expect(workbookXml).toContain('_xlnm.Print_Area');
      expect(workbookXml).toContain('_xlnm.Print_Titles');
      expect(allSheets).toMatch(/<mergeCell ref="E1:F1"\/>/);
      expect(allSheets).toMatch(/<pane\b[^>]*xSplit="1"[^>]*ySplit="1"[^>]*state="frozen"/);
      expect(allSheets).toMatch(/<dataValidations\b/);
      expect(allSheets).toMatch(/<conditionalFormatting\b/);
      expect(allSheets).toMatch(/<sheetProtection\b/);
      expect(allSheets).toMatch(/<pageSetup\b[^>]*orientation="landscape"/);
      expect(allSheets).toMatch(/<row\b(?=[^>]*outlineLevel="1")(?=[^>]*hidden="true")[^>]*>/);
      expect(allSheets).toMatch(/SUBTOTAL\(/i);
      expect(allSheets).not.toContain('#REF!');
      expect(allSheets).toMatch(/HYPERLINK\(/i);
      expect(stylesXml).toContain('formatCode="#\,##0.00"');
      expect(stylesXml).toMatch(/<alignment\b(?=[^>]*textRotation="15")(?=[^>]*shrinkToFit="(?:1|true)")[^>]*\/>/);
      expect(names.some((name) => /^xl\/comments\d+\.xml$/i.test(name))).toBe(true);
      expect(names.some((name) => /^xl\/media\//i.test(name))).toBe(true);
      expect(names.some((name) => /^xl\/drawings\/drawing\d+\.xml$/i.test(name))).toBe(true);
      const tableName = names.find((name) => /^xl\/tables\/table\d+\.xml$/i.test(name));
      const tableXml = await archive.file(tableName!)?.async('string');
      expect(tableXml).toMatch(/<autoFilter\b/);
      const chartName = names.find((name) => /^xl\/charts\/chart\d+\.xml$/i.test(name));
      const chartXml = await archive.file(chartName!)?.async('string');
      expect(chartXml).toMatch(/<c:barDir val="col"\/>/);
      expect(chartXml).toMatch(/<c:cat>.*?<c:v>A<\/c:v>.*?<c:v>C<\/c:v>.*?<\/c:cat>/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 180_000);

  it('proves the supported subset of partial PowerPoint professional features', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-pptx-partial-contract-'));
    try {
      const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', 'base64');
      await writeFile(path.join(directory, 'tone.wav'), wav);
      const generated = await generateUnoProgramDocument({
        assetsPath: directory,
        documentType: 'presentation',
        fileName: 'partial-presentation-contract.pptx',
        sourceCode: `
def create_document(job):
    deck = job.presentation('deck')
    first = deck.slide('first', layout='blank')
    shape = first.add_shape('animated', box={'x': 1, 'y': 1, 'w': 3, 'h': 1.2}, fill=0x2563EB)
    first.animate(shape, effect='appear', speed='fast')
    first.set_notes('notes', 'Speaker note contract')
    first.add_comment('comment', 'Slide comment contract', author='Reviewer')
    first.add_field('page', 'page-number', box={'x': 11.5, 'y': 6.5, 'w': 1, 'h': 0.7})
    first.apply_master(index=1)
    media = deck.slide('media', layout='blank')
    media.add_media('audio', 'tone.wav', box={'x': 1, 'y': 1, 'w': 4, 'h': 2}, media_type='audio')
    deck.add_custom_show('Contract show', [1, 2])
    deck.save()
    deck.close()
`,
      });
      const archive = await JSZip.loadAsync(generated.buffer);
      const names = Object.keys(archive.files);
      const presentationXml = await archive.file('ppt/presentation.xml')?.async('string');
      const allSlides = (await Promise.all(names
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .map((name) => archive.file(name)!.async('string')))).join('\n');
      expect(names.some((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name))).toBe(true);
      expect(names.some((name) => /^ppt\/comments\/comment\d+\.xml$/i.test(name))).toBe(true);
      expect(names.some((name) => /^ppt\/media\//i.test(name))).toBe(true);
      expect(allSlides).toMatch(/<a:fld\b/);
      expect(allSlides).toMatch(/<p:timing\b/);
      expect(presentationXml).toContain('Contract show');
      const features = generated.report.featureCounts as Record<string, number>;
      expect(features.speakerNotes).toBe(1);
      expect(features.slideComment).toBe(1);
      expect(features.embeddedMedia).toBe(1);
      expect(features.shapeAnimation).toBe(1);
      expect(features.masterLayoutAssignment).toBe(1);
      expect(features.customShow).toBe(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 180_000);

  it('proves the supported subset of partial Word object and control features', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const generated = await generateUnoProgramDocument({
      documentType: 'word',
      fileName: 'partial-writer-contract.docx',
      sourceCode: `
def create_document(job):
    document = job.writer('document')
    document.add_content_control('control', text='Controlled text', tag='contract', title='Contract control', locked=True)
    document.add_formula('formula', 'a over b')
    document.add_chart('chart', ['A', 'B'], [10, 20], chart_type='column', series_name='Value')
    document.add_mail_merge_field('merge', 'Database', 'Customers', 'Name')
    document.protect('secret')
    document.save()
    document.close()
`,
    });
    const archive = await JSZip.loadAsync(generated.buffer);
    const names = Object.keys(archive.files);
    const documentXml = await archive.file('word/document.xml')?.async('string');
    const settingsXml = await archive.file('word/settings.xml')?.async('string');
    expect(documentXml).toMatch(/<w:sdt\b/);
    expect(documentXml).toContain('Controlled text');
    expect(documentXml).toMatch(/MERGEFIELD|DATABASE/i);
    expect(settingsXml).toMatch(/<w:documentProtection\b/);
    expect(names.some((name) => /^word\/charts\/chart\d+\.xml$/i.test(name))).toBe(true);
    expect(documentXml).toMatch(/<m:oMath\b|<m:oMathPara\b/);
    const features = generated.report.featureCounts as Record<string, number>;
    expect(features.contentControl).toBe(1);
    expect(features.formulaObject).toBe(1);
    expect(features.nativeChart).toBe(1);
    expect(features.mailMergeField).toBe(1);
    expect(features.documentProtection).toBe(1);
  }, 180_000);

  it('proves the supported subset of partial Excel analytical features', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const generated = await generateUnoProgramDocument({
      documentType: 'spreadsheet',
      fileName: 'partial-calc-contract.xlsx',
      sourceCode: `
def create_document(job):
    workbook = job.spreadsheet('workbook')
    sheet = workbook.sheet('data', 'Data')
    sheet.set_range('values', 'A1', [['Category', 'Value'], ['A', 10], ['A', 20], ['B', 30]])
    sheet.add_pivot('pivot', 'A1:B4', 'D1', row_fields=['Category'], data_fields=['Value'])
    sheet.add_scenario('scenario', 'Higher value', 'B2', [[25]], comment='Contract scenario')
    sheet.set_cell('variable', 'B8', 2)
    sheet.set_cell('formula', 'B9', '=B8*2')
    result = sheet.goal_seek('goal', 'B9', 'B8', 20)
    if abs(result['result'] - 10) > 0.01:
        raise ValueError('Goal seek returned the wrong variable value')
    workbook.save()
    workbook.close()
`,
    });
    const archive = await JSZip.loadAsync(generated.buffer);
    const names = Object.keys(archive.files);
    const allSheets = (await Promise.all(names
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .map((name) => archive.file(name)!.async('string')))).join('\n');
    expect(names.some((name) => /^xl\/pivotTables\/pivotTable\d+\.xml$/i.test(name))).toBe(true);
    expect(names.some((name) => /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/i.test(name))).toBe(true);
    expect(allSheets).toMatch(/<scenarios\b/);
    const features = generated.report.featureCounts as Record<string, number>;
    expect(features.pivotTable).toBe(1);
    expect(features.scenario).toBe(1);
    expect(features.goalSeek).toBe(1);
  }, 180_000);
});
