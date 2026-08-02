import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  BROWSER_PREVIEW_VIDEO_MIME_TYPE,
  BrowserPreviewVideoEncoder,
  FragmentedMp4Chunker,
  browserPreviewH264Configuration,
  browserPreviewVideoBitrateKbps,
  browserPreviewVideoMimeType,
} from './browser-preview-video-encoder';

function mp4Box(type: string, payload: Buffer) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

test('fragmented MP4 chunker preserves init and complete media fragments across arbitrary chunks', () => {
  const initializations: Buffer[] = [];
  const fragments: Buffer[] = [];
  const chunker = new FragmentedMp4Chunker({
    onFragment: (fragment) => fragments.push(fragment),
    onInitialization: (initialization) => initializations.push(initialization),
  });
  const initialization = Buffer.concat([
    mp4Box('ftyp', Buffer.from('brand')),
    mp4Box('moov', Buffer.from('metadata')),
  ]);
  const firstFragment = Buffer.concat([
    mp4Box('moof', Buffer.from('one')),
    mp4Box('mdat', Buffer.from('frame-one')),
  ]);
  const secondFragment = Buffer.concat([
    mp4Box('moof', Buffer.from('two')),
    mp4Box('mdat', Buffer.from('frame-two')),
  ]);
  const stream = Buffer.concat([initialization, firstFragment, secondFragment]);
  for (let offset = 0; offset < stream.length; offset += 7) chunker.push(stream.subarray(offset, offset + 7));

  assert.equal(initializations.length, 1);
  assert.deepEqual(initializations[0], initialization);
  assert.deepEqual(fragments, [firstFragment, secondFragment]);
});

test('fragmented MP4 chunker never emits a truncated media fragment', () => {
  const fragments: Buffer[] = [];
  const chunker = new FragmentedMp4Chunker({
    onFragment: (fragment) => fragments.push(fragment),
    onInitialization: () => undefined,
  });
  chunker.push(Buffer.concat([
    mp4Box('ftyp', Buffer.from('brand')),
    mp4Box('moov', Buffer.from('metadata')),
    mp4Box('moof', Buffer.from('incomplete')),
  ]));
  chunker.flush();
  assert.deepEqual(fragments, []);
});

test('H.264 configuration covers Full HD, 2K, UHD 4K, and DCI 4K up to 60 FPS', () => {
  assert.deepEqual(browserPreviewH264Configuration(1920, 1080, 30), { level: '4.1', profile: 'baseline' });
  assert.deepEqual(browserPreviewH264Configuration(1920, 1080, 60), { level: '4.2', profile: 'high' });
  assert.deepEqual(browserPreviewH264Configuration(2560, 1440, 30), { level: '5.0', profile: 'high' });
  assert.deepEqual(browserPreviewH264Configuration(2560, 1440, 60), { level: '5.1', profile: 'high' });
  assert.deepEqual(browserPreviewH264Configuration(3840, 2160, 30), { level: '5.1', profile: 'high' });
  assert.deepEqual(browserPreviewH264Configuration(3840, 2160, 60), { level: '5.2', profile: 'high' });
  assert.deepEqual(browserPreviewH264Configuration(4096, 2160, 60), { level: '5.2', profile: 'high' });
  assert.deepEqual(browserPreviewH264Configuration(1920, 1080, 30, 120_000), { level: '5.0', profile: 'high' });
  assert.deepEqual(browserPreviewH264Configuration(2560, 1440, 30, 800_000), { level: '6.2', profile: 'high' });
});

test('4K bitrate is estimated automatically and an 800 Mbps configured bitrate is preserved', () => {
  const previous = process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS;
  try {
    delete process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS;
    assert.equal(browserPreviewVideoBitrateKbps(3840, 2160, 30), 29_860);
    assert.equal(browserPreviewVideoBitrateKbps(3840, 2160, 60), 59_720);
    process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS = '120000';
    assert.equal(browserPreviewVideoBitrateKbps(3840, 2160, 60), 120_000);
    process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS = '800000';
    assert.equal(browserPreviewVideoBitrateKbps(2560, 1440, 30), 800_000);
  } finally {
    if (previous === undefined) delete process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS;
    else process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS = previous;
  }
});

test('FFmpeg encoder emits real H.264 fragmented MP4 from browser JPEG frames', async () => {
  const initializations: Buffer[] = [];
  const fragments: Buffer[] = [];
  const mimeTypes: string[] = [];
  const errors: Error[] = [];
  const frames = await Promise.all(Array.from({ length: 12 }, (_, index) => (
    sharp({
      create: {
        background: { b: 140, g: 70 + index * 4, r: index * 12 },
        channels: 3,
        height: 180,
        width: 320,
      },
    }).jpeg({ quality: 85 }).toBuffer()
  )));
  const encoder = new BrowserPreviewVideoEncoder({
    contentType: 'image/jpeg',
    framesPerSecond: 10,
    height: 180,
    onError: (error) => errors.push(error),
    onFragment: (fragment) => fragments.push(fragment),
    onInitialization: (initialization, mimeType) => {
      initializations.push(initialization);
      mimeTypes.push(mimeType);
    },
    width: 320,
  });
  for (const frame of frames) encoder.pushFrame(frame);
  await encoder.stop();

  assert.equal(BROWSER_PREVIEW_VIDEO_MIME_TYPE, 'video/mp4; codecs="avc1.42C029"');
  assert.deepEqual(errors, []);
  assert.equal(initializations.length, 1);
  assert.ok(initializations[0].includes(Buffer.from('ftyp')));
  assert.ok(initializations[0].includes(Buffer.from('moov')));
  const avcConfigurationOffset = initializations[0].indexOf(Buffer.from('avcC'));
  assert.ok(avcConfigurationOffset >= 0);
  assert.deepEqual(
    [...initializations[0].subarray(avcConfigurationOffset + 4, avcConfigurationOffset + 8)],
    [0x01, 0x42, 0xc0, 0x29],
  );
  assert.deepEqual(mimeTypes, ['video/mp4; codecs="avc1.42C029"']);
  assert.equal(browserPreviewVideoMimeType(initializations[0]), mimeTypes[0]);
  assert.ok(fragments.length >= 1);
  assert.ok(fragments.some((fragment) => fragment.includes(Buffer.from('moof'))));
  assert.ok(fragments.some((fragment) => fragment.includes(Buffer.from('mdat'))));
  assert.ok(encoder.metrics().encodedBytes > 0);
});

test('FFmpeg encoder accepts an explicitly configured 800 Mbps H.264 stream', async () => {
  const previous = process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS;
  process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS = '800000';
  try {
    const frame = await sharp({
      create: {
        background: { b: 30, g: 90, r: 180 },
        channels: 3,
        height: 180,
        width: 320,
      },
    }).png().toBuffer();
    const errors: Error[] = [];
    const mimeTypes: string[] = [];
    const encoder = new BrowserPreviewVideoEncoder({
      contentType: 'image/png',
      framesPerSecond: 30,
      height: 1440,
      onError: (error) => errors.push(error),
      onFragment: () => undefined,
      onInitialization: (_initialization, mimeType) => mimeTypes.push(mimeType),
      width: 2560,
    });
    for (let index = 0; index < 4; index += 1) encoder.pushFrame(frame);
    await encoder.stop();

    assert.deepEqual(errors, []);
    assert.deepEqual(mimeTypes, ['video/mp4; codecs="avc1.64003E"']);
    assert.equal(encoder.metrics().bitrateKbps, 800_000);
    assert.equal(encoder.metrics().h264Level, '6.2');
  } finally {
    if (previous === undefined) delete process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS;
    else process.env.BROWSER_PREVIEW_VIDEO_BITRATE_KBPS = previous;
  }
});

test('FFmpeg encoder emits an actual UHD 4K 60 FPS High Profile stream', async () => {
  const frame = await sharp({
    create: {
      background: { b: 90, g: 60, r: 30 },
      channels: 3,
      height: 360,
      width: 640,
    },
  }).jpeg({ quality: 80 }).toBuffer();
  const errors: Error[] = [];
  const mimeTypes: string[] = [];
  const fragments: Buffer[] = [];
  const encoder = new BrowserPreviewVideoEncoder({
    contentType: 'image/jpeg',
    framesPerSecond: 60,
    height: 2160,
    onError: (error) => errors.push(error),
    onFragment: (fragment) => fragments.push(fragment),
    onInitialization: (_initialization, mimeType) => mimeTypes.push(mimeType),
    width: 3840,
  });
  for (let index = 0; index < 4; index += 1) encoder.pushFrame(frame);
  await encoder.stop();

  assert.deepEqual(errors, []);
  assert.deepEqual(mimeTypes, ['video/mp4; codecs="avc1.640034"']);
  assert.ok(fragments.some((fragment) => fragment.includes(Buffer.from('mdat'))));
  assert.equal(encoder.metrics().h264Profile, 'high');
  assert.equal(encoder.metrics().h264Level, '5.2');
  assert.equal(encoder.metrics().width, 3840);
  assert.equal(encoder.metrics().height, 2160);
});
