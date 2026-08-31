import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { resolveLibreOfficePythonExecutable } from './libreoffice';

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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-office-ast-'));
  const sourcePath = path.join(directory, 'draft.py');
  try {
    await writeFile(sourcePath, source, 'utf8');
    const script = [
      'import ast, builtins, json, math, pathlib, sys, unicodedata',
      'p = pathlib.Path(sys.argv[1])',
      'diagnostics = []',
      'high_risk_properties = {"Position", "Size", "Width", "Height", "AnchorType", "Surround", "FrameStyleName", "IsAutoHeight", "RowHeight", "OptimalHeight", "ParaLineSpacing", "BreakType"}',
      'facade_methods = {"set_page","add_slide","bounds","content_box","grid","stack","mm","cm","inch","pt","text_height","estimate_text_box","add_text","add_text_box","add_card","add_footer","add_shape","add_connector","add_image","add_image_contain","add_native_table","add_bar_chart","add_line_chart","add_donut_chart","add_timeline","add_paragraph","add_heading","add_table","add_inline_image","add_page_break","add_worksheet","set_value","set_values","add_chart"}',
      'element_methods = {"add_slide","add_text","add_text_box","add_card","add_footer","add_shape","add_connector","add_image","add_image_contain","add_native_table","add_bar_chart","add_line_chart","add_donut_chart","add_timeline","add_paragraph","add_heading","add_table","add_inline_image","add_page_break","add_worksheet","add_chart"}',
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
      'def signature_issue(function, call):',
      ' params = function_parameters(function)',
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
      '    required=int(math.ceil(lines*minimum*(2540.0/72.0)*1.22+2.0*padding))',
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
      ' def __init__(self): self.expert_calls=0; self.tags=0; self.function_depth=0; self.element_ids={}; self.expert_vars=set(); self.facade_vars=set(); self.raw_document_vars=set()',
      ' def visit_FunctionDef(self,node):',
      '  self.function_depth += 1',
      '  self.generic_visit(node)',
      '  self.function_depth -= 1',
      ' visit_AsyncFunctionDef = visit_FunctionDef',
      ' def visit_Call(self,node):',
      '  name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ""',
      '  receiver = node.func.value.id if isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name) else None',
      '  if receiver in self.raw_document_vars and name in facade_methods: add("FACADE_METHOD_ON_RAW_UNO_DOCUMENT",node,f"{receiver}.{name}(...) calls a stable facade method on a raw UNO document. Wrap the component with job.presentation/job.writer/job.spreadsheet and call {name} on that facade variable.","error")',
      '  if name == "getattr" and len(node.args) >= 2 and isinstance(node.args[0],ast.Name) and node.args[0].id in self.facade_vars and isinstance(node.args[1],ast.Constant) and str(node.args[1].value) in {"component","_component","document","doc","raw"}: add("FACADE_COMPONENT_ACCESS_UNSUPPORTED",node,f"Do not guess internal component access on facade {node.args[0].id!r}. Declare expert = job.expert(reason) and use doc = expert.component({node.args[0].id}).","error")',
      '  if name == "create_document" and self.function_depth == 0: add("DRAFT_ENTRYPOINT_CALLED_DIRECTLY",node,"Do not call create_document yourself. The LibreOffice worker invokes create_document(job) with the real job object.","error")',
      '  if name in {"writer","presentation","spreadsheet","set_page","add_slide","add_text","add_text_box","add_card","add_footer","add_shape","add_connector","add_image","add_image_contain","add_native_table","add_bar_chart","add_line_chart","add_donut_chart","add_timeline","add_paragraph","add_heading","add_table","add_inline_image","add_page_break"} and node.args and isinstance(node.args[0],ast.Constant) and isinstance(node.args[0].value,str):',
      '   element_id=node.args[0].value',
      '   if element_id in self.element_ids: add("DUPLICATE_ELEMENT_ID",node,f"Duplicate literal elementId {element_id!r}; first declared on line {self.element_ids[element_id]}. Runtime registration will disambiguate it deterministically, but the authored helper should use role-specific IDs.","warning")',
      '   else: self.element_ids[element_id]=node.lineno',
      '  if name == "expert":',
      '   self.expert_calls += 1',
      '   reason = node.args[0] if node.args else None',
      '   if not isinstance(reason,ast.Constant) or not isinstance(reason.value,str) or len(reason.value.strip()) < 8: add("EXPERT_REASON_REQUIRED",node,"job.expert(reason) requires a concrete string reason of at least 8 characters.","error")',
      '   else: add("EXPERT_MODE_USED",node,f"Expert mode declared: {reason.value.strip()}")',
      '  if name == "tag": self.tags += 1',
      '  if name in {"eval","exec","compile","__import__"}: add("UNSAFE_DYNAMIC_EXECUTION",node,f"{name} is forbidden in an Office draft.","error")',
      '  if name == "setattr": add("DYNAMIC_UNO_PROPERTY",node,"Dynamic setattr prevents reliable layout analysis; use an explicit property assignment.")',
      '  if name == "createInstance":',
      '   service = node.args[0].value if node.args and isinstance(node.args[0],ast.Constant) and isinstance(node.args[0].value,str) else ""',
      '   if service == "com.sun.star.drawing.ConnectorShape": add("RAW_CONNECTOR_SHAPE_UNSTABLE",node,"Raw ConnectorShape can dispose the LibreOffice bridge in large Impress decks. Use deck.add_connector(...) with the same stable elementId instead.","error")',
      '   else: add("RAW_UNO_SERVICE",node,"Raw UNO service creation is high risk; declare expert mode and tag the created object.")',
      '  self.generic_visit(node)',
      ' def visit_Attribute(self,node):',
      '  if node.attr == "raw": add("RAW_ACCESS_REQUIRES_EXPERT_MODE",node,"Direct .raw access is not available; use job.expert(reason).","error")',
      '  if isinstance(node.value,ast.Name) and node.value.id in self.facade_vars and node.attr in {"component","_component","document","doc"}: add("FACADE_COMPONENT_ACCESS_UNSUPPORTED",node,f"Do not access private component member {node.value.id}.{node.attr}. Declare expert = job.expert(reason) and use doc = expert.component({node.value.id}).","error")',
      '  self.generic_visit(node)',
      ' def visit_ImportFrom(self,node):',
      '  module = node.module or ""',
      '  if module.startswith("com.sun.star"):',
      '   add("UNO_PYTHON_IMPORT_UNSUPPORTED",node,f"Python import from {module!r} is not supported by the installed LibreOffice runtime. Keep only import uno; use uno.Enum(fully_qualified_type, member), uno.getConstantByName(...), and uno.createUnoStruct(...) exactly as returned by unoApi.","error")',
      '  self.generic_visit(node)',
      ' def visit_Assign(self,node):',
      '  assigned_names = [target.id for target in node.targets if isinstance(target,ast.Name)]',
      '  call_name = node.value.func.attr if isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute) else ""',
      '  call_receiver = node.value.func.value.id if isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute) and isinstance(node.value.func.value,ast.Name) else None',
      '  for name in assigned_names:',
      '   if call_receiver == "job" and call_name in {"writer","presentation","spreadsheet"}: self.facade_vars.add(name); self.raw_document_vars.discard(name); self.expert_vars.discard(name)',
      '   elif call_receiver == "job" and call_name == "expert": self.expert_vars.add(name); self.facade_vars.discard(name); self.raw_document_vars.discard(name)',
      '   elif call_receiver in self.expert_vars and call_name in {"new_document","open_document","component"}: self.raw_document_vars.add(name); self.facade_vars.discard(name); self.expert_vars.discard(name)',
      '   else: self.facade_vars.discard(name); self.raw_document_vars.discard(name); self.expert_vars.discard(name)',
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
      '  repeated = len(calls) > 1 or any(repeated_context(call) for call in calls)',
      '  if repeated:',
      '   for candidate in ast.walk(function):',
      '    if not isinstance(candidate,ast.Call) or owning_function(candidate) is not function: continue',
      '    if callable_name(candidate) in element_methods and candidate.args and isinstance(candidate.args[0],ast.Constant) and isinstance(candidate.args[0].value,str):',
      '     add("HELPER_FIXED_ELEMENT_ID",candidate,f"Reusable helper {name} is invoked {len(calls)} time(s) but always registers fixed elementId {candidate.args[0].value!r}. Accept a stable id prefix parameter and derive a unique ID for each logical object.","error")',
      '     break',
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
  else if (/(?:com\.sun\.star\.lang\.DisposedException|Binary URP bridge disposed|bridge disposed during call)/i.test(errorText)) code = 'UNO_BRIDGE_DISPOSED';
  else if (/Presentation geometry (?:requires non-negative position and positive size|exceeds slide bounds)/i.test(errorText)) code = 'PRESENTATION_GEOMETRY_INVALID';
  else if (/Presentation text cannot fit without becoming unreadable/i.test(errorText)) code = 'PRESENTATION_TEXT_OVERFLOW';
  else if (/Duplicate elementId/i.test(errorText)) code = 'DUPLICATE_ELEMENT_ID';
  else if (/AttributeError:.*has no attribute ['"](?:add_slide|bounds|content_box|grid|stack|mm|cm|inch|pt|text_height|estimate_text_box|add_text|add_text_box|add_card|add_footer|add_shape|add_connector|add_image|add_image_contain|add_native_table|add_bar_chart|add_line_chart|add_donut_chart|add_timeline)['"]/i.test(errorText)) code = 'FACADE_METHOD_ON_RAW_UNO_DOCUMENT';
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
