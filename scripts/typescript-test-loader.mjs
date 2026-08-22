import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function typescriptCandidate(filePath) {
  if (path.extname(filePath)) return existsSync(filePath) ? filePath : undefined;
  for (const extension of ['.ts', '.tsx']) {
    const candidate = `${filePath}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('next/') && !specifier.endsWith('.js')) return nextResolve(`${specifier}.js`, context);
  if (specifier.startsWith('@/')) {
    const candidate = typescriptCandidate(path.join(projectRoot, 'src', specifier.slice(2)));
    if (candidate) return { shortCircuit: true, url: pathToFileURL(candidate).href };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const candidate = typescriptCandidate(path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier));
    if (candidate) return { shortCircuit: true, url: pathToFileURL(candidate).href };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: fileURLToPath(url),
    }).outputText;
    return { format: 'module', shortCircuit: true, source: output };
  }
  return nextLoad(url, context);
}
