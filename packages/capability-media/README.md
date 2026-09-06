# @webpilot/capability-media

Portable media operations for OCR, transcription, video frame extraction, inspection, and image generation. Providers resolve opaque source references and publish outputs through host artifact storage; raw host paths never need to enter model input.

## TypeScript Agent framework integration

```ts
import { createMediaCapability, type MediaOperations } from '@webpilot/capability-media';

const mediaOperations: MediaOperations = {
  inspect: (sourceRef, context) => mediaBackend.inspect(sourceRef, context),
  ocr: (input, context) => mediaBackend.ocr(input, context),
};

const provider = createMediaCapability({
  createOperations: () => mediaOperations,
});
```

`mediaBackend` represents the host-selected OCR, transcription, inspection, or
generation implementation. Register the provider with `mountCapabilities()`,
expose the resolved `media` tool through the consuming TypeScript Agent
framework, inject the package Skill, and preserve returned image/artifact
content. See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).

`createFfmpegMediaOperations` accepts an optional `ffprobePath` for structured metadata inspection. Without it, FFmpeg inspects stream headers with zero output duration. Cancellation and timeouts terminate the child process tree and reject the operation; partial stderr is not treated as successful inspection.
