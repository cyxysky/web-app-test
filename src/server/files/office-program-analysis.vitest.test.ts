import { describe, expect, it } from 'vitest';
import { analyzeOfficeProgram, diagnoseOfficeProgramRuntimeError } from './office-program-analysis';

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
    deck.add_text('slide-01/label', page, 'Label', 1000, 1000, 5000, deck.mm(3), font_size=12)
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
});
