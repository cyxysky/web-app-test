import path from 'node:path';

export function appDataRoot() {
  // Runtime data is external to the build and must never make Turbopack trace
  // the workspace. The packaged launcher supplies APP_DATA_DIR explicitly.
  return path.resolve(/*turbopackIgnore: true*/ process.env.APP_DATA_DIR || path.join(process.cwd(), 'runtime'));
}

export function artifactsRoot() {
  return path.resolve(/*turbopackIgnore: true*/ process.env.ARTIFACTS_DIR || path.join(appDataRoot(), 'artifacts'));
}

export function codeSandboxRoot(...segments: string[]) {
  return path.join(path.resolve(/*turbopackIgnore: true*/ process.env.CODE_SANDBOX_DIR || path.join(appDataRoot(), 'code-sandbox')), ...segments);
}

export function artifactPath(...segments: string[]) {
  return path.join(artifactsRoot(), ...segments);
}
