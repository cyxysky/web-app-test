import { createHash } from 'node:crypto';
import { access, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import PptxGenJS from 'pptxgenjs';
import * as docx from 'docx';
import ExcelJS from 'exceljs';

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const programPath = path.resolve(value('--program') || '');
const outputPath = path.resolve(value('--output') || '');
const assetsPath = path.resolve(value('--assets') || '.');
const expectedDigest = value('--expected-source-digest');

function assetPath(name) {
  const candidate = path.resolve(assetsPath, String(name || ''));
  const relative = path.relative(assetsPath, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Asset paths must stay within the conversation asset workspace.');
  }
  return access(candidate).then(() => candidate);
}

async function main() {
  const source = await (await import('node:fs/promises')).readFile(programPath, 'utf8');
  const digest = createHash('sha256').update(source, 'utf8').digest('hex');
  if (expectedDigest && digest !== expectedDigest) throw new Error('JavaScript draft changed after validation.');
  const moduleUrl = `${pathToFileURL(programPath).href}?digest=${digest}`;
  const draft = await import(moduleUrl);
  if (typeof draft.createDocument !== 'function') {
    throw new Error('JavaScript Office draft must export createDocument(job).');
  }
  const assets = await readdir(assetsPath, { withFileTypes: true }).catch(() => []);
  const job = Object.freeze({
    outputPath,
    outputUrl: pathToFileURL(outputPath).href,
    assetsPath,
    assetPath,
    listAssets: async () => Promise.all(assets.filter((item) => item.isFile() && !item.name.startsWith('.')).map(async (item) => ({
      name: item.name,
      bytes: (await stat(path.join(assetsPath, item.name))).size,
    }))),
    writeOutput: async (bytes) => writeFile(outputPath, bytes),
    PptxGenJS,
    docx,
    ExcelJS,
  });
  await draft.createDocument(job);
  const output = await stat(outputPath);
  if (!output.isFile() || output.size < 64) throw new Error('createDocument(job) did not create the requested Office file.');
  process.stdout.write(JSON.stringify({ bytes: output.size, renderer: 'javascript-office', sourceDigest: digest }));
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
