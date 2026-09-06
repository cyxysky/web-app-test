/** Tokenize SQL without treating literals, identifiers, or ordinary comments as commands. */
function parseSql(statement: string): { tokens: string[]; sql: string } {
  let terminator = -1;
  const tokens: string[] = [];
  let rest = statement;
  while (rest.length) {
    const space = rest.match(/^\s+|^--[^\r\n]*(?:\r?\n|$)/);
    if (space) { rest = rest.slice(space[0].length); continue; }
    if (rest.startsWith('/*')) {
      if (rest.startsWith('/*!')) return { tokens: [], sql: '' };
      let depth = 1, end = 2;
      for (; end < rest.length && depth; end++) {
        if (rest.slice(end, end + 2) === '/*') { depth++; end++; }
        else if (rest.slice(end, end + 2) === '*/') { depth--; end++; }
      }
      if (depth) return { tokens: [], sql: '' };
      rest = rest.slice(end); continue;
    }
    const quoted = rest.match(/^(?:'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\])/);
    if (quoted) { tokens.push('quoted'); rest = rest.slice(quoted[0].length); continue; }
    const dollar = rest.match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
    if (dollar) {
      const end = rest.indexOf(dollar, dollar.length);
      if (end < 0) return { tokens: [], sql: '' };
      tokens.push('quoted'); rest = rest.slice(end + dollar.length); continue;
    }
    if (/^['"`\[]/.test(rest)) return { tokens: [], sql: '' };
    const word = rest.match(/^[a-zA-Z_][a-zA-Z0-9_$]*/)?.[0];
    if (!word && rest[0] === ';') terminator = statement.length - rest.length;
    tokens.push(word ? word.toLowerCase() : rest[0]);
    rest = rest.slice(word?.length || 1);
  }
  if (tokens.at(-1) === ';') tokens.pop();
  return { tokens: tokens.includes(';') ? [] : tokens, sql: (terminator >= 0 ? statement.slice(0, terminator) : statement).trim() };
}

export function sqlTokens(statement: string): string[] {
  return parseSql(statement).tokens;
}

export function isReadOnlyStatement(statement: string) {
  const tokens = sqlTokens(statement);
  const first = tokens[0];
  if (!first) return false;
  if (first === 'pragma') {
    const pragmas = new Set(['table_info', 'table_xinfo', 'index_info', 'index_xinfo', 'index_list', 'foreign_key_list', 'database_list', 'compile_options', 'user_version', 'schema_version', 'page_count', 'freelist_count']);
    const name = tokens[2] === '.' ? tokens[3] : tokens[1];
    if (!pragmas.has(name) || tokens.includes('=')) return false;
    const takesArgument = new Set(['table_info', 'table_xinfo', 'index_info', 'index_xinfo', 'index_list', 'foreign_key_list']);
    return !tokens.includes('(') || takesArgument.has(name);
  }
  if (!['select', 'with', 'explain', 'show', 'describe'].includes(first)) return false;
  const writes = new Set(['insert', 'update', 'delete', 'merge', 'alter', 'drop', 'create', 'truncate', 'grant', 'revoke', 'replace', 'vacuum', 'attach', 'detach', 'into', 'call', 'copy', 'lock', 'load_extension']);
  return !tokens.some((token) => writes.has(token));
}

export function boundedReadStatement(statement: string, maxRows: number) {
  const { tokens, sql } = parseSql(statement);
  const first = tokens[0];
  return first === 'select' || first === 'with'
    ? `SELECT * FROM (\n${sql}\n) AS webpilot_bounded_query LIMIT ${maxRows + 1}`
    : sql;
}
