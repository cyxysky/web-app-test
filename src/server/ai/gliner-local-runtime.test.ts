import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundledGlinerRuntimeDirectories,
  localGlinerPythonCandidates,
  localGlinerServiceDirectories,
  normalizedGlinerModelName,
  normalizedGlinerRuntimeMode,
} from './gliner-local-runtime';

describe('local GLiNER runtime configuration', () => {
  it('normalizes supported runtime modes', () => {
    expect(normalizedGlinerRuntimeMode('LOCAL')).toBe('local');
    expect(normalizedGlinerRuntimeMode('external')).toBe('external');
    expect(normalizedGlinerRuntimeMode('invalid')).toBe('auto');
    expect(normalizedGlinerRuntimeMode(undefined)).toBe('auto');
  });

  it('migrates the legacy GLiNER checkpoint to the GLiNER2.5 default', () => {
    expect(normalizedGlinerModelName('urchade/gliner_multi-v2.1')).toBe('fastino/gliner2.5-multi-v1');
    expect(normalizedGlinerModelName('custom/gliner2.5')).toBe('custom/gliner2.5');
  });

  it('prioritizes configured service and Python paths', () => {
    const projectRoot = path.resolve('C:/workspace/webpilot');
    const serviceDirectory = path.resolve('C:/runtime/gliner-service');
    const pythonPath = path.resolve('C:/runtime/python.exe');
    expect(localGlinerServiceDirectories(projectRoot, serviceDirectory)[0]).toBe(serviceDirectory);
    expect(localGlinerPythonCandidates(projectRoot, pythonPath)[0]).toBe(pythonPath);
    expect(bundledGlinerRuntimeDirectories(projectRoot)[0]).toBe(path.join(projectRoot, 'gliner-runtime'));
  });
});
