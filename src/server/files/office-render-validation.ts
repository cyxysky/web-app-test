import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import type { OfficeArtifactIssue } from './office-artifact-validator';

export type OfficeRendererResult = {
  available: boolean;
  outputPath?: string;
  renderer: 'libreoffice' | 'microsoft-office';
  status: 'failed' | 'passed' | 'skipped' | 'unavailable';
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

function runMicrosoftOfficeExport(inputPath: string, outputPath: string, extension: string) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const payload = Buffer.from(JSON.stringify({ inputPath, outputPath, extension }), 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$configJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
$config = $configJson | ConvertFrom-Json
$inputPath = [string]$config.inputPath
$outputPath = [string]$config.outputPath
$extension = ([string]$config.extension).ToLowerInvariant()
$app = $null
$document = $null
try {
  if ($extension -in @('.doc', '.docx', '.odt')) {
    if (-not [type]::GetTypeFromProgID('Word.Application')) { Write-Output '{"available":false}'; exit 0 }
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false
    $app.DisplayAlerts = 0
    try { $app.AutomationSecurity = 3 } catch {}
    $document = $app.Documents.Open($inputPath, $false, $true)
    $document.ExportAsFixedFormat($outputPath, 17)
  } elseif ($extension -in @('.ppt', '.pptx', '.odp')) {
    if (-not [type]::GetTypeFromProgID('PowerPoint.Application')) { Write-Output '{"available":false}'; exit 0 }
    $app = New-Object -ComObject PowerPoint.Application
    $document = $app.Presentations.Open($inputPath, $true, $true, $false)
    $document.SaveAs($outputPath, 32)
  } elseif ($extension -in @('.xls', '.xlsx', '.ods')) {
    if (-not [type]::GetTypeFromProgID('Excel.Application')) { Write-Output '{"available":false}'; exit 0 }
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false
    $app.DisplayAlerts = $false
    try { $app.AutomationSecurity = 3 } catch {}
    $document = $app.Workbooks.Open($inputPath, 0, $true)
    $document.ExportAsFixedFormat(0, $outputPath)
  } else {
    throw "Unsupported Microsoft Office extension: $extension"
  }
  Write-Output '{"available":true}'
} finally {
  if ($document -ne $null) { try { $document.Close($false) } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
  if ($app -ne $null) { try { $app.Quit() } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise<{ available: boolean }>((resolve, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
      timeout: 180_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
      else {
        try { resolve(JSON.parse(String(stdout).trim())); }
        catch { reject(new Error(`Microsoft Office renderer returned unreadable diagnostics: ${String(stdout).trim()}`)); }
      }
    });
  });
}

export async function validateOfficeRendererMatrix(input: {
  absolutePath: string;
  extension: string;
  libreOfficePdfPath?: string;
  microsoftPdfPath: string;
}) {
  const issues: OfficeArtifactIssue[] = [];
  const extension = input.extension.toLowerCase();
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

  const policy = String(process.env.MICROSOFT_OFFICE_VALIDATION || 'required').trim().toLowerCase();
  let microsoftOffice: OfficeRendererResult = { available: false, renderer: 'microsoft-office', status: 'skipped' };
  if (extension === '.pdf') {
    microsoftOffice.warning = 'A final PDF is renderer-independent; Microsoft Office rendering is not applicable.';
  } else if (policy === 'disabled') {
    microsoftOffice.warning = 'Microsoft Office validation is disabled by configuration.';
  } else if (process.platform !== 'win32') {
    microsoftOffice.status = 'unavailable';
    microsoftOffice.warning = 'Microsoft Office COM rendering is available only on Windows.';
  } else {
    try {
      await unlink(input.microsoftPdfPath).catch(() => undefined);
      const result = await runMicrosoftOfficeExport(input.absolutePath, input.microsoftPdfPath, extension);
      microsoftOffice.available = result.available;
      microsoftOffice.status = result.available ? 'passed' : 'unavailable';
      if (result.available) {
        microsoftOffice.outputPath = input.microsoftPdfPath;
        microsoftOffice.summary = await pdfSummary(input.microsoftPdfPath);
      } else {
        microsoftOffice.warning = 'The corresponding Microsoft Office desktop application is not installed or its COM registration is unavailable.';
      }
    } catch (error) {
      microsoftOffice.status = 'failed';
      microsoftOffice.warning = error instanceof Error ? error.message : String(error);
      issues.push({ code: 'MICROSOFT_OFFICE_RENDER_FAILED', message: `Microsoft Office could not render the generated file: ${microsoftOffice.warning}`, severity: 'error' });
    }
  }
  if (microsoftOffice.status === 'unavailable') {
    issues.push({
      code: 'MICROSOFT_OFFICE_RENDERER_UNAVAILABLE',
      message: microsoftOffice.warning || 'Microsoft Office rendering is unavailable.',
      severity: policy === 'required' ? 'error' : 'warning',
    });
  }
  if (libreOffice.summary && microsoftOffice.summary) {
    if (libreOffice.summary.pages !== microsoftOffice.summary.pages) {
      issues.push({
        code: 'CROSS_RENDERER_PAGE_COUNT_MISMATCH',
        message: `LibreOffice rendered ${libreOffice.summary.pages} page(s), while Microsoft Office rendered ${microsoftOffice.summary.pages}.`,
        severity: 'error',
      });
    }
    const larger = Math.max(1, libreOffice.summary.textCharacters, microsoftOffice.summary.textCharacters);
    const ratio = Math.min(libreOffice.summary.textCharacters, microsoftOffice.summary.textCharacters) / larger;
    if (ratio < 0.6) issues.push({
      code: 'CROSS_RENDERER_TEXT_MISMATCH',
      message: `Cross-renderer extracted text differs substantially (${Math.round(ratio * 100)}% character-count agreement).`,
      severity: 'error',
    });
  }
  return {
    issues,
    passed: !issues.some((issue) => issue.severity === 'error'),
    policy,
    renderers: { libreOffice, microsoftOffice },
  };
}
