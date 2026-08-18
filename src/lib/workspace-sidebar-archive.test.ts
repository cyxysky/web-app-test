import { expect, test } from 'vitest';
import { groupWorkspaceSidebarArchive } from './workspace-sidebar-archive';

function localTimestamp(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month - 1, day, hour).toISOString();
}

test('groups workspace archive items by their local updated date while preserving order', () => {
  const groups = groupWorkspaceSidebarArchive([
    { id: 'a', createdAt: localTimestamp(2026, 8, 10), updatedAt: localTimestamp(2026, 8, 18) },
    { id: 'b', createdAt: localTimestamp(2026, 8, 18) },
    { id: 'c', createdAt: localTimestamp(2026, 8, 17) },
  ], 'zh');

  expect(groups.map((group) => ({
    day: group.day,
    ids: group.items.map((item) => item.id),
    key: group.key,
    month: group.month,
  }))).toEqual([
    { day: '18', ids: ['a', 'b'], key: '2026-08-18', month: '八月' },
    { day: '17', ids: ['c'], key: '2026-08-17', month: '八月' },
  ]);
});

test('uses deterministic English month labels and keeps invalid dates together', () => {
  const groups = groupWorkspaceSidebarArchive([
    { id: 'a', updatedAt: localTimestamp(2026, 8, 18) },
    { id: 'b', updatedAt: 'invalid' },
    { id: 'c' },
  ], 'en');

  expect(groups[0]?.month).toBe('Aug');
  expect(groups[0]?.ariaLabel).toBe('Aug 18, 2026');
  expect(groups[1]).toEqual({
    ariaLabel: 'Unknown date',
    day: '—',
    items: [{ id: 'b', updatedAt: 'invalid' }, { id: 'c' }],
    key: 'unknown',
    month: 'Unknown',
  });
});
