import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { validateOfficeArtifact } from '@webpilot/capability-file/node';

describe('Office preserve-only feature gate', () => {
  it('blocks an existing PPTX edit that drops SmartArt package parts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-office-preservation-'));
    const source = path.join(directory, 'source.pptx');
    const output = path.join(directory, 'output.pptx');
    const addCore = (zip: JSZip) => {
      zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
      zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sld>');
    };
    try {
      const before = new JSZip();
      addCore(before);
      before.file('ppt/diagrams/data1.xml', '<dgm:dataModel xmlns:dgm="dgm"/>');
      before.file('ppt/activeX/activeX1.xml', '<ax:ocx xmlns:ax="ax"/>');
      before.file('ppt/embeddings/oleObject1.bin', Buffer.from([1, 2, 3]));
      before.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:p14="p14"><p:cSld><p:spTree/></p:cSld><p:transition><p14:morph/></p:transition></p:sld>');
      await writeFile(source, await before.generateAsync({ type: 'nodebuffer' }));
      const after = new JSZip();
      addCore(after);
      await writeFile(output, await after.generateAsync({ type: 'nodebuffer' }));

      const result = await validateOfficeArtifact({
        absolutePath: output,
        sourceAbsolutePath: source,
        extension: '.pptx',
      });
      expect(result.passed).toBe(false);
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST',
          target: 'smartArt',
        }),
        expect.objectContaining({ code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST', target: 'activeX' }),
        expect.objectContaining({ code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST', target: 'embeddedObjects' }),
        expect.objectContaining({ code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST', target: 'morphTransitions' }),
      ]));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('blocks an existing DOCX edit that drops tracked revisions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-word-preservation-'));
    const source = path.join(directory, 'source.docx');
    const output = path.join(directory, 'output.docx');
    try {
      const before = new JSZip();
      before.file('word/document.xml', '<w:document xmlns:w="w"><w:body><w:ins w:id="1"><w:r><w:t>added</w:t></w:r></w:ins></w:body></w:document>');
      before.file('word/embeddings/oleObject1.bin', Buffer.from([1, 2, 3]));
      await writeFile(source, await before.generateAsync({ type: 'nodebuffer' }));
      const after = new JSZip();
      after.file('word/document.xml', '<w:document xmlns:w="w"><w:body><w:r><w:t>added</w:t></w:r></w:body></w:document>');
      await writeFile(output, await after.generateAsync({ type: 'nodebuffer' }));

      const result = await validateOfficeArtifact({
        absolutePath: output,
        sourceAbsolutePath: source,
        extension: '.docx',
      });
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST',
          target: 'trackedChanges',
        }),
        expect.objectContaining({ code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST', target: 'embeddedObjects' }),
      ]));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('blocks an existing XLSX edit that drops structured tables, slicers, or external links', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'webpilot-excel-preservation-'));
    const source = path.join(directory, 'source.xlsx');
    const output = path.join(directory, 'output.xlsx');
    const addCore = (zip: JSZip) => {
      zip.file('xl/workbook.xml', '<workbook xmlns="x"><sheets/></workbook>');
      zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="x"><sheetData/></worksheet>');
    };
    try {
      const before = new JSZip();
      addCore(before);
      before.file('xl/tables/table1.xml', '<table xmlns="x"/>');
      before.file('xl/slicers/slicer1.xml', '<slicer xmlns="x"/>');
      before.file('xl/externalLinks/externalLink1.xml', '<externalLink xmlns="x"/>');
      before.file('xl/activeX/activeX1.xml', '<ocx xmlns="x"/>');
      before.file('xl/chartsEx/chartEx1.xml', '<cx:chart xmlns:cx="cx"/>');
      before.file('xl/timelines/timeline1.xml', '<timeline xmlns="x"/>');
      await writeFile(source, await before.generateAsync({ type: 'nodebuffer' }));
      const after = new JSZip();
      addCore(after);
      await writeFile(output, await after.generateAsync({ type: 'nodebuffer' }));

      const result = await validateOfficeArtifact({
        absolutePath: output,
        sourceAbsolutePath: source,
        extension: '.xlsx',
      });
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST', target: 'structuredTables' }),
        expect.objectContaining({ code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST', target: 'slicers' }),
        expect.objectContaining({ code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST', target: 'externalLinks' }),
        expect.objectContaining({ code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST', target: 'activeX' }),
        expect.objectContaining({ code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST', target: 'chartExtensions' }),
        expect.objectContaining({ code: 'OFFICE_PRESERVE_ONLY_FEATURE_LOST', target: 'timelines' }),
      ]));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
