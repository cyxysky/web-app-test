type ValidationIssue = {
  code?: string;
  expected?: string;
  message?: string;
  path?: Array<string | number>;
  received?: string;
};

type OfficeSourceDiagnostic = {
  column?: number;
  line?: number;
  message?: string;
  severity?: string;
};

function recordFromUnknown(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parsedJsonValue(value: string) {
  const source = value.trim();
  if (!source || (source[0] !== '{' && source[0] !== '[')) return undefined;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
}

function officeSourceValidationFailure(value: unknown) {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth = 0): Record<string, unknown> | undefined => {
    if (depth > 7 || current === null || current === undefined) return undefined;
    if (typeof current === 'string') {
      const parsed = parsedJsonValue(current);
      return parsed === undefined ? undefined : visit(parsed, depth + 1);
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        const match = visit(item, depth + 1);
        if (match) return match;
      }
      return undefined;
    }
    const record = recordFromUnknown(current);
    if (!record || seen.has(record)) return undefined;
    seen.add(record);
    const kind = typeof record.kind === 'string' ? record.kind : '';
    const validation = typeof record.validation === 'string'
      ? record.validation
      : typeof record.validationStatus === 'string'
        ? record.validationStatus
        : '';
    if (
      validation === 'failed'
      && (kind === 'uno-draft-validation' || kind === 'office-source-unit-validation')
    ) return record;
    for (const key of ['actual', 'rawResult', 'result', 'error', 'cause']) {
      const match = visit(record[key], depth + 1);
      if (match) return match;
    }
    return undefined;
  };
  return visit(value);
}

function officeSourceDiagnostic(value: unknown): OfficeSourceDiagnostic | undefined {
  const record = recordFromUnknown(value);
  if (!record) return undefined;
  return {
    column: typeof record.column === 'number' ? record.column : undefined,
    line: typeof record.line === 'number' ? record.line : undefined,
    message: typeof record.message === 'string' ? record.message.trim() : undefined,
    severity: typeof record.severity === 'string' ? record.severity : undefined,
  };
}

function localizedOfficeSourceMessage(message: string) {
  const expectedMatch = message.match(/^'(.+)' expected\.?$/i);
  if (expectedMatch) return `缺少“${expectedMatch[1]}”`;
  return message.replace(/\.$/, '');
}

export function browserChatToolFailureSummary(value: unknown) {
  const failure = officeSourceValidationFailure(value);
  if (!failure) return undefined;
  const diagnostics = Array.isArray(failure.diagnostics)
    ? failure.diagnostics.map(officeSourceDiagnostic).filter((item): item is OfficeSourceDiagnostic => Boolean(item))
    : [];
  const diagnostic = diagnostics.find((item) => item.severity === 'error') || diagnostics[0];
  const fallbackError = typeof failure.error === 'string' ? failure.error.trim() : '';
  const fallbackMatch = fallbackError.match(/^(\d+):(\d+)\s+(.+)$/);
  const line = diagnostic?.line || (fallbackMatch ? Number(fallbackMatch[1]) : undefined);
  const column = diagnostic?.column || (fallbackMatch ? Number(fallbackMatch[2]) : undefined);
  const message = diagnostic?.message || fallbackMatch?.[3] || fallbackError || '源码校验未通过';
  const location = line
    ? `第 ${line} 行${column ? `第 ${column} 列` : ''}`
    : '';
  return `文件源码${location}语法错误：${localizedOfficeSourceMessage(message)}（草稿已保留）`;
}

function validationIssue(value: unknown): ValidationIssue | undefined {
  const record = recordFromUnknown(value);
  if (!record) return undefined;
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const path = Array.isArray(record.path)
    ? record.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
    : undefined;
  if (!message && !path?.length) return undefined;
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    expected: typeof record.expected === 'string' ? record.expected : undefined,
    message: message || undefined,
    path,
    received: typeof record.received === 'string' ? record.received : undefined,
  };
}

function parseJsonArrayAfterMarker(value: string) {
  const markerIndex = value.indexOf('Error message:');
  const searchStart = markerIndex >= 0 ? markerIndex + 'Error message:'.length : 0;
  const arrayStart = value.indexOf('[', searchStart);
  if (arrayStart < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = arrayStart; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '[') depth += 1;
    if (character !== ']') continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      const parsed = JSON.parse(value.slice(arrayStart, index + 1));
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function collectValidationIssues(value: unknown) {
  const issues: ValidationIssue[] = [];
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth = 0) => {
    if (depth > 7 || current === null || current === undefined) return;
    if (typeof current === 'string') {
      const parsed = parseJsonArrayAfterMarker(current);
      for (const item of parsed || []) {
        const issue = validationIssue(item);
        if (issue) issues.push(issue);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    const record = recordFromUnknown(current);
    if (!record || seen.has(record)) return;
    seen.add(record);
    const direct = validationIssue(record);
    if (direct && (direct.code || direct.expected || direct.received)) issues.push(direct);
    visit(record.issues, depth + 1);
    visit(record.cause, depth + 1);
    visit(record.error, depth + 1);
    visit(record.message, depth + 1);
  };
  visit(value);
  return issues;
}

function typeNames(issue: ValidationIssue) {
  const match = issue.message?.match(/expected\s+([^,]+),\s*received\s+([^\s,.;]+)/i);
  return {
    expected: issue.expected || match?.[1]?.trim(),
    received: issue.received || match?.[2]?.trim(),
  };
}

export function browserChatToolValidationSummary(value: unknown) {
  const issues = collectValidationIssues(value);
  const summaries: string[] = [];
  const summarizedPaths = new Set<string>();
  for (const issue of issues) {
    const path = issue.path?.length ? issue.path.join('.') : 'input';
    const { expected, received } = typeNames(issue);
    if (summarizedPaths.has(path) || !expected || !received) continue;
    summarizedPaths.add(path);
    summaries.push(`${path}：应为 ${expected}，实际为 ${received}`);
  }
  if (summaries.length) {
    const visible = summaries.slice(0, 3);
    const remainder = summaries.length - visible.length;
    return `${visible.join('；')}${remainder > 0 ? `；另 ${remainder} 项` : ''}`;
  }
  return '工具输入不符合 schema；请打开详情查看完整错误';
}
