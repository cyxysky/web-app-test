import { describe, expect, it } from 'vitest';
import { analyzeOfficeProgram, diagnoseOfficeProgramRuntimeError } from '@webpilot/capability-file/node';

describe('Office program diagnostic excerpts', () => {
  it('includes the failing JavaScript source line', async () => {
    const result = await analyzeOfficeProgram(
      'export function createDocument(job) { const broken = ; }',
      'javascript',
    );
    const diagnostic = result.diagnostics.find((item) => item.severity === 'error');
    expect(result.passed).toBe(false);
    expect(diagnostic?.sourceExcerpt).toMatch(/>\s*1 \|/);
  });

  it('includes both ends of a mismatched Python bracket', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    values = (
        'one',
    ]`, 'uno');
    const diagnostic = result.diagnostics.find((item) => item.code === 'PYTHON_SYNTAX');
    if (!diagnostic) return;
    expect(result.passed).toBe(false);
    expect(diagnostic.sourceExcerpt).toMatch(/>\s*2 \|/);
    expect(diagnostic.sourceExcerpt).toMatch(/>\s*4 \|/);
  });

  it('rejects names that are never defined before starting LibreOffice', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_shape('card', page, 0, 0, 1000, leg_h)
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const diagnostic = result.diagnostics.find((item) => item.code === 'PYTHON_UNDEFINED_NAME');
    expect(result.passed).toBe(false);
    expect(diagnostic?.message).toContain('leg_h');
    expect(diagnostic?.sourceExcerpt).toMatch(/leg_h/);
  });

  it('rejects direct calls to the worker-owned draft entrypoint', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    return job.presentation('deck')

create_document(None)`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    expect(result.passed).toBe(false);
    expect(result.diagnostics.some((item) => item.code === 'DRAFT_ENTRYPOINT_CALLED_DIRECTLY')).toBe(true);
  });

  it('collects independent Python syntax errors in one recoverable AST preflight', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    deck.set_doc_info(
        title='JWST',
        subject='Overview'
    slide = deck.slide('cover', layout='title-cover', title='JWST')
               box=(0.7, 1.4, 4.0, 0.5),
               style={'font_size': 14})
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const syntax = result.diagnostics.filter((item) => item.code === 'PYTHON_SYNTAX');
    expect(result.passed).toBe(false);
    expect(syntax.length).toBeGreaterThanOrEqual(2);
    expect(new Set(syntax.map((item) => item.line)).size, JSON.stringify(syntax)).toBeGreaterThanOrEqual(2);
  });

  it('validates installed facade signatures and nested shape parameters before execution', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('cover', layout='title-cover', title='JWST')
    slide.set_notes('missing-element-id')
    slide.add_shape('space', box=(0.7, 1.4, 4.0, 2.0), gradient={'type': 'linear', 'colors': [0x000000, 0xFFFFFF]})
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    expect(result.passed).toBe(false);
    expect(result.diagnostics.find((item) => item.code === 'UNO_API_SIGNATURE_MISMATCH')?.message)
      .toContain("missing required argument 'text'");
    expect(result.diagnostics.find((item) => item.code === 'UNO_API_ARGUMENT_INVALID')?.message)
      .toContain('colors, type');
  });

  it('rejects guessed timeline options while accepting the installed text_color option', async () => {
    const rejected = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('timeline', layout='title-content', title='Timeline')
    slide.add_timeline('events', [{'title': '2026', 'body': 'Launch'}], body_color='#CBD5E1')
    deck.save()
    deck.close()`, 'uno');
    if (rejected.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    expect(rejected.passed).toBe(false);
    expect(rejected.diagnostics.find((item) => item.code === 'UNO_API_SIGNATURE_MISMATCH')?.message)
      .toContain("does not accept keyword 'body_color'");

    const accepted = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('timeline', layout='title-content', title='Timeline')
    slide.add_timeline('events', [{'title': '2026', 'body': 'Launch'}], text_color='#CBD5E1')
    deck.save()
    deck.close()`, 'uno');
    expect(accepted.diagnostics.some((item) => item.code === 'UNO_API_SIGNATURE_MISMATCH')).toBe(false);
  });

  it('collects all literal bounds defects while accepting PptxGenJS w/h grid aliases', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('cover', layout='blank')
    slide.add_shape('glow-left', box=(-2.0, -1.0, 6.0, 6.0), shape_type='ellipse')
    slide.add_shape('glow-right', box=(9.0, 4.0, 7.0, 7.0), shape_type='ellipse')
    cells = slide.grid(2, 1)
    for cell in cells:
        slide.add_text('metric', '42', box=(cell['x'], cell['y'], cell['w'], cell['h']))`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    expect(result.passed).toBe(false);
    expect(result.diagnostics.filter((item) => item.code === 'PRESENTATION_GEOMETRY_INVALID').length)
      .toBeGreaterThanOrEqual(2);
    expect(result.diagnostics.some((item) => item.code === 'PRESENTATION_GEOMETRY_OUT_OF_BOUNDS')).toBe(true);
    expect(result.diagnostics.some((item) => item.code.startsWith('UNO_LAYOUT_CELL_'))).toBe(false);
  });

  it('reports grid flattening and tuple indexing before execution', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('cover', layout='blank')
    cells = slide.grid(2, 1)
    flat = []
    for cell in cells:
        flat.extend(cell)
        slide.add_text('metric', '42', box=(cell[0], cell['y'], cell['w'], cell['h']))`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    expect(result.passed).toBe(false);
    expect(result.diagnostics.some((item) => item.code === 'UNO_LAYOUT_GRID_FLATTEN_INVALID')).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'UNO_LAYOUT_CELL_INDEX_INVALID')).toBe(true);
  });

  it('validates facade option schemas hidden behind double-star keyword forwarding', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('cover', layout='blank')
    slide.add_text('title', 'Rome', box=(0.7, 0.7, 4.0, 1.0), style=dict(font_size=40, letter_spacing=4))
    slide.add_table('metrics', [['Metric', 'Value']], box=(0.7, 2.0, 5.0, 2.0), header=True, mystery=True)
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    expect(result.passed).toBe(false);
    const messages = result.diagnostics
      .filter((item) => item.code === 'UNO_API_ARGUMENT_INVALID')
      .map((item) => item.message);
    expect(messages.some((message) => message.includes('letter_spacing'))).toBe(true);
    expect(messages.some((message) => message.includes('mystery'))).toBe(true);
  });

  it('rejects com.sun.star imports before starting LibreOffice', async () => {
    const result = await analyzeOfficeProgram(`from com.sun.star.drawing import FillStyle as _FS

def create_document(job):
    deck = job.presentation('deck')`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const diagnostic = result.diagnostics.find((item) => item.code === 'MODEL_RAW_UNO_FORBIDDEN');
    expect(result.passed).toBe(false);
    expect(diagnostic?.message).toContain('worker-owned');
    expect(diagnostic?.sourceExcerpt).toContain('from com.sun.star.drawing');
  });

  it('rejects guessed facade component access and points to high-level recipes', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    doc = getattr(deck, 'component', None)
    doc.createInstance('com.sun.star.drawing.RectangleShape')`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const diagnostic = result.diagnostics.find((item) => item.code === 'MODEL_RAW_UNO_FORBIDDEN');
    expect(result.passed).toBe(false);
    expect(diagnostic?.message).toContain('high-level capability recipe');
    expect(diagnostic?.sourceExcerpt).toContain("getattr(deck, 'component', None)");
  });

  it('rejects expert access before any raw UNO document can be created', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    expert = job.expert('need a raw Impress component')
    doc = expert.new_document('impress')
    page = doc.add_slide('slide-01')`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const diagnostic = result.diagnostics.find((item) => item.code === 'MODEL_RAW_UNO_FORBIDDEN');
    expect(result.passed).toBe(false);
    expect(diagnostic?.message).toContain('job.expert() is worker-owned');
    expect(diagnostic?.sourceExcerpt).toContain("expert = job.expert");
  });

  it('rejects raw ConnectorShape creation with a facade recipe replacement', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    expert = job.expert('need a connection between diagram nodes')
    doc = expert.new_document('presentation')
    connector = doc.createInstance('com.sun.star.drawing.ConnectorShape')`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const diagnostic = result.diagnostics.find((item) => item.code === 'MODEL_RAW_UNO_FORBIDDEN'
      && item.message.includes('Raw UNO service creation'));
    expect(result.passed).toBe(false);
    expect(diagnostic?.message).toContain('versioned feature recipe');
    expect(diagnostic?.sourceExcerpt).toContain('ConnectorShape');
  });

  it('allows duplicate literal element IDs because runtime slide scope disambiguates them', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_text('slide-01/title', page, 'First', 100, 100, 2000, 1000)
    deck.add_text('slide-01/title', page, 'Second', 100, 1200, 2000, 1000)
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    expect(result.passed).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'DUPLICATE_ELEMENT_ID')).toBe(false);
  });

  it('allows a fixed child element ID inside a helper called for different slides', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    def add_bg(page):
        deck.add_shape('bg', page, 0, 0, 1000, 1000)
    page1 = deck.add_slide('slide-01')
    add_bg(page1)
    page2 = deck.add_slide('slide-02')
    add_bg(page2)
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    expect(result.passed).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'HELPER_FIXED_ELEMENT_ID')).toBe(false);
  });

  it('rejects local helper signature drift and overlap-suppression defaults', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    def add_rect(sid, page, x, y, w, h, fill, allow_overlap=True):
        deck.add_shape(sid, page, x, y, w, h, fill=fill, allow_overlap=allow_overlap)
    page = deck.add_slide('slide-01')
    add_rect('slide-01/card', page, 0, 0, 1000, 1000, 0xFFFFFF, layout_role='container')
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    expect(result.passed).toBe(false);
    expect(result.diagnostics.find((item) => item.code === 'HELPER_CALL_SIGNATURE_MISMATCH')?.message)
      .toContain("does not accept keyword 'layout_role'");
    expect(result.diagnostics.find((item) => item.code === 'HELPER_OVERLAP_DEFAULT_ENABLED')?.message)
      .toContain('defaults allow_overlap=True');
  });

  it('checks static geometry passed through a local shape helper', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    def add_rect(sid, page, x, y, w, h):
        deck.add_shape(sid, page, x, y, w, h)
    page = deck.add_slide('slide-01')
    add_rect('slide-01/glow', page, -100, 0, 1000, 1000)
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const diagnostic = result.diagnostics.find((item) => item.code === 'PRESENTATION_GEOMETRY_INVALID');
    expect(result.passed).toBe(false);
    expect(diagnostic?.message).toContain('x=-100');
    expect(diagnostic?.line).toBe(6);
  });

  it('rejects a point-sized label placed in an impossible geometry height', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_text('slide-01/label', page, 'Label', 1000, 1000, 5000, deck.mm(3), font_size=12, min_font_size=12)
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const diagnostic = result.diagnostics.find((item) => item.code === 'PRESENTATION_TEXT_BOX_TOO_SHORT');
    expect(result.passed).toBe(false);
    expect(diagnostic?.line).toBe(4);
    expect(diagnostic?.message).toContain('height=300');
    expect(diagnostic?.message).toContain('1/100 mm');
    expect(diagnostic?.message).toContain('pt');
  });

  it('checks unit-aware text height through a reusable local helper', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    def add_label(sid, page, text, x, y, w, h, size=12):
        deck.add_text(sid, page, text, x, y, w, h, font_size=size, min_font_size=size)
    page = deck.add_slide('slide-01')
    add_label('slide-01/label', page, 'Helper label', 1000, 1000, 5000, 300)
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const diagnostic = result.diagnostics.find((item) => item.code === 'PRESENTATION_TEXT_BOX_TOO_SHORT');
    expect(result.passed).toBe(false);
    expect(diagnostic?.line).toBe(6);
    expect(diagnostic?.message).toContain('min_font_size=12pt');
  });

  it('rejects geometry that becomes negative on the first loop iteration', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    bounds = deck.bounds()
    page = deck.add_slide('slide-01')
    for i in range(8):
        deck.add_shape(f'slide-01/line-{i}', page, 0, i * int(bounds['height'] / 8) - 10, bounds['width'], 10)
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const diagnostic = result.diagnostics.find((item) => item.code === 'PRESENTATION_GEOMETRY_INVALID');
    expect(result.passed).toBe(false);
    expect(diagnostic?.message).toContain('y=-10');
    expect(diagnostic?.sourceExcerpt).toContain("deck.add_shape(f'slide-01/line-{i}'");
  });

  it('maps runtime geometry failures back to the exact draft call and element', () => {
    const source = `def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_shape('slide-01/line-0', page, 0, -10, 1000, 10)`;
    const [diagnostic] = diagnoseOfficeProgramRuntimeError(source, [
      'Traceback (most recent call last):',
      '  File "C:\\runtime\\document-drafts\\.candidate-deck.py", line 4, in create_document',
      'ValueError: Presentation geometry requires non-negative position and positive size: elementId=\'slide-01/line-0\', x=0, y=-10, width=1000, height=10',
    ].join('\n'));
    expect(diagnostic.code).toBe('PRESENTATION_GEOMETRY_INVALID');
    expect(diagnostic.line).toBe(4);
    expect(diagnostic.elementId).toBe('slide-01/line-0');
    expect(diagnostic.sourceExcerpt).toContain("deck.add_shape('slide-01/line-0'");
  });

  it('does not treat LibreOffice worker traceback lines as draft source lines', () => {
    const source = [
      'def create_document(job):',
      "    deck = job.presentation('deck')",
      "    page = deck.add_slide('slide-01')",
      "    deck.add_shape('slide-01/card', page, 0, 0, 1000, 1000)",
      ...Array.from({ length: 950 }, (_, index) => `    # filler ${index + 1}`),
    ].join('\n');
    const [diagnostic] = diagnoseOfficeProgramRuntimeError(source, [
      'Traceback (most recent call last):',
      '  File "C:\\project\\src\\server\\files\\libreoffice-program-worker.py", line 932, in add_shape',
      '  File "C:\\runtime\\document-drafts\\.candidate-deck.py", line 4, in create_document',
      "ValueError: Duplicate elementId: slide-01/card",
    ].join('\n'));
    expect(diagnostic.line).toBe(4);
    expect(diagnostic.sourceExcerpt).toContain('   4 |');
    expect(diagnostic.sourceExcerpt).not.toContain(' 932 |');
  });

  it('classifies a LibreOffice pipe startup failure as infrastructure, not source code', () => {
    const source = `def create_document(job):
    deck = job.presentation('deck')`;
    const [diagnostic] = diagnoseOfficeProgramRuntimeError(
      source,
      `RuntimeError: Unable to connect to LibreOffice UNO: Connector : couldn't connect to pipe "webpilot_deadbeef": 1`,
    );
    expect(diagnostic.code).toBe('UNO_BRIDGE_STARTUP');
    expect(diagnostic.line).toBeUndefined();
    expect(diagnostic.sourceExcerpt).toBeUndefined();
  });

  it('expands batched UNO layout diagnostics with source excerpts', () => {
    const source = `def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_text('slide-01/title', page, 'Title', 0, 0, 1000, 200)`;
    const diagnostics = diagnoseOfficeProgramRuntimeError(source, `ValueError: __WEBPILOT_LAYOUT_DIAGNOSTICS__[{"code":"PRESENTATION_TEXT_OVERFLOW","severity":"error","elementId":"slide-01/title","line":4,"column":1,"message":"Text is too small."}]`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('PRESENTATION_TEXT_OVERFLOW');
    expect(diagnostics[0].sourceExcerpt).toContain("deck.add_text('slide-01/title'");
  });

  it('preserves every distinct overlap pair reported from the layout pass', () => {
    const source = `def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_text('a', page, 'A', 0, 0, 1000, 400)
    deck.add_text('b', page, 'B', 0, 0, 1000, 400)
    deck.add_text('c', page, 'C', 0, 0, 1000, 400)`;
    const issues = [
      { code: 'PRESENTATION_OVERLAP', severity: 'error', line: 5, column: 1, elementId: 'b', elementIds: ['a', 'b'], message: 'b overlaps a' },
      { code: 'PRESENTATION_OVERLAP', severity: 'error', line: 6, column: 1, elementId: 'c', elementIds: ['a', 'c'], message: 'c overlaps a' },
      { code: 'PRESENTATION_OVERLAP', severity: 'error', line: 6, column: 1, elementId: 'c', elementIds: ['b', 'c'], message: 'c overlaps b' },
    ];
    const diagnostics = diagnoseOfficeProgramRuntimeError(
      source,
      `ValueError: __WEBPILOT_LAYOUT_DIAGNOSTICS__${JSON.stringify(issues)}`,
    );
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map((item) => item.elementIds)).toEqual([['a', 'b'], ['a', 'c'], ['b', 'c']]);
  });
});
