import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';

export type OfficeArtifactIssue = {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  target?: string;
};

function normalizedFontName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
}

const FONT_FILE_ALIASES: Record<string, string[]> = {
  arial: ['Arial'],
  calibri: ['Calibri'],
  deng: ['DengXian'],
  msyh: ['Microsoft YaHei'],
  msyhbd: ['Microsoft YaHei'],
  simfang: ['FangSong'],
  simhei: ['SimHei'],
  simkai: ['KaiTi'],
  simsun: ['SimSun'],
};

async function installedFontNames() {
  const roots = process.platform === 'win32'
    ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')]
    : ['/usr/share/fonts', '/usr/local/share/fonts'];
  const names = new Set<string>();
  for (const root of roots) {
    try {
      for (const entry of await readdir(root, { recursive: true })) {
        const extension = path.extname(String(entry)).toLowerCase();
        if (!['.ttf', '.ttc', '.otf'].includes(extension)) continue;
        const baseName = normalizedFontName(path.basename(String(entry), extension));
        names.add(baseName);
        for (const alias of FONT_FILE_ALIASES[baseName] || []) names.add(normalizedFontName(alias));
      }
    } catch {
      // Font inventory is advisory; file validation must remain available.
    }
  }
  return names;
}

function expectedPackageEntry(extension: string) {
  if (extension === '.pptx') return 'ppt/presentation.xml';
  if (extension === '.docx') return 'word/document.xml';
  if (extension === '.xlsx') return 'xl/workbook.xml';
  if (['.odp', '.ods', '.odt'].includes(extension)) return 'content.xml';
  return undefined;
}

function mediaPrefix(extension: string) {
  if (extension === '.pptx') return 'ppt/media/';
  if (extension === '.docx') return 'word/media/';
  if (extension === '.xlsx') return 'xl/media/';
  if (['.odp', '.ods', '.odt'].includes(extension)) return 'Pictures/';
  return undefined;
}

export async function validateOfficeArtifact(input: {
  absolutePath: string;
  extension: string;
}) {
  const issues: OfficeArtifactIssue[] = [];
  const extension = input.extension.toLowerCase();
  if (!['.pptx', '.docx', '.xlsx', '.odp', '.ods', '.odt'].includes(extension)) {
    return { issues, passed: true, requestedFonts: [], missingFonts: [], media: [], platform: process.platform };
  }
  const zip = await JSZip.loadAsync(await readFile(input.absolutePath));
  const expectedEntry = expectedPackageEntry(extension)!;
  if (!zip.file(expectedEntry)) {
    issues.push({ code: 'OFFICE_PACKAGE_ENTRY_MISSING', message: `Required package entry ${expectedEntry} is missing.`, severity: 'error' });
  }
  const xmlEntries = Object.values(zip.files).filter((entry) => !entry.dir && /\.xml$/i.test(entry.name));
  const requestedFonts = new Set<string>();
  for (const entry of xmlEntries) {
    const xml = await entry.async('string');
    for (const match of xml.matchAll(/(?:typeface|ascii|hAnsi|eastAsia|font-name|font-family)="([^"]+)"/gi)) {
      const name = match[1].trim();
      if (name && !name.startsWith('+')) requestedFonts.add(name);
    }
  }
  const installed = await installedFontNames();
  const missingFonts = [...requestedFonts].filter((font) => {
    const normalized = normalizedFontName(font);
    return normalized && ![...installed].some((candidate) => candidate.includes(normalized) || normalized.includes(candidate));
  });
  for (const font of missingFonts) {
    issues.push({ code: 'FONT_NOT_FOUND', message: `Requested font "${font}" was not matched in the ${process.platform} font inventory; verify LibreOffice substitution.`, severity: 'warning', target: font });
  }
  const prefix = mediaPrefix(extension)!;
  const media: Array<{ name: string; width?: number; height?: number; format?: string }> = [];
  for (const entry of Object.values(zip.files).filter((item) => !item.dir && item.name.startsWith(prefix))) {
    try {
      const metadata = await sharp(await entry.async('nodebuffer'), { failOn: 'none' }).metadata();
      media.push({ name: entry.name, width: metadata.width, height: metadata.height, format: metadata.format });
      if (metadata.width && metadata.height && metadata.width * metadata.height > 40_000_000) {
        issues.push({ code: 'OVERSIZED_EMBEDDED_IMAGE', message: `${entry.name} contains ${metadata.width}x${metadata.height} pixels and may unnecessarily increase file size.`, severity: 'warning', target: entry.name });
      }
    } catch {
      issues.push({ code: 'UNREADABLE_EMBEDDED_IMAGE', message: `Embedded image ${entry.name} could not be decoded.`, severity: 'warning', target: entry.name });
    }
  }
  return {
    issues,
    passed: !issues.some((issue) => issue.severity === 'error'),
    requestedFonts: [...requestedFonts],
    missingFonts,
    media,
    platform: process.platform,
  };
}

export async function inspectRenderedPage(imagePath: string) {
  const image = sharp(imagePath, { failOn: 'none' });
  const [metadata, stats] = await Promise.all([image.metadata(), image.stats()]);
  const channels = stats.channels.slice(0, 3);
  const dynamicRange = channels.length
    ? Math.max(...channels.map((channel) => channel.max)) - Math.min(...channels.map((channel) => channel.min))
    : 0;
  const issues: OfficeArtifactIssue[] = [];
  if (!metadata.width || !metadata.height) {
    issues.push({ code: 'PAGE_IMAGE_EMPTY', message: 'Rendered page has no measurable dimensions.', severity: 'error' });
  } else if (stats.isOpaque && dynamicRange < 4) {
    issues.push({ code: 'PAGE_APPEARS_BLANK', message: 'Rendered page is nearly uniform and may be blank.', severity: 'warning' });
  }
  return { width: metadata.width, height: metadata.height, issues };
}
