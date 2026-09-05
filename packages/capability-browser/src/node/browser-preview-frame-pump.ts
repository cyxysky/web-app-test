export type BrowserPreviewFramePumpMetrics = {
  activeCaptures?: number;
  captureDurationMs?: number;
  captureDurationMsAverage?: number;
  coalescedFrames: number;
  coalescedRatio: number;
  elapsedSeconds: number;
  failedFrames: number;
  imageFormat?: 'jpeg' | 'png';
  imageQuality?: number;
  lastCapturedAt?: string;
  lastTransmittedAt?: string;
  maxConcurrentCaptures?: number;
  nativeFrames: number;
  nativeFps: number;
  startedAt: string;
  targetFps?: number;
  transmittedFrames: number;
  transmittedFps: number;
};

export class BrowserPreviewFramePump<TFrame extends { capturedAt?: string }> {
  private activeSend?: Promise<void>;
  private latest?: { frame: TFrame; sequence: number };
  private nextSequence = 0;
  private transmittedSequence = 0;
  private nextEligibleAt = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly state: BrowserPreviewFramePumpMetrics = {
    coalescedFrames: 0,
    coalescedRatio: 0,
    elapsedSeconds: 0,
    failedFrames: 0,
    nativeFrames: 0,
    nativeFps: 0,
    startedAt: new Date().toISOString(),
    transmittedFrames: 0,
    transmittedFps: 0,
  };

  constructor(private readonly options: {
    intervalMs: () => number;
    onError?: (error: unknown) => void;
    onFrame: (frame: TFrame) => void | Promise<void>;
  }) {}

  push(frame: TFrame) {
    if (this.stopped) return;
    const sequence = ++this.nextSequence;
    this.state.nativeFrames += 1;
    this.state.lastCapturedAt = frame.capturedAt;
    if (this.latest && this.latest.sequence > this.transmittedSequence) this.state.coalescedFrames += 1;
    this.latest = { frame, sequence };
    this.schedule();
  }

  metrics(): BrowserPreviewFramePumpMetrics {
    const elapsedSeconds = Math.max(0.001, (Date.now() - Date.parse(this.state.startedAt)) / 1000);
    return {
      ...this.state,
      elapsedSeconds,
      nativeFps: this.state.nativeFrames / elapsedSeconds,
      transmittedFps: this.state.transmittedFrames / elapsedSeconds,
      coalescedRatio: this.state.nativeFrames ? this.state.coalescedFrames / this.state.nativeFrames : 0,
    };
  }

  async flushLatest() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activeSend?.catch(() => undefined);
    if (!this.stopped) await this.flush();
  }

  private schedule() {
    if (this.stopped || this.timer || this.activeSend || !this.latest || this.latest.sequence <= this.transmittedSequence) return;
    const delay = Math.max(0, this.nextEligibleAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  private async flush() {
    if (this.stopped || this.activeSend) return;
    const candidate = this.latest;
    if (!candidate || candidate.sequence <= this.transmittedSequence) return;
    const send = Promise.resolve().then(() => this.options.onFrame(candidate.frame));
    this.activeSend = send;
    try {
      await send;
      this.transmittedSequence = candidate.sequence;
      this.state.transmittedFrames += 1;
      this.state.lastTransmittedAt = new Date().toISOString();
      this.nextEligibleAt = Date.now() + Math.max(1, Math.floor(this.options.intervalMs()));
    } catch (error) {
      this.transmittedSequence = candidate.sequence;
      this.state.failedFrames += 1;
      this.nextEligibleAt = Date.now() + Math.max(1, Math.floor(this.options.intervalMs()));
      this.options.onError?.(error);
    } finally {
      this.activeSend = undefined;
      this.schedule();
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activeSend?.catch(() => undefined);
    this.latest = undefined;
  }
}
