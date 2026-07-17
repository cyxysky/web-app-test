export function apiErrorMessage(data: unknown, fallback: string) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const error = (data as Record<string, unknown>).error;
    if (typeof error === 'string' && error.trim()) return error;
    const message = (data as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

export async function readApiJson<T = Record<string, unknown>>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiErrorMessage(data, fallback));
  return data as T;
}
