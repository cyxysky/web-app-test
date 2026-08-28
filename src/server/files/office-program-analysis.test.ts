import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeOfficeProgram } from './office-program-analysis';

test('reports JavaScript syntax and incompatible CommonJS usage before Office execution', async () => {
  const syntax = await analyzeOfficeProgram('export function createDocument(job) { const broken = ; }', 'javascript');
  assert.equal(syntax.passed, false);
  assert.ok(syntax.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.line === 1));

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
