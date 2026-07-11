import path from 'node:path';

export function appDataRoot() {
  return path.resolve(process.env.APP_DATA_DIR || process.cwd());
}

export function appConfigFilePath() {
  return path.join(appDataRoot(), '.data', 'app-config.json');
}

function safeDataFileSegment(value: string) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
  return normalized || 'unknown';
}

export function browserChatSessionsDir() {
  return path.join(appDataRoot(), '.data', 'browser-chat-sessions');
}

export function browserChatSessionFilePath(sessionId: string) {
  return path.join(browserChatSessionsDir(), `${safeDataFileSegment(sessionId)}.json`);
}

export function browserChatSessionSummariesDir() {
  return path.join(appDataRoot(), '.data', 'browser-chat-session-summaries');
}

export function browserChatSessionSummaryFilePath(sessionId: string) {
  return path.join(browserChatSessionSummariesDir(), `${safeDataFileSegment(sessionId)}.json`);
}

export function personalMemoryFilePath() {
  return path.join(appDataRoot(), '.data', 'personal-memory', 'items.json');
}

export function targetTestMetadataFilePath() {
  return path.join(appDataRoot(), '.data', 'target-test-metadata.json');
}

export function targetTestCasesDir() {
  return path.join(appDataRoot(), '.data', 'target-test-cases');
}

export function targetTestCaseFilePath(testCaseId: string) {
  return path.join(targetTestCasesDir(), `${safeDataFileSegment(testCaseId)}.json`);
}

export function targetTestRunsDir() {
  return path.join(appDataRoot(), '.data', 'target-test-runs');
}

export function targetTestRunFilePath(runId: string) {
  return path.join(targetTestRunsDir(), `${safeDataFileSegment(runId)}.json`);
}

export function artifactsRoot() {
  return path.resolve(process.env.ARTIFACTS_DIR || path.join(appDataRoot(), 'artifacts'));
}

export function artifactPath(...segments: string[]) {
  return path.join(artifactsRoot(), ...segments);
}
