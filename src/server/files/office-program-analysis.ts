import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { resolveLibreOfficePythonExecutable } from './libreoffice';

export type OfficeProgramDiagnostic = {
  code: string;
  column?: number;
  line?: number;
  message: string;
  severity: 'error' | 'warning';
};

function lineAndColumn(sourceFile: ts.SourceFile, position: number | undefined) {
  if (position === undefined) return {};
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function javascriptDiagnostics(source: string): OfficeProgramDiagnostic[] {
  const sourceFile = ts.createSourceFile('draft.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const syntaxDiagnostics = ts.transpileModule(source, {
    compilerOptions: { allowJs: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'draft.mjs',
    reportDiagnostics: true,
  }).diagnostics || [];
  const diagnostics: OfficeProgramDiagnostic[] = syntaxDiagnostics.map((diagnostic: ts.Diagnostic) => ({
    code: `JS${diagnostic.code}`,
    ...lineAndColumn(sourceFile, diagnostic.start),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    severity: 'error',
  }));
  if (!/export\s+(?:async\s+)?function\s+createDocument\s*\(\s*job\s*\)/m.test(source)) {
    diagnostics.push({
      code: 'JAVASCRIPT_ENTRYPOINT_MISSING',
      message: 'JavaScript Office source must export function createDocument(job).',
      severity: 'error',
    });
  }
  if (/\b(?:module\.exports|exports\.)/.test(source)) {
    diagnostics.push({
      code: 'MIXED_MODULE_SYSTEM',
      message: 'JavaScript Office drafts are ESM modules; do not mix module.exports/exports with export syntax.',
      severity: 'error',
    });
  }
  if (/\brequire\s*\(/.test(source)) {
    diagnostics.push({
      code: 'COMMONJS_REQUIRE',
      message: 'JavaScript Office drafts run as ESM; use the libraries exposed on job instead of require().',
      severity: 'error',
    });
  }
  if (!/\b(?:await\s+)?(?:job\.)?writeOutput\s*\(|\.writeFile\s*\(\s*job\.outputPath\s*\)|storeAsURL\s*\(/m.test(source)) {
    diagnostics.push({
      code: 'OUTPUT_WRITE_NOT_OBSERVED',
      message: 'No definite write to job.outputPath/job.writeOutput was observed. Ensure createDocument writes the requested file.',
      severity: 'warning',
    });
  }
  return diagnostics;
}

async function pythonDiagnostics(source: string): Promise<OfficeProgramDiagnostic[]> {
  const executable = await resolveLibreOfficePythonExecutable();
  if (!executable) return [{
    code: 'PYTHON_AST_UNAVAILABLE',
    message: 'Python AST preflight is unavailable; the UNO worker will still compile and execute this source.',
    severity: 'warning',
  }];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-ast-'));
  const sourcePath = path.join(directory, 'draft.py');
  try {
    await writeFile(sourcePath, source, 'utf8');
    const script = [
      'import ast, json, pathlib, sys',
      'p = pathlib.Path(sys.argv[1])',
      'try:',
      ' tree = ast.parse(p.read_text(encoding="utf-8"), filename=str(p))',
      ' matches = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "create_document" and len(n.args.args) == 1 and n.args.args[0].arg == "job"]',
      ' print(json.dumps([] if matches else [{"code":"PYTHON_ENTRYPOINT_MISSING","message":"UNO source must define create_document(job).","severity":"error"}]))',
      'except SyntaxError as e:',
      ' print(json.dumps([{"code":"PYTHON_SYNTAX","line":e.lineno,"column":e.offset,"message":e.msg,"severity":"error"}]))',
    ].join('\n');
    const output = await new Promise<string>((resolve, reject) => {
      execFile(executable, ['-c', script, sourcePath], { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message)));
        else resolve(stdout);
      });
    });
    return JSON.parse(output.trim() || '[]') as OfficeProgramDiagnostic[];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function analyzeOfficeProgram(source: string, generator: 'javascript' | 'uno') {
  const diagnostics = generator === 'javascript'
    ? javascriptDiagnostics(source)
    : await pythonDiagnostics(source);
  return {
    diagnostics,
    passed: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
  };
}
