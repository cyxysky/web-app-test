export { jsonRecordFromUnknown as asRecord } from '@webpilot/capability-sdk';

export function finiteNumber(value: unknown) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}
