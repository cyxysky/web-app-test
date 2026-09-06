import { createHash } from 'node:crypto';
import type { OfficeDocumentDraft } from '../office/types.js';

export function sourceDigest(source: string) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function normalizedDraftSource(source: string) {
  return source.replace(/\r\n?/g, '\n');
}

export type ParsedSourceUnit = {
  content: string;
  endLine: number;
  inferred?: boolean;
  kind?: 'explicit' | 'page' | 'sheet' | 'symbol';
  path: string;
  startLine: number;
  symbolName?: string;
};

export const SOURCE_UNIT_START = /^\s*(?:#|\/\/)\s*@webpilot-unit\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,159})\s*$/;

export const SOURCE_UNIT_END = /^\s*(?:#|\/\/)\s*@webpilot-endunit\s*$/;

export function normalizedSourceUnitPath(value: string | undefined) {
  const unitPath = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!unitPath || unitPath.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(unitPath)) {
    throw new Error('Office source unit path must be a relative path using letters, numbers, dot, underscore, slash, or hyphen.');
  }
  return unitPath;
}

export function parseSourceUnits(source: string): ParsedSourceUnit[] {
  const lines = normalizedDraftSource(source).split('\n');
  const units: ParsedSourceUnit[] = [];
  const names = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = SOURCE_UNIT_START.exec(lines[index]);
    if (!match) continue;
    const unitPath = normalizedSourceUnitPath(match[1]);
    if (names.has(unitPath)) throw new Error(`Duplicate Office source unit path: ${unitPath}.`);
    const endMarker = lines.findIndex((line, candidate) => candidate > index && SOURCE_UNIT_END.test(line));
    if (endMarker < 0) throw new Error(`Office source unit ${unitPath} is missing @webpilot-endunit.`);
    const nested = lines.slice(index + 1, endMarker).find((line) => SOURCE_UNIT_START.test(line));
    if (nested) throw new Error(`Office source unit ${unitPath} contains a nested unit marker.`);
    units.push({ path: unitPath, startLine: index + 2, endLine: endMarker, content: lines.slice(index + 1, endMarker).join('\n'), kind: 'explicit' });
    names.add(unitPath);
    index = endMarker;
  }
  return units;
}

export function inferredUnitSegment(value: string, fallback: string) {
  const normalized = value.trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (normalized || fallback).slice(0, 100);
}

export function inferredPythonSymbolSourceUnits(source: string): ParsedSourceUnit[] {
  const lines = normalizedDraftSource(source).split('\n');
  const candidates = lines.flatMap((line, index) => {
    const match = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    return match ? [{ index, indent: match[1].length, name: match[2] }] : [];
  }).map((candidate) => {
    let endIndex = lines.length - 1;
    for (let index = candidate.index + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = line.match(/^\s*/)?.[0].length || 0;
      if (indent <= candidate.indent) {
        endIndex = index - 1;
        break;
      }
    }
    while (endIndex > candidate.index && !lines[endIndex].trim()) endIndex -= 1;
    return { ...candidate, endIndex };
  });
  const reusable = candidates.filter((candidate) => candidate.name !== 'create_document' && !candidates.some((parent) => (
    parent !== candidate
    && parent.name !== 'create_document'
    && parent.index < candidate.index
    && parent.endIndex >= candidate.endIndex
  )));
  const names = new Set<string>();
  return reusable.map((candidate) => {
    const baseName = inferredUnitSegment(candidate.name, `function-line-${candidate.index + 1}`);
    let unitName = baseName;
    let suffix = 2;
    while (names.has(unitName)) unitName = `${baseName}-${suffix++}`;
    names.add(unitName);
    return {
      content: lines.slice(candidate.index, candidate.endIndex + 1).join('\n'),
      endLine: candidate.endIndex + 1,
      inferred: true,
      kind: 'symbol' as const,
      path: `symbols/${unitName}`,
      startLine: candidate.index + 1,
      symbolName: candidate.name,
    };
  });
}

export function pythonCallEndIndex(lines: string[], startIndex: number) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const character of lines[index]) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
    }
    if (depth <= 0) return index;
  }
  return startIndex;
}

export function inferredPythonSlideFactoryCallUnits(source: string, symbols: ParsedSourceUnit[]) {
  const lines = normalizedDraftSource(source).split('\n');
  const factories = symbols.filter((symbol) => symbol.symbolName && /\.add_slide\s*\(/.test(symbol.content));
  const starts = factories.flatMap((factory) => {
    const escaped = factory.symbolName!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^\\s*${escaped}\\s*\\(`);
    return lines.flatMap((line, index) => {
      const insideSymbol = symbols.some((symbol) => index + 1 >= symbol.startLine && index + 1 <= symbol.endLine);
      return !insideSymbol && pattern.test(line) ? [{ factory, index }] : [];
    });
  }).sort((left, right) => left.index - right.index);
  const names = new Set<string>();
  return starts.map(({ factory, index }) => {
    const endIndex = pythonCallEndIndex(lines, index);
    const call = lines.slice(index, endIndex + 1).join('\n');
    const firstArgument = new RegExp(`^\\s*${factory.symbolName}\\s*\\(\\s*(?:(\\d+)|['\"]([^'\"]+)['\"])`).exec(call);
    const numeric = firstArgument?.[1];
    const authored = firstArgument?.[2];
    const authoredNumeric = authored?.match(/^slide[-_/]?(\d+)$/i)?.[1];
    const baseName = numeric || authoredNumeric
      ? `slide-${String(Number(numeric || authoredNumeric)).padStart(3, '0')}`
      : authored
        ? inferredUnitSegment(authored, `${factory.symbolName}-call-line-${index + 1}`)
        : `${inferredUnitSegment(factory.symbolName || 'slide-factory', 'slide-factory')}-call-line-${index + 1}`;
    let unitName = baseName;
    let suffix = 2;
    while (names.has(unitName)) unitName = `${baseName}-${suffix++}`;
    names.add(unitName);
    return {
      content: call,
      endLine: endIndex + 1,
      inferred: true,
      kind: 'page' as const,
      path: `pages/${unitName}`,
      startLine: index + 1,
    };
  });
}

export function uniqueInferredSourceUnitPaths(units: ParsedSourceUnit[]) {
  const paths = new Set<string>();
  return units.map((unit) => {
    if (!paths.has(unit.path)) {
      paths.add(unit.path);
      return unit;
    }
    let suffix = 2;
    let path = `${unit.path}-${suffix}`;
    while (paths.has(path)) path = `${unit.path}-${++suffix}`;
    paths.add(path);
    return { ...unit, path };
  });
}

export function inferredPresentationSourceUnits(
  source: string,
  generator: OfficeDocumentDraft['generator'],
  symbols: ParsedSourceUnit[] = [],
  additionalBoundaries: ParsedSourceUnit[] = [],
): ParsedSourceUnit[] {
  const lines = normalizedDraftSource(source).split('\n');
  const slidePattern = generator === 'javascript'
    ? /^(\s*)(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.addSlide\s*\(/
    : /^(\s*)(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.(?:add_slide|slide)\s*\(/;
  const starts = lines.flatMap((line, index) => {
    const match = slidePattern.exec(line);
    const insideSymbol = symbols.some((symbol) => index + 1 >= symbol.startLine && index + 1 <= symbol.endLine);
    return match && !insideSymbol ? [{ index, indent: match[1].length, line }] : [];
  });
  if (!starts.length) return [];
  const names = new Set<string>();
  return starts.map((start, index) => {
    const nextStart = [
      starts[index + 1]?.index,
      ...symbols.filter((symbol) => symbol.startLine - 1 > start.index).map((symbol) => symbol.startLine - 1),
      ...additionalBoundaries.filter((unit) => unit.startLine - 1 > start.index).map((unit) => unit.startLine - 1),
    ].filter((value): value is number => value !== undefined).sort((left, right) => left - right)[0];
    let endIndex = nextStart === undefined ? lines.length - 1 : nextStart - 1;
    if (nextStart === undefined) {
      const terminal = lines.findIndex((line, candidate) => (
        candidate > start.index
        && (line.match(/^\s*/)?.[0].length || 0) <= start.indent
        && /\.(?:save|close)\s*\(/.test(line)
      ));
      if (terminal > start.index) endIndex = terminal - 1;
    }
    while (endIndex > start.index && !lines[endIndex].trim()) endIndex -= 1;
    const authoredId = /\.(?:add_slide|addSlide|slide)\s*\(\s*['"]([^'"]+)['"]/.exec(start.line)?.[1];
    const numericId = authoredId?.match(/^slide[-_/]?(\d+)$/i)?.[1];
    const baseName = numericId
      ? `slide-${String(Number(numericId)).padStart(3, '0')}`
      : authoredId
        ? inferredUnitSegment(authoredId, `slide-call-line-${start.index + 1}`)
        : `slide-call-line-${start.index + 1}`;
    let unitName = baseName;
    let suffix = 2;
    while (names.has(unitName)) unitName = `${baseName}-${suffix++}`;
    names.add(unitName);
    return {
      content: lines.slice(start.index, endIndex + 1).join('\n'),
      endLine: endIndex + 1,
      inferred: true,
      kind: 'page' as const,
      path: `pages/${unitName}`,
      startLine: start.index + 1,
    };
  });
}

export function inferredWriterSourceUnits(source: string): ParsedSourceUnit[] {
  const lines = normalizedDraftSource(source).split('\n');
  const writerAssignment = lines.flatMap((line, index) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*job\.writer\s*\(/.exec(line);
    return match ? [{ index, variable: match[1] }] : [];
  }).at(-1);
  if (!writerAssignment) return [];
  const escaped = writerAssignment.variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const contentPattern = new RegExp(`^\\s*${escaped}\\.(?:add_heading|add_inline_image|add_page_break|add_paragraph|add_table)\\s*\\(`);
  const firstContent = lines.findIndex((line, index) => index > writerAssignment.index && contentPattern.test(line));
  if (firstContent < 0) return [];
  const pageBreakPattern = new RegExp(`^\\s*${escaped}\\.add_page_break\\s*\\(`);
  const starts = [firstContent, ...lines.flatMap((line, index) => (
    index > firstContent && pageBreakPattern.test(line) ? [index] : []
  ))];
  if (starts.length < 2) return [];
  return starts.map((start, index) => {
    const nextStart = starts[index + 1];
    let endIndex = nextStart === undefined ? lines.length - 1 : nextStart - 1;
    if (nextStart === undefined) {
      const terminal = lines.findIndex((line, candidate) => (
        candidate > start && new RegExp(`^\\s*${escaped}\\.(?:save|close)\\s*\\(`).test(line)
      ));
      if (terminal > start) endIndex = terminal - 1;
    }
    while (endIndex > start && !lines[endIndex].trim()) endIndex -= 1;
    return {
      content: lines.slice(start, endIndex + 1).join('\n'),
      endLine: endIndex + 1,
      inferred: true,
      kind: 'page' as const,
      path: `pages/page-${String(index + 1).padStart(3, '0')}`,
      startLine: start + 1,
    };
  });
}

export function inferredCalcSourceUnits(source: string): ParsedSourceUnit[] {
  const lines = normalizedDraftSource(source).split('\n');
  const declarations = lines.flatMap((line, index) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[A-Za-z_][A-Za-z0-9_]*\.add_worksheet\s*\(/.exec(line);
    return match ? [{ index, variable: match[1] }] : [];
  });
  if (declarations.length < 2) return [];
  const lastDeclaration = declarations.at(-1)!.index;
  const starts = declarations.flatMap((declaration, declarationIndex) => {
    const escaped = declaration.variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usePattern = new RegExp(`\\b${escaped}\\b`);
    const index = lines.findIndex((line, candidate) => (
      candidate > lastDeclaration && !/^\s*#/.test(line) && usePattern.test(line)
    ));
    return index < 0 ? [] : [{ declarationIndex, index }];
  }).sort((left, right) => left.index - right.index);
  if (starts.length < 2 || new Set(starts.map((start) => start.index)).size !== starts.length) return [];
  return starts.map((start, index) => {
    const nextStart = starts[index + 1]?.index;
    let endIndex = nextStart === undefined ? lines.length - 1 : nextStart - 1;
    if (nextStart === undefined) {
      const terminal = lines.findIndex((line, candidate) => (
        candidate > start.index && /^\s*[A-Za-z_][A-Za-z0-9_]*\.(?:save|close)\s*\(/.test(line)
      ));
      if (terminal > start.index) endIndex = terminal - 1;
    }
    while (endIndex > start.index && !lines[endIndex].trim()) endIndex -= 1;
    return {
      content: lines.slice(start.index, endIndex + 1).join('\n'),
      endLine: endIndex + 1,
      inferred: true,
      kind: 'sheet' as const,
      path: `sheets/sheet-${String(start.declarationIndex + 1).padStart(3, '0')}`,
      startLine: start.index + 1,
    };
  });
}

export function sourceUnitsForDraft(source: string, draft: Pick<OfficeDocumentDraft, 'documentType' | 'generator'>) {
  const explicit = parseSourceUnits(source);
  if (explicit.length) return explicit;
  if (draft.documentType === 'presentation') {
    const symbols = draft.generator === 'uno' ? inferredPythonSymbolSourceUnits(source) : [];
    const factoryCalls = draft.generator === 'uno' ? inferredPythonSlideFactoryCallUnits(source, symbols) : [];
    return uniqueInferredSourceUnitPaths([
      ...symbols,
      ...factoryCalls,
      ...inferredPresentationSourceUnits(source, draft.generator, symbols, factoryCalls),
    ].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine));
  }
  if (draft.generator !== 'uno') return [];
  if (draft.documentType === 'word') return inferredWriterSourceUnits(source);
  if (draft.documentType === 'spreadsheet') return inferredCalcSourceUnits(source);
  return [];
}

export function replaceSourceUnit(source: string, unit: ParsedSourceUnit, content: string) {
  const lines = normalizedDraftSource(source).split('\n');
  lines.splice(unit.startLine - 1, Math.max(0, unit.endLine - unit.startLine + 1), ...normalizedDraftSource(content).split('\n'));
  return lines.join('\n');
}

export function isolateSourceUnit(
  source: string,
  requestedPath: string,
  generator: OfficeDocumentDraft['generator'],
  units: ParsedSourceUnit[],
) {
  const lines = normalizedDraftSource(source).split('\n');
  for (const unit of [...units].reverse()) {
    if (unit.path === requestedPath || unit.kind === 'symbol') continue;
    const current = lines.slice(unit.startLine - 1, unit.endLine);
    const contentIndent = current.find((line) => line.trim())?.match(/^\s*/)?.[0];
    const markerIndent = lines[unit.startLine - 2]?.match(/^\s*/)?.[0] || '';
    const indent = contentIndent ?? `${markerIndent}${generator === 'javascript' ? '  ' : '    '}`;
    const replacement = generator === 'javascript' ? `${indent}// unchanged source unit skipped during isolated validation` : `${indent}pass`;
    lines.splice(unit.startLine - 1, Math.max(0, unit.endLine - unit.startLine + 1), replacement);
  }
  return lines.join('\n');
}

export function synchronizeSourceUnits(draft: OfficeDocumentDraft, validation?: 'failed' | 'passed') {
  const previous = new Map((draft.sourceUnits || []).map((unit) => [unit.path, unit]));
  const units = sourceUnitsForDraft(draft.program || '', draft);
  draft.sourceUnits = units.map((unit) => {
    const digest = sourceDigest(unit.content);
    const prior = previous.get(unit.path);
    const alreadyValidated = prior?.validatedDigest === digest;
    return {
      path: unit.path,
      sourceDigest: digest,
      validatedDigest: validation === 'passed' ? digest : alreadyValidated ? digest : undefined,
      status: validation === 'passed' || alreadyValidated
        ? 'passed' as const
        : validation === 'failed' || (prior?.sourceDigest === digest && prior.status === 'failed')
          ? 'failed' as const
          : 'pending' as const,
    };
  });
}

export function draftSourceLineCount(source: string) {
  const normalized = normalizedDraftSource(source);
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n').length;
}

export type CodexDraftPatchChunk = {
  changeContext?: string;
  contextLineIndices: Array<[number, number]>;
  isEndOfFile: boolean;
  newLines: string[];
  oldLines: string[];
};

export function emptyCodexDraftPatchChunk(changeContext?: string): CodexDraftPatchChunk {
  return { changeContext, contextLineIndices: [], isEndOfFile: false, newLines: [], oldLines: [] };
}

export function parseCodexDraftPatch(patchText: string) {
  const lines = normalizedDraftSource(String(patchText || '')).trim().split('\n');
  if (lines[0]?.trim() !== '*** Begin Patch') {
    throw new Error("The first line of the patch must be '*** Begin Patch'.");
  }
  if (lines.at(-1)?.trim() !== '*** End Patch') {
    throw new Error("The last line of the patch must be '*** End Patch'.");
  }
  const updates: CodexDraftPatchChunk[][] = [];
  let chunks: CodexDraftPatchChunk[] | undefined;
  const currentChunk = () => {
    if (!chunks) throw new Error("Expected an '*** Update File: draft.py' header before patch lines.");
    if (!chunks.length) chunks.push(emptyCodexDraftPatchChunk());
    return chunks[chunks.length - 1];
  };

  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    const updatePath = line.startsWith('*** Update File: ')
      ? line.slice('*** Update File: '.length).trim().replace(/^\.\//, '')
      : undefined;
    if (updatePath !== undefined) {
      if (updatePath !== 'draft.py') throw new Error("Codex patch may update only the staged file named 'draft.py'.");
      chunks = [];
      updates.push(chunks);
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Move to: ')) {
      throw new Error("Office draft patches may only use '*** Update File: draft.py'.");
    }
    if (line === '@@') {
      if (!chunks) throw new Error("Expected an '*** Update File: draft.py' header before '@@'.");
      chunks.push(emptyCodexDraftPatchChunk());
      continue;
    }
    if (line.startsWith('@@ ')) {
      if (!chunks) throw new Error("Expected an '*** Update File: draft.py' header before '@@'.");
      chunks.push(emptyCodexDraftPatchChunk(line.slice(3)));
      continue;
    }
    if (line === '*** End of File') {
      currentChunk().isEndOfFile = true;
      continue;
    }
    const chunk = currentChunk();
    if (chunk.isEndOfFile && line === '') continue;
    if (chunk.isEndOfFile) throw new Error("Expected a new '@@' context marker after '*** End of File'.");
    if (line === '') {
      chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
      chunk.oldLines.push('');
      chunk.newLines.push('');
      continue;
    }
    const marker = line[0];
    const content = line.slice(1);
    if (marker === ' ') {
      chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
      chunk.oldLines.push(content);
      chunk.newLines.push(content);
    } else if (marker === '+') chunk.newLines.push(content);
    else if (marker === '-') chunk.oldLines.push(content);
    else if (line.startsWith('*** ') || line.startsWith('@@')) {
      throw new Error(`Unexpected patch control line ${index + 1}. Use one Codex-format Update File section with @@ hunks.`);
    } else {
      // Models occasionally omit the one-character context marker while
      // preserving the exact source line. Inside a hunk, an otherwise bare
      // non-control line is unambiguously unchanged context, so normalize it
      // instead of failing the entire edit and encouraging a full rewrite.
      chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
      chunk.oldLines.push(line);
      chunk.newLines.push(line);
    }
  }
  if (!updates.length) throw new Error("Patch requires at least one '*** Update File: draft.py' section.");
  if (updates.some((update) => !update.length)) throw new Error("Update patch for 'draft.py' is empty.");
  const allChunks = updates.flat();
  if (!allChunks.length || allChunks.some((chunk) => !chunk.oldLines.length && !chunk.newLines.length)) {
    throw new Error('Update patch contains an empty hunk.');
  }
  if (allChunks.length > 100) throw new Error('Office draft patch is limited to 100 atomic hunks.');
  return updates;
}

export function codexDraftPatchChunkHasChange(chunk: CodexDraftPatchChunk) {
  return chunk.oldLines.length !== chunk.newLines.length
    || chunk.oldLines.some((line, index) => line !== chunk.newLines[index]);
}

export function seekCodexPatchSequence(lines: string[], pattern: string[], start: number, eof: boolean, end = lines.length) {
  if (!pattern.length) return start;
  const upper = end - pattern.length;
  const searchStart = eof ? Math.max(start, lines.length - pattern.length) : start;
  let found: number | undefined;
  for (let index = searchStart; index <= upper; index += 1) {
    if (pattern.every((line, offset) => lines[index + offset] === line)) {
      if (found !== undefined) {
        throw new Error(`PATCH_TARGET_AMBIGUOUS: exact matches on lines ${found + 1} and ${index + 1}. Include more unchanged context or use a readSource source-unit path. Nothing was saved.`);
      }
      found = index;
    }
  }
  return found;
}

export type CodexDraftReplacement = [start: number, oldLength: number, newLines: string[]];

export function codexDraftPatchReplacements(originalLines: string[], chunks: CodexDraftPatchChunk[]) {
  const replacements: CodexDraftReplacement[] = [];
  for (const chunk of chunks) {
    let lineIndex = 0;
    let scopeEnd = originalLines.length;
    if (chunk.changeContext !== undefined) {
      const contextIndex = seekCodexPatchSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (contextIndex === undefined) throw new Error(`Failed to find patch context '${chunk.changeContext}' in draft.py.`);
      lineIndex = contextIndex + 1;
      // A Python function/class anchor cannot drift into a later declaration.
      if (/^\s*(?:async\s+def|def|class)\s/.test(chunk.changeContext)) {
        const indent = chunk.changeContext.match(/^[\t ]*/)?.[0].length || 0;
        for (let index = lineIndex; index < originalLines.length; index += 1) {
          const line = originalLines[index];
          if (line.trim() && !line.trimStart().startsWith('#') && (line.match(/^[\t ]*/)?.[0].length || 0) <= indent) {
            scopeEnd = index;
            break;
          }
        }
      }
    }
    if (!chunk.oldLines.length) {
      if (chunk.changeContext !== undefined) {
        throw new Error('PATCH_INSERTION_ANCHOR_REQUIRED: include the exact anchor as an unchanged hunk line for an insertion. A context-free insertion only appends at EOF.');
      }
      replacements.push([originalLines.length, 0, [...chunk.newLines]]);
      continue;
    }
    let pattern = chunk.oldLines;
    let newLines = chunk.newLines;
    let startIndex = seekCodexPatchSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, scopeEnd);
    if (startIndex === undefined && pattern.length > 1 && pattern.at(-1) === '') {
      pattern = pattern.slice(0, -1);
      if (newLines.at(-1) === '') newLines = newLines.slice(0, -1);
      // An EOF newline is not an extra blank source line. Never drop a blank in the middle.
      startIndex = seekCodexPatchSequence(originalLines, pattern, lineIndex, true, scopeEnd);
    }
    if (startIndex === undefined) {
      throw new Error('PATCH_TARGET_NOT_FOUND: copy the exact current program, including indentation and punctuation. No fuzzy match or already-applied guess was used.');
    }

    // Leave unchanged context in place so neighboring hunks may share context.
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= newLines.length) break;
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([
          startIndex + oldStart,
          oldContext - oldStart,
          newLines.slice(newStart, newContext),
        ]);
      }
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newLines.length) {
      replacements.push([startIndex + oldStart, pattern.length - oldStart, newLines.slice(newStart)]);
    }
  }
  return replacements.sort((left, right) => left[0] - right[0]);
}

export function applyUnoDraftPatch(source: string, patchText: string) {
  const result = applyUnoDraftPatchHunks(source, patchText);
  if (result.failedHunks.length) throw new Error(result.failedHunks.map((failure) => `hunk ${failure.hunk}: ${failure.error}`).join('\n'));
  return result.source;
}

export type UnoDraftPatchHunkFailure = {
  hunk: number;
  error: string;
  sourceContext?: { startLine: number; endLine: number; lineNumberBasis: string; content: string };
};

export function replacementConflictSourceContext(source: string, oldText: string) {
  const lines = source.split('\n');
  const requested = oldText.split('\n');
  for (const [offset, line] of requested.entries()) {
    const anchor = line.trim();
    if (anchor.length < 16) continue;
    const matches = lines.flatMap((candidate, index) => candidate.trim() === anchor ? [index] : []);
    if (matches.length !== 1) continue;
    const start = Math.max(0, matches[0] - Math.min(offset, 4));
    const window: string[] = [];
    for (const candidate of lines.slice(start, start + 12)) {
      if (window.join('\n').length + candidate.length > 1800) break;
      window.push(candidate);
    }
    if (!window.length) return undefined;
    return { startLine: start + 1, endLine: start + window.length,
      lineNumberBasis: '1-based within the requested source unit, or the full draft when no path was supplied',
      content: window.join('\n') };
  }
  return undefined;
}

export type UnoDraftPatchResult = {
  source: string;
  appliedHunks: number;
  alreadyAppliedHunks: number;
  failedHunks: UnoDraftPatchHunkFailure[];
  ignoredHunks: number;
  totalHunks: number;
  blockedHunks: number[];
};

export function sourceEditRangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }) {
  // Insertions on a replacement boundary have ambiguous ordering; require one combined edit.
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

export function applyUnoDraftPatchHunks(source: string, patchText: string): UnoDraftPatchResult {
  const normalized = normalizedDraftSource(source);
  const hasFinalNewline = normalized.endsWith('\n');
  const lines = normalized ? (hasFinalNewline ? normalized.slice(0, -1) : normalized).split('\n') : [];
  const candidates: Array<{ start: number; end: number; newLines: string[]; hunk: number }> = [];
  const failedHunks: UnoDraftPatchHunkFailure[] = [];
  const parsedChunks = parseCodexDraftPatch(patchText).flat();
  const changedChunks = parsedChunks
    .map((chunk, index) => ({ chunk, hunk: index + 1 }))
    .filter(({ chunk }) => codexDraftPatchChunkHasChange(chunk));
  if (changedChunks.length !== parsedChunks.length) {
    const hunk = parsedChunks.findIndex((chunk) => !codexDraftPatchChunkHasChange(chunk)) + 1;
    throw new Error(
      `PATCH_MISSING_CHANGE_MARKERS: hunk ${hunk} has no source change. No hunks were saved. `
      + "Use '-old' and '+new' in the SAME @@ hunk, followed by the full source indentation. "
      + 'Two context-only @@ blocks are NOT an old/new replacement. '
      + 'For indentation repairs use replacements: [{oldText: exact current source, newText: corrected source}] instead of patch. '
      + 'Do not add comments just to force a byte change.',
    );
  }
  changedChunks.forEach(({ chunk, hunk }) => {
    try {
      for (const [start, oldLength, newLines] of codexDraftPatchReplacements(lines, [chunk])) {
        candidates.push({ start, end: start + oldLength, newLines, hunk });
      }
    } catch (error) {
      failedHunks.push({
        hunk,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  const overlapping = new Set<number>();
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (sourceEditRangesOverlap(candidates[i], candidates[j])) {
        overlapping.add(candidates[i].hunk);
        overlapping.add(candidates[j].hunk);
      }
    }
  }
  for (const hunk of overlapping) failedHunks.push({ hunk, error: 'PATCH_TARGET_OVERLAP: combine changes to the same source range into one hunk. No hunks were saved.' });
  if (failedHunks.length) return {
    source: normalized, appliedHunks: 0, alreadyAppliedHunks: 0, failedHunks, ignoredHunks: 0, totalHunks: parsedChunks.length,
    blockedHunks: changedChunks.filter(({ hunk }) => !failedHunks.some((failure) => failure.hunk === hunk)).map(({ hunk }) => hunk),
  };
  const changedLineCount = candidates.reduce((sum, item) => sum + Math.max(item.end - item.start, item.newLines.length), 0);
  if (changedLineCount >= 100 && changedLineCount / Math.max(1, draftSourceLineCount(normalized)) >= 0.6) {
    throw new Error('Near-complete source replacement through one edit is blocked. Keep the same draft and split the repair into focused Codex-format hunks based on the latest read.');
  }
  for (const item of candidates.sort((a, b) => b.start - a.start)) lines.splice(item.start, item.end - item.start, ...item.newLines);
  return {
    source: `${lines.join('\n')}${hasFinalNewline ? '\n' : ''}`,
    appliedHunks: changedChunks.length,
    alreadyAppliedHunks: 0,
    failedHunks,
    ignoredHunks: 0,
    totalHunks: parsedChunks.length,
    blockedHunks: [],
  };
}

export function applyUnoDraftReplacements(
  source: string,
  replacements: Array<{ oldText: string; newText: string }>,
): UnoDraftPatchResult {
  const normalized = normalizedDraftSource(source);
  if (!Array.isArray(replacements) || !replacements.length || replacements.length > 50
    || replacements.some((item) => !item || typeof item.oldText !== 'string' || !item.oldText.length || typeof item.newText !== 'string')
    || replacements.reduce((sum, item) => sum + item.oldText.length + item.newText.length, 0) > 200_000) {
    throw new Error('replacements requires 1-50 oldText/newText pairs, nonempty oldText, at most 200000 total characters.');
  }
  const positions = (text: string) => {
    const found: number[] = [];
    for (let start = 0; text && start <= normalized.length - text.length;) {
      const index = normalized.indexOf(text, start);
      if (index < 0) break;
      start = index + 1;
      // Three leading spaces must not match inside a four-space indent.
      const lineStart = normalized.lastIndexOf('\n', index - 1) + 1;
      if (/^[\t ]/.test(text) && index > lineStart && /^[\t ]*$/.test(normalized.slice(lineStart, index))) continue;
      found.push(index);
      if (found.length > 1) break;
    }
    return found;
  };
  const failedHunks: UnoDraftPatchHunkFailure[] = [];
  let alreadyAppliedHunks = 0;
  const candidates: Array<{ start: number; end: number; text: string; hunk: number }> = [];
  replacements.forEach((item, index) => {
    const hunk = index + 1;
    const oldText = normalizedDraftSource(item.oldText);
    const newText = normalizedDraftSource(item.newText);
    const found = positions(oldText);
    if (found.length !== 1) {
      const sourceContext = failedHunks.length < 3 ? replacementConflictSourceContext(normalized, oldText) : undefined;
      failedHunks.push({ hunk, error: found.length
        ? 'OLD_TEXT_AMBIGUOUS: include surrounding unchanged source until oldText matches exactly once.'
        : 'OLD_TEXT_NOT_FOUND: copy oldText from the exact source, preserving indentation and quote/backslash characters. JSON transport escapes are not extra characters in the Python source. Use sourceContext below when sufficient; otherwise read only the missing local window. No fuzzy matching is performed.',
        ...(sourceContext ? { sourceContext } : {}) });
    } else if (oldText === newText) {
      alreadyAppliedHunks += 1;
    } else {
      candidates.push({ start: found[0], end: found[0] + oldText.length, text: newText, hunk });
    }
  });
  const overlapping = new Set<number>();
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (sourceEditRangesOverlap(candidates[i], candidates[j])) {
        overlapping.add(candidates[i].hunk);
        overlapping.add(candidates[j].hunk);
      }
    }
  }
  for (const hunk of overlapping) failedHunks.push({ hunk, error: 'OVERLAPPING_REPLACEMENTS: combine overlapping changes into a single oldText/newText pair.' });
  if (failedHunks.length) return {
    source: normalized, appliedHunks: 0, alreadyAppliedHunks, failedHunks, ignoredHunks: 0, totalHunks: replacements.length,
    blockedHunks: candidates.filter((item) => !overlapping.has(item.hunk)).map((item) => item.hunk),
  };
  const applicable = candidates;
  let edited = normalized;
  let changedLines = 0;
  for (const item of applicable.sort((a, b) => b.start - a.start)) {
    changedLines += Math.max(draftSourceLineCount(normalized.slice(item.start, item.end)), draftSourceLineCount(item.text));
    edited = edited.slice(0, item.start) + item.text + edited.slice(item.end);
  }
  if (changedLines >= 100 && changedLines / draftSourceLineCount(normalized) >= 0.6) {
    throw new Error('Near-complete source replacement is blocked. Use focused replacements from the latest readSource.');
  }
  if (!applicable.length && !alreadyAppliedHunks) {
    throw new Error(failedHunks.map((item) => `replacement ${item.hunk}: ${item.error}`).join('\n'));
  }
  return { source: edited, appliedHunks: applicable.length, alreadyAppliedHunks, failedHunks, ignoredHunks: 0, totalHunks: replacements.length, blockedHunks: [] };
}
