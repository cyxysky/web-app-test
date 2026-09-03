import { z } from 'zod';
import {
  defineCapabilityInput,
  defineCapabilityTool,
  normalizeBoundedInteger,
  type CapabilityExecutionContext,
  type CapabilityHealth,
  type CapabilityManifest,
  type CapabilityProvider,
  type CapabilityRunContext,
} from '@webpilot/capability-sdk';
import { computerRuntimeSkill } from './runtime-skill.js';
import { computerCapabilitySettings } from './settings.js';

export * from './runtime-skill.js';
export * from './settings.js';

export const computerCapabilityToolNames = Object.freeze({ computer: 'computer' } as const);

const NORMALIZED_COORDINATE_MAX = 1000;

export type ComputerCoordinateSpace = {
  unit: 'normalized';
  min: 0;
  max: 1000;
  origin: 'top-left';
};

export type ComputerObservation = {
  displayId?: string;
  width?: number;
  height?: number;
  activeWindow?: {
    title?: string;
    application?: string;
    bounds?: { x: number; y: number; width: number; height: number };
  };
  artifactId?: string;
  mediaType?: string;
  screenshotBase64?: string;
  elements?: unknown[];
  sequence?: number;
  coordinateSpace?: ComputerCoordinateSpace;
};

export interface ComputerDriver {
  execute(input: {
    action: 'observe' | 'screenshot' | 'click' | 'type' | 'key' | 'scroll' | 'wait';
    x?: number;
    y?: number;
    text?: string;
    keys?: string[];
    deltaX?: number;
    deltaY?: number;
    durationMs?: number;
    button?: 'left' | 'middle' | 'right';
    clickCount?: number;
    timeoutMs: number;
  }, context: CapabilityExecutionContext): Promise<ComputerObservation | Record<string, unknown>>;
  health?(): Promise<CapabilityHealth>;
  dispose?(): Promise<void>;
}

const normalizedX = z.number().int().min(0).max(NORMALIZED_COORDINATE_MAX).describe(
  'Horizontal position in the current screenshot, normalized from 0 at the left edge to 1000 at the right edge. Never use raw image or display pixels.',
);
const normalizedY = z.number().int().min(0).max(NORMALIZED_COORDINATE_MAX).describe(
  'Vertical position in the current screenshot, normalized from 0 at the top edge to 1000 at the bottom edge. Never use raw image or display pixels.',
);

const parser = z.object({
  action: z.enum(['observe', 'screenshot', 'click', 'type', 'key', 'scroll', 'wait']),
  reason: z.string().trim().min(1).max(300),
  x: normalizedX.optional(),
  y: normalizedY.optional(),
  text: z.string().max(20_000).optional(),
  keys: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
  deltaX: z.number().int().min(-100000).max(100000).optional(),
  deltaY: z.number().int().min(-100000).max(100000).optional(),
  durationMs: z.number().int().min(0).max(300000).optional(),
  button: z.enum(['left', 'middle', 'right']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
}).strict().superRefine((input, context) => {
  if (input.action === 'click' && (input.x === undefined || input.y === undefined)) {
    context.addIssue({ code: 'custom', message: 'click requires normalized x and y coordinates.' });
  }
  if (input.action === 'type' && input.text === undefined) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'type requires text.' });
  }
  if (input.action === 'key' && !input.keys?.length) {
    context.addIssue({ code: 'custom', path: ['keys'], message: 'key requires keys.' });
  }
  if (input.action === 'scroll' && input.deltaX === undefined && input.deltaY === undefined) {
    context.addIssue({ code: 'custom', message: 'scroll requires deltaX or deltaY.' });
  }
});

export type ComputerToolInput = z.infer<typeof parser>;

export const computerToolInput = defineCapabilityInput<ComputerToolInput>(
  z.toJSONSchema(parser) as Readonly<Record<string, unknown>>,
  (value) => parser.parse(value),
);

export const computerCapabilityManifest = Object.freeze({
  schemaVersion: 1,
  id: 'com.webpilot.computer',
  name: 'Computer',
  version: '0.1.0',
  description: 'Observe and control a desktop through the built-in Windows driver or an optional remote driver.',
  permissions: ['computer:observe', 'computer:input'],
  runtimeRequirements: { node: '>=22.16', driver: 'built-in-windows-or-host-provided' },
  configuration: { settings: computerCapabilitySettings },
  skills: [computerRuntimeSkill],
} satisfies CapabilityManifest);

function positiveDimension(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function physicalCoordinate(value: number, dimension: number) {
  return Math.max(0, Math.min(
    dimension - 1,
    Math.round((value / NORMALIZED_COORDINATE_MAX) * (dimension - 1)),
  ));
}

const normalizedCoordinateSpace = Object.freeze({
  unit: 'normalized',
  min: 0,
  max: NORMALIZED_COORDINATE_MAX,
  origin: 'top-left',
} satisfies ComputerCoordinateSpace);

export function createComputerTool(
  driver: ComputerDriver,
  configuration: CapabilityRunContext['configuration'],
) {
  let latestScreenshotDimensions: { width: number; height: number } | undefined;

  return defineCapabilityTool<ComputerToolInput, unknown>({
    name: 'computer',
    description: 'Observe a configured desktop or perform one exact input action. Click x/y always use a normalized 0-1000 coordinate space relative to the latest screenshot: (0,0) is top-left and (1000,1000) is bottom-right.',
    input: computerToolInput,
    policy: {
      concurrency: 'serial',
      concurrencyGroup: 'computer-session',
      permissions: computerCapabilityManifest.permissions,
    },
    async execute(input, context) {
      if (configuration.AGENT_COMPUTER_ENABLED !== 'true') {
        return {
          ok: false,
          error: {
            code: 'computer-disabled',
            message: 'Computer control is disabled by host configuration.',
          },
        };
      }

      try {
        if (input.action === 'click' && !latestScreenshotDimensions) {
          throw new Error('Click requires a fresh successful observe or screenshot result first.');
        }

        const driverInput = {
          ...input,
          ...(input.action === 'click' && latestScreenshotDimensions
            ? {
                x: physicalCoordinate(input.x!, latestScreenshotDimensions.width),
                y: physicalCoordinate(input.y!, latestScreenshotDimensions.height),
              }
            : {}),
          timeoutMs: normalizeBoundedInteger(
            configuration.AGENT_COMPUTER_TIMEOUT_MS,
            30000,
            1000,
            300000,
          ),
        };
        const rawData = await driver.execute(driverInput, context);
        const observation = rawData as ComputerObservation;
        const width = positiveDimension(observation.width);
        const height = positiveDimension(observation.height);
        if (observation.artifactId && width && height) {
          latestScreenshotDimensions = { width, height };
        } else if (input.action !== 'observe' && input.action !== 'screenshot') {
          latestScreenshotDimensions = undefined;
        }
        const data = { ...rawData, coordinateSpace: normalizedCoordinateSpace };

        return {
          ok: true,
          summary: `Computer ${input.action} completed.`,
          data,
          content: observation.artifactId
            ? [{ type: 'image' as const, artifactId: observation.artifactId, mediaType: observation.mediaType }]
            : undefined,
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'computer-operation-failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  });
}

export function createComputerCapability(options: {
  createDriver(context: CapabilityRunContext): ComputerDriver | Promise<ComputerDriver>;
}): CapabilityProvider {
  return {
    manifest: computerCapabilityManifest,
    async createRuntime(context) {
      const driver = await options.createDriver(context);
      return {
        tools: Object.freeze({ computer: createComputerTool(driver, context.configuration) }),
        health: () => driver.health?.() || Promise.resolve({
          status: context.configuration.AGENT_COMPUTER_ENABLED === 'true' ? 'healthy' : 'degraded',
          message: context.configuration.AGENT_COMPUTER_ENABLED === 'true'
            ? undefined
            : 'Disabled by configuration.',
        }),
        dispose: () => driver.dispose?.() || Promise.resolve(),
      };
    },
  };
}
