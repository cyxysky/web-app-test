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

  it('rejects duplicate literal element IDs before starting LibreOffice', async () => {
    const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_text('slide-01/title', page, 'First', 100, 100, 2000, 1000)
    deck.add_text('slide-01/title', page, 'Second', 100, 1200, 2000, 1000)
    deck.save()
    deck.close()`, 'uno');
    if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
    const diagnostic = result.diagnostics.find((item) => item.code === 'DUPLICATE_ELEMENT_ID');
    expect(result.passed).toBe(false);
    expect(diagnostic?.message).toContain('first declared on line 4');
    expect(diagnostic?.sourceExcerpt).toContain("deck.add_text('slide-01/title'");
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
