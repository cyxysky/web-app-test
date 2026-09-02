import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeOfficeProgram } from '@webpilot/capability-file/node';

test('reports JavaScript syntax and incompatible CommonJS usage before Office execution', async () => {
  const syntax = await analyzeOfficeProgram('export function createDocument(job) { const broken = ; }', 'javascript');
  assert.equal(syntax.passed, false);
  assert.ok(syntax.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.line === 1));
  assert.match(syntax.diagnostics.find((diagnostic) => diagnostic.line === 1)?.sourceExcerpt || '', />\s*1 \|/);

  const commonJs = await analyzeOfficeProgram('export function createDocument(job) { require("fs"); }', 'javascript');
  assert.equal(commonJs.passed, false);
  assert.ok(commonJs.diagnostics.some((diagnostic) => diagnostic.code === 'COMMONJS_REQUIRE'));
});

test('keeps direct JavaScript Office libraries outside UNO-only layout restrictions', async () => {
  const result = await analyzeOfficeProgram(`export async function createDocument(job) {
    const pptx = new job.PptxGenJS();
    const slide = pptx.addSlide();
    slide.addText('Title', { x: 1, y: 1, w: 4, h: 1 });
    await pptx.writeFile({ fileName: job.outputPath });
  }`, 'javascript');
  assert.equal(result.passed, true);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error'), false);
});

test('validates required facade parameters before Office execution', async () => {
  const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    deck.add_slide()
    deck.save()
    deck.close()`, 'uno');
  if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
  assert.equal(result.passed, false);
  assert.match(
    result.diagnostics.find((item) => item.code === 'UNO_API_SIGNATURE_MISMATCH')?.message || '',
    /missing required argument 'element_id'/,
  );
});

test('lets runtime scope and disambiguate repeated literal element IDs', async () => {
  const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_text('slide-01/title', page, 'First', 100, 100, 2000, 1000)
    deck.add_text('slide-01/title', page, 'Second', 100, 1200, 2000, 1000)
    deck.save()
    deck.close()`, 'uno');
  if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
  assert.equal(result.passed, true);
  assert.equal(result.diagnostics.some((item) => item.code === 'DUPLICATE_ELEMENT_ID'), false);
});

test('rejects stable facade methods called on an expert raw UNO document', async () => {
  const result = await analyzeOfficeProgram(`def create_document(job):
    expert = job.expert('need a raw Impress component')
    doc = expert.new_document('impress')
    page = doc.add_slide('slide-01')`, 'uno');
  if (result.diagnostics.some((item) => item.code === 'PYTHON_AST_UNAVAILABLE')) return;
  assert.equal(result.passed, false);
  const diagnostic = result.diagnostics.find((item) => item.code === 'FACADE_METHOD_ON_RAW_UNO_DOCUMENT');
  assert.match(diagnostic?.message || '', /doc\.add_slide/);
  assert.match(diagnostic?.sourceExcerpt || '', /page = doc\.add_slide/);
});

test('includes both ends of a mismatched Python bracket in the syntax diagnostic excerpt', async () => {
  const result = await analyzeOfficeProgram(`def create_document(job):
    values = (
        'one',
    ]`, 'uno');
  const diagnostic = result.diagnostics.find((item) => item.code === 'PYTHON_SYNTAX');
  if (!diagnostic) return;
  assert.equal(result.passed, false);
  assert.match(diagnostic.sourceExcerpt || '', />\s*2 \|/);
  assert.match(diagnostic.sourceExcerpt || '', />\s*4 \|/);
});
