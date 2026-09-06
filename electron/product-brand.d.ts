export const product: { name: string; description: string };
export function resolveWorkspaceBrand(input?: { prefix?: string | null; text?: string | null }): {
  brandPrefix: string;
  brandText: string;
};
