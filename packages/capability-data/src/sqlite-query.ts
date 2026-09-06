import { spawn } from 'node:child_process';

// A separate process makes CPU-heavy native SQLite queries cancellable as well.
const worker = `
const { DatabaseSync } = require('node:sqlite');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let db;
  try {
    const request = JSON.parse(input);
    db = new DatabaseSync(request.database, { readOnly: request.readOnly });
    db.exec('PRAGMA busy_timeout=3000');
    if (request.readOnly) db.exec('PRAGMA query_only=ON');
    const statement = db.prepare(request.statement);
    statement.setReadBigInts(true);
    const parameters = request.parameters.map(value => value && value.type === 'Buffer' ? Buffer.from(value.data) : value);
    const rows = [];
    for (const row of statement.iterate(...parameters)) {
      rows.push(row);
      if (rows.length > request.maxRows) break;
    }
    process.stdout.write(JSON.stringify(rows, (_, value) => typeof value === 'bigint' ? (Number.isSafeInteger(Number(value)) ? Number(value) : String(value)) : value));
  } catch(error) { process.stderr.write(error.message); process.exitCode=1; }
  finally { db?.close(); }
});`;

export function querySqliteFile(input: {
  database: string; statement: string; parameters: unknown[]; readOnly: boolean; maxRows: number; timeoutMs: number; signal?: AbortSignal;
}): Promise<unknown[]> {
  input.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', worker], {
      windowsHide: true, stdio: 'pipe',
      env: { NODE_ENV: 'production', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' },
    });
    let stdout = '', stderr = '', failure: Error | undefined;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const stop = (error: Error) => { failure ||= error; child.kill('SIGKILL'); };
    const abort = () => stop(input.signal?.reason instanceof Error ? input.signal.reason : new Error('Data query cancelled.'));
    const timer = setTimeout(() => stop(new Error(`Data query exceeded ${input.timeoutMs}ms.`)), input.timeoutMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > 8_000_000) stop(new Error('Data query result exceeds 8 MB; select fewer or smaller columns.'));
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => { failure = error; });
    child.stdin.on('error', (error) => { failure ||= error; });
    child.once('close', (code) => {
      clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) { reject(failure || new Error(stderr || `SQLite query exited with ${code}.`)); return; }
      try { resolve(JSON.parse(stdout) as unknown[]); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
    if (input.signal?.aborted) abort();
  });
}
