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

export type ComputerCoordinateSpace = {
  unit: 'pixels';
  origin: 'top-left';
  width: number;
  height: number;
};

export type ComputerElement = {
  id: string;
  source: 'uia' | 'msaa' | 'ocr' | 'visual';
  role: string;
  name?: string;
  text?: string;
  bounds: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  enabled?: boolean;
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
  elements?: ComputerElement[];
  elementDiscovery?: {
    uiaCount?: number;
    msaaCount?: number;
    ocrCount?: number;
    visualCount?: number;
    ocrUsed?: boolean;
    visualUsed?: boolean;
    errors?: string[];
  };
  sequence?: number;
  coordinateSpace?: ComputerCoordinateSpace;
};

export interface ComputerDriver {
  execute(input: {
    action: 'observe' | 'launch' | 'click' | 'type' | 'key' | 'scroll' | 'wait';
    application?: string;
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

const screenshotPixelX = z.number().int().min(0).max(100_000).describe(
  'Exact horizontal pixel coordinate in the latest screenshot. Use the returned screenshot width; 0 is the left edge and width - 1 is the right edge.',
);
const screenshotPixelY = z.number().int().min(0).max(100_000).describe(
  'Exact vertical pixel coordinate in the latest screenshot. Use the returned screenshot height; 0 is the top edge and height - 1 is the bottom edge.',
);

const parser = z.object({
  action: z.enum(['observe', 'launch', 'click', 'type', 'key', 'scroll', 'wait']),
  reason: z.string().trim().min(1).max(300),
  application: z.string().trim().min(1).max(260).optional().describe(
    'Exact desktop or Start-menu application name to open. Use action=launch for named applications instead of locating an icon by pixels.',
  ),
  elementId: z.string().trim().min(1).max(200).optional().describe(
    'Element id from the latest observe result. Prefer this for click when an exact UIA, desktop-accessibility, OCR, or visual element matches the requested target.',
  ),
  x: screenshotPixelX.optional(),
  y: screenshotPixelY.optional(),
  text: z.string().max(20_000).optional(),
  keys: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
  deltaX: z.number().int().min(-100000).max(100000).optional(),
  deltaY: z.number().int().min(-100000).max(100000).optional(),
  durationMs: z.number().int().min(0).max(300000).optional(),
  button: z.enum(['left', 'middle', 'right']).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
}).strict().superRefine((input, context) => {
  const hasX = input.x !== undefined;
  const hasY = input.y !== undefined;
  if (input.action === 'click' && hasX !== hasY) {
    context.addIssue({ code: 'custom', message: 'click requires both screenshot pixel x and y coordinates.' });
  }
  if (input.action === 'click' && !input.elementId && !hasX) {
    context.addIssue({ code: 'custom', message: 'click requires elementId or screenshot pixel x and y coordinates.' });
  }
  if (input.action === 'click' && input.elementId && hasX) {
    context.addIssue({ code: 'custom', message: 'click accepts elementId or x/y, not both.' });
  }
  if (input.action === 'launch' && !input.application) {
    context.addIssue({ code: 'custom', path: ['application'], message: 'launch requires an application name.' });
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

function finiteInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

function normalizeComputerElements(value: unknown, width: number, height: number) {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const elements: ComputerElement[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const source = record.source === 'uia' || record.source === 'msaa' || record.source === 'ocr' || record.source === 'visual'
      ? record.source
      : undefined;
    const role = typeof record.role === 'string' ? record.role.trim() : '';
    const boundsRecord = record.bounds && typeof record.bounds === 'object' && !Array.isArray(record.bounds)
      ? record.bounds as Record<string, unknown>
      : undefined;
    const x = finiteInteger(boundsRecord?.x);
    const y = finiteInteger(boundsRecord?.y);
    const elementWidth = finiteInteger(boundsRecord?.width);
    const elementHeight = finiteInteger(boundsRecord?.height);
    if (
      !id || ids.has(id) || !source || !role
      || x === undefined || y === undefined || elementWidth === undefined || elementHeight === undefined
      || x < 0 || y < 0 || elementWidth <= 0 || elementHeight <= 0
      || x + elementWidth > width || y + elementHeight > height
    ) continue;
    ids.add(id);
    elements.push({
      id,
      source,
      role,
      ...(typeof record.name === 'string' && record.name.trim() ? { name: record.name.trim() } : {}),
      ...(typeof record.text === 'string' && record.text.trim() ? { text: record.text.trim() } : {}),
      bounds: { x, y, width: elementWidth, height: elementHeight },
      center: {
        x: Math.min(width - 1, x + Math.floor(elementWidth / 2)),
        y: Math.min(height - 1, y + Math.floor(elementHeight / 2)),
      },
      ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
    });
  }
  return elements;
}

export function createComputerTool(
  driver: ComputerDriver,
  configuration: CapabilityRunContext['configuration'],
) {
  let latestObservation: {
    width: number;
    height: number;
    elements: Map<string, ComputerElement>;
  } | undefined;

  return defineCapabilityTool<ComputerToolInput, unknown>({
    name: 'computer',
    description: 'Observe a configured desktop or perform one exact input action. Observe always returns one fresh screenshot with its actual width, height, active window, and discoverable native-accessibility/OCR/visual elements. Prefer click elementId only when its returned name, text, role, and active window are consistent with the target; never substitute an unrelated element. Otherwise click x/y are direct physical pixels in that latest screenshot with no normalized conversion. Use action=launch for named desktop or Start-menu apps.',
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
        if (input.action === 'click' && !latestObservation) {
          throw new Error('Click requires a fresh successful observe result first.');
        }
        const selectedElement = input.action === 'click' && input.elementId
          ? latestObservation?.elements.get(input.elementId)
          : undefined;
        if (input.action === 'click' && input.elementId && !selectedElement) {
          throw new Error(`Element '${input.elementId}' is not present in the latest screenshot observation.`);
        }
        const clickPoint = input.action === 'click'
          ? selectedElement?.center || { x: input.x!, y: input.y! }
          : undefined;
        if (
          input.action === 'click'
          && latestObservation
          && clickPoint
          && (
            clickPoint.x >= latestObservation.width
            || clickPoint.y >= latestObservation.height
          )
        ) {
          throw new Error(
            `Click pixel (${clickPoint.x}, ${clickPoint.y}) is outside the latest screenshot ${latestObservation.width}x${latestObservation.height}.`,
          );
        }

        const clickFrame = input.action === 'click' ? latestObservation : undefined;
        const executedPoint = input.action === 'click' && clickFrame && clickPoint
          ? {
              pixels: clickPoint,
              source: selectedElement ? 'element' as const : 'coordinates' as const,
              ...(selectedElement ? {
                elementId: selectedElement.id,
                element: selectedElement,
              } : {}),
              referenceScreenshot: { width: clickFrame.width, height: clickFrame.height },
            }
          : undefined;
        const driverAction = { ...input };
        delete driverAction.elementId;
        const driverInput = {
          ...driverAction,
          ...(clickPoint ? clickPoint : {}),
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
          const elements = normalizeComputerElements(observation.elements, width, height);
          observation.elements = elements;
          latestObservation = {
            width,
            height,
            elements: new Map(elements.map((element) => [element.id, element])),
          };
        } else if (input.action !== 'observe') {
          latestObservation = undefined;
        }
        const data = {
          ...rawData,
          ...(width && height ? {
            coordinateSpace: {
              unit: 'pixels' as const,
              origin: 'top-left' as const,
              width,
              height,
            } satisfies ComputerCoordinateSpace,
          } : {}),
          ...(executedPoint ? { executedPoint } : {}),
        };

        return {
          ok: true,
          summary: input.action === 'click'
            ? 'Computer click input completed; the requested target outcome still requires observation.'
            : `Computer ${input.action} completed.`,
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
