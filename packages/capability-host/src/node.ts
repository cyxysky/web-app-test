import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CapabilityConfiguration,
  CapabilityManifest,
} from '@webpilot/capability-sdk';
import {
  capabilityConfigScopeKey,
  type CapabilityConfigScope,
  type CapabilityConfigStore,
} from './index.js';

type JsonConfigFile = {
  version: 1;
  scopes: Record<string, Record<string, CapabilityConfiguration>>;
};

function emptyFile(): JsonConfigFile {
  return { version: 1, scopes: {} };
}

/** A small persistent store for CLI agents and single-process Node hosts. */
export class JsonFileCapabilityConfigStore implements CapabilityConfigStore {
  readonly #filePath: string;
  #writeQueue = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async load(manifest: CapabilityManifest, scope?: CapabilityConfigScope) {
    const data = await this.#read();
    const value = data.scopes[capabilityConfigScopeKey(scope)]?.[manifest.id];
    return value ? Object.freeze({ ...value }) : undefined;
  }

  async save(
    manifest: CapabilityManifest,
    values: CapabilityConfiguration,
    scope?: CapabilityConfigScope,
  ) {
    return this.#enqueue(async () => {
      const data = await this.#read();
      const scopeKey = capabilityConfigScopeKey(scope);
      data.scopes[scopeKey] ||= {};
      data.scopes[scopeKey][manifest.id] = Object.freeze({ ...values });
      await this.#write(data);
    });
  }

  async delete(manifest: CapabilityManifest, scope?: CapabilityConfigScope) {
    return this.#enqueue(async () => {
      const data = await this.#read();
      const scopeKey = capabilityConfigScopeKey(scope);
      if (!data.scopes[scopeKey]?.[manifest.id]) return;
      delete data.scopes[scopeKey][manifest.id];
      if (!Object.keys(data.scopes[scopeKey]).length) delete data.scopes[scopeKey];
      await this.#write(data);
    });
  }

  async #read(): Promise<JsonConfigFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, 'utf8')) as Partial<JsonConfigFile>;
      return parsed.version === 1 && parsed.scopes && typeof parsed.scopes === 'object'
        ? { version: 1, scopes: parsed.scopes }
        : emptyFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw error;
    }
  }

  async #write(data: JsonConfigFile) {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  #enqueue<T>(operation: () => Promise<T>) {
    const pending = this.#writeQueue.then(operation, operation);
    this.#writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
