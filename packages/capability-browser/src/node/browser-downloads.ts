import type { Download } from 'playwright';
import type { Readable } from 'node:stream';

export type BrowserDownloadArtifact = {
  artifactId: string; fileName: string; bytes: number; url?: string; downloadUrl?: string;
};
export type BrowserDownloadReceiver = (input: {
  runId: string; fileName: string; sourceUrl: string;
  stream(): Promise<Readable>; cancel(): Promise<void>; abortSignal?: AbortSignal;
}) => Promise<BrowserDownloadArtifact>;
export type BrowserDownloadResult = { ok: true; artifact: BrowserDownloadArtifact } | { ok: false; fileName: string; error: string };
type Job = { id: number; controller: AbortController; pending: Promise<BrowserDownloadResult>; result?: BrowserDownloadResult };

export class BrowserDownloadManager {
  private readonly jobs = new Map<number, Job>();
  private sequence = 0;
  private operation?: { runId: string; signal?: AbortSignal };
  constructor(private readonly receiver: BrowserDownloadReceiver, private readonly defaultRunId: string,
    private readonly report: (result: BrowserDownloadResult) => void) {}

  begin(runId: string, signal?: AbortSignal) {
    this.operation = { runId, signal };
    return this.sequence;
  }
  end() { this.operation = undefined; }

  capture(download: Download) {
    if ([...this.jobs.values()].filter((job) => !job.result).length >= 64) {
      void download.cancel().catch(() => undefined);
      this.report({ ok: false, fileName: download.suggestedFilename(), error: 'Browser download queue capacity reached.' });
      return;
    }
    const id = ++this.sequence;
    const controller = new AbortController();
    const operation = this.operation;
    const cancelDownload = () => { void download.cancel().catch(() => undefined); };
    controller.signal.addEventListener('abort', cancelDownload, { once: true });
    const onAbort = () => controller.abort(operation?.signal?.reason);
    if (operation?.signal?.aborted) onAbort();
    else operation?.signal?.addEventListener('abort', onAbort, { once: true });
    const job: Job = { id, controller, pending: Promise.resolve().then(async (): Promise<BrowserDownloadResult> => {
      try {
        const artifact = await this.receiver({ runId: operation?.runId || this.defaultRunId,
          fileName: download.suggestedFilename(), sourceUrl: download.url(), abortSignal: controller.signal,
          cancel: () => download.cancel(), stream: async () => {
            const stream = await download.createReadStream();
            if (!stream) throw new Error(await download.failure() || 'Browser download did not return a readable stream.');
            return stream;
          },
        });
        return { ok: true, artifact };
      } catch (error) {
        await download.cancel().catch(() => undefined);
        return { ok: false, fileName: download.suggestedFilename(), error: error instanceof Error ? error.message : String(error) };
      } finally {
        controller.signal.removeEventListener('abort', cancelDownload);
        operation?.signal?.removeEventListener('abort', onAbort);
      }
    }) };
    this.jobs.set(id, job);
    void job.pending.then((result) => {
      job.result = result;
      this.report(result);
      if (this.jobs.size > 100) for (const [key, previous] of this.jobs) {
        if (this.jobs.size <= 100) break;
        if (previous.result) this.jobs.delete(key);
      }
    }).catch(() => undefined);
  }
  async collect(after: number) {
    return Promise.all([...this.jobs.values()].filter((job) => job.id > after).map((job) => job.pending));
  }
  async dispose() {
    for (const job of this.jobs.values()) job.controller.abort(new Error('Browser session closed.'));
    await Promise.allSettled([...this.jobs.values()].map((job) => job.pending));
    this.jobs.clear(); this.operation = undefined;
  }
}
