export const MINIMUM_DATA_LOADING_MS = 1_000;

export async function waitForMinimumLoading(
  startedAt: number,
  minimumDurationMs = MINIMUM_DATA_LOADING_MS,
) {
  const remainingMs = minimumDurationMs - (Date.now() - startedAt);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, remainingMs);
  });
}
