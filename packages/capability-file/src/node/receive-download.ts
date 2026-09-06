import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CapabilityTaskQueue, raceWithAbort } from '@webpilot/capability-sdk';
import { createNodeArtifactPayload, sanitizeNodeArtifactFileName, type NodeArtifactUrlResolver } from './artifacts.js';

export type NodeBrowserDownloadInput = {
  runId: string;
  fileName: string;
  sourceUrl: string;
  stream(): Promise<Readable>;
  cancel(): Promise<void>;
  abortSignal?: AbortSignal;
};

/** Persists the browser's authenticated response bytes; never fetches its URL a second time. */
export function createNodeFileDownloadReceiver(options: {
  artifactsRoot: string;
  artifactUrl?: NodeArtifactUrlResolver;
  maxBytes?: number;
  timeoutMs?: number;
}) {
  const queue = new CapabilityTaskQueue({ concurrency: 2, maxQueued: 32, queueTimeoutMs: 120_000 });
  return (input: NodeBrowserDownloadInput) => queue.run(async (signal) => {
    const directory = path.join(path.resolve(options.artifactsRoot), sanitizeNodeArtifactFileName(input.runId, 'adhoc'), 'downloads');
    await mkdir(directory, { recursive: true });
    const requestedName = sanitizeNodeArtifactFileName(input.fileName, 'download');
    const parsed = path.parse(requestedName);
    const fileName = `${parsed.name}-${randomUUID().slice(0, 12)}${parsed.ext}`;
    const target = path.join(directory, fileName);
    const temporary = `${target}.partial`;
    const cancel = () => { void input.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const pendingStream = input.stream().then((stream) => { if (signal.aborted) stream.destroy(); return stream; });
      const stream = await raceWithAbort(pendingStream, signal);
      signal.throwIfAborted();
      let bytes = 0;
      const limit = options.maxBytes ?? 128 * 1024 * 1024;
      const bound = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        done(bytes > limit ? new Error(`Browser download exceeds ${limit} bytes.`) : null, chunk);
      } });
      await pipeline(stream, bound, createWriteStream(temporary, { flags: 'wx' }), { signal });
      signal.throwIfAborted();
      await rename(temporary, target);
      return { ...createNodeArtifactPayload(options, { bytes: (await stat(target)).size, fileName, filePath: target, kind: 'download' }), sourceUrl: input.sourceUrl };
    } catch (error) {
      await input.cancel().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    } finally { signal.removeEventListener('abort', cancel); }
  }, { abortSignal: input.abortSignal, executionTimeoutMs: options.timeoutMs ?? 120_000 });
}
