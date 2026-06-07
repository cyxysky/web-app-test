import path from 'node:path';

export function appDataRoot() {
  return path.resolve(process.env.APP_DATA_DIR || process.cwd());
}

export function storeFilePath() {
  return path.join(appDataRoot(), '.data', 'store.json');
}

export function artifactsRoot() {
  return path.resolve(process.env.ARTIFACTS_DIR || path.join(appDataRoot(), 'artifacts'));
}

export function artifactPath(...segments: string[]) {
  return path.join(artifactsRoot(), ...segments);
}
