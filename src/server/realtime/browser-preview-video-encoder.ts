import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { normalizeBoundedInteger } from '@webpilot/capability-sdk';
import ffmpegStaticPath from 'ffmpeg-static';

export { browserPreviewVideoDimensions } from '@webpilot/capability-browser/node';

export const BROWSER_PREVIEW_VIDEO_MIME_TYPE = 'video/mp4; codecs="avc1.42C029"';

export type BrowserPreviewH264Configuration = {
  level: '4.1' | '4.2' | '5.0' | '5.1' | '5.2' | '6.0' | '6.1' | '6.2';
  profile: 'baseline' | 'high';
};

export type BrowserPreviewVideoEncoderMetrics = {
  bitrateKbps?: number;
  droppedInputFrames: number;
  encodedBytes: number;
  encodedFragments: number;
  height?: number;
  h264Level?: BrowserPreviewH264Configuration['level'];
  h264Profile?: BrowserPreviewH264Configuration['profile'];
  inputFrames: number;
  mimeType?: string;
  startedAt: string;
  width?: number;
};

type FragmentedMp4ChunkerOptions = {
  onFragment: (fragment: Buffer) => void;
  onInitialization: (initialization: Buffer) => void;
};

function readMp4BoxSize(buffer: Buffer) {
  if (buffer.length < 8) return undefined;
  const size32 = buffer.readUInt32BE(0);
  if (size32 === 1) {
    if (buffer.length < 16) return undefined;
    const size64 = buffer.readBigUInt64BE(8);
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Fragmented MP4 box exceeds the safe buffer size.');
    return Number(size64);
  }
  if (size32 === 0) throw new Error('Open-ended MP4 boxes are not supported for the live preview stream.');
  if (size32 < 8) throw new Error(`Invalid fragmented MP4 box size: ${size32}.`);
  return size32;
}

/** Converts arbitrary FFmpeg stdout chunks into one init segment plus complete moof/mdat fragments. */
export class FragmentedMp4Chunker {
  private currentFragment: Buffer[] = [];
  private initializationBoxes: Buffer[] = [];
  private initializationSegment?: Buffer;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(private readonly options: FragmentedMp4ChunkerOptions) {}

  push(chunk: Buffer) {
    if (!chunk.length) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 8) {
      const boxSize = readMp4BoxSize(this.pending);
      if (boxSize === undefined || this.pending.length < boxSize) return;
      if (boxSize > 128 * 1024 * 1024) throw new Error(`Fragmented MP4 box is too large: ${boxSize} bytes.`);
      const box = this.pending.subarray(0, boxSize);
      this.pending = this.pending.subarray(boxSize);
      this.acceptBox(Buffer.from(box));
    }
  }

  flush() {
    // A complete moof/mdat pair is emitted immediately from acceptBox(). If
    // FFmpeg exits in the middle of a box, never pass that partial fragment to
    // MediaSource because it would poison the rest of the decoder stream.
    this.currentFragment = [];
  }

  private acceptBox(box: Buffer) {
    const type = box.toString('ascii', 4, 8);
    if (!this.initializationSegment) {
      if (type !== 'moof') {
        this.initializationBoxes.push(box);
        return;
      }
      this.initializationSegment = Buffer.concat(this.initializationBoxes);
      this.initializationBoxes = [];
      if (!this.initializationSegment.length) throw new Error('FFmpeg did not emit an MP4 initialization segment.');
      this.options.onInitialization(this.initializationSegment);
      this.currentFragment.push(box);
      return;
    }

    if (type === 'moof') {
      if (this.currentFragment.length) this.options.onFragment(Buffer.concat(this.currentFragment));
      this.currentFragment = [box];
      return;
    }
    if (!this.currentFragment.length) {
      // Top-level metadata after moov is safe to append as its own media chunk.
      this.options.onFragment(box);
      return;
    }
    this.currentFragment.push(box);
    if (type === 'mdat') {
      this.options.onFragment(Buffer.concat(this.currentFragment));
      this.currentFragment = [];
    }
  }
}

function evenDimension(value: number, fallback: number) {
  const normalized = Number.isFinite(value) ? Math.max(2, Math.floor(value)) : fallback;
  return normalized % 2 === 0 ? normalized : normalized - 1;
}

function boundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  return normalizeBoundedInteger(process.env[name], fallback, minimum, maximum);
}

export function browserPreviewH264Configuration(
  width: number,
  height: number,
  framesPerSecond: number,
  bitrateKbps = 0,
): BrowserPreviewH264Configuration {
  const macroblocksPerFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const macroblocksPerSecond = macroblocksPerFrame * framesPerSecond;
  const levels: Array<{
    level: BrowserPreviewH264Configuration['level'];
    maxBitrateKbps: number;
    maxMacroblocksPerFrame: number;
    maxMacroblocksPerSecond: number;
  }> = [
    { level: '4.1', maxBitrateKbps: 50_000, maxMacroblocksPerFrame: 8_192, maxMacroblocksPerSecond: 245_760 },
    { level: '4.2', maxBitrateKbps: 50_000, maxMacroblocksPerFrame: 8_704, maxMacroblocksPerSecond: 522_240 },
    { level: '5.0', maxBitrateKbps: 135_000, maxMacroblocksPerFrame: 22_080, maxMacroblocksPerSecond: 589_824 },
    { level: '5.1', maxBitrateKbps: 240_000, maxMacroblocksPerFrame: 36_864, maxMacroblocksPerSecond: 983_040 },
    { level: '5.2', maxBitrateKbps: 240_000, maxMacroblocksPerFrame: 36_864, maxMacroblocksPerSecond: 2_073_600 },
    { level: '6.0', maxBitrateKbps: 240_000, maxMacroblocksPerFrame: 139_264, maxMacroblocksPerSecond: 4_177_920 },
    { level: '6.1', maxBitrateKbps: 480_000, maxMacroblocksPerFrame: 139_264, maxMacroblocksPerSecond: 8_355_840 },
    { level: '6.2', maxBitrateKbps: 800_000, maxMacroblocksPerFrame: 139_264, maxMacroblocksPerSecond: 16_711_680 },
  ];
  const selected = levels.find((candidate) => (
    macroblocksPerFrame <= candidate.maxMacroblocksPerFrame
    && macroblocksPerSecond <= candidate.maxMacroblocksPerSecond
    && bitrateKbps <= candidate.maxBitrateKbps
  ));
  if (!selected) {
    throw new Error(`H.264 video settings exceed Level 6.2: ${width}x${height}@${framesPerSecond}, ${bitrateKbps} Kbps.`);
  }
  return {
    level: selected.level,
    profile: selected.level === '4.1' ? 'baseline' : 'high',
  };
}

export function browserPreviewVideoMimeType(initialization: Buffer) {
  const avcConfigurationOffset = initialization.indexOf(Buffer.from('avcC'));
  if (avcConfigurationOffset < 0 || initialization.length < avcConfigurationOffset + 8) {
    throw new Error('FFmpeg MP4 initialization segment does not contain a valid avcC box.');
  }
  const codec = initialization
    .subarray(avcConfigurationOffset + 5, avcConfigurationOffset + 8)
    .toString('hex')
    .toUpperCase();
  return `video/mp4; codecs="avc1.${codec}"`;
}

export function browserPreviewVideoBitrateKbps(width: number, height: number, framesPerSecond: number) {
  const estimated = Math.round(width * height * framesPerSecond * 0.12 / 1000);
  const configured = Number(process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS || '');
  if (Number.isFinite(configured) && configured >= 500) return Math.floor(configured);
  return Math.max(1_500, estimated);
}

export function browserPreviewVideoFfmpegPath() {
  return String(process.env.FFMPEG_PATH || ffmpegStaticPath || '').trim();
}

export class BrowserPreviewVideoEncoder {
  private child?: ChildProcessWithoutNullStreams;
  private readonly chunker: FragmentedMp4Chunker;
  private inputBlocked = false;
  private latestPendingFrame?: Buffer;
  private reportedError = false;
  private stderr = '';
  private stopped = false;
  private stopping = false;
  private readonly state: BrowserPreviewVideoEncoderMetrics = {
    droppedInputFrames: 0,
    encodedBytes: 0,
    encodedFragments: 0,
    inputFrames: 0,
    startedAt: new Date().toISOString(),
  };

  constructor(private readonly options: {
    contentType: 'image/jpeg' | 'image/png';
    framesPerSecond: number;
    height: number;
    onError: (error: Error) => void;
    onFragment: (fragment: Buffer) => void;
    onInitialization: (initialization: Buffer, mimeType: string) => void;
    width: number;
  }) {
    this.chunker = new FragmentedMp4Chunker({
      onFragment: (fragment) => {
        this.state.encodedBytes += fragment.length;
        this.state.encodedFragments += 1;
        this.options.onFragment(fragment);
      },
      onInitialization: (initialization) => {
        this.state.encodedBytes += initialization.length;
        const mimeType = browserPreviewVideoMimeType(initialization);
        this.state.mimeType = mimeType;
        this.options.onInitialization(initialization, mimeType);
      },
    });
    this.start();
  }


  metrics(): BrowserPreviewVideoEncoderMetrics {
    return { ...this.state };
  }

  pushFrame(frame: Buffer) {
    if (this.stopped || !frame.length) return false;
    this.state.inputFrames += 1;
    if (this.inputBlocked) {
      if (this.latestPendingFrame) this.state.droppedInputFrames += 1;
      this.latestPendingFrame = frame;
      return false;
    }
    return this.writeFrame(frame);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    this.latestPendingFrame = undefined;
    if (!child) return;
    child.stdin.end();
    if (child.exitCode === null) {
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => {
          stopTimer = setTimeout(() => {
            child.kill();
            resolve();
          }, 1_500);
          stopTimer.unref?.();
        }),
      ]);
      if (stopTimer) clearTimeout(stopTimer);
    }
    this.chunker.flush();
  }

  private start() {
    const executable = browserPreviewVideoFfmpegPath();
    if (!executable) throw new Error('FFmpeg executable is unavailable. Install ffmpeg-static or configure FFMPEG_PATH.');
    const framesPerSecond = Math.max(1, Math.min(60, Math.floor(this.options.framesPerSecond)));
    const width = evenDimension(this.options.width, 1280);
    const height = evenDimension(this.options.height, 720);
    const bitrateKbps = browserPreviewVideoBitrateKbps(width, height, framesPerSecond);
    const h264 = browserPreviewH264Configuration(width, height, framesPerSecond, bitrateKbps);
    Object.assign(this.state, {
      bitrateKbps,
      height,
      h264Level: h264.level,
      h264Profile: h264.profile,
      width,
    });
    const keyframeInterval = boundedIntegerEnv(
      'BROWSER_PREVIEW_VIDEO_KEYFRAME_INTERVAL',
      Math.max(5, Math.round(framesPerSecond / 2)),
      1,
      framesPerSecond * 2,
    );
    const inputCodec = this.options.contentType === 'image/png' ? 'png' : 'mjpeg';
    const child = spawn(executable, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 'image2pipe',
      '-framerate', String(framesPerSecond),
      '-vcodec', inputCodec,
      '-i', 'pipe:0',
      '-an',
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', h264.profile,
      '-level:v', h264.level,
      ...(h264.profile === 'high' ? ['-x264-params', 'cabac=1:8x8dct=1'] : []),
      '-g', String(keyframeInterval),
      '-keyint_min', String(keyframeInterval),
      '-sc_threshold', '0',
      '-b:v', `${bitrateKbps}k`,
      '-maxrate', `${bitrateKbps}k`,
      '-bufsize', `${bitrateKbps}k`,
      '-movflags', 'empty_moov+default_base_moof+frag_every_frame',
      '-f', 'mp4',
      'pipe:1',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.chunker.push(chunk);
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-8_000);
    });
    child.stdin.on('error', (error) => {
      if (!this.stopping) this.reportError(error);
    });
    child.once('error', (error) => this.reportError(error));
    child.once('exit', (code, signal) => {
      this.chunker.flush();
      if (this.stopping || code === 0) return;
      this.reportError(new Error([
        `FFmpeg video encoder exited unexpectedly (code=${code ?? 'null'}, signal=${signal || 'none'}).`,
        this.stderr.trim(),
      ].filter(Boolean).join(' ')));
    });
  }

  private writeFrame(frame: Buffer) {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) return false;
    const accepted = child.stdin.write(frame);
    if (!accepted) {
      this.inputBlocked = true;
      child.stdin.once('drain', () => {
        this.inputBlocked = false;
        const latest = this.latestPendingFrame;
        this.latestPendingFrame = undefined;
        if (latest && !this.stopped) this.writeFrame(latest);
      });
    }
    return accepted;
  }

  private reportError(error: Error) {
    if (this.reportedError || this.stopping) return;
    this.reportedError = true;
    this.options.onError(error);
  }
}
