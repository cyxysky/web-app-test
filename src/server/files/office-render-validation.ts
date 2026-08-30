import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';
import type { OfficeArtifactIssue } from './office-artifact-validator';

export type OfficeRendererResult = {
  available: boolean;
  outputPath?: string;
  renderer: 'libreoffice';
  status: 'failed' | 'passed' | 'unavailable';
  summary?: { pages: number; textCharacters: number };
  warning?: string;
};

async function pdfSummary(pdfPath: string) {
  const parser = new PDFParse({ data: await readFile(pdfPath) });
  try {
    const info = await parser.getInfo();
    const text = await parser.getText();
    return { pages: info.total, textCharacters: text.text.replace(/\s+/g, '').length };
  } finally {
    await parser.destroy();
  }
}

/** Validate the PDF produced by the same LibreOffice runtime used by UNO. */
export async function validateOfficeRendererMatrix(input: {
  libreOfficePdfPath?: string;
}) {
  const issues: OfficeArtifactIssue[] = [];
  const libreOffice: OfficeRendererResult = {
    available: Boolean(input.libreOfficePdfPath),
    outputPath: input.libreOfficePdfPath,
    renderer: 'libreoffice',
    status: input.libreOfficePdfPath ? 'passed' : 'unavailable',
  };
  if (input.libreOfficePdfPath) {
    try {
      await access(input.libreOfficePdfPath, constants.R_OK);
      libreOffice.summary = await pdfSummary(input.libreOfficePdfPath);
    } catch (error) {
      libreOffice.status = 'failed';
      issues.push({ code: 'LIBREOFFICE_RENDER_FAILED', message: `LibreOffice PDF verification failed: ${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
    }
  } else {
    issues.push({ code: 'LIBREOFFICE_RENDERER_UNAVAILABLE', message: 'LibreOffice did not provide a PDF renderer result.', severity: 'error' });
  }

  return {
    issues,
    passed: !issues.some((issue) => issue.severity === 'error'),
    policy: 'libreoffice-only' as const,
    renderers: { libreOffice },
  };
}
