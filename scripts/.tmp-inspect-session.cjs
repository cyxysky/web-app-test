const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('runtime/.data/webpilot.db', { readOnly: true });
const sessionId = process.argv[2];
if (!sessionId) throw new Error('session id required');
const minimumToolIndex = Number(process.argv[3] || 0);
const mode = process.argv[4] || 'summary';

const session = db.prepare(
  'SELECT id, title, status, revision, created_at, updated_at FROM browser_chat_session WHERE id = ?',
).get(sessionId);
const steps = db.prepare(
  'SELECT step_index, record_json FROM browser_chat_step WHERE session_id = ? ORDER BY step_index',
).all(sessionId);

if (mode === 'schema') {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  console.log(JSON.stringify({ tables }, null, 2));
  for (const row of steps) {
    const record = JSON.parse(row.record_json);
    console.log(JSON.stringify({
      stepIndex: row.step_index,
      recordKeys: Object.keys(record),
      toolKeys: (record.tools || []).map((tool) => Object.keys(tool)).filter((keys, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(keys)) === index),
      lastTools: (record.tools || []).slice(-5),
    }, null, 2));
  }
  process.exit(0);
}

if (mode === 'timeline') {
  for (const row of steps) {
    const record = JSON.parse(row.record_json);
    console.log(JSON.stringify({
      stepIndex: row.step_index,
      status: record.status,
      tools: (record.tools || []).map((tool, toolIndex) => ({
        toolIndex,
        id: tool.id,
        name: tool.name,
        action: tool.input?.action,
        reason: tool.reason == null ? tool.reason : String(tool.reason).slice(0, 140),
        ok: tool.ok,
        elapsedMs: tool.elapsedMs,
        aiRequestElapsedMs: tool.aiRequestElapsedMs,
        requestCreatedAt: tool.contextBefore?.requestCreatedAt,
        contextBefore: tool.contextBefore?.estimatedTotalTokens,
        contextAfter: tool.contextAfter?.estimatedTotalTokens,
      })),
    }, null, 2));
  }
  process.exit(0);
}

if (mode === 'logs') {
  const logs = db.prepare(
    'SELECT id, time, record_json FROM browser_chat_log WHERE session_id = ? ORDER BY time, id',
  ).all(sessionId);
  for (const row of logs) {
    if (process.argv[5] && !String(row.time).includes(process.argv[5])) continue;
    const record = JSON.parse(row.record_json);
    const phase = String(record.phase || '');
    if (!phase.includes('runtime') && !phase.includes('context-compression')) continue;
    const raw = JSON.stringify(record);
    console.log(JSON.stringify({ id: row.id, time: row.time, phase, record: raw.length > 3500 ? `${raw.slice(0, 3500)}...[${raw.length - 3500} more]` : record }, null, 2));
  }
  process.exit(0);
}

if (mode === 'confirmations') {
  const logs = db.prepare(
    'SELECT id, time, record_json FROM browser_chat_log WHERE session_id = ? ORDER BY time, id',
  ).all(sessionId);
  for (const row of logs) {
    const record = JSON.parse(row.record_json);
    if (!String(record.phase || '').includes('confirmation')) continue;
    console.log(JSON.stringify({ id: row.id, time: row.time, ...record }, null, 2));
  }
  process.exit(0);
}

if (mode === 'tools') {
  for (const row of steps) {
    const record = JSON.parse(row.record_json);
    (record.tools || []).forEach((tool, toolIndex) => {
      if (toolIndex < minimumToolIndex) return;
      console.log(JSON.stringify({ stepIndex: row.step_index, toolIndex, name: tool.name, input: tool.input, result: tool.result }, null, 2));
    });
  }
  process.exit(0);
}

const compact = (value, max = 5000) => {
  if (value == null) return value;
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  return source.length > max ? `${source.slice(0, max)}...[${source.length - max} more]` : source;
};

console.log(JSON.stringify({ session }, null, 2));
for (const row of steps) {
  const record = JSON.parse(row.record_json);
  const tools = record.tools || [];
  const failures = tools
    .map((tool, toolIndex) => ({ tool, toolIndex }))
    .filter(({ tool, toolIndex }) => toolIndex >= minimumToolIndex && (tool.ok === false || tool.status === 'failed'))
    .map(({ tool, toolIndex }) => ({
      toolIndex,
      name: tool.name,
      reason: tool.reason,
      ok: tool.ok,
      status: tool.status,
      input: compact(tool.input, 2500),
      result: compact(tool.result, 3500),
      error: compact(tool.error, 2500),
    }));
  const recent = tools.slice(-12).map((tool, offset) => ({
    toolIndex: tools.length - Math.min(12, tools.length) + offset,
    name: tool.name,
    reason: tool.reason,
    ok: tool.ok,
    status: tool.status,
    result: tool.ok === false ? compact(tool.result, 1500) : undefined,
  }));
  console.log(JSON.stringify({
    stepIndex: row.step_index,
    status: record.status,
    actual: compact(record.actual, 1500),
    toolCount: tools.length,
    failures,
    recent,
  }, null, 2));
}
