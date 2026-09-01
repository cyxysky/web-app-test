import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { resolveLibreOfficePythonExecutable } from './libreoffice';
import { resolveUnoProgramWorker } from './uno-program';

export type OfficeProgramDiagnostic = {
  callColumn?: number;
  callLine?: number;
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

function diagnosticSourceExcerpt(
  source: string,
  diagnostic: OfficeProgramDiagnostic,
  additionalFocusLines: number[] = [],
) {
  if (!diagnostic.line) return undefined;
  const sourceLines = source.replace(/\r\n?/g, '\n').split('\n');
  const focusLines = new Set<number>([diagnostic.line, diagnostic.callLine, ...additionalFocusLines]
    .filter((line): line is number => typeof line === 'number'
      && Number.isInteger(line) && line > 0 && line <= sourceLines.length));
  // Python syntax messages may explicitly identify the matching opening line.
  // Runtime tracebacks are handled separately so worker line numbers are never
  // mistaken for candidate-draft lines.
  if (diagnostic.code === 'PYTHON_SYNTAX') {
    for (const match of diagnostic.message.matchAll(/\bline\s+(\d+)\b/gi)) {
      const line = Number(match[1]);
      if (Number.isInteger(line) && line > 0 && line <= sourceLines.length) focusLines.add(line);
    }
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

function draftTracebackLineNumbers(errorText: string, sourceLineCount: number) {
  return [...errorText.matchAll(/File ["']([^"']+\.py)["'], line (\d+)/g)]
    .map((match) => ({ file: match[1], line: Number(match[2]) }))
    .filter((frame) => /(?:document-drafts|\.candidate-)/i.test(frame.file)
      && Number.isInteger(frame.line) && frame.line > 0 && frame.line <= sourceLineCount)
    .map((frame) => frame.line);
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
  const workerPath = await resolveUnoProgramWorker();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-ast-'));
  const sourcePath = path.join(directory, 'draft.py');
  const analysisPath = path.join(directory, 'analyze.py');
  try {
    await writeFile(sourcePath, source, 'utf8');
    const script = [
      'import ast, builtins, io, json, math, pathlib, sys, tokenize, unicodedata',
      'p = pathlib.Path(sys.argv[1])',
      'diagnostics = []',
      'high_risk_properties = {"Position", "Size", "Width", "Height", "AnchorType", "Surround", "FrameStyleName", "IsAutoHeight", "RowHeight", "OptimalHeight", "ParaLineSpacing", "BreakType"}',
      'facade_methods = {"feature","slide","sheet","slot","set_page","add_slide","bounds","content_box","grid","stack","mm","cm","inch","pt","text_height","estimate_text_box","add_text","add_link","add_text_box","add_card","add_header","add_footer","add_shape","connect","add_connector","add_image","add_image_contain","add_table","add_native_table","add_chart","add_bar_chart","add_line_chart","add_donut_chart","add_timeline","set_transition","add_paragraph","add_title","add_heading","add_bullets","add_numbered_list","add_inline_image","add_page_break","add_worksheet","set_cell","set_range","format","merge","freeze","column_width","row_height"}',
      'element_methods = {"slide","sheet","add_slide","add_text","add_link","add_text_box","add_card","add_header","add_footer","add_shape","connect","add_connector","add_image","add_image_contain","add_table","add_native_table","add_chart","add_bar_chart","add_line_chart","add_donut_chart","add_timeline","add_paragraph","add_title","add_heading","add_bullets","add_numbered_list","add_inline_image","add_page_break","add_worksheet","set_cell","set_range","format","merge","freeze","column_width","row_height"}',
      'def add(code, node, message, severity="warning"):',
      ' diagnostics.append({"code":code,"line":getattr(node,"lineno",None),"column":(getattr(node,"col_offset",0)+1),"message":message,"severity":severity})',
      'def callable_name(node):',
      ' return node.func.attr if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) else node.func.id if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) else ""',
      'def function_parameters(node):',
      ' return [arg.arg for arg in [*node.args.posonlyargs,*node.args.args]]',
      'def call_argument(node, function, parameter):',
      ' params = function_parameters(function)',
      ' if parameter in params:',
      '  index = params.index(parameter)',
      '  if index < len(node.args) and not isinstance(node.args[index],ast.Starred): return node.args[index]',
      ' for keyword in node.keywords:',
      '  if keyword.arg == parameter: return keyword.value',
      ' defaults = dict(zip(params[len(params)-len(function.args.defaults):],function.args.defaults)) if function.args.defaults else {}',
      ' if parameter in defaults: return defaults[parameter]',
      ' return None',
      'def call_value(node, position, keyword, default=None):',
      ' if position < len(node.args) and not isinstance(node.args[position],ast.Starred): return node.args[position]',
      ' for item in node.keywords:',
      '  if item.arg == keyword: return item.value',
      ' return default',
      'def static_text(node):',
      ' return node.value if isinstance(node,ast.Constant) and isinstance(node.value,str) else None',
      'def text_units(value):',
      ' lines=[]',
      ' for line in str(value or "").replace("\\r\\n","\\n").replace("\\r","\\n").split("\\n"):',
      '  units=0.0',
      '  for character in line:',
      '   if character == "\\t": units += 2.0',
      '   elif character.isspace(): units += 0.33',
      '   elif unicodedata.east_asian_width(character) in {"W","F"}: units += 1.0',
      '   elif unicodedata.category(character).startswith("P"): units += 0.48',
      '   elif character.isupper() or character.isdigit(): units += 0.62',
      '   else: units += 0.55',
      '  lines.append(units)',
      ' return lines or [0.0]',
      'def signature_issue(function, call, skip_first=False):',
      ' params = function_parameters(function)',
      ' if skip_first and params: params = params[1:]',
      ' positional = [arg for arg in call.args if not isinstance(arg,ast.Starred)]',
      ' if len(positional) != len(call.args): return None',
      ' keyword_names = [keyword.arg for keyword in call.keywords if keyword.arg is not None]',
      ' if any(keyword.arg is None for keyword in call.keywords): return None',
      ' if function.args.vararg is None and len(positional) > len(params): return f"accepts at most {len(params)} positional arguments but receives {len(positional)}"',
      ' unexpected = [name for name in keyword_names if name not in params and name not in [arg.arg for arg in function.args.kwonlyargs]]',
      ' if unexpected and function.args.kwarg is None: return f"does not accept keyword {unexpected[0]!r}"',
      ' duplicate = [params[index] for index in range(min(len(positional),len(params))) if params[index] in keyword_names]',
      ' if duplicate: return f"receives multiple values for {duplicate[0]!r}"',
      ' required_count = len(params) - len(function.args.defaults)',
      ' supplied = set(params[:len(positional)]) | set(keyword_names)',
      ' missing = [name for name in params[:required_count] if name not in supplied]',
      ' required_kw = [arg.arg for arg,default in zip(function.args.kwonlyargs,function.args.kw_defaults) if default is None]',
      ' missing.extend(name for name in required_kw if name not in keyword_names)',
      ' return f"is missing required argument {missing[0]!r}" if missing else None',
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
      ' if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr in {"mm","cm","inch","pt"} and len(node.args)==1:',
      '  value = static_number(node.args[0],env)',
      '  factors = {"mm":100.0,"cm":1000.0,"inch":2540.0,"pt":2540.0/72.0}',
      '  return None if value is None else round(value*factors[node.func.attr])',
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
      ' def __init__(self, wrappers): self.env={}; self.seen=set(); self.wrappers=wrappers',
      ' def visit_Assign(self,node):',
      '  value=static_number(node.value,self.env)',
      '  for target in node.targets:',
      '   if isinstance(target,ast.Name):',
      '    if value is None: self.env.pop(target.id,None)',
      '    else: self.env[target.id]=value',
      '  self.generic_visit(node)',
      ' def visit_Call(self,node):',
      '  name = callable_name(node)',
      '  geometry_start = 2 if name == "add_shape" else 3 if name in {"add_text","add_image"} else None',
      '  geometry = []',
      '  if geometry_start is not None and len(node.args) >= geometry_start + 4:',
      '   geometry = [("x",node.args[geometry_start]),("y",node.args[geometry_start+1]),("width",node.args[geometry_start+2]),("height",node.args[geometry_start+3])]',
      '  elif isinstance(node.func,ast.Name) and name in self.wrappers:',
      '   function,mapping = self.wrappers[name]',
      '   geometry = [(label,call_argument(node,function,parameter)) for label,parameter in mapping]',
      '  for label,value_node in geometry:',
      '    invalid = (lambda value:value<0) if label in {"x","y"} else (lambda value:value<=0)',
      '    value = static_number(value_node,self.env) if value_node is not None else None',
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
      'class TextBoxVisitor(ast.NodeVisitor):',
      ' def __init__(self, wrappers): self.env={}; self.seen=set(); self.wrappers=wrappers',
      ' def visit_Assign(self,node):',
      '  value=static_number(node.value,self.env)',
      '  for target in node.targets:',
      '   if isinstance(target,ast.Name):',
      '    if value is None: self.env.pop(target.id,None)',
      '    else: self.env[target.id]=value',
      '  self.generic_visit(node)',
      ' def wrapper_value(self,node,function,mapping,label):',
      '  mode,value = mapping.get(label,(None,None))',
      '  return call_argument(node,function,value) if mode == "param" else value if mode == "fixed" else None',
      ' def visit_Call(self,node):',
      '  name = callable_name(node)',
      '  values = None',
      '  if name == "add_text":',
      '   values = {',
      '    "text":call_value(node,2,"text"), "width":call_value(node,5,"width"), "height":call_value(node,6,"height"),',
      '    "font_size":call_value(node,7,"font_size",ast.Constant(value=18)),',
      '    "min_font_size":call_value(node,99,"min_font_size",ast.Constant(value=8)),',
      '    "padding":call_value(node,99,"padding",ast.Constant(value=0)),',
      '   }',
      '  elif isinstance(node.func,ast.Name) and name in self.wrappers:',
      '   function,mapping = self.wrappers[name]',
      '   values = {label:self.wrapper_value(node,function,mapping,label) for label in ("text","width","height","font_size","min_font_size","padding")}',
      '  if values:',
      '   height = static_number(values["height"],self.env) if values["height"] is not None else None',
      '   width = static_number(values["width"],self.env) if values["width"] is not None else None',
      '   font_size = static_number(values["font_size"],self.env) if values["font_size"] is not None else 18',
      '   min_font_size = static_number(values["min_font_size"],self.env) if values["min_font_size"] is not None else 8',
      '   padding = static_number(values["padding"],self.env) if values["padding"] is not None else 0',
      '   if height is not None and min_font_size is not None:',
      '    padding = max(0,float(padding or 0)); minimum = max(1.0,float(min_font_size)); lines = 1',
      '    text = static_text(values["text"])',
      '    if text is not None and width is not None:',
      '     usable=max(1.0,float(width)-2.0*padding); capacity=max(0.5,usable/(minimum*(2540.0/72.0)))',
      '     lines=max(1,sum(max(1,int(math.ceil(units/capacity))) for units in text_units(text)))',
      '    required=int(math.ceil(minimum*(2540.0/72.0)*(1.05+max(0,lines-1)*1.15)+2.0*padding))',
      '    key=(getattr(node,"lineno",None),required)',
      '    if float(height)+25 < required and key not in self.seen:',
      '     self.seen.add(key)',
      '     requested = static_number(values["font_size"],self.env) if values["font_size"] is not None else font_size',
      '     add("PRESENTATION_TEXT_BOX_TOO_SHORT",node,f"Presentation {name} height={height:g} (1/100 mm) cannot hold {lines} line(s) at min_font_size={minimum:g}pt; estimated minimum height is {required}. Geometry and CharHeight use different units. Use deck.text_height(), deck.estimate_text_box(), or a high-level card/footer component instead of a hand-sized text box (requestedFontSize={requested or font_size}pt).","error")',
      '  self.generic_visit(node)',
      ' def visit_For(self,node):',
      '  if isinstance(node.target,ast.Name) and isinstance(node.iter,ast.Call) and isinstance(node.iter.func,ast.Name) and node.iter.func.id == "range":',
      '   args=[static_number(arg,self.env) for arg in node.iter.args]',
      '   if 1 <= len(args) <= 3 and all(value is not None and int(value) == value for value in args):',
      '    previous=self.env.get(node.target.id); existed=node.target.id in self.env',
      '    try:',
      '     for iteration,value in enumerate(range(*[int(value) for value in args])):',
      '      if iteration >= 256: break',
      '      self.env[node.target.id]=value',
      '      for statement in node.body: self.visit(statement)',
      '    except ValueError: pass',
      '    if existed: self.env[node.target.id]=previous',
      '    else: self.env.pop(node.target.id,None)',
      '    for statement in node.orelse: self.visit(statement)',
      '    return',
      '  self.generic_visit(node)',
      'class Visitor(ast.NodeVisitor):',
      ' def __init__(self): self.function_depth=0; self.facade_vars=set(); self.expert_vars=set(); self.raw_document_vars=set()',
      ' def visit_FunctionDef(self,node):',
      '  self.function_depth += 1',
      '  self.generic_visit(node)',
      '  self.function_depth -= 1',
      ' visit_AsyncFunctionDef = visit_FunctionDef',
      ' def visit_Call(self,node):',
      '  name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ""',
      '  receiver = node.func.value.id if isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name) else None',
      '  if receiver in self.raw_document_vars and name in facade_methods: add("FACADE_METHOD_ON_RAW_UNO_DOCUMENT",node,f"{receiver}.{name}(...) calls a stable facade method on a raw UNO document. Wrap the component with job.presentation/job.writer/job.spreadsheet and call {name} on that facade variable.","error")',
      '  if name == "getattr" and len(node.args) >= 2 and isinstance(node.args[0],ast.Name) and node.args[0].id in self.facade_vars and isinstance(node.args[1],ast.Constant) and str(node.args[1].value) in {"component","_component","document","doc","raw","_page","_sheet"}: add("MODEL_RAW_UNO_FORBIDDEN",node,f"Do not inspect internal Office objects on facade {node.args[0].id!r}; query unoApi for a high-level capability recipe.","error")',
      '  if name == "create_document" and self.function_depth == 0: add("DRAFT_ENTRYPOINT_CALLED_DIRECTLY",node,"Do not call create_document yourself. The LibreOffice worker invokes create_document(job) with the real job object.","error")',
      '  if name == "expert":',
      '   add("MODEL_RAW_UNO_FORBIDDEN",node,"job.expert() is worker-owned. Query unoApi for a versioned high-level feature recipe.","error")',
      '  if name in {"eval","exec","compile","__import__"}: add("UNSAFE_DYNAMIC_EXECUTION",node,f"{name} is forbidden in an Office draft.","error")',
      '  if name == "setattr": add("DYNAMIC_UNO_PROPERTY",node,"Dynamic setattr prevents reliable layout analysis; use an explicit property assignment.")',
      '  if name == "createInstance":',
      '   add("MODEL_RAW_UNO_FORBIDDEN",node,"Raw UNO service creation is worker-owned. Use a returned facade call or versioned feature recipe.","error")',
      '  self.generic_visit(node)',
      ' def visit_Attribute(self,node):',
      '  if node.attr in {"raw","_component","_page","_sheet"}: add("MODEL_RAW_UNO_FORBIDDEN",node,f"Direct .{node.attr} access is worker-owned. Use the returned high-level facade.","error")',
      '  if isinstance(node.value,ast.Name) and node.value.id in self.facade_vars and node.attr in {"component","document","doc"}: add("MODEL_RAW_UNO_FORBIDDEN",node,f"Do not access private component member {node.value.id}.{node.attr}; query unoApi for a high-level capability recipe.","error")',
      '  self.generic_visit(node)',
      ' def visit_Import(self,node):',
      '  if any(alias.name == "uno" or alias.name.startswith("com.sun.star") for alias in node.names): add("MODEL_RAW_UNO_FORBIDDEN",node,"Raw UNO imports are worker-owned. Use the high-level Office facade.","error")',
      '  self.generic_visit(node)',
      ' def visit_ImportFrom(self,node):',
      '  module = node.module or ""',
      '  if module.startswith("com.sun.star"):',
      '   add("MODEL_RAW_UNO_FORBIDDEN",node,f"Raw import from {module!r} is worker-owned. Use the high-level Office facade.","error")',
      '  self.generic_visit(node)',
      ' def visit_Assign(self,node):',
      '  assigned_names = [target.id for target in node.targets if isinstance(target,ast.Name)]',
      '  call_name = node.value.func.attr if isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute) else ""',
      '  call_receiver = node.value.func.value.id if isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute) and isinstance(node.value.func.value,ast.Name) else None',
      '  for name in assigned_names:',
      '   if call_receiver == "job" and call_name in {"writer","presentation","spreadsheet"}: self.facade_vars.add(name); self.expert_vars.discard(name); self.raw_document_vars.discard(name)',
      '   elif call_receiver == "job" and call_name == "expert": self.expert_vars.add(name); self.facade_vars.discard(name); self.raw_document_vars.discard(name)',
      '   elif call_receiver in self.expert_vars and call_name in {"new_document","open_document","component"}: self.raw_document_vars.add(name); self.facade_vars.discard(name); self.expert_vars.discard(name)',
      '   else: self.facade_vars.discard(name); self.expert_vars.discard(name); self.raw_document_vars.discard(name)',
      '  for target in node.targets:',
      '   if isinstance(target,ast.Attribute) and target.attr in high_risk_properties: add("HIGH_RISK_LAYOUT_PROPERTY",target,f"Direct assignment to {target.attr} can cause clipping or overlap; confirm geometry and tag the element.")',
      '  self.generic_visit(node)',
      ' def visit_AnnAssign(self,node):',
      '  if isinstance(node.target,ast.Attribute) and node.target.attr in high_risk_properties: add("HIGH_RISK_LAYOUT_PROPERTY",node.target,f"Direct assignment to {node.target.attr} can cause clipping or overlap; confirm geometry and tag the element.")',
      '  self.generic_visit(node)',
      'source_text = p.read_text(encoding="utf-8")',
      'working_lines = source_text.splitlines(keepends=True)',
      'syntax_diagnostics = []',
      'tree = None',
      'seen_syntax = set()',
      'def unmatched_opening_line(text):',
      ' stack = []',
      ' pairs = {")":"(", "]":"[", "}":"{"}',
      ' try:',
      '  tokens = tokenize.generate_tokens(io.StringIO(text).readline)',
      '  for token in tokens:',
      '   if token.type != tokenize.OP: continue',
      '   if token.string in {"(","[","{"}: stack.append((token.string,token.start[0]))',
      '   elif token.string in pairs and stack and stack[-1][0] == pairs[token.string]: stack.pop()',
      ' except (tokenize.TokenError,IndentationError,SyntaxError): pass',
      ' return stack[-1][1] if stack else None',
      'for _syntax_attempt in range(64):',
      ' try:',
      '  tree = ast.parse("".join(working_lines), filename=str(p))',
      '  break',
      ' except SyntaxError as e:',
      '  key = (e.lineno or 1, e.offset or 1, e.msg)',
      '  if key in seen_syntax: break',
      '  seen_syntax.add(key)',
      '  syntax_diagnostics.append({"code":"PYTHON_SYNTAX","line":e.lineno,"column":e.offset,"message":e.msg,"severity":"error"})',
      '  start = max(0, min(len(working_lines) - 1, (e.lineno or 1) - 1))',
      '  opening_line = unmatched_opening_line("".join(working_lines))',
      '  if not opening_line:',
      '   for backward in range(start, max(-1,start-80), -1):',
      '    segment = "".join(working_lines[backward:start+1])',
      '    balance = sum(segment.count(character) for character in "([{") - sum(segment.count(character) for character in ")]}" )',
      '    if balance > 0 and working_lines[backward].rstrip().endswith(("(","[","{")):',
      '     opening_line = backward + 1',
      '     break',
      '  if opening_line and opening_line <= (e.lineno or opening_line): start = opening_line - 1',
      '  else: opening_line = None',
      '  end = max(start, min(len(working_lines) - 1, (getattr(e,"end_lineno",None) or e.lineno or 1) - 1))',
      '  raw = working_lines[start].rstrip("\\r\\n")',
      '  indent = len(raw) - len(raw.lstrip(" \\t"))',
      '  message = str(e.msg or "").lower()',
      '  if opening_line or "never closed" in message or "unterminated" in message or "unexpected eof" in message:',
      '   scan = start + 1',
      '   while scan < len(working_lines):',
      '    candidate = working_lines[scan].rstrip("\\r\\n")',
      '    if candidate.strip():',
      '     candidate_indent = len(candidate) - len(candidate.lstrip(" \\t"))',
      '     if candidate_indent <= indent:',
      '      if candidate.lstrip().startswith((")","]","}")): end = scan',
      '      break',
      '     end = scan',
      '    else: end = scan',
      '    scan += 1',
      '  elif "unexpected indent" in message:',
      '   scan = start + 1',
      '   while scan < len(working_lines):',
      '    candidate = working_lines[scan].rstrip("\\r\\n")',
      '    if candidate.strip() and len(candidate) - len(candidate.lstrip(" \\t")) < indent: break',
      '    end = scan',
      '    scan += 1',
      '  newline = "\\n" if working_lines[start].endswith("\\n") else ""',
      '  replacement = "" if "unexpected indent" in message else (raw[:indent] + "pass")',
      '  working_lines[start] = replacement + newline',
      '  for line_index in range(start + 1, end + 1):',
      '   working_lines[line_index] = "\\n" if working_lines[line_index].endswith("\\n") else ""',
      'diagnostics.extend(syntax_diagnostics)',
      'if tree is None:',
      ' print(json.dumps(diagnostics))',
      ' sys.exit(0)',
      'try:',
      ' matches = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "create_document" and len(n.args.args) == 1 and n.args.args[0].arg == "job"]',
      ' if len(matches) != 1 or isinstance(matches[0],ast.AsyncFunctionDef): diagnostics.append({"code":"PYTHON_ENTRYPOINT_MISSING","message":"UNO source must define exactly one synchronous create_document(job).","severity":"error"})',
      ' parents = {child:parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}',
      ' def owning_function(node):',
      '  current = parents.get(node)',
      '  while current is not None:',
      '   if isinstance(current,(ast.FunctionDef,ast.AsyncFunctionDef)): return current',
      '   current = parents.get(current)',
      '  return None',
      ' def repeated_context(node):',
      '  current = parents.get(node)',
      '  while current is not None and not isinstance(current,(ast.FunctionDef,ast.AsyncFunctionDef)):',
      '   if isinstance(current,(ast.For,ast.AsyncFor,ast.While,ast.comprehension)): return True',
      '   current = parents.get(current)',
      '  return False',
      ' functions = {node.name:node for node in ast.walk(tree) if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef))}',
      ' worker_classes = {}',
      ' worker_path = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None',
      ' if worker_path and worker_path.is_file():',
      '  try:',
      '   worker_tree = ast.parse(worker_path.read_text(encoding="utf-8"), filename=str(worker_path))',
      '   wanted = {"DocumentJob","WriterLayout","PresentationLayout","PresentationSlide","PresentationShape","PresentationTable","SpreadsheetLayout","SpreadsheetSheet"}',
      '   for class_node in worker_tree.body:',
      '    if isinstance(class_node,ast.ClassDef) and class_node.name in wanted:',
      '     worker_classes[class_node.name] = {member.name:member for member in class_node.body if isinstance(member,(ast.FunctionDef,ast.AsyncFunctionDef)) and not member.name.startswith("_")}',
      '   if "PresentationTable" in worker_classes and "PresentationShape" in worker_classes:',
      '    worker_classes["PresentationTable"] = {**worker_classes["PresentationShape"], **worker_classes["PresentationTable"]}',
      '  except (OSError,SyntaxError,UnicodeError) as worker_error:',
      '   diagnostics.append({"code":"FACADE_AST_UNAVAILABLE","message":f"Installed facade signatures could not be loaded: {worker_error}","severity":"warning"})',
      ' else:',
      '  diagnostics.append({"code":"FACADE_AST_UNAVAILABLE","message":"Installed facade signatures are unavailable; runtime validation will still enforce them.","severity":"warning"})',
      ' return_types = {',
      '  ("DocumentJob","writer"):"WriterLayout", ("DocumentJob","presentation"):"PresentationLayout", ("DocumentJob","spreadsheet"):"SpreadsheetLayout",',
      '  ("PresentationLayout","slide"):"PresentationSlide", ("PresentationLayout","select_slide"):"PresentationSlide", ("PresentationLayout","duplicate_slide"):"PresentationSlide",',
      '  ("PresentationSlide","add_shape"):"PresentationShape", ("PresentationSlide","select_shape"):"PresentationShape", ("PresentationSlide","group"):"PresentationShape",',
      '  ("PresentationSlide","add_table"):"PresentationTable",',
      '  ("SpreadsheetLayout","sheet"):"SpreadsheetSheet", ("SpreadsheetLayout","select_sheet"):"SpreadsheetSheet",',
      ' }',
      ' class FacadeSignatureVisitor(ast.NodeVisitor):',
      '  def __init__(self): self.types={"job":"DocumentJob"}; self.grid_collections=set(); self.grid_cell_vars=set()',
      '  def inferred_type(self,value):',
      '   if not isinstance(value,ast.Call) or not isinstance(value.func,ast.Attribute) or not isinstance(value.func.value,ast.Name): return None',
      '   receiver_type = self.types.get(value.func.value.id)',
      '   return return_types.get((receiver_type,value.func.attr))',
      '  def visit_Assign(self,node):',
      '   inferred = self.inferred_type(node.value)',
      '   grid_result = isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute) and isinstance(node.value.func.value,ast.Name) and self.types.get(node.value.func.value.id) in {"PresentationLayout","PresentationSlide"} and node.value.func.attr in {"grid","stack"}',
      '   for target in node.targets:',
      '    if isinstance(target,ast.Name):',
      '     if inferred: self.types[target.id]=inferred',
      '     else: self.types.pop(target.id,None)',
      '     if grid_result: self.grid_collections.add(target.id)',
      '     else: self.grid_collections.discard(target.id)',
      '   self.generic_visit(node)',
      '  def visit_AnnAssign(self,node):',
      '   if isinstance(node.target,ast.Name):',
      '    inferred = self.inferred_type(node.value)',
      '    if inferred: self.types[node.target.id]=inferred',
      '    else: self.types.pop(node.target.id,None)',
      '   self.generic_visit(node)',
      '  def visit_For(self,node):',
      '   iter_names = {item.id for item in ast.walk(node.iter) if isinstance(item,ast.Name)}',
      '   introduced = set()',
      '   if iter_names & self.grid_collections:',
      '    introduced = {item.id for item in ast.walk(node.target) if isinstance(item,ast.Name)}',
      '    self.grid_cell_vars.update(introduced)',
      '   self.generic_visit(node)',
      '   self.grid_cell_vars.difference_update(introduced)',
      '  def visit_Subscript(self,node):',
      '   key = node.slice.value if isinstance(node.slice,ast.Constant) else None',
      '   if isinstance(node.value,ast.Name) and node.value.id in self.grid_cell_vars and isinstance(key,int):',
      '    add("UNO_LAYOUT_CELL_INDEX_INVALID",node,"Grid/stack cells are mappings, not tuples. Use x/y/width/height or PptxGenJS-compatible w/h keys, or pass the complete cell directly as box=cell.","error")',
      '   self.generic_visit(node)',
      '  def visit_Call(self,node):',
      '   if isinstance(node.func,ast.Attribute) and node.func.attr == "extend" and any(isinstance(arg,ast.Name) and arg.id in self.grid_cell_vars for arg in node.args):',
      '    add("UNO_LAYOUT_GRID_FLATTEN_INVALID",node,"slide.grid/stack already returns a flat row-major list of cell mappings. Do not extend/flatten a cell; iterate the returned list directly and pass box=cell.","error")',
      '   if isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name):',
      '    receiver_name, method = node.func.value.id, node.func.attr',
      '    receiver_type = self.types.get(receiver_name)',
      '    if receiver_type and receiver_type in worker_classes:',
      '     function = worker_classes[receiver_type].get(method)',
      '     if function is None:',
      '      add("UNO_API_METHOD_UNKNOWN",node,f"{receiver_name} is a {receiver_type} facade, which has no public method {method!r}. Query unoApi for the corresponding module and copy an installed example.","error")',
      '     else:',
      '      issue = signature_issue(function,node,True)',
      '      if issue: add("UNO_API_SIGNATURE_MISMATCH",node,f"Installed facade signature {receiver_type}.{method} {issue}. Query unoApi for this module and copy its exact signature and example.","error")',
      '     if receiver_type == "PresentationSlide" and method == "add_table":',
      '      allowed = {"element_id","rows","slot","box","column_weights","col_widths","header","header_fill","header_color","body_fill","alternate_fill","body_color","font_size","font_name","first_column_align"}',
      '      supplied = {keyword.arg for keyword in node.keywords if keyword.arg is not None}',
      '      unknown = sorted(supplied - allowed)',
      '      if unknown: add("UNO_API_ARGUMENT_INVALID",node,f"Unsupported presentation table option(s): {\', \'.join(unknown)}. Query unoApi module presentation.table and copy its installed signature and example.","error")',
      '      if "column_weights" in supplied and "col_widths" in supplied: add("UNO_API_ARGUMENT_INVALID",node,"Presentation table accepts either column_weights or col_widths, not both.","error")',
      '     if receiver_type == "PresentationSlide" and method in {"add_text","add_rich_text","add_bullets","add_link"}:',
      '      text_keys = {"font_size","fontSize","min_font_size","minFontSize","bold","italic","underline","strike","strikeout","color","fontColor","fontColour","font_name","fontFamily","fontFace","align","textAlign","valign","verticalAlign","padding","margin","line_spacing","lineSpacing","background","backgroundColor","background_transparency","backgroundTransparency","fill","fillColor","fill_transparency","fillTransparency","border","borderColor","line","lineColor","line_width","lineWidth","borderWidth","link","rotation","rotate","layout_role","layoutRole","allow_overlap","allowOverlap","fontWeight"}',
      '      style = call_value(node,99,"style")',
      '      style_keys = []',
      '      if isinstance(style,ast.Dict): style_keys = [key.value for key in style.keys if isinstance(key,ast.Constant) and isinstance(key.value,str)]',
      '      elif isinstance(style,ast.Call) and isinstance(style.func,ast.Name) and style.func.id == "dict": style_keys = [keyword.arg for keyword in style.keywords if keyword.arg is not None]',
      '      unknown = sorted(set(style_keys) - text_keys)',
      '      if unknown: add("UNO_API_ARGUMENT_INVALID",node,f"Unsupported presentation text style key(s): {\', \'.join(unknown)}. Query unoApi module presentation.text and copy its installed style example.","error")',
      '     if receiver_type == "PresentationSlide" and method.startswith("add_"):',
      '      box = call_value(node,99,"box")',
      '      values = None',
      '      if isinstance(box,(ast.Tuple,ast.List)) and len(box.elts) >= 4: values = box.elts[:4]',
      '      elif isinstance(box,ast.Dict):',
      '       mapping = {key.value:value for key,value in zip(box.keys,box.values) if isinstance(key,ast.Constant) and isinstance(key.value,str)}',
      '       values = [mapping.get("x"),mapping.get("y"),mapping.get("width",mapping.get("w")),mapping.get("height",mapping.get("h"))]',
      '      if values and all(value is not None for value in values):',
      '       numbers = [static_number(value,{}) for value in values]',
      '       labels = ["x","y","width","height"]',
      '       for label,value in zip(labels,numbers):',
      '        if value is not None and (value < 0 if label in {"x","y"} else value <= 0): add("PRESENTATION_GEOMETRY_INVALID",node,f"PresentationSlide.{method} box has invalid {label}={value}; positions must be non-negative and sizes must be positive.","error")',
      '       if all(value is not None for value in numbers):',
      '        x,y,width,height = numbers',
      '        if x + width > 13.334 or y + height > 7.501: add("PRESENTATION_GEOMETRY_OUT_OF_BOUNDS",node,f"PresentationSlide.{method} box ({x}, {y}, {width}, {height}) exceeds the 13.333 x 7.5 inch slide. Keep decorative bleeds inside the slide rectangle too.","error")',
      '   if isinstance(node.func,ast.Attribute) and node.func.attr in {"add_shape","set_style"}:',
      '    gradient = call_value(node,99,"gradient")',
      '    if isinstance(gradient,ast.Dict):',
      '     keys = [key.value for key in gradient.keys if isinstance(key,ast.Constant) and isinstance(key.value,str)]',
      '     allowed = {"style","start_color","startColor","end_color","endColor","angle","border","x_offset","xOffset","y_offset","yOffset","start_intensity","startIntensity","end_intensity","endIntensity"}',
      '     unknown = sorted(set(keys) - allowed)',
      '     if unknown: add("UNO_API_ARGUMENT_INVALID",node,f"Unsupported presentation gradient key(s): {\', \'.join(unknown)}. Use gradient={{\'style\':\'linear\',\'start_color\':0xFFFFFF,\'end_color\':0x000000,\'angle\':0}}; query unoApi module presentation.shape for every supported variant.","error")',
      '   if isinstance(node.func,ast.Attribute) and node.func.attr.startswith("add_"):',
      '    role = call_value(node,99,"layout_role")',
      '    if isinstance(role,ast.Constant) and isinstance(role.value,str) and role.value.lower() not in {"content","container","decoration","background"}:',
      '     add("UNO_API_ARGUMENT_INVALID",node,f"Unknown presentation layout_role {role.value!r}; expected content, container, decoration, or background.","error")',
      '   self.generic_visit(node)',
      ' FacadeSignatureVisitor().visit(tree)',
      ' named_calls = {}',
      ' for node in ast.walk(tree):',
      '  if isinstance(node,ast.Call) and isinstance(node.func,ast.Name): named_calls.setdefault(node.func.id,[]).append(node)',
      ' wrapper_geometry = {}',
      ' wrapper_text = {}',
      ' for name,function in functions.items():',
      '  params = set(function_parameters(function))',
      '  for candidate in ast.walk(function):',
      '   if not isinstance(candidate,ast.Call) or owning_function(candidate) is not function: continue',
      '   target = callable_name(candidate)',
      '   geometry_start = 2 if target == "add_shape" else 3 if target in {"add_text","add_image"} else None',
      '   if geometry_start is None or len(candidate.args) < geometry_start + 4: continue',
      '   values = candidate.args[geometry_start:geometry_start+4]',
      '   if all(isinstance(value,ast.Name) and value.id in params for value in values):',
      '    wrapper_geometry[name] = (function,list(zip(("x","y","width","height"),[value.id for value in values])))',
      '   if target == "add_text":',
      '    fields = {',
      '     "text":call_value(candidate,2,"text"), "width":call_value(candidate,5,"width"), "height":call_value(candidate,6,"height"),',
      '     "font_size":call_value(candidate,7,"font_size",ast.Constant(value=18)),',
      '     "min_font_size":call_value(candidate,99,"min_font_size",ast.Constant(value=8)),',
      '     "padding":call_value(candidate,99,"padding",ast.Constant(value=0)),',
      '    }',
      '    mapping={}',
      '    for label,value in fields.items():',
      '     mapping[label] = ("param",value.id) if isinstance(value,ast.Name) and value.id in params else ("fixed",value)',
      '    wrapper_text[name] = (function,mapping)',
      '   if name in wrapper_geometry and name in wrapper_text: break',
      ' signature_groups = {}',
      ' for name,function in functions.items():',
      '  if name == "create_document": continue',
      '  calls = named_calls.get(name,[])',
      '  for call in calls:',
      '   issue = signature_issue(function,call)',
      '   if issue:',
      '    key = (name,issue)',
      '    if key not in signature_groups: signature_groups[key] = [call,0,function.lineno]',
      '    signature_groups[key][1] += 1',
      '  positional = function_parameters(function)',
      '  defaults = dict(zip(positional[len(positional)-len(function.args.defaults):],function.args.defaults)) if function.args.defaults else {}',
      '  if isinstance(defaults.get("allow_overlap"),ast.Constant) and defaults["allow_overlap"].value is True:',
      '   add("HELPER_OVERLAP_DEFAULT_ENABLED",function,f"Reusable helper {name} defaults allow_overlap=True, which suppresses collision validation for every caller. Default it to False and opt in only for deliberate backgrounds, containers, or decoration.","error")',
      ' for (name,issue),(call,count,definition_line) in signature_groups.items():',
      '  suffix = f" across {count} call sites" if count > 1 else ""',
      '  add("HELPER_CALL_SIGNATURE_MISMATCH",call,f"Helper {name} defined on line {definition_line} {issue}{suffix}. Update the helper and all callers together.","error")',
      ' visitor=Visitor(); visitor.visit(tree)',
      ' GeometryVisitor(wrapper_geometry).visit(tree)',
      ' TextBoxVisitor(wrapper_text).visit(tree)',
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
      ' print(json.dumps(diagnostics))',
      'except SyntaxError as e:',
      ' diagnostics.append({"code":"PYTHON_SYNTAX","line":e.lineno,"column":e.offset,"message":e.msg,"severity":"error"})',
      ' print(json.dumps(diagnostics))',
    ].join('\n');
    await writeFile(analysisPath, script, 'utf8');
    const output = await new Promise<string>((resolve, reject) => {
      execFile(executable, [analysisPath, sourcePath, workerPath || ''], { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
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
          const key = JSON.stringify([
            diagnostic.code,
            diagnostic.line,
            diagnostic.column,
            diagnostic.page,
            [...(diagnostic.elementIds || []), diagnostic.elementId]
              .filter(Boolean)
              .sort(),
          ]);
          const existing = grouped.get(key);
          if (!existing) {
            grouped.set(key, {
              ...diagnostic,
              ...(diagnostic.elementIds?.length
                ? { elementIds: [...new Set(diagnostic.elementIds)] }
                : diagnostic.elementId ? { elementIds: [diagnostic.elementId] } : {}),
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
          const sourceExcerpt = diagnosticSourceExcerpt(
            source,
            withAffected,
            draftTracebackLineNumbers(diagnostic.message, source.replace(/\r\n?/g, '\n').split('\n').length),
          );
          return { ...withAffected, ...(sourceExcerpt ? { sourceExcerpt } : {}) };
        });
      }
    } catch {
      // Fall through to the generic traceback mapper.
    }
  }
  const sourceLines = source.replace(/\r\n?/g, '\n').split('\n');
  const draftLines = draftTracebackLineNumbers(errorText, sourceLines.length);
  const line = draftLines.at(-1);
  let code = 'UNO_RUNTIME_ERROR';
  if (/NameError:\s*name ['"][^'"]+['"] is not defined/i.test(errorText)) code = 'PYTHON_UNDEFINED_NAME';
  else if (/(?:Unable to connect to LibreOffice UNO|couldn'?t connect to (?:pipe|socket))/i.test(errorText)) code = 'UNO_BRIDGE_STARTUP';
  else if (/(?:com\.sun\.star\.lang\.DisposedException|Binary URP bridge disposed|bridge disposed during call)/i.test(errorText)) code = 'UNO_BRIDGE_DISPOSED';
  else if (/Presentation geometry (?:requires non-negative position and positive size|exceeds slide bounds)/i.test(errorText)) code = 'PRESENTATION_GEOMETRY_INVALID';
  else if (/Presentation text cannot fit without becoming unreadable/i.test(errorText)) code = 'PRESENTATION_TEXT_OVERFLOW';
  else if (/Duplicate elementId/i.test(errorText)) code = 'DUPLICATE_ELEMENT_ID';
  else if (/AttributeError:.*has no attribute ['"](?:add_slide|bounds|content_box|grid|stack|mm|cm|inch|pt|text_height|estimate_text_box|add_text|add_text_box|add_card|add_header|add_footer|add_shape|add_connector|add_image|add_image_contain|add_native_table|add_bar_chart|add_line_chart|add_donut_chart|add_timeline)['"]/i.test(errorText)) code = 'FACADE_METHOD_ON_RAW_UNO_DOCUMENT';
  else if (/create_document\(None\)|NoneType.*presentation/i.test(errorText)) code = 'DRAFT_ENTRYPOINT_CALLED_DIRECTLY';
  const elementId = errorText.match(/elementId=['"]([^'"]+)['"]/i)?.[1];
  const diagnostic: OfficeProgramDiagnostic = {
    code,
    ...(line ? { line, column: 1 } : {}),
    ...(elementId ? { elementId } : {}),
    message: errorText.trim(),
    severity: 'error',
  };
  const sourceExcerpt = diagnosticSourceExcerpt(source, diagnostic, draftLines);
  return [{ ...diagnostic, ...(sourceExcerpt ? { sourceExcerpt } : {}) }];
}
