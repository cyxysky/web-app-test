import { describe, expect, it } from 'vitest';
import { validateOfficeRendererMatrix } from '@webpilot/capability-file/node';

describe('Office renderer validation policy', () => {
  it('uses LibreOffice only and never exposes a Microsoft renderer slot', async () => {
    const result = await validateOfficeRendererMatrix({});
    expect(result.policy).toBe('libreoffice-only');
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'LIBREOFFICE_RENDERER_UNAVAILABLE')).toBe(true);
    expect(result.renderers).toEqual({
      libreOffice: expect.objectContaining({ renderer: 'libreoffice', status: 'unavailable' }),
    });
    expect(result.renderers).not.toHaveProperty('microsoftOffice');
  });
});
