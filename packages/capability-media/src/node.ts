import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCapabilityProcess } from '@webpilot/capability-sdk/node';
import { createMediaCapability, type MediaArtifact, type MediaOperations } from './index.js';
import type { CapabilityExecutionContext, CapabilityRunContext } from '@webpilot/capability-sdk';

function run(executable: string, args: string[], timeoutMs: number, context: CapabilityExecutionContext) {
  return runCapabilityProcess({ executable, args, timeoutMs, signal: context.abortSignal, maxOutputChars: 100_000 });
}
export function createFfmpegMediaOperations(input: {
  ffmpegPath: string; ffprobePath?: string;
  resolveSource(sourceRef: string, context: CapabilityExecutionContext): Promise<string>;
  publishArtifact(filePath: string, context: CapabilityExecutionContext): Promise<MediaArtifact>;
  timeoutMs?: number; ocr?: MediaOperations['ocr']; transcribe?: MediaOperations['transcribe']; generateImage?: MediaOperations['generateImage'];
}): MediaOperations {
  return {
    async inspect(sourceRef, context) {
      context.abortSignal?.throwIfAborted();
      const source = await input.resolveSource(sourceRef, context);
      if (input.ffprobePath) {
        const result = await run(input.ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', source], Math.min(input.timeoutMs || 15_000, 15_000), context);
        const probe = JSON.parse(result.stdout.split(source).join(sourceRef)) as unknown;
        return { sourceRef, inspected: true, probe };
      }
      // Zero output duration reads stream headers without decoding the entire recording.
      const result = await run(input.ffmpegPath, ['-hide_banner', '-nostdin', '-i', source, '-t', '0', '-f', 'null', '-'],
        Math.min(input.timeoutMs || 15_000, 15_000), context);
      return { sourceRef, inspected: true, probe: result.stderr.split(source).join(sourceRef).slice(0, 20_000) };
    },
    async extractFrames(request, context) {
      context.abortSignal?.throwIfAborted();
      const source = await input.resolveSource(request.sourceRef, context);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'webpilot-media-'));
      try {
        const pattern = path.join(directory, 'frame-%04d.jpg');
        const filter = request.intervalSeconds ? `fps=1/${request.intervalSeconds}` : `thumbnail=${Math.max(1, request.maxFrames)}`;
        await run(input.ffmpegPath, ['-hide_banner', '-nostdin', '-i', source, '-vf', filter, '-frames:v', String(request.maxFrames), '-q:v', '2', pattern], input.timeoutMs || 120_000, context);
        context.abortSignal?.throwIfAborted();
        const files = (await readdir(directory)).filter((name) => name.endsWith('.jpg')).sort().slice(0, request.maxFrames);
        const artifacts: MediaArtifact[] = [];
        for (const name of files) { context.abortSignal?.throwIfAborted(); artifacts.push(await input.publishArtifact(path.join(directory, name), context)); }
        return artifacts;
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
    ocr: input.ocr, transcribe: input.transcribe, generateImage: input.generateImage,
    async health() { return input.ffmpegPath ? { status: 'healthy' } : { status: 'needs-runtime', message: 'FFmpeg path is not configured.' }; },
  };
}
export function createNodeMediaCapability(input: { createOperations(context: CapabilityRunContext): MediaOperations | Promise<MediaOperations> }) { return createMediaCapability(input); }
