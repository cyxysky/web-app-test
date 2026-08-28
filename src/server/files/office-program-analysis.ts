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
      'diagnostics = []',
      'high_risk_properties = {"Position", "Size", "Width", "Height", "AnchorType", "Surround", "FrameStyleName", "IsAutoHeight", "RowHeight", "OptimalHeight", "ParaLineSpacing", "BreakType"}',
      'element_methods = {"add_paragraph", "add_heading", "add_bullets", "add_table", "add_inline_image", "add_page_break", "add_slide", "add_text", "add_shape", "add_image", "add_worksheet", "set_cell", "set_range"}',
      'def add(code, node, message, severity="warning"):',
      ' diagnostics.append({"code":code,"line":getattr(node,"lineno",None),"column":(getattr(node,"col_offset",0)+1),"message":message,"severity":severity})',
      'class Visitor(ast.NodeVisitor):',
      ' def __init__(self): self.expert_calls=0; self.tags=0',
      ' def visit_Call(self,node):',
      '  name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ""',
      '  if name in element_methods:',
      '   first = node.args[0] if node.args else next((x.value for x in node.keywords if x.arg=="element_id"), None)',
      '   if not isinstance(first, ast.Constant) or not isinstance(first.value, str): add("ELEMENT_ID_REQUIRED",node,f"{name} requires a stable string element_id.","error")',
      '  if name == "expert":',
      '   self.expert_calls += 1',
      '   reason = node.args[0] if node.args else None',
      '   if not isinstance(reason,ast.Constant) or not isinstance(reason.value,str) or len(reason.value.strip()) < 8: add("EXPERT_REASON_REQUIRED",node,"job.expert(reason) requires a concrete string reason of at least 8 characters.","error")',
      '   else: add("EXPERT_MODE_USED",node,f"Expert mode declared: {reason.value.strip()}")',
      '  if name == "tag": self.tags += 1',
      '  if name in {"eval","exec","compile","__import__"}: add("UNSAFE_DYNAMIC_EXECUTION",node,f"{name} is forbidden in an Office draft.","error")',
      '  if name == "setattr": add("DYNAMIC_UNO_PROPERTY",node,"Dynamic setattr prevents reliable layout analysis; use an explicit property assignment.")',
      '  if name == "createInstance": add("RAW_UNO_SERVICE",node,"Raw UNO service creation is high risk; declare expert mode and tag the created object.")',
      '  self.generic_visit(node)',
      ' def visit_Attribute(self,node):',
      '  if node.attr == "raw": add("RAW_ACCESS_REQUIRES_EXPERT_MODE",node,"Direct .raw access is not available; use job.expert(reason).","error")',
      '  self.generic_visit(node)',
      ' def visit_Assign(self,node):',
      '  for target in node.targets:',
      '   if isinstance(target,ast.Attribute) and target.attr in high_risk_properties: add("HIGH_RISK_LAYOUT_PROPERTY",target,f"Direct assignment to {target.attr} can cause clipping or overlap; confirm geometry and tag the element.")',
      '  self.generic_visit(node)',
      ' def visit_AnnAssign(self,node):',
      '  if isinstance(node.target,ast.Attribute) and node.target.attr in high_risk_properties: add("HIGH_RISK_LAYOUT_PROPERTY",node.target,f"Direct assignment to {node.target.attr} can cause clipping or overlap; confirm geometry and tag the element.")',
      '  self.generic_visit(node)',
      'try:',
      ' tree = ast.parse(p.read_text(encoding="utf-8"), filename=str(p))',
      ' matches = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "create_document" and len(n.args.args) == 1 and n.args.args[0].arg == "job"]',
      ' if len(matches) != 1 or isinstance(matches[0],ast.AsyncFunctionDef): diagnostics.append({"code":"PYTHON_ENTRYPOINT_MISSING","message":"UNO source must define exactly one synchronous create_document(job).","severity":"error"})',
      ' visitor=Visitor(); visitor.visit(tree)',
      ' if visitor.expert_calls and not visitor.tags: diagnostics.append({"code":"EXPERT_ELEMENTS_NOT_TAGGED","message":"Expert mode is used, but no expert.tag(...) call was found.","severity":"error"})',
      ' print(json.dumps(diagnostics))',
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
