import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeOfficeProgram } from './office-program-analysis';

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

test('allows facade calls without statically requiring element IDs', async () => {
  const result = await analyzeOfficeProgram(`def create_document(job):
    deck = job.presentation('deck')
    deck.add_slide()
    deck.save()
    deck.close()`, 'uno');
  assert.equal(result.passed, true);
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
