import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { resolveLibreOfficePythonExecutable } from './libreoffice';

export type OfficeProgramDiagnostic = {
  code: string;
  column?: number;
  elementId?: string;
  elementIds?: string[];
  line?: number;
  locator?: Record<string, unknown>;
  message: string;
  page?: number;
  severity: 'error' | 'warning';
  shapes?: number[];
  sourceExcerpt?: string;
  target?: string;
};

function diagnosticSourceExcerpt(source: string, diagnostic: OfficeProgramDiagnostic) {
  if (!diagnostic.line) return undefined;
  const sourceLines = source.replace(/\r\n?/g, '\n').split('\n');
  const focusLines = new Set<number>([diagnostic.line]);
  for (const match of diagnostic.message.matchAll(/\bline\s+(\d+)\b/gi)) {
    const line = Number(match[1]);
    if (Number.isInteger(line) && line > 0 && line <= sourceLines.length) focusLines.add(line);
  }
  const included = new Set<number>();
  for (const line of focusLines) {
    for (let current = Math.max(1, line - 2); current <= Math.min(sourceLines.length, line + 2); current += 1) {
      included.add(current);
    }
  }
  const ordered = [...included].sort((left, right) => left - right);
  const excerpt: string[] = [];
  let previous = 0;
  for (const line of ordered) {
    if (previous && line > previous + 1) excerpt.push('...');
    const marker = focusLines.has(line) ? '>' : ' ';
    const text = sourceLines[line - 1] || '';
    excerpt.push(`${marker}${String(line).padStart(4, ' ')} | ${text.slice(0, 320)}`);
    previous = line;
  }
  return excerpt.join('\n');
}

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
      'import ast, builtins, json, pathlib, sys',
      'p = pathlib.Path(sys.argv[1])',
      'diagnostics = []',
      'high_risk_properties = {"Position", "Size", "Width", "Height", "AnchorType", "Surround", "FrameStyleName", "IsAutoHeight", "RowHeight", "OptimalHeight", "ParaLineSpacing", "BreakType"}',
      'def add(code, node, message, severity="warning"):',
      ' diagnostics.append({"code":code,"line":getattr(node,"lineno",None),"column":(getattr(node,"col_offset",0)+1),"message":message,"severity":severity})',
      'def static_number(node, env):',
      ' if isinstance(node,ast.Constant) and isinstance(node.value,(int,float)) and not isinstance(node.value,bool): return node.value',
      ' if isinstance(node,ast.Name): return env.get(node.id)',
      ' if isinstance(node,ast.UnaryOp):',
      '  value = static_number(node.operand,env)',
      '  if value is None: return None',
      '  if isinstance(node.op,ast.USub): return -value',
      '  if isinstance(node.op,ast.UAdd): return value',
      ' if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in {"int","float"} and len(node.args)==1:',
      '  value = static_number(node.args[0],env)',
      '  return None if value is None else int(value) if node.func.id == "int" else float(value)',
      ' if isinstance(node,ast.BinOp):',
      '  left,right = static_number(node.left,env),static_number(node.right,env)',
      '  if isinstance(node.op,ast.Mult) and (left == 0 or right == 0): return 0',
      '  if left is None or right is None: return None',
      '  try:',
      '   if isinstance(node.op,ast.Add): return left + right',
      '   if isinstance(node.op,ast.Sub): return left - right',
      '   if isinstance(node.op,ast.Mult): return left * right',
      '   if isinstance(node.op,ast.Div): return left / right',
      '   if isinstance(node.op,ast.FloorDiv): return left // right',
      '   if isinstance(node.op,ast.Mod): return left % right',
      '  except (ArithmeticError,ValueError): return None',
      ' return None',
      'class GeometryVisitor(ast.NodeVisitor):',
      ' def __init__(self): self.env={}; self.seen=set()',
      ' def visit_Call(self,node):',
      '  name = node.func.attr if isinstance(node.func,ast.Attribute) else ""',
      '  geometry_start = 2 if name == "add_shape" else 3 if name in {"add_text","add_image"} else None',
      '  if geometry_start is not None and len(node.args) >= geometry_start + 4:',
      '   for label,offset,invalid in (("x",0,lambda value:value<0),("y",1,lambda value:value<0),("width",2,lambda value:value<=0),("height",3,lambda value:value<=0)):',
      '    index = geometry_start + offset',
      '    value = static_number(node.args[index],self.env)',
      '    key = (getattr(node,"lineno",None),label)',
      '    if value is not None and invalid(value) and key not in self.seen:',
      '     self.seen.add(key)',
      '     add("PRESENTATION_GEOMETRY_INVALID",node,f"Presentation {name} has a statically invalid {label}={value}; positions must be non-negative and sizes must be positive for every loop iteration.","error")',
      '  self.generic_visit(node)',
      ' def visit_For(self,node):',
      '  if isinstance(node.target,ast.Name) and isinstance(node.iter,ast.Call) and isinstance(node.iter.func,ast.Name) and node.iter.func.id == "range":',
      '   args = [static_number(arg,self.env) for arg in node.iter.args]',
      '   if 1 <= len(args) <= 3 and all(value is not None and int(value) == value for value in args):',
      '    previous = self.env.get(node.target.id); existed = node.target.id in self.env',
      '    try:',
      '     for iteration,value in enumerate(range(*[int(value) for value in args])):',
      '      if iteration >= 256: break',
      '      self.env[node.target.id] = value',
      '      for statement in node.body: self.visit(statement)',
      '    except ValueError: pass',
      '    if existed: self.env[node.target.id] = previous',
      '    else: self.env.pop(node.target.id,None)',
      '    for statement in node.orelse: self.visit(statement)',
      '    return',
      '  self.generic_visit(node)',
      'class Visitor(ast.NodeVisitor):',
      ' def __init__(self): self.expert_calls=0; self.tags=0; self.function_depth=0; self.element_ids={}',
      ' def visit_FunctionDef(self,node):',
      '  self.function_depth += 1',
      '  self.generic_visit(node)',
      '  self.function_depth -= 1',
      ' visit_AsyncFunctionDef = visit_FunctionDef',
      ' def visit_Call(self,node):',
      '  name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ""',
      '  if name == "create_document" and self.function_depth == 0: add("DRAFT_ENTRYPOINT_CALLED_DIRECTLY",node,"Do not call create_document yourself. The LibreOffice worker invokes create_document(job) with the real job object.","error")',
      '  if name in {"writer","presentation","spreadsheet","set_page","add_slide","add_text","add_shape","add_image","add_paragraph","add_heading","add_table","add_inline_image","add_page_break"} and node.args and isinstance(node.args[0],ast.Constant) and isinstance(node.args[0].value,str):',
      '   element_id=node.args[0].value',
      '   if element_id in self.element_ids: add("DUPLICATE_ELEMENT_ID",node,f"Duplicate literal elementId {element_id!r}; first declared on line {self.element_ids[element_id]}. Element IDs must be unique.","error")',
      '   else: self.element_ids[element_id]=node.lineno',
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
      ' GeometryVisitor().visit(tree)',
      ' defined = set(dir(builtins)) | {"uno", "__name__", "__file__", "__webpilot_static_diagnostics__"}',
      ' for node in ast.walk(tree):',
      '  if isinstance(node,ast.Name) and isinstance(node.ctx,(ast.Store,ast.Param)): defined.add(node.id)',
      '  elif isinstance(node,ast.arg): defined.add(node.arg)',
      '  elif isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)): defined.add(node.name)',
      '  elif isinstance(node,ast.alias): defined.add(node.asname or node.name.split(".")[0])',
      '  elif isinstance(node,ast.ExceptHandler) and isinstance(node.name,str): defined.add(node.name)',
      ' undefined = set()',
      ' for node in ast.walk(tree):',
      '  if isinstance(node,ast.Name) and isinstance(node.ctx,ast.Load) and node.id not in defined and node.id not in undefined:',
      '   undefined.add(node.id)',
      '   add("PYTHON_UNDEFINED_NAME",node,f"Python name {node.id!r} is referenced but never defined in this draft.","error")',
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
  const rawDiagnostics = generator === 'javascript'
    ? javascriptDiagnostics(source)
    : await pythonDiagnostics(source);
  const diagnostics = rawDiagnostics.map((diagnostic) => {
    const sourceExcerpt = diagnosticSourceExcerpt(source, diagnostic);
    return sourceExcerpt ? { ...diagnostic, sourceExcerpt } : diagnostic;
  });
  return {
    diagnostics,
    passed: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
  };
}

export function diagnoseOfficeProgramRuntimeError(source: string, errorText: string): OfficeProgramDiagnostic[] {
  const structuredLayout = errorText.match(/__WEBPILOT_LAYOUT_DIAGNOSTICS__(\[[^\r\n]*\])/)?.[1];
  if (structuredLayout) {
    try {
      const parsed = JSON.parse(structuredLayout) as OfficeProgramDiagnostic[];
      if (Array.isArray(parsed) && parsed.length) {
        const grouped = new Map<string, OfficeProgramDiagnostic>();
        for (const diagnostic of parsed) {
          const key = JSON.stringify([diagnostic.code, diagnostic.line, diagnostic.column]);
          const existing = grouped.get(key);
          if (!existing) {
            grouped.set(key, {
              ...diagnostic,
              ...(diagnostic.elementId ? { elementIds: [diagnostic.elementId] } : {}),
            });
            continue;
          }
          const elementIds = new Set([...(existing.elementIds || []), ...(diagnostic.elementId ? [diagnostic.elementId] : [])]);
          existing.elementIds = [...elementIds];
          existing.elementId = existing.elementIds.length === 1 ? existing.elementIds[0] : undefined;
        }
        return [...grouped.values()].map((diagnostic) => {
          const affected = diagnostic.elementIds?.length
            ? ` Affected runtime elements (${diagnostic.elementIds.length}): ${diagnostic.elementIds.slice(0, 20).join(', ')}.`
            : '';
          const withAffected = affected ? { ...diagnostic, message: `${diagnostic.message}${affected}` } : diagnostic;
          const sourceExcerpt = diagnosticSourceExcerpt(source, withAffected);
          return { ...withAffected, ...(sourceExcerpt ? { sourceExcerpt } : {}) };
        });
      }
    } catch {
      // Fall through to the generic traceback mapper.
    }
  }
  const sourceLines = source.replace(/\r\n?/g, '\n').split('\n');
  const frames = [...errorText.matchAll(/File ["']([^"']+\.py)["'], line (\d+)/g)]
    .map((match) => ({ file: match[1], line: Number(match[2]) }))
    .filter((frame) => /(?:document-drafts|\.candidate-)/i.test(frame.file)
      && Number.isInteger(frame.line) && frame.line > 0 && frame.line <= sourceLines.length);
  const line = frames.at(-1)?.line;
  let code = 'UNO_RUNTIME_ERROR';
  if (/NameError:\s*name ['"][^'"]+['"] is not defined/i.test(errorText)) code = 'PYTHON_UNDEFINED_NAME';
  else if (/Presentation geometry (?:requires non-negative position and positive size|exceeds slide bounds)/i.test(errorText)) code = 'PRESENTATION_GEOMETRY_INVALID';
  else if (/Presentation text cannot fit without becoming unreadable/i.test(errorText)) code = 'PRESENTATION_TEXT_OVERFLOW';
  else if (/Duplicate elementId/i.test(errorText)) code = 'DUPLICATE_ELEMENT_ID';
  else if (/create_document\(None\)|NoneType.*presentation/i.test(errorText)) code = 'DRAFT_ENTRYPOINT_CALLED_DIRECTLY';
  const elementId = errorText.match(/elementId=['"]([^'"]+)['"]/i)?.[1];
  const diagnostic: OfficeProgramDiagnostic = {
    code,
    ...(line ? { line, column: 1 } : {}),
    ...(elementId ? { elementId } : {}),
    message: errorText.trim(),
    severity: 'error',
  };
  const sourceExcerpt = diagnosticSourceExcerpt(source, diagnostic);
  return [{ ...diagnostic, ...(sourceExcerpt ? { sourceExcerpt } : {}) }];
}
