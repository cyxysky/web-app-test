import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { inspectRenderedPage, validateOfficeArtifact } from './office-artifact-validator';

test('validates the final OOXML package independently from its authoring engine', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-validator-'));
  const target = path.join(directory, 'sample.pptx');
  try {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name="root"/></p:nvGrpSpPr><a:rPr typeface="Arial"/></p:spTree></p:cSld></p:sld>');
    await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await validateOfficeArtifact({ absolutePath: target, extension: '.pptx' });
    assert.equal(result.passed, true);
    assert.deepEqual(result.requestedFonts, ['Arial']);
    assert.ok(Array.isArray(result.media));
    assert.ok(result.platform.length > 0);
    assert.deepEqual(result.formatChecks, {
      presentation: { chartCount: 0, imageCount: 0, slideCount: 1, tableCount: 0 },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('flags a nearly uniform rendered page for automatic visual review', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-page-validator-'));
  const target = path.join(directory, 'blank.png');
  try {
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ffffff' } }).png().toFile(target);
    const result = await inspectRenderedPage(target);
    assert.ok(result.issues.some((issue) => issue.code === 'PAGE_APPEARS_BLANK'));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('preserves advanced DOCX layout while surfacing its visual-review risks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-docx-validator-'));
  const target = path.join(directory, 'advanced.docx');
  try {
    const zip = new JSZip();
    zip.file('word/document.xml', [
      '<w:document xmlns:w="w" xmlns:wp="wp"><w:body>',
      '<w:p><w:pPr><w:framePr/></w:pPr><w:r><w:t>Positioned text</w:t></w:r></w:p>',
      '<w:tbl><w:tr><w:trPr><w:trHeight w:val="240" w:hRule="exact"/></w:trPr></w:tr></w:tbl>',
      '<w:p><w:r><w:drawing><wp:anchor/></w:drawing></w:r></w:p>',
      '<w:sectPr/></w:body></w:document>',
    ].join(''));
    await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await validateOfficeArtifact({ absolutePath: target, extension: '.docx', validationProfile: 'uno-strict' });
    assert.equal(result.passed, true);
    assert.ok(result.issues.some((issue) => issue.code === 'DOCX_FLOATING_OBJECTS_REQUIRE_VISUAL_QA'));
    assert.ok(result.issues.some((issue) => issue.code === 'DOCX_TEXT_FRAMES_REQUIRE_VISUAL_QA'));
    assert.ok(result.issues.some((issue) => issue.code === 'DOCX_FIXED_TABLE_ROWS_REQUIRE_VISUAL_QA'));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('rejects PPTX object geometry outside the declared slide size', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-pptx-geometry-'));
  const target = path.join(directory, 'outside.pptx');
  try {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"><p:sldSz cx="1000" cy="1000"/></p:presentation>');
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="wp_title"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="900" y="0"/><a:ext cx="200" cy="100"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sld>');
    await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await validateOfficeArtifact({
      absolutePath: target,
      elementMap: [{ elementId: 'title', artifactName: 'wp_title', kind: 'text', line: 42, locator: { slide: 1, shape: 1 } }],
      extension: '.pptx',
      validationProfile: 'uno-strict',
    });
    assert.equal(result.passed, false);
    const issue = result.issues.find((candidate) => candidate.code === 'PPTX_OBJECT_OUT_OF_BOUNDS');
    assert.equal(issue?.elementId, 'title');
    assert.equal(issue?.line, 42);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('rejects PPTX native tables with collapsed internal rows or columns', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-pptx-table-grid-'));
  const target = path.join(directory, 'collapsed-table.pptx');
  try {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"><p:sldSz cx="1000" cy="1000"/></p:presentation>');
    zip.file('ppt/slides/slide1.xml', [
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:graphicFrame>',
      '<p:nvGraphicFramePr><p:cNvPr id="2" name="wp_table"/></p:nvGraphicFramePr>',
      '<p:xfrm><a:off x="0" y="0"/><a:ext cx="900" cy="900"/></p:xfrm>',
      '<a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="900"/><a:gridCol w="0"/></a:tblGrid>',
      '<a:tr h="900"/><a:tr h="0"/></a:tbl></a:graphicData></a:graphic>',
      '</p:graphicFrame></p:spTree></p:cSld></p:sld>',
    ].join(''));
    await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await validateOfficeArtifact({
      absolutePath: target,
      elementMap: [{ elementId: 'table', artifactName: 'wp_table', kind: 'table', line: 99, locator: { slide: 1 } }],
      extension: '.pptx',
      validationProfile: 'uno-strict',
    });
    assert.equal(result.passed, false);
    assert.equal(result.issues.find((issue) => issue.code === 'PPTX_TABLE_COLUMN_WIDTH_INVALID')?.line, 99);
    assert.equal(result.issues.find((issue) => issue.code === 'PPTX_TABLE_ROW_HEIGHT_INVALID')?.elementId, 'table');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('rejects XLSX workbooks without worksheets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-xlsx-structure-'));
  const target = path.join(directory, 'empty.xlsx');
  try {
    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<workbook/>');
    await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await validateOfficeArtifact({ absolutePath: target, extension: '.xlsx', validationProfile: 'uno-strict' });
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((issue) => issue.code === 'XLSX_NO_WORKSHEETS'));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('applies OOXML structure checks to JavaScript basic validation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-xlsx-basic-'));
  const target = path.join(directory, 'empty.xlsx');
  try {
    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<workbook/>');
    await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await validateOfficeArtifact({ absolutePath: target, extension: '.xlsx', validationProfile: 'basic' });
    assert.equal(result.passed, false);
    assert.equal(result.issues.some((issue) => issue.code === 'XLSX_NO_WORKSHEETS'), true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('rejects visible XLSX error cells and reports deterministic workbook counts in basic mode', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-xlsx-errors-'));
  const target = path.join(directory, 'errors.xlsx');
  try {
    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="Edge Cases"/></sheets></workbook>');
    zip.file('xl/worksheets/sheet1.xml', [
      '<worksheet><dimension ref="A1:B2"/><sheetData><row r="1">',
      '<c r="A1"><f>1+1</f><v>2</v></c>',
      '<c r="B1" t="e"><f>1/0</f><v>#VALUE!</v></c>',
      '</row></sheetData></worksheet>',
    ].join(''));
    zip.file('xl/charts/chart1.xml', '<chart/>');
    await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));

    const result = await validateOfficeArtifact({ absolutePath: target, extension: '.xlsx', validationProfile: 'basic' });

    assert.equal(result.passed, false);
    assert.ok(result.issues.some((issue) => issue.code === 'XLSX_FORMULA_ERROR_LITERAL'));
    assert.deepEqual(result.formatChecks, {
      spreadsheet: { chartCount: 1, errorCellCount: 1, formulaCount: 2, imageCount: 0, worksheetCount: 1 },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
